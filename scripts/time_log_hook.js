#!/usr/bin/env node
/**
 * pareto-focus: PostToolUse time-tracking hook.
 *
 * Reads a Claude Code hook JSON payload from stdin and appends a JSONL entry
 * to ~/.claude/projects/pareto-focus/data/time_log.jsonl when the tool event
 * happens inside a project under $HOME/Projects/ (or wherever `projects_root`
 * points to in config.yaml).
 *
 * Must ALWAYS exit 0 silently — any error is swallowed and logged to
 * data/time_log_hook.err so a failure here never blocks tool use.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DATA_ROOT = path.join(HOME, '.claude', 'projects', 'pareto-focus');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const CONFIG_PATH = path.join(DATA_ROOT, 'config.yaml');
const LOG_PATH = path.join(DATA_DIR, 'time_log.jsonl');
const ERR_PATH = path.join(DATA_DIR, 'time_log_hook.err');

// Default; overridden by `projects_root` in config.yaml if set.
const PROJECTS_ROOT = path.join(HOME, 'Projects') + path.sep;
const ALLOWED_TOOLS = new Set([
  'Bash',
  'Edit',
  'Write',
  'Read',
  'MultiEdit',
  'NotebookEdit',
]);

function logErr(err) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = `${new Date().toISOString()} ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(ERR_PATH, line);
  } catch (_) {
    /* nothing we can do */
  }
}

/**
 * Minimal YAML extractor for the two keys we care about:
 *   time_tracking:
 *     session_gap_minutes: 15
 *     ignore_paths:
 *       - "/tmp"
 *       - "~/.claude"
 *
 * Returns { ignore_paths: string[], session_gap_minutes: number|null }.
 * Any parse trouble -> defaults, never throws.
 */
function parseConfig(yamlText) {
  const result = { ignore_paths: [], session_gap_minutes: null };
  if (!yamlText) return result;

  const lines = yamlText.split(/\r?\n/);
  let inTimeTracking = false;
  let inIgnorePaths = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const indent = raw.length - raw.replace(/^\s*/, '').length;
    const line = raw.trim();

    // top-level key ends the time_tracking block
    if (indent === 0) {
      inTimeTracking = /^time_tracking\s*:/.test(line);
      inIgnorePaths = false;
      continue;
    }

    if (!inTimeTracking) continue;

    // session_gap_minutes
    const gapMatch = line.match(/^session_gap_minutes\s*:\s*(\d+)/);
    if (gapMatch) {
      result.session_gap_minutes = parseInt(gapMatch[1], 10);
      inIgnorePaths = false;
      continue;
    }

    // ignore_paths list start
    if (/^ignore_paths\s*:/.test(line)) {
      inIgnorePaths = true;
      continue;
    }

    // ignore_paths list item
    if (inIgnorePaths) {
      const item = line.match(/^-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/);
      if (item) {
        result.ignore_paths.push(item[1].trim());
        continue;
      }
      // another key inside time_tracking
      if (/^[^\s-].*:/.test(line)) {
        inIgnorePaths = false;
      }
    }
  }

  return result;
}

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    return parseConfig(text);
  } catch (err) {
    logErr(err);
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
      });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      // Safety: if stdin isn't connected, resolve quickly.
      setTimeout(done, 1500);
    } catch (err) {
      logErr(err);
      done();
    }
  });
}

function isIgnored(cwd, ignorePaths) {
  if (!cwd) return true;
  for (const p of ignorePaths) {
    if (!p) continue;
    const norm = p.replace(/\/+$/, '');
    if (cwd === norm || cwd.startsWith(norm + '/')) return true;
  }
  return false;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw || !raw.trim()) return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      logErr(new Error(`invalid JSON payload: ${err.message}`));
      return;
    }

    const toolName = payload && payload.tool_name;
    const cwd = payload && payload.cwd;
    const sessionId = (payload && payload.session_id) || '';

    if (!toolName || !ALLOWED_TOOLS.has(toolName)) return;
    if (!cwd || typeof cwd !== 'string') return;
    if (!cwd.startsWith(PROJECTS_ROOT)) return;

    const config = readConfig();
    // If config missing, skip logging entirely (per spec: never error out).
    if (!config) return;

    if (isIgnored(cwd, config.ignore_paths || [])) return;

    const remainder = cwd.slice(PROJECTS_ROOT.length);
    const project = remainder.split('/')[0];
    if (!project) return;

    const entry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      cwd,
      tool: toolName,
      project,
      session_id: sessionId,
    };

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    logErr(err);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    logErr(err);
    process.exit(0);
  }
);
