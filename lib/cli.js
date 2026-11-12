'use strict';

/**
 * Shared plumbing for setup.js and uninstall.js: argument parsing, choosing
 * the settings file, reading it safely, backups, atomic writes, confirmation.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const USAGE_TARGETS = `Which settings file:
  (default)            $CLAUDE_CONFIG_DIR/settings.json if CLAUDE_CONFIG_DIR is set,
                       otherwise ~/.claude/settings.json
  --config-dir <dir>   <dir>/settings.json
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
  const base = `${file}.agent-buddy-${timestamp(date)}`;
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
  const tmp = `${target}.agent-buddy-${process.pid}.tmp`;
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
async function approved(opts) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.log('\nNo terminal to confirm in. Re-run with --yes to apply these changes.');
    return false;
  }
  return confirm('\nApply these changes?');
}

module.exports = {
  USAGE_TARGETS,
  parseArgs,
  resolveTarget,
  readSettings,
  backupPath,
  makeBackup,
  writeJsonAtomic,
  approved,
};
