#!/usr/bin/env node
/**
 * pareto-focus: draft pitch.
 *
 * CLI:
 *   node draft_pitch.js <PROP-id>
 *
 *   e.g. node draft_pitch.js PROP-20260417-003
 *
 * Behavior:
 *   1. Parse the YYYYMMDD date embedded in the id.
 *   2. Find the candidate in data/signals/<date>/opportunities.json.
 *      If the exact day has no file, search the prior 30 days.
 *   3. Read state/proposals.md. If a section for <PROP-id> already
 *      exists, print it and exit 0 (idempotent).
 *   4. Otherwise append a new section + 1-pager scaffold, write
 *      proposals.md, and print the appended section.
 *
 * Pure Node stdlib. Graceful on missing inputs.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DATA_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const STATE_DIR = path.join(DATA_ROOT, 'state');
const SIGNALS_DIR = path.join(DATA_ROOT, 'data', 'signals');
const PROPOSALS_PATH = path.join(STATE_DIR, 'proposals.md');

const TEMPLATE_PROPOSALS_PATH = path.join(
  HOME,
  '.claude',
  'skills',
  'pareto-focus',
  'templates',
  'proposals.md'
);

const BACKSEARCH_DAYS = 30;
const PROP_ID_RE = /^PROP-(\d{4})(\d{2})(\d{2})-(\d+)$/;

function parseArgs(argv) {
  const id = argv[2];
  return { id: id ? String(id).trim() : null };
}

function parsePropId(id) {
  const m = PROP_ID_RE.exec(id);
  if (!m) return null;
  const [, y, mo, d] = m;
  return {
    isoDate: `${y}-${mo}-${d}`,
    year: Number(y),
    month: Number(mo),
    day: Number(d),
  };
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    process.stderr.write(`draft_pitch: bad json at ${p}: ${err.message}\n`);
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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function shiftDaysUTC(baseIso, deltaDays) {
  const [y, m, d] = baseIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return isoDate(dt);
}

function findCandidate(id, dayIso) {
  // Exact day first.
  const exact = readJsonSafe(path.join(SIGNALS_DIR, dayIso, 'opportunities.json'));
  if (exact && Array.isArray(exact.candidates)) {
    const hit = exact.candidates.find((c) => c.id === id);
    if (hit) return { candidate: hit, sourceDate: dayIso };
  }
  // Search backwards up to BACKSEARCH_DAYS.
  for (let i = 1; i <= BACKSEARCH_DAYS; i++) {
    const back = shiftDaysUTC(dayIso, -i);
    const doc = readJsonSafe(path.join(SIGNALS_DIR, back, 'opportunities.json'));
    if (!doc || !Array.isArray(doc.candidates)) continue;
    const hit = doc.candidates.find((c) => c.id === id);
    if (hit) return { candidate: hit, sourceDate: back };
  }
  return null;
}

function leadScoreOf(c) {
  if (typeof c.lead_score === 'number') return c.lead_score;
  const s = c.scoring_inputs;
  if (!s) return null;
  if (typeof s.lead_score === 'number') return s.lead_score;
  const visibility = Number(s.visibility || 0);
  const novelty = Number(s.novelty || 0);
  const teamFit = Number(s.team_fit || 0);
  const aspiration = Number(s.aspiration_match || 0);
  const feasibility = Number(s.feasibility || 0);
  const raw = (visibility + novelty + teamFit + aspiration) * feasibility;
  return Number(raw.toFixed(3));
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + '…';
}

function synthesizeProblem(whyGapLines) {
  if (!whyGapLines.length) return '(describe the current gap)';
  return whyGapLines.map((w) => `- ${w}`).join('\n');
}

function pickCollaborator(candidate) {
  const cc = Array.isArray(candidate.collaborator_candidates)
    ? candidate.collaborator_candidates
    : [];
  if (!cc.length) {
    return {
      display: '(open — pick from state/teammates.md)',
      strength: 'domain expertise',
    };
  }
  const top = cc[0] || {};
  const name = top.name || '(name)';
  const handle = top.handle || '';
  const strength =
    top.strength ||
    (Array.isArray(top.strengths) ? top.strengths[0] : '') ||
    'domain expertise';
  const display = handle ? `${name} (${handle})` : name;
  return { display, strength };
}

function timelineBucket(candidate) {
  const target = String(candidate.artifact_target || '').toLowerCase();
  if (target.includes('pr in')) return 'L=6wk';
  if (target.includes('rfc')) return 'M=3wk';
  return 'S=1wk';
}

function findExistingSection(md, id) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const startRe = new RegExp(`^###\\s+${id}\\b`);
  const nextRe = /^###\s+PROP-\d{8}-\d+\b/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (nextRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '\n');
}

function buildSection(candidate, sourceDate) {
  const id = candidate.id;
  const oneLine = String(candidate.one_line || '');
  const titleTruncated = truncate(oneLine, 80);
  const score = leadScoreOf(candidate);
  const scoreStr = score === null ? '(tbd)' : score.toFixed(2);
  const whyGap = Array.isArray(candidate.why_gap) ? candidate.why_gap : [];
  const firstStep = candidate.first_step || '(define first concrete step)';
  const artifactTarget = candidate.artifact_target || '(define artifact target)';
  const { display: collaborator, strength } = pickCollaborator(candidate);
  const timeline = timelineBucket(candidate);
  const problemBlock = synthesizeProblem(whyGap);
  const whyNowCites = whyGap.length
    ? whyGap.slice(0, 2).join(' | ')
    : 'industry + repo gap signals';

  const lines = [
    '',
    `### ${id} — ${titleTruncated}`,
    `- status: draft`,
    `- created: ${sourceDate}`,
    `- lead_score: ${scoreStr}`,
    `- one_line: ${oneLine || '(no one-liner)'}`,
    `- why_gap:`,
    ...(whyGap.length
      ? whyGap.map((w) => `  - ${w}`)
      : ['  - (no why_gap recorded)']),
    `- collaborator: ${collaborator}`,
    `- first_step: ${firstStep}`,
    `- artifact_target: ${artifactTarget}`,
    '',
    '#### 1-pager scaffold',
    problemBlock.includes('\n')
      ? `**Problem** —\n${problemBlock}`
      : `**Problem** — ${problemBlock}`,
    `**Proposal** — ${oneLine || '(describe proposal)'}`,
    `**Why now** — ${whyNowCites}`,
    '**Success criteria** —',
    '- [ ] (define measurable outcome 1)',
    '- [ ] (define measurable outcome 2)',
    '- [ ] (define measurable outcome 3)',
    `**Timeline** — ${timeline}`,
    `**Collaborator ask** — ${collaborator}, tap their ${strength}`,
    '**Risks** — (identify top 2 risks + mitigations)',
    '',
  ];
  return lines.join('\n');
}

function ensureProposalsFile() {
  if (fs.existsSync(PROPOSALS_PATH)) return;
  const template = readTextSafe(TEMPLATE_PROPOSALS_PATH);
  const seed = template
    ? template
    : [
        '# Proposals',
        '',
        '<!-- entries appended by draft_pitch.js -->',
        '',
      ].join('\n');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PROPOSALS_PATH, seed);
}

function main() {
  const { id } = parseArgs(process.argv);
  if (!id) {
    process.stderr.write('draft_pitch: missing <PROP-id>\n');
    process.stderr.write('usage: node draft_pitch.js PROP-YYYYMMDD-NNN\n');
    process.exit(2);
  }
  const parsed = parsePropId(id);
  if (!parsed) {
    process.stderr.write(`draft_pitch: invalid PROP id "${id}"\n`);
    process.exit(2);
  }

  ensureProposalsFile();

  // Idempotent short-circuit.
  const existingMd = readTextSafe(PROPOSALS_PATH) || '';
  const existingSection = findExistingSection(existingMd, id);
  if (existingSection) {
    process.stdout.write(existingSection);
    process.exit(0);
  }

  const found = findCandidate(id, parsed.isoDate);
  if (!found) {
    process.stderr.write(
      `draft_pitch: no candidate found for ${id} in signals within ${BACKSEARCH_DAYS}d of ${parsed.isoDate}\n`
    );
    process.exit(0); // graceful degradation
  }

  const section = buildSection(found.candidate, found.sourceDate);

  // Append (ensuring exactly one blank line separator).
  const prev = existingMd.replace(/\s+$/, '');
  const next = `${prev}\n${section}\n`;
  fs.writeFileSync(PROPOSALS_PATH, next);
  process.stdout.write(section);
}

main();
