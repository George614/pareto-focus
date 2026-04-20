#!/usr/bin/env node
/**
 * pareto-focus: emit a JSON plan of cron registrations / deletions derived
 * from config.yaml cadences.
 *
 * CLI:
 *   node register_crons.js [--plan]
 *
 * This script NEVER mutates any external system. Its only job is to print a
 * JSON plan to stdout. A caller (the /focus-config command, or Claude at
 * runtime) is expected to translate `actions[*]` into CronCreate calls and
 * `deletions[*]` into CronDelete calls.
 *
 * Plan shape:
 *   {
 *     "actions":   [{ op, name, schedule, command, reason }],
 *     "deletions": [{ op, name, reason }]
 *   }
 *
 * Current registry is read from state/cron_registry.json if present; when
 * absent (v1 default) we emit creates for every enabled cadence and deletes
 * for every disabled cadence so the plan is idempotent either way.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DATA_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const CONFIG_PATH = path.join(DATA_ROOT, 'config.yaml');
const REGISTRY_PATH = path.join(DATA_ROOT, 'state', 'cron_registry.json');
const SCRIPTS_DIR = path.join(
  HOME,
  '.claude',
  'skills',
  'pareto-focus',
  'scripts'
);

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const CADENCES = [
  {
    key: 'morning_brief',
    name: 'pareto-focus-morning-brief',
    script: 'morning_brief.js',
    kind: 'daily',
    defaultTime: '07:00',
  },
  {
    key: 'end_of_day',
    name: 'pareto-focus-end-of-day',
    script: 'end_of_day_hook.js',
    kind: 'daily',
    defaultTime: '18:00',
  },
  {
    key: 'weekly_review',
    name: 'pareto-focus-weekly-review',
    script: 'weekly_review.js',
    kind: 'weekly',
    defaultTime: '16:00',
    defaultDay: 'fri',
  },
  {
    key: 'monthly_review',
    name: 'pareto-focus-monthly-review',
    script: 'monthly_review.js',
    kind: 'monthly',
    defaultTime: '16:00',
    defaultDay: 'last',
  },
];

function parseArgs(argv) {
  // --plan is the default behavior; accept the flag for symmetry.
  const args = { plan: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--plan') args.plan = true;
  }
  return args;
}

/**
 * Minimal YAML subset parser for the cadences block.
 * Supports inline flow mappings:
 *   morning_brief:    { enabled: false, time: "07:00" }
 * and nested block mappings:
 *   weekly_review:
 *     enabled: true
 *     day: fri
 *     time: "16:00"
 */
function parseConfigCadences(text) {
  const lines = text.split(/\r?\n/);
  const cadences = {};
  let inCadences = false;
  let currentKey = null;
  let currentIndent = -1;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.replace(/^\s*/, '').length;
    const line = raw.trim();

    if (indent === 0) {
      inCadences = /^cadences\s*:/.test(line);
      currentKey = null;
      currentIndent = -1;
      continue;
    }
    if (!inCadences) continue;

    const flowMatch = line.match(/^([a-z_]+)\s*:\s*\{(.*)\}\s*$/i);
    if (flowMatch) {
      cadences[flowMatch[1]] = parseFlowMapping(flowMatch[2]);
      currentKey = null;
      currentIndent = -1;
      continue;
    }

    const blockOpenMatch = line.match(/^([a-z_]+)\s*:\s*$/i);
    if (blockOpenMatch && (currentKey === null || indent <= currentIndent)) {
      currentKey = blockOpenMatch[1];
      currentIndent = indent;
      cadences[currentKey] = cadences[currentKey] || {};
      continue;
    }

    if (currentKey && indent > currentIndent) {
      const kv = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
      if (kv) {
        cadences[currentKey][kv[1]] = coerce(stripQuotes(kv[2]));
      }
    }
  }

  return cadences;
}

function parseFlowMapping(inner) {
  const result = {};
  const parts = [];
  let buf = '';
  let inQuote = false;
  let quoteCh = '';
  for (const ch of inner) {
    if (inQuote) {
      if (ch === quoteCh) inQuote = false;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteCh = ch;
      buf += ch;
    } else if (ch === ',') {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const m = p.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
    if (m) result[m[1]] = coerce(stripQuotes(m[2]));
  }
  return result;
}

function stripQuotes(v) {
  const s = String(v).trim();
  if (
    s.length >= 2 &&
    (s[0] === '"' || s[0] === "'") &&
    s[s.length - 1] === s[0]
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { cadences: {} };
  }
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  return { cadences: parseConfigCadences(text) };
}

function readRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : raw.entries || [];
  } catch (_) {
    return [];
  }
}

function parseHHMM(s, fallback) {
  const src = s || fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(src).trim());
  if (!m) return { hour: 7, minute: 0 };
  const hour = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const minute = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return { hour, minute };
}

function buildSchedule(cadence, cfg) {
  const { hour, minute } = parseHHMM(cfg.time, cadence.defaultTime);
  if (cadence.kind === 'daily') {
    return { schedule: `${minute} ${hour} * * *`, note: null };
  }
  if (cadence.kind === 'weekly') {
    const dayKey = String(cfg.day || cadence.defaultDay || 'fri').toLowerCase();
    const dow = DOW[dayKey] != null ? DOW[dayKey] : DOW[cadence.defaultDay];
    return {
      schedule: `${minute} ${hour} * * ${dow}`,
      note: `day=${dayKey}`,
    };
  }
  if (cadence.kind === 'monthly') {
    const dayKey = String(cfg.day || cadence.defaultDay || 'last').toLowerCase();
    if (dayKey === 'last') {
      return {
        schedule: `${minute} ${hour} 28-31 * *`,
        note:
          'day=last; wrapper must guard via `[ "$(date -v+1d +%d)" = "01" ] || exit 0` so it only fires on the true last day of the month',
      };
    }
    const dom = parseInt(dayKey, 10);
    if (!isNaN(dom) && dom >= 1 && dom <= 31) {
      return { schedule: `${minute} ${hour} ${dom} * *`, note: `day=${dom}` };
    }
    return {
      schedule: `${minute} ${hour} 28-31 * *`,
      note: `day=${dayKey} unrecognized; defaulted to last-day pattern`,
    };
  }
  return { schedule: `${minute} ${hour} * * *`, note: null };
}

function buildReason(cadence, cfg, schedNote) {
  const parts = [`cadences.${cadence.key}.enabled=${cfg.enabled === true}`];
  if (cfg.day != null) parts.push(`day=${cfg.day}`);
  if (cfg.time != null) parts.push(`time=${cfg.time}`);
  if (schedNote) parts.push(schedNote);
  return parts.join(', ');
}

function buildPlan(cfgCadences, registry) {
  const actions = [];
  const deletions = [];
  const registeredNames = new Set(
    registry.map((e) => (typeof e === 'string' ? e : e.name)).filter(Boolean)
  );

  for (const cadence of CADENCES) {
    const cfg = cfgCadences[cadence.key] || {};
    const enabled = cfg.enabled === true;

    if (enabled) {
      const { schedule, note } = buildSchedule(cadence, cfg);
      actions.push({
        op: 'create',
        name: cadence.name,
        schedule,
        command: `node ${path.join(SCRIPTS_DIR, cadence.script)}`,
        reason: buildReason(cadence, cfg, note),
      });
    } else {
      // When registry is empty (v1 default) emit deletes for every disabled
      // cadence so /focus-config can reconcile blindly. Once the registry is
      // populated, only emit a delete for names actually present.
      if (registeredNames.size === 0 || registeredNames.has(cadence.name)) {
        deletions.push({
          op: 'delete',
          name: cadence.name,
          reason: `cadences.${cadence.key}.enabled=false`,
        });
      }
    }
  }

  return { actions, deletions };
}

function main() {
  parseArgs(process.argv);
  const { cadences } = readConfig();
  const registry = readRegistry();
  const plan = buildPlan(cadences, registry);
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}

main();
