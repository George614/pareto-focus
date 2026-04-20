#!/usr/bin/env node
/**
 * pareto-focus: aggregate time_log.jsonl into per-project session rollups.
 *
 * CLI:
 *   node aggregate_time.js [--since YYYY-MM-DD] [--out <path>]
 *
 * - Default --since = 7 days ago (UTC).
 * - Sessions are detected per-project using session_gap_minutes from config.yaml
 *   (default 15). Each tool event is a 2-min anchor; session duration = max(2,
 *   last_ts - first_ts).
 * - Enriches each project with commit counts via `git log --author=<email>
 *   --since=<date> --format=%H%x09%s --all`. Silent skip if git / email absent.
 * - Prints JSON to stdout and also writes to data/aggregates/YYYY-MM-DD.json
 *   (today) when --out is given or by default when log exists.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DATA_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const LOG_PATH = path.join(DATA_DIR, 'time_log.jsonl');
const CONFIG_PATH = path.join(DATA_ROOT, 'config.yaml');
const AGG_DIR = path.join(DATA_DIR, 'aggregates');
// Default; overridden by `projects_root` in config.yaml if set.
const PROJECTS_ROOT = path.join(HOME, 'Projects');

const DEFAULT_SESSION_GAP_MIN = 15;
const ANCHOR_MIN = 2;
const DEFAULT_WINDOW_DAYS = 7;

function parseArgs(argv) {
  const args = { since: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' && argv[i + 1]) {
      args.since = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    }
  }
  return args;
}

function isoDate(d) {
  // YYYY-MM-DD from a Date in UTC
  return d.toISOString().slice(0, 10);
}

function parseSinceDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function readConfigSessionGap() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_SESSION_GAP_MIN;
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    const lines = text.split(/\r?\n/);
    let inTimeTracking = false;
    for (const raw of lines) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const indent = raw.length - raw.replace(/^\s*/, '').length;
      const line = raw.trim();
      if (indent === 0) {
        inTimeTracking = /^time_tracking\s*:/.test(line);
        continue;
      }
      if (!inTimeTracking) continue;
      const m = line.match(/^session_gap_minutes\s*:\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
  } catch (_) {
    /* fall through */
  }
  return DEFAULT_SESSION_GAP_MIN;
}

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const text = fs.readFileSync(LOG_PATH, 'utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.ts && obj.project) {
        const t = new Date(obj.ts);
        if (!isNaN(t.getTime())) {
          out.push({
            ts: t,
            project: String(obj.project),
            cwd: obj.cwd || '',
            tool: obj.tool || '',
          });
        }
      }
    } catch (_) {
      /* skip malformed line */
    }
  }
  return out;
}

function getGitEmail() {
  try {
    return execFileSync('git', ['config', '--global', 'user.email'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

function getCommitCount(projectPath, email, sinceStr) {
  try {
    if (!fs.existsSync(path.join(projectPath, '.git'))) return 0;
    const out = execFileSync(
      'git',
      [
        '-C',
        projectPath,
        'log',
        `--author=${email}`,
        `--since=${sinceStr}`,
        '--format=%H%x09%s',
        '--all',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Given sorted-by-ts events for a single project, produce sessions.
 * Each session: { start, end, events }.
 */
function buildSessions(events, gapMinutes) {
  const gapMs = gapMinutes * 60 * 1000;
  const sessions = [];
  let current = null;
  for (const ev of events) {
    if (!current) {
      current = { start: ev.ts, end: ev.ts, events: 1 };
      continue;
    }
    if (ev.ts.getTime() - current.end.getTime() > gapMs) {
      sessions.push(current);
      current = { start: ev.ts, end: ev.ts, events: 1 };
    } else {
      current.end = ev.ts;
      current.events += 1;
    }
  }
  if (current) sessions.push(current);
  return sessions;
}

function sessionMinutes(session) {
  const diffMs = session.end.getTime() - session.start.getTime();
  const diffMin = diffMs / 60000;
  return Math.max(ANCHOR_MIN, Math.round(diffMin));
}

function aggregate(events, sinceDate, untilDate, gapMinutes) {
  const filtered = events.filter(
    (e) => e.ts >= sinceDate && e.ts <= untilDate
  );
  filtered.sort((a, b) => a.ts - b.ts);

  const byProject = new Map();
  for (const ev of filtered) {
    if (!byProject.has(ev.project)) byProject.set(ev.project, []);
    byProject.get(ev.project).push(ev);
  }

  const projects = {};
  const dailyTotals = {};

  for (const [project, evs] of byProject) {
    const sessions = buildSessions(evs, gapMinutes);
    let totalMin = 0;
    const daySet = new Set();
    let lastTs = null;

    for (const s of sessions) {
      const mins = sessionMinutes(s);
      totalMin += mins;
      // Attribute minutes to the day of session start (UTC).
      const dayKey = isoDate(s.start);
      daySet.add(dayKey);
      if (!dailyTotals[dayKey]) dailyTotals[dayKey] = {};
      dailyTotals[dayKey][project] =
        (dailyTotals[dayKey][project] || 0) + mins;
      if (!lastTs || s.end > lastTs) lastTs = s.end;
    }

    projects[project] = {
      total_minutes: totalMin,
      sessions: sessions.length,
      days_active: daySet.size,
      last_activity: lastTs
        ? lastTs.toISOString().replace(/\.\d{3}Z$/, 'Z')
        : null,
    };
  }

  // drift analysis
  const totals = Object.entries(projects).map(([p, v]) => [p, v.total_minutes]);
  const grandTotal = totals.reduce((s, [, m]) => s + m, 0);
  const coverage = {};
  let topPct = 0;
  for (const [p, m] of totals) {
    const pct = grandTotal > 0 ? m / grandTotal : 0;
    coverage[p] = Number(pct.toFixed(4));
    if (pct > topPct) topPct = pct;
  }

  return {
    projects,
    dailyTotals,
    drift: {
      top_project_pct: Number(topPct.toFixed(4)),
      coverage_pct_per_project: coverage,
    },
  };
}

function enrichWithCommits(projects, sinceStr) {
  const email = getGitEmail();
  if (!email) return; // silent skip
  for (const name of Object.keys(projects)) {
    const projectPath = path.join(PROJECTS_ROOT, name);
    const commits = getCommitCount(projectPath, email, sinceStr);
    projects[name].commits = commits;
  }
}

function writeAggregate(payload, outPath) {
  const target =
    outPath || path.join(AGG_DIR, `${isoDate(new Date())}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n');
  return target;
}

function main() {
  const args = parseArgs(process.argv);
  const now = new Date();

  let sinceDate = parseSinceDate(args.since);
  if (!sinceDate) {
    const past = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    sinceDate = new Date(
      Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), past.getUTCDate())
    );
  }
  const untilDate = now;
  const sinceStr = isoDate(sinceDate);
  const untilStr = isoDate(untilDate);

  const gap = readConfigSessionGap();
  const events = readLog();
  const { projects, dailyTotals, drift } = aggregate(
    events,
    sinceDate,
    untilDate,
    gap
  );

  enrichWithCommits(projects, sinceStr);

  const payload = {
    window: { since: sinceStr, until: untilStr },
    projects,
    daily_totals: dailyTotals,
    drift_analysis_input: drift,
  };

  const json = JSON.stringify(payload, null, 2);
  process.stdout.write(json + '\n');

  try {
    writeAggregate(payload, args.out);
  } catch (err) {
    process.stderr.write(
      `aggregate_time: failed to persist aggregate: ${err.message}\n`
    );
  }
}

main();
