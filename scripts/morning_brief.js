#!/usr/bin/env node
/**
 * pareto-focus: daily morning brief generator (cron-invoked).
 *
 * Pipeline:
 *   1. Refresh signals + rollups by shelling out to sibling scripts:
 *        aggregate_time.js
 *        ingest_github.js
 *        ingest_industry.js
 *        detect_opportunities.js         (optional - may not exist yet)
 *        score_and_rank.js --cadence today  (optional - may not exist yet)
 *      Missing scripts are logged to morning_brief.err and skipped.
 *
 *   2. Load state/priorities.md (if present) for the body.
 *
 *   3. Diff today's signals/YYYY-MM-DD/github.json against yesterday's and
 *      emit an "Overnight changes" section listing new merged PRs and new P0
 *      issues.
 *
 *   4. Render the final brief to data/briefs/YYYY-MM-DD.md using either the
 *      inline layout or templates/brief_morning.md when present.
 *
 * Exits 0 even on partial failures (cron should not retry on its own).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const HOME = os.homedir();
const SKILL_DIR = path.join(HOME, '.claude', 'skills', 'pareto-focus');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const TEMPLATES_DIR = path.join(SKILL_DIR, 'templates');
const DATA_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const STATE_DIR = path.join(DATA_ROOT, 'state');
const BRIEFS_DIR = path.join(DATA_DIR, 'briefs');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const ERR_LOG = path.join(DATA_DIR, 'morning_brief.err');

// Sequential steps run before and after the parallel ingest block.
// ingest_github and ingest_industry write to independent files with no
// interdependency, so they run in parallel to cut wall-clock time.
const PRE_PARALLEL = [
  { script: 'aggregate_time.js', args: [], required: true },
];
const PARALLEL = [
  { script: 'ingest_github.js', args: [], required: true },
  { script: 'ingest_industry.js', args: [], required: true },
];
const POST_PARALLEL = [
  { script: 'detect_opportunities.js', args: [], required: false },
  { script: 'score_and_rank.js', args: ['--cadence', 'today'], required: false },
];

function logErr(msg) {
  try {
    fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
    const line = `${new Date().toISOString()}\t${msg}\n`;
    fs.appendFileSync(ERR_LOG, line);
  } catch (_) {
    /* best-effort */
  }
}

function localDateISO(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}

function localTimeHM(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function runPipelineStep(step) {
  const full = path.join(SCRIPTS_DIR, step.script);
  if (!fs.existsSync(full)) {
    if (step.required) {
      logErr(`${step.script}: missing script at ${full}`);
    }
    return;
  }
  try {
    const res = spawnSync(process.execPath, [full, ...step.args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    if (res.error) {
      logErr(`${step.script}: ${res.error.message}`);
      return;
    }
    if (res.status !== 0) {
      logErr(
        `${step.script}: exit ${res.status} stderr=${String(res.stderr || '').trim().slice(0, 500)}`
      );
    }
  } catch (err) {
    logErr(`${step.script}: ${err.message}`);
  }
}

function runPipelineStepAsync(step) {
  const full = path.join(SCRIPTS_DIR, step.script);
  if (!fs.existsSync(full)) {
    if (step.required) {
      logErr(`${step.script}: missing script at ${full}`);
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [full, ...step.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* best-effort */ }
      logErr(`${step.script}: timeout after 120000ms`);
    }, 120000);
    child.on('error', (err) => {
      clearTimeout(timer);
      logErr(`${step.script}: ${err.message}`);
      resolve();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logErr(`${step.script}: exit ${code} stderr=${stderrBuf.trim().slice(0, 500)}`);
      }
      resolve();
    });
  });
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logErr(`safeReadJson ${filePath}: ${err.message}`);
    return null;
  }
}

function readPriorities() {
  const p = path.join(STATE_DIR, 'priorities.md');
  if (!fs.existsSync(p)) {
    return '_No priorities.md found. Run `/focus today` to generate one._';
  }
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (err) {
    logErr(`readPriorities: ${err.message}`);
    return '_priorities.md could not be read._';
  }
}

function collectIds(section) {
  const ids = new Set();
  if (!Array.isArray(section)) return ids;
  for (const item of section) {
    if (!item) continue;
    const id = item.id || item.number || item.url || item.title;
    if (id) ids.add(String(id));
  }
  return ids;
}

function diffGithubSignals(todayDate, yesterdayDate) {
  const todayFile = path.join(SIGNALS_DIR, todayDate, 'github.json');
  const yFile = path.join(SIGNALS_DIR, yesterdayDate, 'github.json');
  const today = safeReadJson(todayFile);
  const yesterday = safeReadJson(yFile);

  if (!today) {
    return '_No GitHub signals for today yet._';
  }

  const lines = [];
  const repos = today.repos || {};
  const yRepos = (yesterday && yesterday.repos) || {};

  for (const repoName of Object.keys(repos).sort()) {
    const cur = repos[repoName] || {};
    const prev = yRepos[repoName] || {};
    const curPrs = Array.isArray(cur.merged_prs) ? cur.merged_prs : [];
    const prevPrIds = collectIds(prev.merged_prs || []);
    const newPrs = curPrs.filter(
      (p) => !prevPrIds.has(String(p.id || p.number || p.url || p.title))
    );

    const curIssues = Array.isArray(cur.p0_issues) ? cur.p0_issues : [];
    const prevIssueIds = collectIds(prev.p0_issues || []);
    const newIssues = curIssues.filter(
      (i) => !prevIssueIds.has(String(i.id || i.number || i.url || i.title))
    );

    if (newPrs.length === 0 && newIssues.length === 0) continue;

    lines.push(`### ${repoName}`);
    if (newPrs.length) {
      lines.push('**New merged PRs**');
      for (const p of newPrs) {
        const tag = p.id || p.number || '';
        const title = p.title || '(untitled)';
        lines.push(`- ${tag} ${title}`.trim());
      }
    }
    if (newIssues.length) {
      lines.push('**New P0 issues**');
      for (const i of newIssues) {
        const tag = i.id || i.number || '';
        const title = i.title || '(untitled)';
        lines.push(`- ${tag} ${title}`.trim());
      }
    }
    lines.push('');
  }

  if (lines.length === 0) {
    return '_No new merged PRs or P0 issues since yesterday._';
  }
  return lines.join('\n').trim();
}

function renderBrief({ date, time, overnight, priorities }) {
  const tpl = path.join(TEMPLATES_DIR, 'brief_morning.md');
  if (fs.existsSync(tpl)) {
    try {
      const raw = fs.readFileSync(tpl, 'utf8');
      return raw
        .replace(/{{date}}/g, date)
        .replace(/{{time}}/g, time)
        .replace(/{{overnight_changes}}/g, overnight)
        .replace(/{{priorities_md_body}}/g, priorities)
        .trim() + '\n';
    } catch (err) {
      logErr(`renderBrief template: ${err.message}`);
    }
  }
  return [
    `# Pareto Focus — Morning Brief (${date})`,
    '',
    '## Overnight changes',
    '',
    overnight,
    '',
    "## Today's priorities",
    '',
    priorities,
    '',
    '---',
    `_Generated at ${time} local time_`,
    '',
  ].join('\n');
}

async function main() {
  try {
    fs.mkdirSync(BRIEFS_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
  } catch (err) {
    logErr(`mkdir: ${err.message}`);
  }

  for (const step of PRE_PARALLEL) {
    runPipelineStep(step);
  }
  await Promise.all(PARALLEL.map(runPipelineStepAsync));
  for (const step of POST_PARALLEL) {
    runPipelineStep(step);
  }

  const now = new Date();
  const today = localDateISO(now);
  const yesterday = localDateISO(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const time = localTimeHM(now);

  let overnight = '_unavailable_';
  try {
    overnight = diffGithubSignals(today, yesterday);
  } catch (err) {
    logErr(`diffGithubSignals: ${err.message}`);
  }

  const priorities = readPriorities();
  const body = renderBrief({ date: today, time, overnight, priorities });

  const out = path.join(BRIEFS_DIR, `${today}.md`);
  try {
    fs.writeFileSync(out, body);
    process.stdout.write(`wrote ${out}\n`);
  } catch (err) {
    logErr(`writeBrief ${out}: ${err.message}`);
  }

  process.exit(0);
}

main().catch((err) => {
  logErr(`main: ${err && err.stack ? err.stack : err}`);
  process.exit(0);
});
