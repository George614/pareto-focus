#!/usr/bin/env node
/**
 * pareto-focus: end-of-day Stop hook.
 *
 * Reads Claude Code Stop-hook JSON from stdin and, when the
 * `cadences.end_of_day.enabled` toggle is true in
 * ~/.claude/projects/pareto-focus/config.yaml (fallback: skill template),
 * appends a single JSON line to state/decisions.log capturing:
 *   - planned Do / Propose items (from state/priorities.md)
 *   - actual top-3 projects for today (from data/time_log.jsonl)
 *   - alignment score (fraction of planned_do that appear in actual)
 *
 * Never blocks the Stop event: always exits 0, logs errors to
 * data/end_of_day_hook.err.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const PROJECT_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const SKILL_ROOT = path.join(HOME, '.claude', 'skills', 'pareto-focus');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.yaml');
const TEMPLATE_CONFIG_PATH = path.join(SKILL_ROOT, 'templates', 'config.yaml');
const PRIORITIES_PATH = path.join(PROJECT_ROOT, 'state', 'priorities.md');
const TIME_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'time_log.jsonl');
const DECISIONS_LOG_PATH = path.join(PROJECT_ROOT, 'state', 'decisions.log');
const ERR_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'end_of_day_hook.err');

function logError(err) {
  try {
    const line = `${new Date().toISOString()} ${err && err.stack ? err.stack : String(err)}\n`;
    fs.mkdirSync(path.dirname(ERR_LOG_PATH), { recursive: true });
    fs.appendFileSync(ERR_LOG_PATH, line);
  } catch (_) {
    // never throw from the error logger
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function resolveConfigPath() {
  if (fs.existsSync(CONFIG_PATH)) return CONFIG_PATH;
  if (fs.existsSync(TEMPLATE_CONFIG_PATH)) return TEMPLATE_CONFIG_PATH;
  return null;
}

function isEndOfDayEnabled(yamlText) {
  if (!yamlText) return false;

  // Preferred: python3 YAML parser if available.
  try {
    const out = execFileSync(
      'python3',
      [
        '-c',
        [
          'import sys,yaml,json',
          'd=yaml.safe_load(sys.stdin.read()) or {}',
          'c=(d.get("cadences") or {}).get("end_of_day") or {}',
          'print(json.dumps(bool(c.get("enabled", False))))',
        ].join('\n'),
      ],
      { input: yamlText, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(String(out).trim()) === true;
  } catch (_) {
    // fall through to regex
  }

  // Regex fallback — handles inline flow-map form (default template):
  //   end_of_day: { enabled: false }
  const flowRe = /end_of_day:\s*\{[^}]*enabled:\s*(true|false)/i;
  const m1 = yamlText.match(flowRe);
  if (m1) return m1[1].toLowerCase() === 'true';

  // Block form fallback:
  //   end_of_day:
  //     enabled: true
  const blockRe = /end_of_day:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+enabled:\s*(true|false)/i;
  const m2 = yamlText.match(blockRe);
  if (m2) return m2[1].toLowerCase() === 'true';

  return false;
}

function todayIso() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse priorities.md. Looking for sections like:
 *   ## Do
 *   - item-A ...
 *   - item-B ...
 *   ## Propose
 *   - prop-X ...
 *
 * Returns { planned_do: string[], planned_propose: string[] }.
 * Top-3 for Do, top-1 for Propose.
 */
function parsePriorities(md) {
  if (!md) return { planned_do: [], planned_propose: [] };

  const sectionRe = /^#{1,6}\s+([A-Za-z][A-Za-z0-9 _-]*)\s*$/;
  const bulletRe = /^\s*[-*+]\s+(.+?)\s*$/;

  const lines = md.split(/\r?\n/);
  const sections = {};
  let current = null;

  for (const line of lines) {
    const s = line.match(sectionRe);
    if (s) {
      current = s[1].trim().toLowerCase();
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (!current) continue;
    const b = line.match(bulletRe);
    if (b) {
      const text = b[1].replace(/[`*_]/g, '').trim();
      if (text) sections[current].push(text);
    }
  }

  const firstToken = (s) => {
    // Prefer a leading project/item slug like `nlp.slime` or `item-A`.
    const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    return m ? m[1] : s;
  };

  const doList = (sections['do'] || []).slice(0, 3).map(firstToken);
  const proposeList = (sections['propose'] || []).slice(0, 1).map(firstToken);

  return { planned_do: doList, planned_propose: proposeList };
}

/**
 * Read today's rows from time_log.jsonl. Returns top-3 projects by event count
 * as [[name, count], ...].
 */
function todayTopProjects(today) {
  if (!fs.existsSync(TIME_LOG_PATH)) return [];

  const raw = fs.readFileSync(TIME_LOG_PATH, 'utf8');
  const counts = new Map();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const ts = entry.timestamp || entry.ts || entry.time || entry.at;
    if (typeof ts !== 'string' || !ts.startsWith(today)) continue;

    const project =
      entry.project ||
      entry.repo ||
      entry.project_name ||
      entry.name ||
      null;
    if (!project) continue;
    counts.set(project, (counts.get(project) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

function computeAlignment(plannedDo, actualTopProjects) {
  if (!plannedDo || plannedDo.length === 0) return 0;
  const actualNames = new Set(
    actualTopProjects.map((p) => String(p[0]).toLowerCase())
  );
  let hits = 0;
  for (const item of plannedDo) {
    if (actualNames.has(String(item).toLowerCase())) hits += 1;
  }
  return Number((hits / plannedDo.length).toFixed(4));
}

function main() {
  // Always exit 0. Read stdin for completeness (don't rely on its shape).
  try {
    readStdin();

    const configPath = resolveConfigPath();
    let enabled = false;
    if (configPath) {
      try {
        const yamlText = fs.readFileSync(configPath, 'utf8');
        enabled = isEndOfDayEnabled(yamlText);
      } catch (e) {
        logError(e);
      }
    }

    if (!enabled) {
      process.exit(0);
      return;
    }

    const today = todayIso();

    let planned = { planned_do: [], planned_propose: [] };
    if (fs.existsSync(PRIORITIES_PATH)) {
      try {
        const md = fs.readFileSync(PRIORITIES_PATH, 'utf8');
        planned = parsePriorities(md);
      } catch (e) {
        logError(e);
      }
    }

    let actualTop = [];
    try {
      actualTop = todayTopProjects(today);
    } catch (e) {
      logError(e);
    }

    const alignment = computeAlignment(planned.planned_do, actualTop);

    const entry = {
      session_end: new Date().toISOString(),
      date: today,
      planned_do: planned.planned_do,
      planned_propose: planned.planned_propose,
      actual_top_projects: actualTop,
      alignment,
      alignment_notes: 'auto',
    };

    try {
      fs.mkdirSync(path.dirname(DECISIONS_LOG_PATH), { recursive: true });
      fs.appendFileSync(DECISIONS_LOG_PATH, JSON.stringify(entry) + '\n');
    } catch (e) {
      logError(e);
    }

    process.exit(0);
  } catch (e) {
    logError(e);
    process.exit(0);
  }
}

main();
