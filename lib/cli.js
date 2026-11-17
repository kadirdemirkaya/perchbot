'use strict';

/**
 * Shared plumbing for setup.js and uninstall.js: argument parsing, choosing
 * the settings files (by default every Claude Code account on this computer,
 * see findAccounts), reading them safely, backups, atomic writes, confirmation.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');
const names = require('./names');

const USAGE_TARGETS = `Which settings files:
  (default)            every Claude Code account found on this computer:
                       ~/.claude, ~/.claude-<name> (e.g. ~/.claude-personal,
                       ~/.claude-work) and $CLAUDE_CONFIG_DIR, one settings.json each
  --config-dir <dir>   only <dir>/settings.json
  --project [dir]      <dir>/.claude/settings.json        (shared project settings)
  --local [dir]        <dir>/.claude/settings.local.json  (personal project settings)
                       [dir] defaults to the folder you ran npm from

Other options:
  --dry-run            show what would change and write nothing
  --yes, -y            do not ask for confirmation
  --help, -h           show this help`;

function parseArgs(argv) {
  const opts = { dryRun: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const takeOptional = () => (next !== undefined && !next.startsWith('-') ? argv[++i] : '');
    switch (arg) {
      case '--config-dir':
        if (next === undefined || next.startsWith('-')) throw new Error('--config-dir needs a folder');
        opts.configDir = argv[++i];
        break;
      case '--project':
        opts.project = takeOptional();
        break;
      case '--local':
        opts.local = takeOptional();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  const targets = ['configDir', 'project', 'local'].filter((k) => opts[k] !== undefined);
  if (targets.length > 1) throw new Error('Use only one of --config-dir, --project, --local');
  return opts;
}

/** A ~/.claude-<name> folder counts as an account when Claude Code has left one of these in it. */
const ACCOUNT_DIR_RE = /^\.claude(?:-[A-Za-z0-9._-]+)?$/;
const ACCOUNT_MARKERS = ['settings.json', 'projects', '.credentials.json', 'history.jsonl', 'todos', 'shell-snapshots', 'statsig', 'plugins', 'sessions', 'ide'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Claude Code accounts (config folders) on this computer: $CLAUDE_CONFIG_DIR
 * if set, ~/.claude, and every ~/.claude-<name> that Claude Code has used (it
 * holds settings.json, projects/, ...; other tools' ~/.claude-something
 * folders do not count). Sorted, no duplicates.
 * @returns {Array<{ dir: string, file: string, why: string }>}
 */
function findAccounts({ env = process.env, home = os.homedir() } = {}) {
  const out = [];
  const seen = new Set();
  const add = (dir, why) => {
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ dir: resolved, file: path.join(resolved, 'settings.json'), why });
  };
  if (env.CLAUDE_CONFIG_DIR) add(env.CLAUDE_CONFIG_DIR, 'from CLAUDE_CONFIG_DIR');
  let names = [];
  try {
    names = fs.readdirSync(home).filter((name) => ACCOUNT_DIR_RE.test(name)).sort();
  } catch {
    // no home folder to look in
  }
  for (const name of names) {
    const dir = path.join(home, name);
    if (!isDir(dir)) continue; // e.g. ~/.claude.json
    if (name !== '.claude' && !ACCOUNT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) continue;
    add(dir, `Claude account "${name.slice(1)}"`);
  }
  return out;
}

/**
 * The settings files to work on: the one an option names, otherwise every
 * account findAccounts() finds (or ~/.claude when there is none yet).
 * @returns {Array<{ file: string, why: string }>}
 */
function resolveTargets(opts, env = process.env, home = os.homedir()) {
  if (opts.configDir !== undefined || opts.project !== undefined || opts.local !== undefined) return [resolveTarget(opts, env)];
  const found = findAccounts({ env, home });
  if (!found.length) return [{ file: path.join(home, '.claude', 'settings.json'), why: 'default user settings' }];
  return found.map(({ file, why }) => ({ file, why }));
}

/** @returns {{ file: string, why: string }} */
function resolveTarget(opts, env = process.env) {
  const startDir = env.INIT_CWD || process.cwd();
  if (opts.configDir !== undefined) {
    return { file: path.join(path.resolve(opts.configDir), 'settings.json'), why: '--config-dir' };
  }
  if (opts.project !== undefined) {
    const dir = path.resolve(opts.project || startDir);
    return { file: path.join(dir, '.claude', 'settings.json'), why: 'project settings (--project)' };
  }
  if (opts.local !== undefined) {
    const dir = path.resolve(opts.local || startDir);
    return { file: path.join(dir, '.claude', 'settings.local.json'), why: 'local project settings (--local)' };
  }
  if (env.CLAUDE_CONFIG_DIR) {
    return { file: path.join(path.resolve(env.CLAUDE_CONFIG_DIR), 'settings.json'), why: 'from CLAUDE_CONFIG_DIR' };
  }
  return { file: path.join(os.homedir(), '.claude', 'settings.json'), why: 'default user settings' };
}

/**
 * @returns {{ exists: boolean, data?: object, text?: string, error?: string }}
 */
function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, data: {} };
    return { exists: true, error: `cannot read the file (${err.code || err.message})` };
  }
  const body = text.replace(/^﻿/, '');
  if (!body.trim()) return { exists: true, data: {}, text };
  try {
    const data = JSON.parse(body);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { exists: true, error: 'the file does not contain a JSON object' };
    }
    return { exists: true, data, text };
  } catch (err) {
    return { exists: true, error: `the file is not valid JSON (${err.message})` };
  }
}

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** A backup file name next to `file` that does not exist yet. */
function backupPath(file, date = new Date()) {
  const base = `${file}.perchbot-${timestamp(date)}`;
  let candidate = `${base}.bak`;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}.bak`;
  return candidate;
}

/** Copy the file next to itself; never overwrites an existing backup. */
function makeBackup(file, target = backupPath(file)) {
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  return target;
}

/** Write JSON via a temp file + rename. Follows a symlinked settings file. */
function writeJsonAtomic(file, data) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // does not exist yet
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.perchbot-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Ask for confirmation unless --yes. Without a terminal there is nobody to
 * ask, so we refuse instead of guessing.
 */
async function approved(opts, question = 'Apply these changes?') {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.log('\nNo terminal to confirm in. Re-run with --yes to apply these changes.');
    return false;
  }
  return confirm(`\n${question}`);
}

/** "2.1.326 (Claude Code)" -> "2.1.326"; null when there is no x.y.z in it. */
function parseClaudeVersion(text) {
  const m = typeof text === 'string' ? text.match(/\b(\d+)\.(\d+)\.(\d+)\b/) : null;
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function runClaudeVersion() {
  try {
    // Through a shell, so claude.exe, claude.cmd (npm) and the claude script are found alike.
    // A fixed command: nothing in it comes from outside.
    return execSync('claude --version', { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

let claudeVersionCache;

/**
 * The installed Claude Code's version ("2.1.326"), or null when `claude` cannot be
 * run. Some hook events need a recent one (lib/hooks-config.js VERSIONED_SPECS).
 * Asked once per process. PERCHBOT_CLAUDE_VERSION stands in for it (tests; "none":
 * as if Claude Code were not found).
 * @param {{ env?: NodeJS.ProcessEnv, run?: () => string|null }} [o]
 */
function claudeVersion({ env = process.env, run = null } = {}) {
  const override = names.envValue('CLAUDE_VERSION', env);
  if (override !== undefined) return override === 'none' ? null : parseClaudeVersion(override);
  if (run) return parseClaudeVersion(run());
  if (claudeVersionCache === undefined) claudeVersionCache = parseClaudeVersion(runClaudeVersion());
  return claudeVersionCache;
}

module.exports = {
  USAGE_TARGETS,
  parseArgs,
  findAccounts,
  resolveTargets,
  resolveTarget,
  readSettings,
  backupPath,
  makeBackup,
  writeJsonAtomic,
  approved,
  parseClaudeVersion,
  claudeVersion,
};
