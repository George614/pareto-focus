#!/usr/bin/env node
/**
 * detect_opportunities.js — opportunity detection synthesis for pareto-focus.
 *
 * CLI:
 *   node detect_opportunities.js [--date YYYY-MM-DD]
 *
 * Reads:
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/github.json
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/papers.json
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/x_linkedin.json  (optional)
 *   ~/.claude/projects/pareto-focus/config.yaml
 *   ~/.claude/projects/pareto-focus/state/expertise.md  (optional)
 *   ~/.claude/projects/pareto-focus/state/teammates.md  (optional)
 *   ~/.claude/projects/pareto-focus/state/goals.md      (optional)
 *
 * Writes:
 *   ~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/opportunities.json
 *
 * Synthesis:
 *   gap = industry_momentum ∩ team_capability_or_repo_gap ∩ user_expertise − already_being_done
 *
 * Sources:
 *   1. paper × repo intersection
 *   2. repo gap × expertise (missing_docs, stale_todos)
 *   3. stale issues/PRs × expertise
 *
 * Pure Node stdlib. Idempotent. Re-run overwrites same date file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const PROJECT_ROOT = path.join(HOME, '.claude/projects/pareto-focus');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.yaml');
const EXPERTISE_PATH = path.join(PROJECT_ROOT, 'state/expertise.md');
const TEAMMATES_PATH = path.join(PROJECT_ROOT, 'state/teammates.md');
const GOALS_PATH = path.join(PROJECT_ROOT, 'state/goals.md');
const SIGNALS_ROOT = path.join(PROJECT_ROOT, 'data/signals');

const JACCARD_MATCH_THRESHOLD = 0.2;
const MAX_COLLABORATORS = 2;
const TOP_STALE_TODOS_USED = 3;

// Stopwords trimmed when tokenizing keywords.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'of', 'the', 'to', 'in', 'on', 'for', 'by',
  'with', 'is', 'it', 'as', 'at', 'be', 'this', 'that', 'from', 'into',
  'via', 'vs', 'using', 'use', 'used', 'your', 'my', 'our', 'their',
  'example', 'eg', 'ie', 'etc',
]);

// ────────────────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { date: todayISO() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' && argv[i + 1]) {
      args.date = argv[i + 1];
      i++;
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

// ────────────────────────────────────────────────────────────────────────────
// I/O helpers
// ────────────────────────────────────────────────────────────────────────────

function readJSONSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[detect_opportunities] warn: could not read JSON ${p}: ${e.message}\n`);
    return null;
  }
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Minimal YAML subset parser for config.yaml's active_repos.
// Only extracts what we need: active_repos[].{name, topics[]}
function parseUserHandleFromYAML(yamlText) {
  if (!yamlText) return null;
  // Tiny YAML lookup: top-level `user:` block, then `github_handle: "..."`.
  const lines = yamlText.split(/\r?\n/);
  let inUser = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/^user:\s*$/.test(line)) { inUser = true; continue; }
    if (inUser) {
      if (/^\S/.test(line)) break; // left the block (next top-level key)
      const m = line.match(/^\s+github_handle:\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  }
  return null;
}

function parseActiveReposFromYAML(yamlText) {
  if (!yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  const repos = [];
  let inActiveRepos = false;
  let current = null;

  const pushCurrent = () => {
    if (current && current.name) repos.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, '').trimEnd();
    if (!stripped.trim()) continue;

    if (/^active_repos\s*:/.test(stripped)) {
      inActiveRepos = true;
      continue;
    }
    if (inActiveRepos) {
      // A new top-level key ends the active_repos block.
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(stripped) && !/^\s/.test(stripped)) {
        pushCurrent();
        inActiveRepos = false;
        continue;
      }
      const itemMatch = stripped.match(/^\s*-\s*name\s*:\s*(.+)\s*$/);
      if (itemMatch) {
        pushCurrent();
        current = { name: itemMatch[1].trim().replace(/^["']|["']$/g, ''), topics: [] };
        continue;
      }
      if (current) {
        const topicsInline = stripped.match(/^\s*topics\s*:\s*\[(.*)\]\s*$/);
        if (topicsInline) {
          current.topics = topicsInline[1]
            .split(',')
            .map((t) => t.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
          continue;
        }
        // Other per-repo scalar fields (path, github) ignored on purpose.
      }
    }
  }
  pushCurrent();
  return repos;
}

// ────────────────────────────────────────────────────────────────────────────
// Tokenization + keyword matching
// ────────────────────────────────────────────────────────────────────────────

function tokenize(str) {
  if (!str) return [];
  const lowered = String(str).toLowerCase();
  const rawTokens = lowered.split(/[^a-z0-9+.#-]+/).filter(Boolean);
  return rawTokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function tokenSet(strs) {
  const s = new Set();
  for (const str of strs) {
    for (const t of tokenize(str)) s.add(t);
  }
  return s;
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function anyTokenOverlap(aSet, bSet) {
  for (const t of aSet) if (bSet.has(t)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown section parsing (expertise.md, teammates.md, goals.md)
// ────────────────────────────────────────────────────────────────────────────

// Extract bullet items under a given `## section` heading, dropping lines that
// begin (case-insensitive) with "Example:" or parenthetical placeholders.
function extractBulletsUnderH2(mdText, sectionName) {
  if (!mdText) return [];
  const lines = mdText.split(/\r?\n/);
  const bullets = [];
  let inSection = false;
  const target = sectionName.toLowerCase();

  for (const raw of lines) {
    const line = raw.trim();
    const h2Match = line.match(/^##\s+(.+?)\s*$/);
    if (h2Match) {
      inSection = h2Match[1].trim().toLowerCase() === target;
      continue;
    }
    if (!inSection) continue;
    // Stop on next heading of same or higher level.
    if (/^#{1,2}\s+/.test(line)) {
      inSection = false;
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (!bulletMatch) continue;
    let content = bulletMatch[1].trim();
    // Strip leading quoted "Example:" style placeholders.
    if (/^["']?example\s*:/i.test(content)) continue;
    if (/^\(.*replace.*\)$/i.test(content)) continue;
    content = content.replace(/^["']|["']$/g, '');
    if (content) bullets.push(content);
  }
  return bullets;
}

function parseExpertise(mdText) {
  return {
    known_for: extractBulletsUnderH2(mdText, 'known_for'),
    emerging_strengths: extractBulletsUnderH2(mdText, 'emerging_strengths'),
    not_my_lane: extractBulletsUnderH2(mdText, 'not_my_lane'),
  };
}

function parseLeadershipAspirations(goalsMdText) {
  if (!goalsMdText) return [];
  const bullets = extractBulletsUnderH2(goalsMdText, 'leadership_aspirations');
  // Goals bullets typically include checkbox markers like "[ ]" / "[x]" — strip them.
  return bullets
    .map((b) => b.replace(/^\[[\sxX]\]\s*/, '').trim())
    .filter(Boolean);
}

// Parse teammates.md entries. Each entry looks like:
//   ### <Name> — <handle>
//   - strengths: a, b, c
//   - current_focus: ...
//   - complement: ...
//   - last_collab: ...
// We skip the "Example Person" template entry and the `# Auto-discovered`
// section (raw commit-author rows, not curated collaborators).
function parseTeammates(mdText) {
  if (!mdText) return [];
  const lines = mdText.split(/\r?\n/);
  const entries = [];
  let inAutoDiscovered = false;
  let current = null;

  const pushCurrent = () => {
    if (current && current.name && !/^example\b/i.test(current.name)) {
      entries.push(current);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^#\s+auto[- ]discovered/i.test(line)) {
      pushCurrent();
      inAutoDiscovered = true;
      continue;
    }
    if (/^#\s+/.test(line) && !/^#\s+auto[- ]discovered/i.test(line)) {
      pushCurrent();
      inAutoDiscovered = false;
      continue;
    }
    if (inAutoDiscovered) continue;

    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      pushCurrent();
      // Name may include a trailing " — handle" separator.
      const parts = h3[1].split(/\s+[—–-]\s+/);
      const name = parts[0].trim();
      const handle = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
      current = { name, handle, strengths: [], current_focus: '', complement: '' };
      continue;
    }
    if (!current) continue;
    const strengthsMatch = line.match(/^[-*]\s*strengths\s*:\s*(.+)$/i);
    if (strengthsMatch) {
      current.strengths = strengthsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    const focusMatch = line.match(/^[-*]\s*current_focus\s*:\s*(.+)$/i);
    if (focusMatch) {
      current.current_focus = focusMatch[1].trim();
      continue;
    }
    const complementMatch = line.match(/^[-*]\s*complement\s*:\s*(.+)$/i);
    if (complementMatch) {
      current.complement = complementMatch[1].trim();
      continue;
    }
  }
  pushCurrent();
  return entries;
}

// ────────────────────────────────────────────────────────────────────────────
// ID counter — persist seq per date by scanning existing opportunities.json
// ────────────────────────────────────────────────────────────────────────────

function findMaxSeqForDate(dateStr) {
  const compact = dateStr.replace(/-/g, '');
  const prefix = `PROP-${compact}-`;
  const dir = path.join(SIGNALS_ROOT, dateStr);
  const file = path.join(dir, 'opportunities.json');
  let maxSeq = 0;
  if (fs.existsSync(file)) {
    const data = readJSONSafe(file);
    if (data && Array.isArray(data.candidates)) {
      for (const c of data.candidates) {
        if (typeof c.id === 'string' && c.id.startsWith(prefix)) {
          const tail = c.id.slice(prefix.length);
          const n = parseInt(tail, 10);
          if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
        }
      }
    }
  }
  return maxSeq;
}

// Note: this continues the sequence from any existing same-day file so that
// a partial re-run doesn't reuse IDs. Full re-run overwrites the file — the
// function is called before the write, so the file still contains the prior
// state when we read it. Since we overwrite entirely afterward, IDs restart
// from 0 + startSeq on re-run; idempotency is at the *file* level (same
// candidates produce the same-index IDs given deterministic source ordering).
function makeIdFactory(dateStr, startSeq) {
  const compact = dateStr.replace(/-/g, '');
  let seq = startSeq;
  return () => {
    seq += 1;
    return `PROP-${compact}-${String(seq).padStart(3, '0')}`;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Collaborator suggestion
// ────────────────────────────────────────────────────────────────────────────

function suggestCollaborators(candidateKeywords, teammates) {
  const scored = [];
  for (const t of teammates) {
    const tSet = tokenSet([
      ...(t.strengths || []),
      t.current_focus || '',
      t.complement || '',
    ]);
    const score = jaccard(candidateKeywords, tSet);
    if (score > 0) {
      scored.push({
        name: t.name,
        handle: t.handle || '',
        strengths: t.strengths || [],
        match_score: Number(score.toFixed(3)),
      });
    }
  }
  scored.sort((a, b) => b.match_score - a.match_score);
  return scored.slice(0, MAX_COLLABORATORS);
}

// ────────────────────────────────────────────────────────────────────────────
// Aspiration matching for score boost
// ────────────────────────────────────────────────────────────────────────────

function computeAspirationMatch(candidateKeywords, aspirations) {
  if (!aspirations || aspirations.length === 0) return 0.5;
  let best = 0;
  for (const a of aspirations) {
    const aSet = tokenSet([a]);
    const j = jaccard(candidateKeywords, aSet);
    if (j > best) best = j;
  }
  // Scale Jaccard to [0.3, 1.0] — zero match still yields a usable floor.
  return Math.min(1, 0.3 + best * 2);
}

// ────────────────────────────────────────────────────────────────────────────
// Source 1: paper × repo intersection
// ────────────────────────────────────────────────────────────────────────────

function sourcePaperXRepo({ papers, repos, github, teammates, aspirations }) {
  const candidates = [];
  if (!papers || !Array.isArray(papers.papers)) return candidates;
  if (!repos || repos.length === 0) return candidates;

  // Minimum Jaccard overlap between paper TITLE tokens and repo TOPIC tokens.
  // Per SKILL.md Quality Bar: "Apply paper X to repo Y" must require real keyword
  // overlap, not freshness × name match. We deliberately exclude paper.topic_matched
  // (the user's query that surfaced the paper) — including it is tautological since
  // the query already matched the paper's domain.
  const PAPER_REPO_MIN_JACCARD = 0.10;

  for (const paper of papers.papers) {
    const titleTokens = tokenSet([paper.title || '']);
    if (titleTokens.size === 0) continue;
    // Keep topic_matched in the candidate keyword bag for downstream collaborator
    // matching and aspiration scoring, but NOT for the relevance gate.
    const paperTopicSet = tokenSet([paper.topic_matched || '', paper.title || '']);

    for (const repo of repos) {
      const repoTopicSet = tokenSet(repo.topics || []);
      if (repoTopicSet.size === 0) continue;
      // Real-relevance gate: paper title must materially overlap with repo topics.
      if (jaccard(titleTokens, repoTopicSet) < PAPER_REPO_MIN_JACCARD) continue;

      // "Already being done?" — does github data show recent commits / PRs
      // mentioning any of the same keywords?
      const repoGh = github && github.repos ? github.repos[repo.name] : null;
      const recentSubjects = [];
      if (repoGh && repoGh.local && Array.isArray(repoGh.local.recent_commits)) {
        for (const c of repoGh.local.recent_commits) {
          if (c && c.subject) recentSubjects.push(c.subject);
        }
      }
      const recentPRsSubjects = [];
      if (repoGh && repoGh.gaps && Array.isArray(repoGh.gaps.stale_open_prs)) {
        for (const p of repoGh.gaps.stale_open_prs) {
          if (p && p.title) recentPRsSubjects.push(p.title);
        }
      }
      const commitSet = tokenSet([...recentSubjects, ...recentPRsSubjects]);
      const alreadyBeingDone = anyTokenOverlap(paperTopicSet, commitSet);
      if (alreadyBeingDone) continue;

      const primaryKeyword = (paper.topic_matched || repo.topics[0] || '').toString();
      const candidateKeywords = new Set([...paperTopicSet, ...repoTopicSet]);

      const oneLine = `Apply "${truncate(paper.title, 80)}" to ${repo.name} — no one on the team has explored this angle yet`;
      const whyGap = [
        `paper: ${truncate(paper.title, 100)} (freshness ${formatNum(paper.freshness)})`,
        `repo ${repo.name}: 0 recent commits/PRs mention "${primaryKeyword}" keywords`,
      ];

      const aspirationMatch = computeAspirationMatch(candidateKeywords, aspirations);
      candidates.push({
        _internal: {
          keywords: candidateKeywords,
          primary_keyword: primaryKeyword.toLowerCase(),
          repo_or_paper_id: `${repo.name}::${paper.id}`,
        },
        source: 'paper_x_repo',
        one_line: oneLine,
        why_gap: whyGap,
        collaborator_candidates: suggestCollaborators(candidateKeywords, teammates),
        first_step: `Share "${truncate(paper.title, 60)}" in team channel + draft 1-pager on applicability to ${repo.name}`,
        artifact_target: `1-pager → RFC → PR in ${repo.name}`,
        evidence: {
          paper_id: paper.id,
          paper_url: paper.url || '',
          repo: repo.name,
          repo_topics: repo.topics || [],
        },
        scoring_inputs: {
          novelty: 0.8,
          visibility: 0.6,
          team_fit: 0.5,
          feasibility: 0.6,
          urgency: 0.3,
          aspiration_match: Number(aspirationMatch.toFixed(2)),
        },
      });
    }
  }
  return candidates;
}

// ────────────────────────────────────────────────────────────────────────────
// Source 2: repo gap × expertise (missing docs, stale TODOs)
// ────────────────────────────────────────────────────────────────────────────

function sourceRepoGapXExpertise({ github, repos, expertise, teammates, aspirations }) {
  const candidates = [];
  if (!github || !github.repos) return candidates;
  const expertiseTokens = tokenSet([
    ...(expertise.known_for || []),
    ...(expertise.emerging_strengths || []),
  ]);

  const reposByName = {};
  for (const r of repos) reposByName[r.name] = r;

  for (const [repoName, repoData] of Object.entries(github.repos)) {
    const gaps = (repoData && repoData.gaps) || {};
    const repoCfg = reposByName[repoName] || { name: repoName, topics: [] };
    const repoTopicSet = tokenSet(repoCfg.topics || []);

    // Missing-docs candidates
    for (const missing of gaps.missing_docs || []) {
      const docTokens = tokenSet([missing, repoName, ...(repoCfg.topics || [])]);
      const matchesExpertise =
        expertiseTokens.size === 0 || anyTokenOverlap(docTokens, expertiseTokens);
      if (!matchesExpertise) continue;

      const candidateKeywords = new Set([...docTokens, ...repoTopicSet]);
      const aspirationMatch = computeAspirationMatch(candidateKeywords, aspirations);
      const primaryKeyword = missing.toLowerCase();

      candidates.push({
        _internal: {
          keywords: candidateKeywords,
          primary_keyword: primaryKeyword,
          repo_or_paper_id: `${repoName}::doc::${missing}`,
        },
        source: 'repo_gap_x_expertise',
        one_line: `Own the ${missing} for ${repoName} — it's missing and you're the right person to write it`,
        why_gap: [
          `repo ${repoName}: ${missing} not present`,
          repoCfg.topics && repoCfg.topics.length
            ? `repo topics align with your expertise: ${repoCfg.topics.join(', ')}`
            : `no curated topics — treat as generic doc ownership`,
        ],
        collaborator_candidates: suggestCollaborators(candidateKeywords, teammates),
        first_step: `Draft a ${missing} outline (purpose, module map, key decisions) in a PR against ${repoName}`,
        artifact_target: `${missing} merged in ${repoName}`,
        evidence: {
          repo: repoName,
          missing_doc: missing,
          repo_topics: repoCfg.topics || [],
        },
        scoring_inputs: {
          // Missing-doc gaps are maintenance chores, not leadership artifacts.
          // Keep them scoreable so they surface when NOTHING else exists, but
          // never let them outrank paper×repo or real proposal opportunities.
          novelty: 0.15,
          visibility: 0.25,
          team_fit: 0.3,
          feasibility: 0.8,
          urgency: 0.2,
          aspiration_match: Number(aspirationMatch.toFixed(2)),
        },
      });
    }

    // Stale-TODO candidates intentionally NOT generated as Propose items.
    // Per SKILL.md Quality Bar: "Stale TODO cleanup (single-line resolutions).
    // They're noise." A propose-lane item should be a scoped project, not a
    // janitorial line edit. Repo-level TODO debt remains visible in
    // gaps.stale_todos for ad-hoc inspection.
  }
  return candidates;
}

// ────────────────────────────────────────────────────────────────────────────
// Source 3: untriaged issues / stale PRs × expertise
// ────────────────────────────────────────────────────────────────────────────

function sourceStaleIssueXExpertise({ github, repos, expertise, teammates, aspirations, userHandle }) {
  const candidates = [];
  if (!github || !github.repos) return candidates;
  const expertiseTokens = tokenSet(expertise.known_for || []);

  const reposByName = {};
  for (const r of repos) reposByName[r.name] = r;

  for (const [repoName, repoData] of Object.entries(github.repos)) {
    const gaps = (repoData && repoData.gaps) || {};
    const repoCfg = reposByName[repoName] || { name: repoName, topics: [] };
    const repoTopicSet = tokenSet(repoCfg.topics || []);

    const items = [
      ...(gaps.untriaged_issues || []).map((x) => ({ kind: 'issue', ...x })),
      ...(gaps.stale_open_prs || []).map((x) => ({ kind: 'pr', ...x })),
    ];

    for (const item of items) {
      const itemText = item.title || item.text || '';
      if (!itemText) continue;
      // QUALITY BAR: only propose "drive resolution" when the user actually owns the PR/issue.
      // Telling someone to "drive" their teammate's PR is presumptuous chore-work, not leadership.
      // Stale PRs by someone else are at most a "review and unblock" Do-lane item, not Propose.
      if (userHandle && item.author && item.author !== userHandle) continue;
      const itemTokens = tokenSet([itemText, ...(repoCfg.topics || [])]);
      const matchesExpertise =
        expertiseTokens.size === 0 || anyTokenOverlap(itemTokens, expertiseTokens);
      if (!matchesExpertise) continue;

      const combined = new Set([...itemTokens, ...repoTopicSet]);
      const aspirationMatch = computeAspirationMatch(combined, aspirations);
      const refId = item.number ? `#${item.number}` : item.id || '';
      const oneLine = `Drive resolution on ${repoName} ${item.kind} ${refId}: ${truncate(itemText, 60)} — visible win, you're the domain expert`;

      candidates.push({
        _internal: {
          keywords: combined,
          primary_keyword: (item.title || item.kind || 'stale').toLowerCase(),
          repo_or_paper_id: `${repoName}::${item.kind}::${refId || itemText.slice(0, 40)}`,
        },
        source: 'stale_issue_x_expertise',
        one_line: oneLine,
        why_gap: [
          `repo ${repoName}: ${item.kind} ${refId} aging without owner`,
          `matches your known_for keywords`,
        ],
        collaborator_candidates: suggestCollaborators(combined, teammates),
        first_step: `Triage, assign, and either close/merge or convert to a scoped followup with timeline`,
        artifact_target: `${item.kind.toUpperCase()} ${refId} resolved or reassigned with plan`,
        evidence: {
          repo: repoName,
          kind: item.kind,
          ref: refId,
          title: itemText,
          age_days: item.age_days || null,
        },
        scoring_inputs: {
          novelty: 0.3,
          visibility: 0.8,
          team_fit: 0.6,
          feasibility: 0.7,
          urgency: 0.7,
          aspiration_match: Number(aspirationMatch.toFixed(2)),
        },
      });
    }
  }
  return candidates;
}

// ────────────────────────────────────────────────────────────────────────────
// Filtering + dedup
// ────────────────────────────────────────────────────────────────────────────

function filterNotMyLane(candidates, notMyLane) {
  if (!notMyLane || notMyLane.length === 0) return { kept: candidates, filtered: 0 };
  const laneSet = tokenSet(notMyLane);
  if (laneSet.size === 0) return { kept: candidates, filtered: 0 };
  const kept = [];
  let filtered = 0;
  for (const c of candidates) {
    const text = [c.one_line, ...(c.why_gap || [])].join(' ');
    const cSet = tokenSet([text]);
    // Drop if Jaccard overlap is strong — avoids incidental single-word hits.
    const j = jaccard(cSet, laneSet);
    if (j >= JACCARD_MATCH_THRESHOLD) {
      filtered++;
      continue;
    }
    kept.push(c);
  }
  return { kept, filtered };
}

function totalScore(c) {
  const s = c.scoring_inputs || {};
  // Simple sum of positive factors — real scoring happens in Wave 3B.
  return (
    (s.novelty || 0) +
    (s.visibility || 0) +
    (s.team_fit || 0) +
    (s.feasibility || 0) +
    (s.urgency || 0) +
    (s.aspiration_match || 0)
  );
}

function dedupe(candidates) {
  const bySig = new Map();
  for (const c of candidates) {
    const sig = `${c.source}|${c._internal.primary_keyword}|${c._internal.repo_or_paper_id}`;
    const existing = bySig.get(sig);
    if (!existing || totalScore(c) > totalScore(existing)) {
      bySig.set(sig, c);
    }
  }
  return Array.from(bySig.values());
}

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

function truncate(s, n) {
  const str = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}

function formatNum(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'n/a';
  return x.toFixed(2);
}

function stripInternal(c) {
  const { _internal, ...rest } = c;
  return rest;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

function main() {
  const { date } = parseArgs(process.argv);
  const signalDir = path.join(SIGNALS_ROOT, date);
  ensureDir(signalDir);

  // Load inputs (graceful on missing).
  const github = readJSONSafe(path.join(signalDir, 'github.json'));
  const papers = readJSONSafe(path.join(signalDir, 'papers.json'));
  // x_linkedin.json is allowed to be missing; not consumed directly in v1
  // because its content arrays are empty pending MCP wiring.
  const xLinkedin = readJSONSafe(path.join(signalDir, 'x_linkedin.json'));

  const configYaml = readTextSafe(CONFIG_PATH);
  if (!configYaml) {
    process.stderr.write(`[detect_opportunities] warn: config.yaml missing at ${CONFIG_PATH}\n`);
  }
  const repos = parseActiveReposFromYAML(configYaml || '');
  const userHandle = parseUserHandleFromYAML(configYaml || '');

  const expertiseMd = readTextSafe(EXPERTISE_PATH);
  if (!expertiseMd) {
    process.stderr.write(`[detect_opportunities] info: expertise.md not found — running without expertise filter\n`);
  }
  const expertise = parseExpertise(expertiseMd || '');

  const teammatesMd = readTextSafe(TEAMMATES_PATH);
  if (!teammatesMd) {
    process.stderr.write(`[detect_opportunities] info: teammates.md not found — no collaborator suggestions\n`);
  }
  const teammates = parseTeammates(teammatesMd || '');

  const goalsMd = readTextSafe(GOALS_PATH);
  const aspirations = parseLeadershipAspirations(goalsMd);

  // Sources.
  const s1 = sourcePaperXRepo({ papers, repos, github, teammates, aspirations });
  const s2 = sourceRepoGapXExpertise({ github, repos, expertise, teammates, aspirations });
  const s3 = sourceStaleIssueXExpertise({ github, repos, expertise, teammates, aspirations, userHandle });

  let all = [...s1, ...s2, ...s3];
  all = dedupe(all);

  const { kept, filtered } = filterNotMyLane(all, expertise.not_my_lane);

  // Assign stable IDs; continue seq from any existing same-day opportunities.json.
  const startSeq = findMaxSeqForDate(date);
  const nextId = makeIdFactory(date, startSeq);
  const withIds = kept.map((c) => ({ id: nextId(), ...stripInternal(c) }));

  const bySource = withIds.reduce((acc, c) => {
    acc[c.source] = (acc[c.source] || 0) + 1;
    return acc;
  }, {});

  const output = {
    date,
    generated_at: new Date().toISOString(),
    candidates: withIds,
    stats: {
      total_candidates: withIds.length,
      by_source: bySource,
      filtered_not_my_lane: filtered,
      inputs: {
        github_present: Boolean(github),
        papers_present: Boolean(papers),
        x_linkedin_present: Boolean(xLinkedin),
        expertise_present: Boolean(expertiseMd),
        teammates_present: Boolean(teammatesMd),
        goals_present: Boolean(goalsMd),
      },
    },
  };

  const outPath = path.join(signalDir, 'opportunities.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  process.stdout.write(`[detect_opportunities] wrote ${outPath} — ${withIds.length} candidates (sources: ${JSON.stringify(bySource)}, filtered: ${filtered})\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[detect_opportunities] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
}
