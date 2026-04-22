#!/usr/bin/env node
/**
 * ingest_github.js — local-git + (optional) gh-CLI ingestor for pareto-focus.
 *
 * CLI:
 *   node ingest_github.js [--date YYYY-MM-DD]
 *
 * Reads active_repos[] from:
 *   1. ~/.claude/projects/pareto-focus/config.yaml  (preferred)
 *   2. ~/.claude/skills/pareto-focus/templates/config.yaml  (fallback)
 *
 * Writes:
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/github.json
 *
 * Augments:
 *   ~/.claude/projects/pareto-focus/state/teammates.md
 *     (appends `# Auto-discovered` section with new commit authors)
 *
 * Pure Node stdlib. 10s per-shell timeout. Never crashes on partial failure.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const PROJECT_ROOT = path.join(HOME, '.claude/projects/pareto-focus');
const SKILL_ROOT = path.join(HOME, '.claude/skills/pareto-focus');
const CONFIG_PATH_PRIMARY = path.join(PROJECT_ROOT, 'config.yaml');
const CONFIG_PATH_FALLBACK = path.join(SKILL_ROOT, 'templates/config.yaml');
const TEAMMATES_PATH = path.join(PROJECT_ROOT, 'state/teammates.md');
const TEAMMATES_TEMPLATE = path.join(SKILL_ROOT, 'templates/teammates.md');
const SIGNALS_ROOT = path.join(PROJECT_ROOT, 'data/signals');

const SHELL_TIMEOUT_MS = 10_000;
const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/;
const STALE_TODO_DAYS = 30;
const MAX_TODOS_PER_REPO = 50;
const TOP_STALE_TODOS = 5;
const STALE_PR_DAYS = 14;
const UNTRIAGED_AGE_DAYS = 7;
const STANDARD_DOCS = ['README.md', 'ARCHITECTURE.md', 'docs'];

// ────────────────────────────────────────────────────────────────────────────
// Shell helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run a command with a timeout. Returns {ok, stdout, stderr, error}.
 * Never throws — every caller gets a structured result.
 */
function runCmd(cmd, args, opts = {}) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout || SHELL_TIMEOUT_MS,
      cwd: opts.cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (res.error) {
      return { ok: false, stdout: '', stderr: '', error: String(res.error.message || res.error) };
    }
    if (res.status !== 0) {
      return {
        ok: false,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        error: `exit ${res.status}`,
      };
    }
    return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '', error: null };
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: String(err.message || err) };
  }
}

function commandExists(bin) {
  const res = runCmd('which', [bin], { timeout: 2000 });
  return res.ok && res.stdout.trim().length > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Config loading
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse config.yaml. Prefers python3+yaml; falls back to a regex parser
 * restricted to the fields we need (active_repos, projects_root).
 */
function loadConfig() {
  let configPath = CONFIG_PATH_PRIMARY;
  if (!fs.existsSync(configPath)) {
    configPath = CONFIG_PATH_FALLBACK;
  }
  if (!fs.existsSync(configPath)) {
    return { projects_root: path.join(HOME, 'Projects'), active_repos: [], _source: null };
  }

  // Prefer python3 yaml if available — robust.
  if (commandExists('python3')) {
    const py = runCmd('python3', [
      '-c',
      'import yaml,json,sys\nprint(json.dumps(yaml.safe_load(open(sys.argv[1]))))',
      configPath,
    ]);
    if (py.ok) {
      try {
        const parsed = JSON.parse(py.stdout);
        const userEmails = Array.isArray(parsed?.user?.emails) ? parsed.user.emails : [];
        const userHandle = (parsed?.user?.github_handle || '').toString().trim();
        return {
          projects_root: parsed.projects_root || path.join(HOME, 'Projects'),
          active_repos: Array.isArray(parsed.active_repos) ? parsed.active_repos : [],
          user_emails: userEmails,
          user_handle: userHandle,
          _source: configPath,
        };
      } catch (_) {
        // fall through to regex
      }
    }
  }

  // Regex fallback — handles the templates/config.yaml shape.
  const raw = fs.readFileSync(configPath, 'utf8');
  const projectsRoot =
    (raw.match(/^projects_root:\s*"?([^"\n]+)"?/m) || [])[1] || path.join(HOME, 'Projects');

  const repos = [];
  const afterAR = raw.split(/^active_repos:\s*$/m)[1] || '';
  // Take only the indented block — stop at the next top-level key.
  const stopAt = afterAR.search(/^\S/m);
  const scoped = stopAt === -1 ? afterAR : afterAR.slice(0, stopAt);

  const entries = scoped.split(/\n\s*-\s+/).slice(1);
  for (const entry of entries) {
    const name = (entry.match(/name:\s*([^\s#]+)/) || [])[1];
    const p = (entry.match(/path:\s*([^\s#]+)/) || [])[1];
    const gh = (entry.match(/github:\s*"?([^"\n#]*)"?/) || [])[1] || '';
    const topicsMatch = entry.match(/topics:\s*\[([^\]]*)\]/);
    const topics = topicsMatch
      ? topicsMatch[1]
          .split(',')
          .map((s) => s.replace(/["']/g, '').trim())
          .filter(Boolean)
      : [];
    if (name && p) {
      repos.push({ name, path: p, github: gh.trim(), topics });
    }
  }

  // Regex fallback: extract user.emails as a YAML inline-list string.
  const emailsLine = (raw.match(/^\s*emails:\s*\[([^\]]*)\]/m) || [])[1] || '';
  const userEmails = emailsLine
    ? emailsLine.split(',').map((s) => s.replace(/["']/g, '').trim()).filter(Boolean)
    : [];
  const userHandle = ((raw.match(/^\s*github_handle:\s*"?([^"\s\n]+)"?/m) || [])[1] || '').trim();

  return {
    projects_root: projectsRoot,
    active_repos: repos,
    user_emails: userEmails,
    user_handle: userHandle,
    _source: configPath,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Local git ingestion
// ────────────────────────────────────────────────────────────────────────────

function parseCommitLine(line) {
  // format: sha|email|name|subject
  const parts = line.split('|');
  if (parts.length < 4) return null;
  const [sha, email, name, ...rest] = parts;
  return {
    sha: sha.trim(),
    author_email: email.trim(),
    author_name: name.trim(),
    subject: rest.join('|').trim(),
  };
}

function collectLocalCommits(repoDir, userEmails = []) {
  const errors = [];
  let recent_commits = [];
  let commits_last_24h = 0;
  let commits_last_7d = 0;

  const res7d = runCmd(
    'git',
    ['-C', repoDir, 'log', '--all', '--since=7 days ago', '--pretty=format:%h|%ae|%an|%s', '--no-merges'],
    {},
  );
  if (res7d.ok) {
    recent_commits = res7d.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(parseCommitLine)
      .filter(Boolean);
    commits_last_7d = recent_commits.length;
  } else {
    errors.push(`git log 7d: ${res7d.error}`);
  }

  const res24h = runCmd(
    'git',
    ['-C', repoDir, 'log', '--all', '--since=1 day ago', '--pretty=format:%h'],
    {},
  );
  if (res24h.ok) {
    commits_last_24h = res24h.stdout.split('\n').filter((l) => l.trim()).length;
  } else {
    errors.push(`git log 24h: ${res24h.error}`);
  }

  // User-only filter: per SKILL.md Quality Bar, "Do" items must reflect what the
  // user actually does, not whole-repo activity. We filter recent_commits by the
  // user's configured emails so downstream signals (active-repo nudges, drift
  // analysis) attribute work correctly. `--all` above ensures we see commits on
  // feature branches the user works on, not just the default branch.
  const emailSet = new Set((userEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const recent_commits_by_user = emailSet.size === 0
    ? []
    : recent_commits.filter((c) => c && c.author_email && emailSet.has(String(c.author_email).toLowerCase()));
  const commits_last_7d_by_user = recent_commits_by_user.length;

  return {
    recent_commits,
    commits_last_24h,
    commits_last_7d,
    recent_commits_by_user,
    commits_last_7d_by_user,
    errors,
  };
}

/**
 * Find stale TODOs. Uses git grep for candidates, then git blame to check
 * author-time. Caps at MAX_TODOS_PER_REPO candidates for performance.
 */
function collectStaleTodos(repoDir) {
  const errors = [];
  const stale = [];

  const grep = runCmd('git', ['-C', repoDir, 'grep', '-n', '-E', 'TODO|FIXME|XXX|HACK'], {});

  if (!grep.ok) {
    // grep exit 1 = no matches — not a real error.
    if (grep.error && !/exit 1/.test(grep.error)) {
      errors.push(`git grep: ${grep.error}`);
    }
    return { stale_todos: [], errors };
  }

  const candidates = grep.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_TODOS_PER_REPO);

  const nowSec = Math.floor(Date.now() / 1000);
  const staleCutoff = STALE_TODO_DAYS * 86400;

  for (const line of candidates) {
    // format: path:lineno:content
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon === -1 || secondColon === -1) continue;
    const file = line.slice(0, firstColon);
    const lineno = parseInt(line.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(lineno)) continue;
    const text = line.slice(secondColon + 1).trim();
    if (!TODO_PATTERN.test(text)) continue;
    if (/node_modules|\.min\.js|\.lock$/.test(file)) continue;

    const blame = runCmd(
      'git',
      ['-C', repoDir, 'blame', '--porcelain', '-L', `${lineno},${lineno}`, '--', file],
      { timeout: 5000 },
    );
    if (!blame.ok) continue;

    const authorTime = parseInt(
      (blame.stdout.match(/^author-time (\d+)/m) || [])[1] || '0',
      10,
    );
    if (!authorTime) continue;
    const ageSec = nowSec - authorTime;
    if (ageSec >= staleCutoff) {
      stale.push({
        file,
        line: lineno,
        text: text.slice(0, 200),
        age_days: Math.floor(ageSec / 86400),
      });
    }
  }

  // Keep the longest comment texts (most "interesting"), cap at TOP_STALE_TODOS.
  stale.sort((a, b) => b.text.length - a.text.length);
  return { stale_todos: stale.slice(0, TOP_STALE_TODOS), errors };
}

function checkMissingDocs(repoDir) {
  const missing = [];
  for (const doc of STANDARD_DOCS) {
    const p = path.join(repoDir, doc);
    if (!fs.existsSync(p)) missing.push(doc);
  }
  return missing;
}

// ────────────────────────────────────────────────────────────────────────────
// GitHub API (via gh CLI)
// ────────────────────────────────────────────────────────────────────────────

function ghAvailable() {
  if (!commandExists('gh')) {
    return { available: false, reason: 'gh CLI not installed' };
  }
  const auth = runCmd('gh', ['auth', 'status'], { timeout: 5000 });
  if (!auth.ok) {
    return { available: false, reason: 'gh CLI not authenticated' };
  }
  return { available: true, reason: null };
}

function daysAgoIso(days) {
  const d = new Date(Date.now() - days * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function collectGithubApi(repoSlug) {
  const errors = [];
  const result = {
    prs_merged_7d: [],
    open_prs: [],
    p0_issues: [],
    ci_status: 'unknown',
  };

  // Merged PRs in last 7d
  const mergedRes = runCmd(
    'gh',
    [
      'pr', 'list', '-R', repoSlug,
      '--state', 'merged',
      '--search', `merged:>=${daysAgoIso(7)}`,
      '--json', 'number,title,author,mergedAt,labels',
      '--limit', '30',
    ],
    {},
  );
  if (mergedRes.ok) {
    const arr = parseJson(mergedRes.stdout) || [];
    result.prs_merged_7d = arr.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login || null,
      merged_at: pr.mergedAt || null,
      labels: (pr.labels || []).map((l) => l.name),
    }));
  } else {
    errors.push(`gh pr list merged: ${mergedRes.error}`);
  }

  // Open PRs
  const openRes = runCmd(
    'gh',
    [
      'pr', 'list', '-R', repoSlug,
      '--state', 'open',
      '--json', 'number,title,author,createdAt,labels',
      '--limit', '30',
    ],
    {},
  );
  if (openRes.ok) {
    const arr = parseJson(openRes.stdout) || [];
    result.open_prs = arr.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login || null,
      created_at: pr.createdAt || null,
      labels: (pr.labels || []).map((l) => l.name),
    }));
  } else {
    errors.push(`gh pr list open: ${openRes.error}`);
  }

  // P0/urgent/blocker issues (union across labels — one call each)
  const p0Map = new Map();
  for (const label of ['P0', 'urgent', 'blocker']) {
    const res = runCmd(
      'gh',
      [
        'issue', 'list', '-R', repoSlug,
        '--state', 'open',
        '--label', label,
        '--json', 'number,title,author,labels,createdAt',
        '--limit', '30',
      ],
      {},
    );
    if (res.ok) {
      const arr = parseJson(res.stdout) || [];
      for (const issue of arr) {
        if (!p0Map.has(issue.number)) {
          p0Map.set(issue.number, {
            number: issue.number,
            title: issue.title,
            author: issue.author?.login || null,
            labels: (issue.labels || []).map((l) => l.name),
            created_at: issue.createdAt || null,
          });
        }
      }
    }
    // missing label is a normal gh error — skip silently
  }
  result.p0_issues = [...p0Map.values()];

  // CI status — last 10 runs
  const ciRes = runCmd(
    'gh',
    ['run', 'list', '-R', repoSlug, '--limit', '10', '--json', 'conclusion,name,createdAt'],
    {},
  );
  if (ciRes.ok) {
    const runs = parseJson(ciRes.stdout) || [];
    if (runs.length === 0) {
      result.ci_status = 'unknown';
    } else {
      const conclusions = runs.map((r) => r.conclusion || 'pending');
      const success = conclusions.filter((c) => c === 'success').length;
      const failure = conclusions.filter((c) => c === 'failure').length;
      if (failure === 0 && success > 0) result.ci_status = 'success';
      else if (success === 0 && failure > 0) result.ci_status = 'failure';
      else if (success > 0 && failure > 0) result.ci_status = 'mixed';
      else result.ci_status = 'unknown';
    }
  } else {
    errors.push(`gh run list: ${ciRes.error}`);
  }

  // Untriaged issues — open + no labels + >7d old
  const untriagedRes = runCmd(
    'gh',
    [
      'issue', 'list', '-R', repoSlug,
      '--state', 'open',
      '--json', 'number,title,labels,createdAt,author',
      '--limit', '50',
    ],
    {},
  );
  let untriaged = [];
  if (untriagedRes.ok) {
    const arr = parseJson(untriagedRes.stdout) || [];
    const cutoff = Date.now() - UNTRIAGED_AGE_DAYS * 86400 * 1000;
    untriaged = arr
      .filter((i) => (i.labels || []).length === 0)
      .filter((i) => i.createdAt && new Date(i.createdAt).getTime() < cutoff)
      .map((i) => ({
        number: i.number,
        title: i.title,
        author: i.author?.login || null,
        created_at: i.createdAt,
      }));
  }

  return { result, untriaged, errors };
}

// ────────────────────────────────────────────────────────────────────────────
// Main per-repo pipeline
// ────────────────────────────────────────────────────────────────────────────

function processRepo(repoDef, projectsRoot, ghState) {
  const repoDir = path.isAbsolute(repoDef.path)
    ? repoDef.path
    : path.join(projectsRoot, repoDef.path);

  const entry = {
    local: null,
    github_api: null,
    gaps: {
      stale_todos: [],
      missing_docs: [],
      stale_open_prs: [],
      untriaged_issues: [],
    },
    errors: [],
  };

  if (!fs.existsSync(repoDir)) {
    entry.errors.push(`repo path not found: ${repoDir}`);
    return entry;
  }
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    entry.errors.push(`not a git repo: ${repoDir}`);
    return entry;
  }

  // Local git
  const commits = collectLocalCommits(repoDir, repoDef._user_emails || []);
  entry.errors.push(...commits.errors);
  entry.local = {
    recent_commits: commits.recent_commits,
    commits_last_24h: commits.commits_last_24h,
    commits_last_7d: commits.commits_last_7d,
    recent_commits_by_user: commits.recent_commits_by_user,
    commits_last_7d_by_user: commits.commits_last_7d_by_user,
  };

  // Gaps (local)
  const todos = collectStaleTodos(repoDir);
  entry.errors.push(...todos.errors);
  entry.gaps.stale_todos = todos.stale_todos;
  entry.gaps.missing_docs = checkMissingDocs(repoDir);

  // GitHub API
  if (repoDef.github && ghState.available) {
    const api = collectGithubApi(repoDef.github);
    entry.errors.push(...api.errors);
    entry.github_api = api.result;
    entry.gaps.untriaged_issues = api.untriaged;

    // Stale open PRs (>14d old)
    const cutoff = Date.now() - STALE_PR_DAYS * 86400 * 1000;
    entry.gaps.stale_open_prs = (api.result.open_prs || [])
      .filter((pr) => pr.created_at && new Date(pr.created_at).getTime() < cutoff)
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author,
        created_at: pr.created_at,
        age_days: Math.floor((Date.now() - new Date(pr.created_at).getTime()) / 86400000),
      }));
  } else if (repoDef.github && !ghState.available) {
    entry.github_api = null;
    entry.errors.push(`gh unavailable: ${ghState.reason}`);
  } else {
    entry.github_api = null; // no slug configured
  }

  return entry;
}

// ────────────────────────────────────────────────────────────────────────────
// Contributor rollup + teammates.md auto-discovery
// ────────────────────────────────────────────────────────────────────────────

function rollupContributors(repoEntries) {
  const map = new Map(); // key: `${name}|${email}`
  for (const entry of Object.values(repoEntries)) {
    const commits = entry?.local?.recent_commits || [];
    for (const c of commits) {
      const key = `${c.author_name}|${c.author_email}`;
      if (!map.has(key)) {
        map.set(key, {
          name: c.author_name,
          email: c.author_email,
          commits_7d: 0,
        });
      }
      map.get(key).commits_7d += 1;
    }
  }
  return [...map.values()].sort((a, b) => b.commits_7d - a.commits_7d);
}

function ensureTeammatesFile() {
  if (fs.existsSync(TEAMMATES_PATH)) return;
  const dir = path.dirname(TEAMMATES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(TEAMMATES_TEMPLATE)) {
    fs.copyFileSync(TEAMMATES_TEMPLATE, TEAMMATES_PATH);
  } else {
    fs.writeFileSync(TEAMMATES_PATH, '# Teammates\n\n', 'utf8');
  }
}

function augmentTeammates(contributors) {
  if (!contributors.length) return { appended: [] };
  ensureTeammatesFile();

  const existing = fs.readFileSync(TEAMMATES_PATH, 'utf8');
  const existingLower = existing.toLowerCase();

  const newOnes = contributors.filter((c) => {
    if (!c.name) return false;
    if (/\[bot\]|-bot$|\bbot\b/i.test(c.name)) return false;
    const nameMatch = existingLower.includes(c.name.toLowerCase());
    const emailMatch = c.email && existingLower.includes(c.email.toLowerCase());
    return !nameMatch && !emailMatch;
  });

  if (!newOnes.length) return { appended: [] };

  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  const hasAutoSection = /^#\s+Auto-discovered\b/m.test(existing);
  let body = existing;
  if (!hasAutoSection) {
    lines.push('', '# Auto-discovered', '');
    lines.push(`_First appended: ${today} by ingest_github.js_`, '');
  } else {
    lines.push('', `_Update: ${today}_`, '');
  }
  for (const c of newOnes) {
    lines.push(`### ${c.name} — ${c.email}`);
    lines.push(`- commits_7d: ${c.commits_7d}`);
    lines.push(`- first_seen: ${today}`);
    lines.push('');
  }
  body += lines.join('\n');
  if (!body.endsWith('\n')) body += '\n';
  fs.writeFileSync(TEAMMATES_PATH, body, 'utf8');
  return { appended: newOnes.map((c) => c.name) };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { date: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) {
      out.date = argv[i + 1];
      i++;
    }
  }
  return out;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const args = parseArgs(process.argv);
  const date = args.date || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Invalid --date: ${date} (expected YYYY-MM-DD)`);
    process.exit(2);
  }

  const cfg = loadConfig();
  const ghState = ghAvailable();
  const repos = {};

  const userHandle = (cfg.user_handle || '').toLowerCase();
  for (const repoDef of cfg.active_repos) {
    try {
      // Inject user emails so processRepo → collectLocalCommits can filter
      // commits to only the user's work (not whole-repo activity).
      repoDef._user_emails = cfg.user_emails || [];
      const entry = processRepo(repoDef, cfg.projects_root, ghState);
      // Per SKILL.md Quality Bar: surface ONLY items the user owns. PRs/issues
      // authored by teammates aren't the user's "Do" work — drop them at ingest
      // so no downstream source can leak them into the Do/Push lanes.
      if (entry && entry.gaps && userHandle) {
        if (Array.isArray(entry.gaps.stale_open_prs)) {
          entry.gaps.stale_open_prs = entry.gaps.stale_open_prs.filter(
            (pr) => pr && pr.author && String(pr.author).toLowerCase() === userHandle,
          );
        }
        if (Array.isArray(entry.gaps.untriaged_issues)) {
          entry.gaps.untriaged_issues = entry.gaps.untriaged_issues.filter(
            (iss) => iss && iss.author && String(iss.author).toLowerCase() === userHandle,
          );
        }
      }
      repos[repoDef.name] = entry;
      // Skip the legacy assignment below; we already set repos[name] above.
      continue;
    } catch (err) {
      repos[repoDef.name] = {
        local: null,
        github_api: null,
        gaps: { stale_todos: [], missing_docs: [], stale_open_prs: [], untriaged_issues: [] },
        errors: [`fatal: ${String(err.message || err)}`],
      };
    }
  }

  const contributors = rollupContributors(repos);

  let teammatesInfo = { appended: [] };
  try {
    teammatesInfo = augmentTeammates(contributors);
  } catch (err) {
    teammatesInfo = { appended: [], error: String(err.message || err) };
  }

  const payload = {
    date,
    generated_at: new Date().toISOString(),
    config_source: cfg._source,
    gh_available: ghState.available,
    gh_reason: ghState.reason,
    repos,
    contributors,
    teammates_appended: teammatesInfo.appended,
  };

  const outDir = path.join(SIGNALS_ROOT, date);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'github.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const repoCount = Object.keys(repos).length;
  const failed = Object.entries(repos).filter(([, v]) => (v.errors || []).length > 0).length;
  console.log(
    `[ingest_github] wrote ${outPath} | repos=${repoCount} (errors:${failed}) | contributors=${contributors.length} | gh=${ghState.available ? 'ok' : 'no'} | teammates_appended=${teammatesInfo.appended.length}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[ingest_github] fatal: ${(err && err.stack) || err}`);
  process.exit(1);
}
