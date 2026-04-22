#!/usr/bin/env node
/**
 * ingest_industry.js — pareto-focus industry-signals ingestor
 *
 * CLI:
 *   node ingest_industry.js [--date YYYY-MM-DD] [--sources papers,blogs,x,linkedin]
 *
 * Modes:
 *   - Direct: arXiv Atom API for papers (no auth, pure node stdlib).
 *   - Manifest: emits a request manifest for sources that need MCP
 *     (exa-search for blogs, x-api for X, linkedin MCP for LinkedIn).
 *     The pareto-focus SKILL routes that manifest to its MCP tools.
 *
 * Outputs:
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/papers.json
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/x_linkedin.json
 *
 * Dependency-free: Node stdlib only (no npm install).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

// ---------- constants ----------

const PROJECT_ROOT = path.join(os.homedir(), '.claude', 'projects', 'pareto-focus');
const SKILL_TEMPLATE_CONFIG = path.join(os.homedir(), '.claude', 'skills', 'pareto-focus', 'templates', 'config.yaml');
const PROJECT_CONFIG = path.join(PROJECT_ROOT, 'config.yaml');
const SIGNALS_ROOT = path.join(PROJECT_ROOT, 'data', 'signals');

const ARXIV_TIMEOUT_MS = 15_000;
const ARXIV_SPACING_MS = 300;
const ARXIV_MAX_RESULTS = 10;
const ARXIV_KEEP_PER_TOPIC = 5;
const FRESHNESS_HALFLIFE_DAYS = 14;
const ALL_SOURCES = ['papers', 'blogs', 'x', 'linkedin'];

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { date: null, sources: ALL_SOURCES.slice() };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date' && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
    } else if (a === '--sources' && argv[i + 1]) {
      args.sources = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node ingest_industry.js [--date YYYY-MM-DD] [--sources papers,blogs,x,linkedin]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

function todayISO() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nowISO() {
  // YYYY-MM-DDTHH:MM:SSZ (strip milliseconds)
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---------- config loader ----------

function pickConfigPath() {
  if (fs.existsSync(PROJECT_CONFIG)) return PROJECT_CONFIG;
  if (fs.existsSync(SKILL_TEMPLATE_CONFIG)) return SKILL_TEMPLATE_CONFIG;
  return null;
}

function loadConfig() {
  const p = pickConfigPath();
  if (!p) {
    return {
      industry_topics: {
        papers: [],
        blogs: [],
        x_handles: [],
        linkedin_companies: [],
        linkedin_people: [],
      },
    };
  }
  // Prefer python3 for robust YAML parsing; fall back to minimal regex parser.
  try {
    const script = `import sys, json, yaml; print(json.dumps(yaml.safe_load(open(${JSON.stringify(p)}))))`;
    const out = execSync(`python3 -c ${JSON.stringify(script)}`, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return normalizeConfig(JSON.parse(out));
  } catch (_err) {
    return normalizeConfig(regexYamlIndustryTopics(fs.readFileSync(p, 'utf8')));
  }
}

function normalizeConfig(cfg) {
  const it = (cfg && cfg.industry_topics) || {};
  return {
    industry_topics: {
      papers: Array.isArray(it.papers) ? it.papers : [],
      blogs: Array.isArray(it.blogs) ? it.blogs : [],
      x_handles: Array.isArray(it.x_handles) ? it.x_handles : [],
      linkedin_companies: Array.isArray(it.linkedin_companies) ? it.linkedin_companies : [],
      linkedin_people: Array.isArray(it.linkedin_people) ? it.linkedin_people : [],
    },
  };
}

function regexYamlIndustryTopics(text) {
  // Extract industry_topics top-level block, stopping at next top-level key
  // (a non-indented line starting with a letter).
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => /^industry_topics:\s*$/.test(l));
  if (startIdx === -1) return { industry_topics: {} };
  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\S/.test(l)) break; // next top-level key
    blockLines.push(l);
  }
  const buckets = {};
  let currentKey = null;
  for (const raw of blockLines) {
    const keyMatch = /^ {2}([a-z_]+):\s*(.*)$/.exec(raw);
    if (keyMatch) {
      currentKey = keyMatch[1];
      buckets[currentKey] = [];
      // Handle inline array `key: []`.
      const rest = keyMatch[2].trim();
      if (rest === '[]') {
        buckets[currentKey] = [];
      }
      continue;
    }
    const itemMatch = /^ {4}-\s*(.+?)\s*$/.exec(raw);
    if (itemMatch && currentKey) {
      let v = itemMatch[1];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      buckets[currentKey].push(v);
    }
  }
  return { industry_topics: buckets };
}

// ---------- http ----------

function httpGet(url, timeoutMs, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'pareto-focus-ingest/1.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        httpGet(res.headers.location, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${url}`));
    });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- arXiv Atom parser ----------

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

function firstMatch(re, hay) {
  const m = re.exec(hay);
  return m ? m[1] : '';
}

function allMatches(re, hay) {
  const out = [];
  let m;
  while ((m = re.exec(hay)) !== null) out.push(m[1]);
  return out;
}

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function extractArxivIdFromUrl(idUrl) {
  // e.g. http://arxiv.org/abs/2604.01234v1  →  2604.01234
  const m = /abs\/([^\s?#]+)$/.exec(idUrl);
  if (!m) return idUrl;
  return m[1].replace(/v\d+$/, '');
}

function parseArxivAtom(xml, topic) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let em;
  while ((em = entryRe.exec(xml)) !== null) {
    const body = em[1];
    const title = normalizeWhitespace(
      decodeEntities(stripTags(firstMatch(/<title>([\s\S]*?)<\/title>/, body))),
    );
    const summary = normalizeWhitespace(
      decodeEntities(stripTags(firstMatch(/<summary>([\s\S]*?)<\/summary>/, body))),
    );
    const idUrl = firstMatch(/<id>([\s\S]*?)<\/id>/, body).trim();
    const publishedFull = firstMatch(/<published>([\s\S]*?)<\/published>/, body).trim();
    const authors = allMatches(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g, body)
      .map((a) => normalizeWhitespace(decodeEntities(stripTags(a))))
      .filter(Boolean);
    if (!idUrl || !title) continue;
    const arxivId = extractArxivIdFromUrl(idUrl);
    entries.push({
      id: arxivId,
      title,
      abstract: summary,
      topic_matched: topic,
      published: publishedFull ? publishedFull.slice(0, 10) : '',
      published_full: publishedFull,
      url: `https://arxiv.org/abs/${arxivId}`,
      authors,
    });
  }
  return entries;
}

function computeFreshness(publishedFullISO, nowMs) {
  if (!publishedFullISO) return 0;
  const t = Date.parse(publishedFullISO);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  const f = Math.exp(-ageDays / FRESHNESS_HALFLIFE_DAYS);
  return Math.round(f * 1000) / 1000;
}

// ---------- fetchers ----------

async function fetchPapersDirect(topics) {
  const errors = [];
  const nowMs = Date.now();
  const seen = new Set();
  const results = [];

  if (!topics.length) {
    return { papers: [], errors, reachable: true };
  }

  let reachable = false;
  let anyNetworkError = false;

  // Scope arxiv queries to AI/ML categories. Without this, a query like
  // "agentic RL training" matches 3D vision papers ("3D Policy Learning"),
  // fashion try-on, etc. The user works in NLP/RL/ML — we only want papers
  // from those categories.
  // arxiv categories used:
  //   cs.LG  — Machine Learning
  //   cs.CL  — Computation and Language (NLP)
  //   cs.AI  — Artificial Intelligence
  //   cs.NE  — Neural and Evolutionary Computing
  //   stat.ML — Statistics: Machine Learning
  const ML_CATEGORIES = '(cat:cs.LG+OR+cat:cs.CL+OR+cat:cs.AI+OR+cat:cs.NE+OR+cat:stat.ML)';

  for (let i = 0; i < topics.length; i += 1) {
    const topic = topics[i];
    const q = encodeURIComponent(topic);
    // arxiv expects '+AND+' as a literal operator (not URL-encoded inside the
    // query expression), so we concatenate the pre-encoded category clause.
    const url =
      `https://export.arxiv.org/api/query?search_query=${ML_CATEGORIES}+AND+all:${q}` +
      `&sortBy=submittedDate&sortOrder=descending&max_results=${ARXIV_MAX_RESULTS}`;
    try {
      const xml = await httpGet(url, ARXIV_TIMEOUT_MS);
      reachable = true;
      const entries = parseArxivAtom(xml, topic);
      const topicResults = [];
      for (const e of entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const freshness = computeFreshness(e.published_full, nowMs);
        topicResults.push({
          id: e.id,
          title: e.title,
          abstract: e.abstract,
          topic_matched: e.topic_matched,
          published: e.published,
          url: e.url,
          freshness,
          authors: e.authors,
        });
      }
      results.push(...topicResults.slice(0, ARXIV_KEEP_PER_TOPIC));
    } catch (err) {
      anyNetworkError = true;
      errors.push(`arxiv[${topic}]: ${err.message}`);
    }
    if (i < topics.length - 1) await sleep(ARXIV_SPACING_MS);
  }

  if (!reachable && anyNetworkError) {
    return { papers: [], errors, reachable: false };
  }
  return { papers: results, errors, reachable: true };
}

function buildBlogsManifest(blogs) {
  return { source: 'exa-search', queries: blogs.slice() };
}

function buildXManifest(handles) {
  return { source: 'x-api', handles: handles.slice() };
}

function buildLinkedinManifest(companies, people) {
  return {
    source: 'mcp__linkedin__*',
    companies: companies.slice(),
    people: people.slice(),
  };
}

// ---------- fs helpers ----------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv);
  const date = args.date && isValidDate(args.date) ? args.date : todayISO();
  const sourcesFiltered = args.sources.filter((s) => ALL_SOURCES.includes(s));
  const sources = new Set(sourcesFiltered.length ? sourcesFiltered : ALL_SOURCES);

  const cfg = loadConfig();
  const topics = cfg.industry_topics;

  const runMode = {};
  const errors = [];

  let papers = [];
  if (sources.has('papers')) {
    const r = await fetchPapersDirect(topics.papers);
    papers = r.papers;
    errors.push(...r.errors);
    runMode.papers = r.reachable ? 'direct' : 'unreachable';
  } else {
    runMode.papers = 'skipped';
  }

  const blogsManifest = sources.has('blogs') ? buildBlogsManifest(topics.blogs) : null;
  runMode.blogs = sources.has('blogs') ? 'manifest' : 'skipped';

  const xManifest = sources.has('x') ? buildXManifest(topics.x_handles) : null;
  runMode.x = sources.has('x') ? 'manifest' : 'skipped';

  const linkedinManifest = sources.has('linkedin')
    ? buildLinkedinManifest(topics.linkedin_companies, topics.linkedin_people)
    : null;
  runMode.linkedin = sources.has('linkedin') ? 'manifest' : 'skipped';

  const generatedAt = nowISO();

  const papersOut = {
    date,
    generated_at: generatedAt,
    mode: { papers: runMode.papers },
    papers,
    errors,
  };

  const xlOut = {
    date,
    generated_at: generatedAt,
    mode: {
      blogs: runMode.blogs,
      x: runMode.x,
      linkedin: runMode.linkedin,
    },
    blogs: [],
    x: [],
    linkedin: [],
    _manifest: {
      ...(blogsManifest ? { blogs: blogsManifest } : {}),
      ...(xManifest ? { x: xManifest } : {}),
      ...(linkedinManifest ? { linkedin: linkedinManifest } : {}),
    },
  };

  const outDir = path.join(SIGNALS_ROOT, date);
  const papersPath = path.join(outDir, 'papers.json');
  const xlPath = path.join(outDir, 'x_linkedin.json');
  writeJson(papersPath, papersOut);
  writeJson(xlPath, xlOut);

  const summary = {
    papers_path: papersPath,
    x_linkedin_path: xlPath,
    counts: {
      papers: papers.length,
      blogs_requests: blogsManifest ? blogsManifest.queries.length : 0,
      x_requests: xManifest ? xManifest.handles.length : 0,
      linkedin_company_requests: linkedinManifest ? linkedinManifest.companies.length : 0,
      linkedin_people_requests: linkedinManifest ? linkedinManifest.people.length : 0,
    },
    mode: runMode,
    errors_count: errors.length,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
}

main().catch((err) => {
  try {
    process.stderr.write(`ingest_industry error: ${err && err.stack ? err.stack : err}\n`);
  } catch (_e) {
    // ignore
  }
  // Graceful degradation: never abort the pipeline.
  process.exit(0);
});
