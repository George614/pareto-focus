#!/usr/bin/env node
/**
 * pareto-focus: monthly review.
 *
 * CLI:
 *   node monthly_review.js [--month YYYY-MM]
 *
 * Defaults to the current month (UTC). Produces
 *   data/briefs/month-YYYY-MM.md
 *
 * Steps:
 *   1. Shell out to aggregate_time.js --since YYYY-MM-01 to get the
 *      month-to-date aggregate.
 *   2. Roll up existing weekly briefs overlapping the month from
 *      data/briefs/week-*.md. If none, fall back to raw signal scan.
 *   3. Build goal completion scorecard from state/goals.md + evidence
 *      (github PRs/commits across the month + decisions.log).
 *      Status bucket: done | advanced | stalled | not_started.
 *   4. Choose one RFC-grade proposal: highest lead_score from the
 *      month whose proposals.md status is draft or reviewed
 *      (if not yet present in proposals.md, treat as draft).
 *   5. Write the markdown brief.
 *
 * Pure Node stdlib. Graceful degradation on missing inputs.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DATA_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const STATE_DIR = path.join(DATA_ROOT, 'state');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const BRIEFS_DIR = path.join(DATA_DIR, 'briefs');
const AGG_DIR = path.join(DATA_DIR, 'aggregates');
const GOALS_PATH = path.join(STATE_DIR, 'goals.md');
const DECISIONS_PATH = path.join(STATE_DIR, 'decisions.log');
const PROPOSALS_PATH = path.join(STATE_DIR, 'proposals.md');
const AGGREGATE_SCRIPT = path.join(
  HOME,
  '.claude',
  'skills',
  'pareto-focus',
  'scripts',
  'aggregate_time.js'
);

const STALLED_EVIDENCE_MIN = 1;
const ADVANCED_EVIDENCE_MIN = 2;

function parseArgs(argv) {
  const args = { month: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month' && argv[i + 1]) {
      args.month = argv[++i];
    }
  }
  return args;
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function parseMonthArg(s) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function currentMonthUTC() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function monthDates(year, month) {
  const out = [];
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    out.push(isoDate(d));
  }
  return { dates: out, firstIso: isoDate(first) };
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

function runAggregate(sinceStr, monthKey) {
  const outPath = path.join(AGG_DIR, `monthly-${monthKey}.json`);
  try {
    fs.mkdirSync(AGG_DIR, { recursive: true });
    execFileSync(
      'node',
      [AGGREGATE_SCRIPT, '--since', sinceStr, '--out', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (err) {
    process.stderr.write(
      `monthly_review: aggregate_time.js failed: ${err.message}\n`
    );
  }
  return (
    readJsonSafe(outPath) || {
      projects: {},
      daily_totals: {},
      drift_analysis_input: {
        top_project_pct: 0,
        coverage_pct_per_project: {},
      },
    }
  );
}

function readDecisionsInRange(startIso, endIso) {
  const text = readTextSafe(DECISIONS_PATH);
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const obj = JSON.parse(line);
      const d = obj.date || (obj.session_end || '').slice(0, 10);
      if (d && d >= startIso && d <= endIso) out.push(obj);
    } catch (_) {
      /* skip */
    }
  }
  return out;
}

function parseGoalsMarkdown(md) {
  const sections = {
    personal_goals: [],
    team_alignment: [],
    leadership_aspirations: [],
  };
  if (!md) return sections;
  const lines = md.split(/\r?\n/);
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^##\s+([a-zA-Z_]+)\s*$/);
    if (h) {
      const key = h[1].toLowerCase();
      current = key in sections ? key : null;
      continue;
    }
    if (!current) continue;
    const b = line.match(/^-\s*(?:\[[ xX]\]\s*)?(.+)$/);
    if (b) {
      const text = b[1].trim();
      if (!text) continue;
      if (text.startsWith('(replace with yours)')) continue;
      if (/^Example:/i.test(text)) continue;
      sections[current].push(text);
    }
  }
  return sections;
}

function collectGithubEvidence(monthIsoDates) {
  const evidence = [];
  for (const date of monthIsoDates) {
    const gh = readJsonSafe(path.join(SIGNALS_DIR, date, 'github.json'));
    if (!gh || !gh.repos) continue;
    for (const [, repoData] of Object.entries(gh.repos)) {
      if (!repoData) continue;
      const local = repoData.local || {};
      for (const c of local.recent_commits || []) {
        if (c && c.subject) {
          evidence.push({ kind: 'commit', text: c.subject, date });
        }
      }
      const api = repoData.github_api;
      if (api && Array.isArray(api.merged_prs)) {
        for (const pr of api.merged_prs) {
          if (pr && pr.title) {
            evidence.push({
              kind: 'pr',
              text: pr.title,
              number: pr.number,
              date,
            });
          }
        }
      }
    }
  }
  return evidence;
}

function collectOpportunities(monthIsoDates) {
  const cands = [];
  for (const date of monthIsoDates) {
    const opp = readJsonSafe(
      path.join(SIGNALS_DIR, date, 'opportunities.json')
    );
    if (!opp || !Array.isArray(opp.candidates)) continue;
    for (const c of opp.candidates) {
      cands.push({ ...c, signal_date: date });
    }
  }
  return cands;
}

function leadScoreOf(c) {
  if (typeof c.lead_score === 'number') return c.lead_score;
  const s = c.scoring_inputs;
  if (!s) return 0;
  if (typeof s.lead_score === 'number') return s.lead_score;
  // Compute quickly from scoring_inputs fields.
  const visibility = Number(s.visibility || 0);
  const novelty = Number(s.novelty || 0);
  const teamFit = Number(s.team_fit || 0);
  const aspiration = Number(s.aspiration_match || 0);
  const feasibility = Number(s.feasibility || 0);
  const raw = (visibility + novelty + teamFit + aspiration) * feasibility;
  return Number(raw.toFixed(3));
}

const STOPWORDS = new Set([
  'this','that','with','from','your','have','will','been','into','about',
  'when','what','which','they','them','their','there','here','more','most',
  'some','such','like','also','over','under','than','then','very','just',
  'through','every','each','first','second','third','next','last','only',
  'across','using','based','while','other','would','could','should',
  'make','made','take','taken','ship','publish','publishes','goals','goal',
  'team','teams','quarter','post','blog','paper','example','measurable',
]);

function extractKeywords(text) {
  return new Set(
    (String(text).toLowerCase().match(/[a-z0-9][a-z0-9\-_.]{3,}/g) || [])
      .filter((w) => !STOPWORDS.has(w))
  );
}

function goalEvidenceCount(goalText, evidence, decisions) {
  const kws = extractKeywords(goalText);
  if (!kws.size) return { count: 0, hits: [] };
  const hits = [];
  const matchesAny = (s) => {
    const low = String(s).toLowerCase();
    for (const k of kws) if (low.includes(k)) return true;
    return false;
  };
  for (const ev of evidence) {
    if (matchesAny(ev.text)) {
      const label =
        ev.kind === 'pr'
          ? `PR "${ev.text}"${ev.number ? ` (#${ev.number})` : ''}`
          : `commit "${ev.text}"`;
      hits.push(label);
    }
  }
  for (const d of decisions) {
    const blob = JSON.stringify(d);
    if (matchesAny(blob)) {
      hits.push(`decision ${d.date || ''}`.trim());
    }
  }
  return { count: hits.length, hits };
}

function goalStatus(goalText, evidence, decisions) {
  const lower = String(goalText).toLowerCase();
  const { count, hits } = goalEvidenceCount(goalText, evidence, decisions);
  // Explicit [x] marker in goals.md already stripped by parse; infer via
  // keyword cues in the goal text itself.
  const doneCue = /\bshipped\b|\bdone\b|\breleased\b|\bmerged\b/.test(lower);
  if (doneCue && count >= STALLED_EVIDENCE_MIN) {
    return { status: 'done', hits };
  }
  if (count >= ADVANCED_EVIDENCE_MIN) return { status: 'advanced', hits };
  if (count >= STALLED_EVIDENCE_MIN) return { status: 'stalled', hits };
  return { status: 'not_started', hits };
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderScorecard(goals, evidence, decisions) {
  const rows = [];
  for (const section of ['personal_goals', 'team_alignment']) {
    for (const g of goals[section] || []) {
      const { status, hits } = goalStatus(g, evidence, decisions);
      const evStr = hits.length
        ? hits.slice(0, 2).join('; ')
        : '_no activity detected_';
      rows.push(`| ${escapeCell(g)} | ${status} | ${escapeCell(evStr)} |`);
    }
  }
  if (!rows.length) {
    rows.push('| _no goals recorded in state/goals.md_ | — | — |');
  }
  return [
    '| Goal | Status | Evidence |',
    '|---|---|---|',
    ...rows,
  ];
}

function parseWeeklyBriefs(monthKey) {
  // monthKey: YYYY-MM
  try {
    if (!fs.existsSync(BRIEFS_DIR)) return [];
  } catch (_) {
    return [];
  }
  const wanted = [];
  const files = fs.readdirSync(BRIEFS_DIR);
  for (const f of files) {
    const m = /^week-(\d{4})-(\d{2})\.md$/.exec(f);
    if (!m) continue;
    // Heuristic: include the weekly brief if any day in that ISO week
    // intersects the target month. We keep it simple and include weeks
    // whose YYYY is the same year as monthKey; we further filter by
    // reading the date range from inside the brief header.
    const text = readTextSafe(path.join(BRIEFS_DIR, f)) || '';
    const header = text.split(/\r?\n/)[0] || '';
    const range = header.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|→)\s*(\d{4}-\d{2}-\d{2})/);
    if (!range) continue;
    const [, startIso, endIso] = range;
    if (startIso.slice(0, 7) === monthKey || endIso.slice(0, 7) === monthKey) {
      wanted.push({ file: f, text, startIso, endIso });
    }
  }
  wanted.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return wanted;
}

function renderWeeklyRollup(weeks) {
  if (!weeks.length) {
    return ['- _no weekly briefs found; scorecard built from raw signals_'];
  }
  const lines = [];
  for (const w of weeks) {
    lines.push(`- ${w.file.replace(/\.md$/, '')} (${w.startIso} to ${w.endIso})`);
  }
  return lines;
}

function minutesToPct(total, grand) {
  if (!grand) return 0;
  return Math.round((total / grand) * 100);
}

function renderTimeAllocation(agg) {
  const projects = agg.projects || {};
  const entries = Object.entries(projects)
    .map(([name, v]) => ({
      name,
      minutes: v.total_minutes || 0,
      sessions: v.sessions || 0,
      days: v.days_active || 0,
    }))
    .sort((a, b) => b.minutes - a.minutes);
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  if (!entries.length) return ['- _no tracked activity this month_'];
  return entries.map(
    (e) =>
      `- ${e.name}: ${minutesToPct(e.minutes, total)}% (${e.minutes} min, ${e.sessions} sessions, ${e.days} days)`
  );
}

function readProposalsStatusMap() {
  const text = readTextSafe(PROPOSALS_PATH);
  if (!text) return new Map();
  const out = new Map();
  const re = /^###\s+(PROP-\d{8}-\d+)\b[\s\S]*?(?=^###\s+PROP-|\Z)/gm;
  // Simpler walk: find each "### PROP-... " header and look for "- status: X".
  const lines = text.split(/\r?\n/);
  let currentId = null;
  for (const line of lines) {
    const h = line.match(/^###\s+(PROP-\d{8}-\d+)\b/);
    if (h) {
      currentId = h[1];
      out.set(currentId, 'draft');
      continue;
    }
    if (currentId) {
      const s = line.match(/^-\s*status:\s*([a-zA-Z_]+)/i);
      if (s) out.set(currentId, s[1].toLowerCase());
    }
  }
  void re;
  return out;
}

function pickRfcProposal(candidates, proposalsStatus) {
  const eligible = candidates.filter((c) => {
    const st = proposalsStatus.get(c.id) || 'draft';
    return st === 'draft' || st === 'reviewed';
  });
  if (!eligible.length) return null;
  const ranked = [...eligible].sort((a, b) => leadScoreOf(b) - leadScoreOf(a));
  return ranked[0];
}

function renderRfc(cand) {
  if (!cand) {
    return ['- _no draft/reviewed opportunities available this month_'];
  }
  const id = cand.id || 'PROP-UNKNOWN';
  const score = leadScoreOf(cand).toFixed(2);
  const one = cand.one_line || '(no one-liner)';
  const why = Array.isArray(cand.why_gap) ? cand.why_gap.slice(0, 3) : [];
  const coll =
    Array.isArray(cand.collaborator_candidates) && cand.collaborator_candidates[0]
      ? cand.collaborator_candidates[0]
      : null;
  const collStr = coll
    ? `${coll.name || '(name)'} ${coll.handle ? `(${coll.handle})` : ''}`.trim()
    : '(open — pick from state/teammates.md)';
  const firstStep = cand.first_step || '(define first concrete step)';
  const lines = [
    `- ${id} — ${one}`,
    `- lead_score: ${score}`,
    `- Why: ${why.length ? why.join(' | ') : 'see signals above'}`,
    '- Proposed draft structure: Problem / Context / Proposal / Plan / Collaborator',
    `- First-week action: ${firstStep}`,
    `- Suggested collaborator: ${collStr}`,
  ];
  return lines;
}

function renderLeadershipTrajectory(agg, aspirations) {
  const cov = (agg.drift_analysis_input || {}).coverage_pct_per_project || {};
  const entries = Object.entries(cov);
  if (!aspirations.length) {
    return ['- _no leadership_aspirations recorded in state/goals.md_'];
  }
  const lines = [];
  for (const asp of aspirations) {
    const kws = extractKeywords(asp);
    let bestPct = 0;
    let bestProj = null;
    for (const [proj, pct] of entries) {
      const projLow = proj.toLowerCase();
      for (const k of kws) {
        if (projLow.includes(k) && pct > bestPct) {
          bestPct = pct;
          bestProj = proj;
        }
      }
    }
    const pctInt = Math.round(bestPct * 100);
    const projNote = bestProj ? ` via ${bestProj}` : '';
    const marker = bestPct < 0.1 ? '⚠️' : '✅';
    lines.push(`- ${marker} "${asp}" — ${pctInt}% time${projNote}`);
  }
  return lines;
}

function renderNextMonthFocus(aspirations, candidates) {
  const actions = [];
  for (const asp of aspirations.slice(0, 2)) {
    actions.push(`Double down on: ${asp}`);
  }
  const topCand = [...candidates].sort(
    (a, b) => leadScoreOf(b) - leadScoreOf(a)
  )[0];
  if (topCand && topCand.one_line) {
    actions.push(
      `Advance the RFC: ${topCand.id || '(unnamed)'} — ${topCand.one_line}`
    );
  }
  if (!actions.length) {
    actions.push('Hold current allocation; review in 30 days.');
  }
  return actions.map((a, i) => `${i + 1}. ${a}`);
}

function main() {
  const args = parseArgs(process.argv);
  let target;
  if (args.month) {
    const parsed = parseMonthArg(args.month);
    if (!parsed) {
      process.stderr.write(`monthly_review: invalid --month "${args.month}"\n`);
      process.exit(2);
    }
    target = parsed;
  } else {
    target = currentMonthUTC();
  }

  const monthKey = `${target.year}-${pad2(target.month)}`;
  const { dates, firstIso } = monthDates(target.year, target.month);
  const lastIso = dates[dates.length - 1];

  const agg = runAggregate(firstIso, monthKey);
  const goals = parseGoalsMarkdown(readTextSafe(GOALS_PATH));
  const evidence = collectGithubEvidence(dates);
  const decisions = readDecisionsInRange(firstIso, lastIso);
  const candidates = collectOpportunities(dates);
  const weeks = parseWeeklyBriefs(monthKey);
  const proposalsStatus = readProposalsStatusMap();
  const rfc = pickRfcProposal(candidates, proposalsStatus);

  const allocLines = renderTimeAllocation(agg);
  const rollupLines = renderWeeklyRollup(weeks);
  const scorecardLines = renderScorecard(goals, evidence, decisions);
  const trajectoryLines = renderLeadershipTrajectory(
    agg,
    goals.leadership_aspirations
  );
  const rfcLines = renderRfc(rfc);
  const nextFocusLines = renderNextMonthFocus(
    goals.leadership_aspirations,
    candidates
  );

  const ts = new Date().toISOString();
  const md = [
    `# Pareto Focus — Monthly Review (${monthKey})`,
    '',
    `_Window: ${firstIso} to ${lastIso}_`,
    '',
    '## Time allocation (month)',
    ...allocLines,
    '',
    '## Weekly rollups covered',
    ...rollupLines,
    '',
    '## Goal completion scorecard',
    ...scorecardLines,
    '',
    '## Leadership trajectory',
    ...trajectoryLines,
    '',
    '## The RFC to draft next month',
    ...rfcLines,
    '',
    '## Recommended next-month focus areas',
    ...nextFocusLines,
    '',
    '---',
    `_Generated by monthly_review.js at ${ts}_`,
    '',
  ].join('\n');

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const outPath = path.join(BRIEFS_DIR, `month-${monthKey}.md`);
  fs.writeFileSync(outPath, md);
  process.stdout.write(`${outPath}\n`);
}

main();
