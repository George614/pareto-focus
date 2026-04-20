#!/usr/bin/env node
/**
 * pareto-focus: weekly review.
 *
 * CLI:
 *   node weekly_review.js [--week YYYY-WW]
 *
 * Defaults to the current ISO week. Produces
 *   data/briefs/week-YYYY-WW.md
 *
 * Steps:
 *   1. Shell out to aggregate_time.js --since <Monday> --out <temp>.
 *   2. Read 7 daily signals dirs (github.json + opportunities.json) if present.
 *   3. Read state/decisions.log entries from the week.
 *   4. Read state/goals.md (personal_goals / team_alignment / leadership_aspirations).
 *   5. Compute time-allocation %, keyword-match goal progress, drift,
 *      top-3 opportunities by lead_score.
 *   6. Write the markdown brief.
 *
 * Graceful degradation: any missing input is skipped with a note.
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
const AGGREGATE_SCRIPT = path.join(
  HOME,
  '.claude',
  'skills',
  'pareto-focus',
  'scripts',
  'aggregate_time.js'
);

const DRIFT_THRESHOLD = 0.1;

function parseArgs(argv) {
  const args = { week: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--week' && argv[i + 1]) {
      args.week = argv[++i];
    }
  }
  return args;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * ISO week number for a given Date (UTC).
 * Returns { year, week }.
 */
function isoWeek(d) {
  const date = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate()
  ));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
  return { year: date.getUTCFullYear(), week };
}

/**
 * Monday (UTC) of the given ISO week.
 */
function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // Mon=0
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

function parseWeekArg(s) {
  const m = /^(\d{4})-W?(\d{1,2})$/.exec(s);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function weekKey(y, w) {
  return `${y}-${pad2(w)}`;
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

function collectWeekDates(mondayDate) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setUTCDate(mondayDate.getUTCDate() + i);
    out.push(isoDate(d));
  }
  return out;
}

function collectGithubEvidence(weekDates) {
  const evidence = [];
  for (const date of weekDates) {
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

function collectOpportunities(weekDates) {
  const cands = [];
  for (const date of weekDates) {
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
  if (c.scoring_inputs && typeof c.scoring_inputs.lead_score === 'number') {
    return c.scoring_inputs.lead_score;
  }
  return 0;
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

function goalAdvanced(goalText, evidence, decisions) {
  const kws = extractKeywords(goalText);
  if (!kws.size) return { advanced: false, hits: [] };
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
      if (hits.length >= 3) break;
    }
  }
  if (hits.length < 3) {
    for (const d of decisions) {
      const blob = JSON.stringify(d);
      if (matchesAny(blob)) {
        hits.push(`decision ${d.date || ''}`.trim());
        if (hits.length >= 5) break;
      }
    }
  }
  return { advanced: hits.length > 0, hits };
}

function minutesToPct(total, grand) {
  if (!grand) return 0;
  return Math.round((total / grand) * 100);
}

function runAggregate(sinceStr) {
  const outPath = path.join(AGG_DIR, `weekly-${sinceStr}.json`);
  try {
    fs.mkdirSync(AGG_DIR, { recursive: true });
    execFileSync(
      'node',
      [AGGREGATE_SCRIPT, '--since', sinceStr, '--out', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (err) {
    process.stderr.write(
      `weekly_review: aggregate_time.js failed: ${err.message}\n`
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
  if (!entries.length) return ['- _no tracked activity this week_'];
  return entries.map(
    (e) =>
      `- ${e.name}: ${minutesToPct(e.minutes, total)}% (${e.minutes} min, ${e.sessions} sessions, ${e.days} days)`
  );
}

function renderGoalSection(heading, goals, evidence, decisions) {
  const lines = [`### ${heading}`];
  if (!goals.length) {
    lines.push('- _no goals recorded in state/goals.md_');
    return lines;
  }
  for (const g of goals) {
    const { advanced, hits } = goalAdvanced(g, evidence, decisions);
    if (advanced) {
      const hitStr = hits.length ? ` — ${hits.slice(0, 2).join('; ')}` : '';
      lines.push(`- ✅ advanced — "${g}"${hitStr}`);
    } else {
      lines.push(`- ⏳ no activity — "${g}"`);
    }
  }
  return lines;
}

function renderDrift(agg, aspirations) {
  const cov = (agg.drift_analysis_input || {}).coverage_pct_per_project || {};
  const entries = Object.entries(cov);
  const lines = [];
  if (!aspirations.length) {
    lines.push('- _no leadership_aspirations recorded_');
    return lines;
  }
  for (const asp of aspirations) {
    const kws = extractKeywords(asp);
    let bestPct = 0;
    let bestProj = null;
    for (const [proj, pct] of entries) {
      const projLow = proj.toLowerCase();
      for (const k of kws) {
        if (projLow.includes(k)) {
          if (pct > bestPct) {
            bestPct = pct;
            bestProj = proj;
          }
        }
      }
    }
    const pctInt = Math.round(bestPct * 100);
    if (bestPct < DRIFT_THRESHOLD) {
      const projNote = bestProj ? ` (best match: ${bestProj})` : '';
      lines.push(
        `- ⚠️ "${asp}" — ${pctInt}% time${projNote} (target >${Math.round(DRIFT_THRESHOLD * 100)}%)`
      );
    } else {
      lines.push(`- ✅ "${asp}" — ${pctInt}% coverage via ${bestProj}`);
    }
  }
  return lines;
}

function renderTopOpportunities(cands) {
  if (!cands.length) return ['- _no opportunities surfaced this week_'];
  const ranked = [...cands].sort((a, b) => leadScoreOf(b) - leadScoreOf(a));
  const top = ranked.slice(0, 3);
  const lines = [];
  top.forEach((c, idx) => {
    const score = leadScoreOf(c).toFixed(2);
    const id = c.id || `CANDIDATE-${idx + 1}`;
    const one = c.one_line || '(no one-liner)';
    lines.push(`${idx + 1}. ${id} — lead_score ${score} — ${one}`);
    const why = Array.isArray(c.why_gap) ? c.why_gap : [];
    if (why.length) lines.push(`   - why: ${why.slice(0, 2).join(' | ')}`);
    if (c.first_step) lines.push(`   - first step: ${c.first_step}`);
  });
  return lines;
}

function proposedFocus(driftLines, candidates) {
  const actions = [];
  const drifting = driftLines
    .filter((l) => l.startsWith('- [drift]'))
    .slice(0, 2);
  for (const d of drifting) {
    const m = d.match(/"([^"]+)"/);
    if (m) actions.push(`Rebalance time toward: ${m[1]}`);
  }
  if (candidates.length) {
    const top = [...candidates].sort(
      (a, b) => leadScoreOf(b) - leadScoreOf(a)
    )[0];
    if (top && top.one_line) {
      actions.push(`Advance opportunity: ${top.id || '(unnamed)'} — ${top.one_line}`);
    }
  }
  if (!actions.length) {
    actions.push('Hold current allocation; no drift detected.');
  }
  return actions.map((a, i) => `${i + 1}. ${a}`);
}

function main() {
  const args = parseArgs(process.argv);
  let target;
  if (args.week) {
    const parsed = parseWeekArg(args.week);
    if (!parsed) {
      process.stderr.write(`weekly_review: invalid --week "${args.week}"\n`);
      process.exit(2);
    }
    target = parsed;
  } else {
    target = isoWeek(new Date());
  }

  const monday = mondayOfIsoWeek(target.year, target.week);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const sinceStr = isoDate(monday);
  const untilStr = isoDate(sunday);
  const wk = weekKey(target.year, target.week);

  const agg = runAggregate(sinceStr);
  const weekDates = collectWeekDates(monday);
  const evidence = collectGithubEvidence(weekDates);
  const decisions = readDecisionsInRange(sinceStr, untilStr);
  const goals = parseGoalsMarkdown(readTextSafe(GOALS_PATH));
  const candidates = collectOpportunities(weekDates);

  const allocLines = renderTimeAllocation(agg);
  const personalLines = renderGoalSection(
    'personal_goals',
    goals.personal_goals,
    evidence,
    decisions
  );
  const teamLines = renderGoalSection(
    'team_alignment',
    goals.team_alignment,
    evidence,
    decisions
  );
  const driftLines = renderDrift(agg, goals.leadership_aspirations);
  const oppLines = renderTopOpportunities(candidates);
  const focusLines = proposedFocus(driftLines, candidates);

  const ts = new Date().toISOString();
  const md = [
    `# Pareto Focus — Weekly Review (${wk}, ${sinceStr} to ${untilStr})`,
    '',
    '## Time allocation',
    ...allocLines,
    '',
    '## Goal progress',
    ...personalLines,
    '',
    ...teamLines,
    '',
    '## Leadership aspirations — drift check',
    ...driftLines,
    '',
    '## Top opportunities this week',
    ...oppLines,
    '',
    '## Proposed focus for next week',
    ...focusLines,
    '',
    '---',
    `_Generated by weekly_review.js at ${ts}_`,
    '',
  ].join('\n');

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const outPath = path.join(BRIEFS_DIR, `week-${wk}.md`);
  fs.writeFileSync(outPath, md);
  process.stdout.write(`${outPath}\n`);
}

main();
