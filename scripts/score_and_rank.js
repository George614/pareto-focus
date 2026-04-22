#!/usr/bin/env node
/**
 * pareto-focus: dual-scoring three-lane ranking engine.
 *
 * CLI:
 *   node score_and_rank.js [--cadence today|week|month] [--date YYYY-MM-DD]
 *
 * Reads (all optional — degrades gracefully):
 *   ~/.claude/projects/pareto-focus/state/weights.json
 *   ~/.claude/projects/pareto-focus/state/goals.md
 *   ~/.claude/projects/pareto-focus/state/expertise.md
 *   ~/.claude/projects/pareto-focus/state/teammates.md
 *   ~/.claude/projects/pareto-focus/data/aggregates/YYYY-MM-DD.json
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/github.json
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/papers.json
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/opportunities.json
 *
 * Writes:
 *   ~/.claude/projects/pareto-focus/state/priorities.md
 *   ~/.claude/projects/pareto-focus/state/priorities.json
 *
 * Scoring:
 *   exec_score = (strategic_fit·wSF × execution_leverage·wEL × urgency·wU × recency_decay)
 *                / (effort × effort_penalty)
 *   lead_score = (visibility·wV × novelty·wN × team_fit·wTF × aspiration_match·wAM) × feasibility
 *
 * Three lanes:
 *   Do      — open high-leverage github work, ranked by exec_score
 *   Push    — in-flight items whose keywords match a drifted aspiration,
 *             exec_score multiplied by 1 + drift_penalty.boost_per_pct_under·(threshold − actual)
 *   Propose — opportunities.json candidates ranked by lead_score
 *
 * Pure Node stdlib. Idempotent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ────────────────────────────────────────────────────────────────────────────
// Paths
// ────────────────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const PROJECT_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const AGG_DIR = path.join(DATA_DIR, 'aggregates');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');

const WEIGHTS_PATH = path.join(STATE_DIR, 'weights.json');
const GOALS_PATH = path.join(STATE_DIR, 'goals.md');
const EXPERTISE_PATH = path.join(STATE_DIR, 'expertise.md');
const TEAMMATES_PATH = path.join(STATE_DIR, 'teammates.md');
const OUT_MD = path.join(STATE_DIR, 'priorities.md');
const OUT_JSON = path.join(STATE_DIR, 'priorities.json');

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  exec: {
    strategic_fit: 0.30,
    execution_leverage: 0.25,
    urgency: 0.20,
    recency_decay_days: 14,
    effort_penalty: 1.0,
  },
  lead: {
    visibility: 0.25,
    novelty: 0.25,
    team_fit: 0.20,
    aspiration_match: 0.20,
    feasibility: 0.10,
  },
  drift_penalty: {
    threshold_pct: 10,
    boost_per_pct_under: 0.05,
  },
};

const TIER_SIZES = {
  today: { do: 3, push: 2, propose: 1 },
  week:  { do: 5, push: 3, propose: 2 },
  month: { do: 3, push: 2, propose: 1 },
};

// Stopwords for keyword extraction.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'of', 'the', 'to', 'in', 'on', 'for', 'by', 'be',
  'with', 'is', 'it', 'as', 'at', 'this', 'that', 'from', 'into', 'via',
  'vs', 'using', 'use', 'used', 'your', 'my', 'our', 'their', 'them', 'they',
  'example', 'eg', 'ie', 'etc', 'will', 'would', 'could', 'should',
  'have', 'has', 'had', 'been', 'being', 'are', 'was', 'were', 'am',
  'about', 'across', 'after', 'all', 'also', 'any', 'both', 'each',
  'more', 'most', 'other', 'some', 'such', 'than', 'then', 'too', 'very',
  'can', 'cannot', 'just', 'like', 'not', 'no', 'only', 'own', 'so',
  'replace', 'yours', 'measurable',
]);

const TEMPLATE_MARKER_RE = /\(replace with yours\)/i;

// Effort keyword hints.
const EFFORT_L_KEYWORDS = ['rfc', 'rewrite', 'redesign', 'architecture', 'arch', 'migration', 'refactor.*entire', 'overhaul', 'new.*system'];
const EFFORT_S_KEYWORDS = ['fix', 'bump', 'update.*version', 'typo', 'lint', 'nit', 'docs\\s*:\\s', 'readme', 'comment', 'log'];

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { cadence: 'today', date: todayISO() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cadence' && argv[i + 1]) {
      args.cadence = argv[++i].toLowerCase();
    } else if (a === '--date' && argv[i + 1]) {
      args.date = argv[++i];
    }
  }
  if (!['today', 'week', 'month'].includes(args.cadence)) {
    args.cadence = 'today';
  }
  return args;
}

function todayISO() {
  const d = new Date();
  return isoDate(d);
}

function isoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ────────────────────────────────────────────────────────────────────────────
// I/O helpers
// ────────────────────────────────────────────────────────────────────────────

function readJSONSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    process.stderr.write(`[score_and_rank] warn: could not read JSON ${p}: ${e.message}\n`);
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

// ────────────────────────────────────────────────────────────────────────────
// Keyword tokenization
// ────────────────────────────────────────────────────────────────────────────

function tokenize(str) {
  if (!str) return [];
  const lowered = String(str).toLowerCase();
  const rawTokens = lowered.split(/[^a-z0-9+.#-]+/).filter(Boolean);
  return rawTokens.filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function tokenSet(strs) {
  const s = new Set();
  for (const str of strs) {
    for (const t of tokenize(str)) s.add(t);
  }
  return s;
}

function jaccard(aSet, bSet) {
  if (!aSet || !bSet || aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function anyOverlap(aSet, bSet) {
  if (!aSet || !bSet) return false;
  for (const t of aSet) if (bSet.has(t)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown parsing (goals.md sections)
// ────────────────────────────────────────────────────────────────────────────

function extractBulletsUnderH2(mdText, sectionName) {
  if (!mdText) return [];
  const lines = mdText.split(/\r?\n/);
  const bullets = [];
  let inSection = false;
  const target = sectionName.toLowerCase();
  for (const raw of lines) {
    const line = raw.trim();
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      inSection = h2[1].trim().toLowerCase() === target;
      continue;
    }
    if (!inSection) continue;
    if (/^#{1,2}\s+/.test(line)) { inSection = false; continue; }
    const b = line.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (!b) continue;
    let content = b[1].trim();
    if (/^["']?example\s*:/i.test(content)) continue;
    if (TEMPLATE_MARKER_RE.test(content)) continue;
    content = content.replace(/^["']|["']$/g, '');
    if (content) bullets.push(content);
  }
  return bullets;
}

function parseGoals(mdText) {
  return {
    personal_goals: extractBulletsUnderH2(mdText, 'personal_goals'),
    team_alignment: extractBulletsUnderH2(mdText, 'team_alignment'),
    leadership_aspirations: extractBulletsUnderH2(mdText, 'leadership_aspirations'),
  };
}

function goalsIsTemplate(mdText) {
  if (!mdText) return true;
  // If every non-example bullet is stripped, treat as template.
  const g = parseGoals(mdText);
  const total = g.personal_goals.length + g.team_alignment.length + g.leadership_aspirations.length;
  if (total === 0) return true;
  return TEMPLATE_MARKER_RE.test(mdText);
}

// ────────────────────────────────────────────────────────────────────────────
// Scoring heuristics
// ────────────────────────────────────────────────────────────────────────────

function recencyDecay(ageDays, halfLifeDays) {
  if (!Number.isFinite(ageDays) || ageDays < 0) ageDays = 0;
  const h = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 14;
  // exp(-age / halfLife); at age=halfLife → e^-1 ≈ 0.368.
  return Math.exp(-ageDays / h);
}

function inferEffort(text, labels) {
  const blob = String(text || '').toLowerCase();
  const labelBlob = (labels || []).join(' ').toLowerCase();
  const combined = `${blob} ${labelBlob}`;
  for (const kw of EFFORT_L_KEYWORDS) {
    if (new RegExp(kw).test(combined)) return { effort: 1.0, label: 'L' };
  }
  for (const kw of EFFORT_S_KEYWORDS) {
    if (new RegExp(kw).test(combined)) return { effort: 0.3, label: 'S' };
  }
  // Length-based fallback.
  const len = blob.length;
  if (len > 140) return { effort: 1.0, label: 'L' };
  if (len < 50) return { effort: 0.3, label: 'S' };
  return { effort: 0.6, label: 'M' };
}

function inferUrgency(text, labels) {
  const blob = String(text || '').toLowerCase();
  const labelBlob = (labels || []).join(' ').toLowerCase();
  if (/p0\b/.test(labelBlob) || /\bp0\b/.test(blob)) return 0.9;
  if (/red\s*ci|ci\s*red|ci\s*fail|broken.*ci|ci.*broken/.test(blob)) return 0.8;
  if (/deadline|due\s+\w+|by\s+(mon|tue|wed|thu|fri|sat|sun|eod|tomorrow|today|\d)/.test(blob)) return 0.7;
  if (/\b(cto|vp|lead|manager|director)\s+(asked|wants|pinged|flagged|requested)/.test(blob)) return 0.6;
  return 0.3;
}

function inferExecutionLeverage(text, labels) {
  const labelBlob = (labels || []).join(' ').toLowerCase();
  const blob = String(text || '').toLowerCase();
  if (/blocker|blocking|depends-on|depends\son/.test(labelBlob) || /blocker|blocking/.test(blob)) return 0.8;
  if (/p0\b/.test(labelBlob) || /\bp0\b/.test(blob)) return 0.7;
  return 0.3;
}

function inferVisibility(text) {
  const blob = String(text || '').toLowerCase();
  if (/rfc|blog|paper|design.doc|design.note|whitepaper/.test(blob)) return 0.9;
  if (/pull.request|open\s*pr|\bpr\b|merged|\#\d+/.test(blob)) return 0.6;
  return 0.2;
}

// ────────────────────────────────────────────────────────────────────────────
// Item → Do lane (from github.json)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build Do candidates from github signals: stale open PRs, untriaged P0 issues,
 * stale TODOs in active repos, and recent commit subjects (as continuation
 * nudges only when no PR/issue items exist for that repo).
 */
function buildDoCandidates({ github, goalsKeywords, recencyHalfLife }) {
  const out = [];
  if (!github || !github.repos) return out;

  for (const [repoName, repoData] of Object.entries(github.repos)) {
    if (!repoData) continue;
    const gaps = repoData.gaps || {};
    const local = repoData.local || {};

    // Stale open PRs.
    for (const pr of gaps.stale_open_prs || []) {
      const title = pr.title || '(untitled PR)';
      const ageDays = Number(pr.age_days) || 0;
      const labels = Array.isArray(pr.labels) ? pr.labels : [];
      const text = `${title} ${Array.isArray(pr.body) ? pr.body.join(' ') : ''}`;
      const kws = tokenSet([title, repoName, ...labels]);
      const item = scoreExec({
        source: 'github_stale_pr',
        title: `[${repoName}] PR ${pr.number ? `#${pr.number}` : ''} ${title}`.trim(),
        repo: repoName,
        ageDays,
        text,
        labels,
        keywords: kws,
        goalsKeywords,
        recencyHalfLife,
        evidence: [
          `repo: ${repoName}`,
          pr.number ? `PR #${pr.number}` : 'PR',
          `age ${ageDays}d`,
          pr.url || '',
        ].filter(Boolean),
      });
      out.push(item);
    }

    // Untriaged / P0 issues.
    for (const iss of gaps.untriaged_issues || []) {
      const title = iss.title || '(untitled issue)';
      const ageDays = Number(iss.age_days) || 0;
      const labels = Array.isArray(iss.labels) ? iss.labels : [];
      const kws = tokenSet([title, repoName, ...labels]);
      out.push(scoreExec({
        source: 'github_untriaged_issue',
        title: `[${repoName}] Issue ${iss.number ? `#${iss.number}` : ''} ${title}`.trim(),
        repo: repoName,
        ageDays,
        text: title,
        labels,
        keywords: kws,
        goalsKeywords,
        recencyHalfLife,
        evidence: [
          `repo: ${repoName}`,
          iss.number ? `issue #${iss.number}` : 'issue',
          labels.length ? `labels: ${labels.join(', ')}` : 'untriaged',
          `age ${ageDays}d`,
        ].filter(Boolean),
      }));
    }

    // Stale TODOs intentionally NOT surfaced as Do/Push items.
    // Per SKILL.md Quality Bar: "Stale TODO cleanup (single-line resolutions).
    // They're noise." Single-line TODO janitorial work is chore-tier and
    // crowds out real in-flight execution work. Repo-level TODO debt is still
    // visible via the github_stale_todo gap data for ad-hoc inspection.

    // The "Ship in-flight work — N commits in last 7 days" continuation source
    // was removed. Per SKILL.md Quality Bar: whole-repo commit rollups conflate
    // teammates' work with the user's; "ship existing feature" is vague chore-tier
    // and not a deliverable. A Do item must reference a SPECIFIC PR/issue/branch
    // the user authored.
  }

  return out;
}

function scoreExec({
  source, title, repo, ageDays, text, labels, keywords,
  goalsKeywords, recencyHalfLife, evidence,
}) {
  const sf = Math.max(0.1, jaccard(keywords, goalsKeywords)) + 0.1; // floor
  const el = inferExecutionLeverage(text, labels);
  const urg = inferUrgency(text, labels);
  const decay = recencyDecay(ageDays, recencyHalfLife);
  const { effort, label: effortLabel } = inferEffort(text, labels);
  return {
    source,
    title,
    repo,
    text,
    keywords,
    effort: effortLabel,
    _components: {
      strategic_fit: Number(sf.toFixed(3)),
      execution_leverage: el,
      urgency: urg,
      recency_decay: Number(decay.toFixed(3)),
      effort_numeric: effort,
    },
    evidence,
  };
}

function finalizeExecScore(item, weights) {
  const c = item._components;
  const wE = weights.exec;
  const num = (c.strategic_fit * wE.strategic_fit)
    * (c.execution_leverage * wE.execution_leverage)
    * (c.urgency * wE.urgency)
    * c.recency_decay;
  const denom = Math.max(0.001, c.effort_numeric * (wE.effort_penalty || 1));
  // Multiply by 1000 so the raw exec_score has a humane range (still just
  // a number for ranking). Optional _score_multiplier lets individual sources
  // cap or boost their contribution (e.g., stale-TODOs are capped at 0.25x).
  const multiplier = item._score_multiplier ?? 1;
  const raw = (num / denom) * 1000 * multiplier;
  item.exec_score = Number(raw.toFixed(4));
  return item;
}

// ────────────────────────────────────────────────────────────────────────────
// Push lane — in-flight items × drifted aspirations
// ────────────────────────────────────────────────────────────────────────────

/**
 * For each leadership aspiration whose coverage_pct < threshold_pct, find
 * existing Do-lane candidates whose keywords overlap the aspiration. Multiply
 * their exec_score by (1 + boost_per_pct_under × (threshold − actual)).
 */
function buildPushCandidates({ doCandidates, aspirations, coveragePctByProject, driftPenalty }) {
  if (!aspirations || aspirations.length === 0) return { pushItems: [], drift: [] };
  const threshold = Number(driftPenalty.threshold_pct) || 10;
  const boost = Number(driftPenalty.boost_per_pct_under) || 0.05;

  // Build per-aspiration coverage: treat the aspiration's best-matching project
  // coverage as the relevant %.
  const drift = [];
  for (const asp of aspirations) {
    const aspKws = tokenSet([asp]);
    let bestPct = 0;
    let bestProj = null;
    for (const [proj, pct] of Object.entries(coveragePctByProject || {})) {
      const projLow = proj.toLowerCase();
      for (const k of aspKws) {
        if (projLow.includes(k)) {
          const pctNum = Number(pct) || 0;
          if (pctNum > bestPct) { bestPct = pctNum; bestProj = proj; }
        }
      }
    }
    drift.push({
      aspiration: asp,
      coverage_pct: bestPct,
      threshold_pct: threshold,
      best_project: bestProj,
      drifted: bestPct < threshold,
    });
  }

  const driftedAspirations = drift.filter((d) => d.drifted);
  if (driftedAspirations.length === 0) return { pushItems: [], drift };

  const pushItems = [];
  for (const d of driftedAspirations) {
    const aspKws = tokenSet([d.aspiration]);
    const factor = 1 + boost * Math.max(0, d.threshold_pct - d.coverage_pct);
    for (const cand of doCandidates) {
      const overlap = jaccard(cand.keywords, aspKws);
      if (overlap < 0.05) continue;
      const boosted = (cand.exec_score || 0) * factor;
      pushItems.push({
        ...cand,
        exec_score: Number(boosted.toFixed(4)),
        _push_boost: Number(factor.toFixed(3)),
        _push_aspiration: d.aspiration,
        _push_reason: `drifted aspiration (${d.coverage_pct}% < ${d.threshold_pct}%)`,
        evidence: [
          ...(cand.evidence || []),
          `aspiration: "${truncate(d.aspiration, 80)}"`,
          `time coverage: ${d.coverage_pct}% (threshold ${d.threshold_pct}%)`,
          `boost: ×${factor.toFixed(2)}`,
        ],
      });
    }
  }

  // Dedup by (title) keeping the highest boosted score.
  const bySig = new Map();
  for (const p of pushItems) {
    const key = p.title;
    const prev = bySig.get(key);
    if (!prev || p.exec_score > prev.exec_score) bySig.set(key, p);
  }
  return { pushItems: Array.from(bySig.values()), drift };
}

// ────────────────────────────────────────────────────────────────────────────
// Propose lane — opportunities.json × lead_score
// ────────────────────────────────────────────────────────────────────────────

function buildProposeCandidates({ opportunities, weights }) {
  if (!opportunities || !Array.isArray(opportunities.candidates)) return [];
  const wL = weights.lead;
  const out = [];
  for (const cand of opportunities.candidates) {
    const s = cand.scoring_inputs || {};
    const visibility = Number.isFinite(s.visibility) ? s.visibility : 0.5;
    const novelty = Number.isFinite(s.novelty) ? s.novelty : 0.5;
    const hasCollab = Array.isArray(cand.collaborator_candidates)
      && cand.collaborator_candidates.some((c) => c && c.name && !/^\s*<.*>\s*$/.test(c.name));
    const team_fit = hasCollab ? 0.8 : (Number.isFinite(s.team_fit) ? s.team_fit : 0.3);
    const aspiration_match = Number.isFinite(s.aspiration_match) ? s.aspiration_match : 0.3;
    const feasibility = Number.isFinite(s.feasibility) ? s.feasibility : 0.5;

    const raw =
      (visibility * wL.visibility)
      * (novelty * wL.novelty)
      * (team_fit * wL.team_fit)
      * (aspiration_match * wL.aspiration_match)
      * feasibility;
    // Scale up so the score has a humane range.
    const lead_score = Number((raw * 1000).toFixed(4));

    const whyGap = Array.isArray(cand.why_gap) ? cand.why_gap : [];
    const evidence = [
      ...whyGap,
      cand.first_step ? `first step: ${cand.first_step}` : null,
      cand.evidence && cand.evidence.paper_url ? cand.evidence.paper_url : null,
      cand.evidence && cand.evidence.repo ? `repo: ${cand.evidence.repo}` : null,
    ].filter(Boolean);

    out.push({
      id: cand.id,
      title: cand.one_line || '(no pitch)',
      lead_score,
      effort: 'M',
      _components: {
        visibility,
        novelty,
        team_fit,
        aspiration_match,
        feasibility,
      },
      source: cand.source || 'opportunity',
      evidence,
      collaborator: hasCollab
        ? cand.collaborator_candidates.filter((c) => c && c.name && !/^\s*<.*>\s*$/.test(c.name))[0]
        : null,
      first_step: cand.first_step || null,
    });
  }
  out.sort((a, b) => b.lead_score - a.lead_score);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

function truncate(s, n) {
  const str = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}

function uniqueByTitle(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.title;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function sanitizeForJson(item) {
  // Drop internal Sets / token caches before serializing.
  const { keywords, _components, _push_boost, _push_aspiration, _push_reason, text, ...rest } = item;
  return rest;
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ────────────────────────────────────────────────────────────────────────────

function renderMarkdown({
  cadence, date, generatedAt, lanes, drift, warnings, propositionMissing,
  aggregatesMissing, goalsTemplate,
}) {
  const lines = [];
  lines.push(`# Pareto Focus — ${cadence.charAt(0).toUpperCase() + cadence.slice(1)} (${date})`);
  lines.push('');

  if (goalsTemplate) {
    lines.push('⚠️ goals.md not filled in — scoring uses keyword heuristics only. Edit ~/.claude/projects/pareto-focus/state/goals.md.');
    lines.push('');
  }
  if (warnings && warnings.length) {
    for (const w of warnings) lines.push(`⚠️ ${w}`);
    lines.push('');
  }

  // Do lane.
  lines.push('## Do');
  if (!lanes.do.length) {
    lines.push('- _No Do-lane items surfaced. Check github signals freshness._');
  } else {
    lanes.do.forEach((it, i) => {
      lines.push(`${i + 1}. **${it.title}** — exec_score ${it.exec_score.toFixed(3)} · effort ${it.effort}`);
      for (const ev of (it.evidence || []).slice(0, 4)) lines.push(`   - ${ev}`);
    });
  }
  lines.push('');

  // Push lane.
  lines.push('## Push');
  if (aggregatesMissing) {
    lines.push('- _No time log yet — work for a session first._');
  } else if (!lanes.push.length) {
    lines.push('- _No drifted aspirations or no matching in-flight items._');
  } else {
    lanes.push.forEach((it, i) => {
      lines.push(`${i + 1}. **${it.title}** — exec_score ${it.exec_score.toFixed(3)} · effort ${it.effort}`);
      for (const ev of (it.evidence || []).slice(0, 5)) lines.push(`   - ${ev}`);
    });
  }
  lines.push('');

  // Propose lane.
  lines.push('## Propose');
  if (propositionMissing) {
    lines.push('- No opportunities detected yet. Run: `node detect_opportunities.js`');
  } else if (!lanes.propose.length) {
    lines.push('- _No Propose-lane items above threshold._');
  } else {
    lanes.propose.forEach((it, i) => {
      const idPart = it.id ? `${it.id} · ` : '';
      lines.push(`${i + 1}. ${idPart}**${it.title}** — lead_score ${it.lead_score.toFixed(3)}`);
      if (it.first_step) lines.push(`   - first step: ${it.first_step}`);
      if (it.collaborator) {
        const handle = it.collaborator.handle ? ` (${it.collaborator.handle})` : '';
        lines.push(`   - collaborator: ${it.collaborator.name}${handle}`);
      }
      for (const ev of (it.evidence || []).slice(0, 3)) lines.push(`   - ${ev}`);
    });
  }
  lines.push('');

  // Drift warnings.
  lines.push('## Drift warnings');
  if (!drift || drift.length === 0) {
    lines.push('- _No leadership_aspirations recorded — fill out goals.md to enable drift tracking._');
  } else {
    const drifted = drift.filter((d) => d.drifted);
    if (drifted.length === 0) {
      lines.push('- _All aspirations above threshold coverage._');
    } else {
      for (const d of drifted) {
        const proj = d.best_project ? ` (best match: ${d.best_project})` : '';
        lines.push(`- "${d.aspiration}" — ${d.coverage_pct}% time coverage${proj} (target >${d.threshold_pct}%)`);
      }
    }
  }
  lines.push('');

  lines.push('---');
  lines.push(`_Generated by score_and_rank.js at ${generatedAt}_`);
  lines.push('');
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  const { cadence, date } = args;
  const tiers = TIER_SIZES[cadence] || TIER_SIZES.today;

  // Load weights (merge with defaults).
  const weightsRaw = readJSONSafe(WEIGHTS_PATH) || {};
  const weights = {
    exec: { ...DEFAULT_WEIGHTS.exec, ...(weightsRaw.exec || {}) },
    lead: { ...DEFAULT_WEIGHTS.lead, ...(weightsRaw.lead || {}) },
    drift_penalty: { ...DEFAULT_WEIGHTS.drift_penalty, ...(weightsRaw.drift_penalty || {}) },
  };
  const recencyHalfLife = weights.exec.recency_decay_days;

  // Load goals / expertise / teammates.
  const goalsMd = readTextSafe(GOALS_PATH);
  const goalsTemplate = goalsIsTemplate(goalsMd);
  const goals = parseGoals(goalsMd);
  const expertiseMd = readTextSafe(EXPERTISE_PATH);

  // Keyword bag for strategic_fit.
  const goalsKeywords = tokenSet([
    ...goals.personal_goals,
    ...goals.team_alignment,
  ]);
  // Fallback to expertise keywords if goals are template.
  if (goalsKeywords.size === 0 && expertiseMd) {
    for (const t of tokenize(expertiseMd)) goalsKeywords.add(t);
  }

  // Load signals.
  const aggregates = readJSONSafe(path.join(AGG_DIR, `${date}.json`));
  const aggregatesMissing = !aggregates;
  const coveragePct = (aggregates
    && aggregates.drift_analysis_input
    && aggregates.drift_analysis_input.coverage_pct_per_project)
    || {};

  const signalDir = path.join(SIGNALS_DIR, date);
  const github = readJSONSafe(path.join(signalDir, 'github.json'));
  const opportunities = readJSONSafe(path.join(signalDir, 'opportunities.json'));
  const propositionMissing = !opportunities;

  // ── Do lane ────────────────────────────────────────────────────────────
  const doRaw = buildDoCandidates({ github, goalsKeywords, recencyHalfLife });
  for (const it of doRaw) finalizeExecScore(it, weights);
  doRaw.sort((a, b) => b.exec_score - a.exec_score);
  // Source-diversity: cap stale-TODO picks at ~half the tier so the lane
  // doesn't degenerate into a TODO list. Other sources fill remaining slots.
  const deduped = uniqueByTitle(doRaw);
  const maxTodos = Math.max(1, Math.floor(tiers.do / 2));
  const picked = [];
  let todosUsed = 0;
  for (const it of deduped) {
    if (picked.length >= tiers.do) break;
    if (it.source === 'github_stale_todo') {
      if (todosUsed >= maxTodos) continue;
      todosUsed += 1;
    }
    picked.push(it);
  }
  // Top-up if we ran out of non-TODOs and still have room.
  if (picked.length < tiers.do) {
    for (const it of deduped) {
      if (picked.length >= tiers.do) break;
      if (!picked.includes(it)) picked.push(it);
    }
  }
  const doLane = picked;

  // ── Push lane ──────────────────────────────────────────────────────────
  // Push draws from the full Do pool (not just the top N), then re-ranks.
  const { pushItems, drift } = buildPushCandidates({
    doCandidates: doRaw,
    aspirations: goals.leadership_aspirations,
    coveragePctByProject: coveragePct,
    driftPenalty: weights.drift_penalty,
  });
  // Remove push items that would duplicate a Do-lane title.
  const doTitles = new Set(doLane.map((d) => d.title));
  const pushFiltered = pushItems.filter((p) => !doTitles.has(p.title));
  pushFiltered.sort((a, b) => b.exec_score - a.exec_score);
  const pushLane = pushFiltered.slice(0, tiers.push);

  // ── Propose lane ───────────────────────────────────────────────────────
  const proposeRaw = buildProposeCandidates({ opportunities, weights });
  const proposeLane = proposeRaw.slice(0, tiers.propose);

  // ── Output ─────────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString();
  const warnings = [];
  if (!github) warnings.push('No github.json — run ingest_github.js to populate Do lane.');
  if (!aggregates) warnings.push('No aggregates/<date>.json — run aggregate_time.js to enable drift detection.');
  if (!opportunities) warnings.push('No opportunities.json — run detect_opportunities.js for the Propose lane.');

  const lanesJson = {
    do: doLane.map(sanitizeForJson).map((it) => ({
      title: it.title,
      score: it.exec_score,
      evidence: it.evidence || [],
      effort: it.effort,
      source: it.source,
      repo: it.repo || null,
    })),
    push: pushLane.map(sanitizeForJson).map((it) => ({
      title: it.title,
      score: it.exec_score,
      evidence: it.evidence || [],
      effort: it.effort,
      source: it.source,
      repo: it.repo || null,
    })),
    propose: proposeLane.map((it) => ({
      id: it.id || null,
      title: it.title,
      score: it.lead_score,
      evidence: it.evidence || [],
      effort: it.effort,
      source: it.source,
      collaborator: it.collaborator || null,
      first_step: it.first_step || null,
    })),
  };

  const jsonOut = {
    cadence,
    date,
    generated_at: generatedAt,
    lanes: lanesJson,
    drift: (drift || []).map((d) => ({
      aspiration: d.aspiration,
      coverage_pct: d.coverage_pct,
      threshold_pct: d.threshold_pct,
      best_project: d.best_project,
      drifted: d.drifted,
    })),
    warnings,
  };

  // Ensure state dir exists.
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const md = renderMarkdown({
    cadence,
    date,
    generatedAt,
    lanes: { do: doLane, push: pushLane, propose: proposeLane },
    drift,
    warnings,
    propositionMissing,
    aggregatesMissing,
    goalsTemplate,
  });

  fs.writeFileSync(OUT_MD, md, 'utf8');
  fs.writeFileSync(OUT_JSON, JSON.stringify(jsonOut, null, 2) + '\n', 'utf8');
  process.stdout.write(`[score_and_rank] wrote ${OUT_MD} + ${OUT_JSON} — do=${doLane.length} push=${pushLane.length} propose=${proposeLane.length}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[score_and_rank] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
}
