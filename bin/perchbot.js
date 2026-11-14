#!/usr/bin/env node
'use strict';

/**
 * The perchbot command (npm install -g perchbot):
 *
 *   perchbot setup       add the hooks to every Claude Code account on this computer
 *   perchbot uninstall   remove them again (only Perchbot's)
 *   perchbot status      which accounts have the hooks, is the overlay running
 *   perchbot start       start the overlay now (normally the first Claude Code event does)
 *   perchbot demo        play a short tour of every state, no Claude Code needed
 *
 * setup / uninstall take --dry-run, --yes, --config-dir <dir>, --project, --local
 * (see "perchbot setup --help"). Node built-ins only, like the hook.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const cli = require('../lib/cli');
const hooks = require('../lib/hooks-config');
const { electronBinary, readConfig } = require('../hooks/send');
const electron = require('../lib/electron');

const SEND_JS = path.join(ROOT, 'hooks', 'send.js');

const HELP = `Perchbot: a tiny animated desktop companion for Claude Code.

Usage: perchbot <command> [options]

  setup       add the hooks to every Claude Code account on this computer
              (~/.claude, ~/.claude-<name>, $CLAUDE_CONFIG_DIR); asks once, backs up each file
  uninstall   remove Perchbot's hooks again (nothing else)
  status      which accounts have the hooks; is the overlay running
              (--config-dir <dir>: only that one)
  doctor     check and fix: hooks everywhere, a live test per account, sessions
              opened before the hooks (--account <name> tests one, --yes)
  start       start the overlay now (normally the first Claude Code event starts it)
  demo        a short tour of every state, without Claude Code

Options for setup / uninstall: --dry-run, --yes, --config-dir <dir>, --project [dir],
--local [dir]. Details: perchbot setup --help`;

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
}

function overlayRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 600 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** One account's hooks: installed for this copy, for another copy, or not at all. */
function hookState(file) {
  const current = cli.readSettings(file);
  if (!current.exists) return 'no settings file yet: not installed';
  if (current.error) return `cannot check (${current.error})`;
  if (hooks.isInstalled(current.data, SEND_JS)) return 'installed';
  if (hooks.countOurHandlers(current.data) > 0) return 'installed by another or an older copy (e.g. from before the rename): run "perchbot setup" to update';
  return 'not installed';
}

const STATUS_USAGE = `Usage: perchbot status [--config-dir <dir> | --project [dir] | --local [dir]]

  (default)            every Claude Code account found on this computer
  --config-dir <dir>   only <dir>/settings.json
  --project [dir]      only <dir>/.claude/settings.json
  --local [dir]        only <dir>/.claude/settings.local.json`;

async function status(args = []) {
  let opts;
  try {
    opts = cli.parseArgs(args);
  } catch (err) {
    console.error(`${err.message}\n\n${STATUS_USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(STATUS_USAGE);
    return 0;
  }
  const { port } = readConfig();
  console.log(`Perchbot ${version()}\n`);
  console.log(`  This copy  : ${ROOT}`);
  console.log(`  Electron   : ${electronBinary() ? 'installed' : 'not downloaded yet ("perchbot setup" or "perchbot start" downloads it)'}`);
  console.log(`  Overlay    : ${(await overlayRunning(port)) ? `running on 127.0.0.1:${port}` : 'not running (the first Claude Code event starts it)'}`);
  // One settings file named by an option: only that one (no other account is read).
  if (opts.configDir !== undefined || opts.project !== undefined || opts.local !== undefined) {
    const [target] = cli.resolveTargets(opts);
    console.log(`\n  Settings file (${target.why}): ${target.file}`);
    console.log(`    ${hookState(target.file)}`);
    return 0;
  }
  const accounts = cli.findAccounts();
  console.log(`\n  Claude Code accounts found: ${accounts.length}`);
  for (const a of accounts) console.log(`    ${path.basename(a.dir).replace(/^\./, '').padEnd(20)} ${hookState(a.file)}`);
  if (!accounts.length) console.log('    (none yet: run Claude Code once, then "perchbot setup")');
  return 0;
}

/** Electron's binary, downloaded first if needed; null (after saying why) when that failed. */
function readyElectron() {
  const got = electron.ensureElectron();
  if (got.ok) return got.binary;
  console.error(electron.failureText(got));
  return null;
}

function start() {
  const binary = readyElectron();
  if (!binary) return 1;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [ROOT], { cwd: ROOT, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  console.log('Perchbot started. It goes away by itself after a while without Claude Code events.');
  return 0;
}

function demo(args) {
  // The demo's events start the overlay through the hook, which never downloads.
  if (!readyElectron()) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'simulate.js'), ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code || 0));
    child.on('error', () => resolve(1));
  });
}

async function run(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'setup':
    case 'install':
      return require('../setup').main(rest);
    case 'uninstall':
    case 'remove':
      return require('../uninstall').main(rest);
    case 'doctor': {
      const at = rest.indexOf('--account');
      return require('../lib/doctor').doctor({
        sendJs: SEND_JS,
        version: version(),
        setup: (args) => require('../setup').main(args),
        yes: rest.includes('--yes'),
        only: at >= 0 ? rest[at + 1] || null : null,
        readConfig,
      });
    }
    case 'status':
      return status(rest);
    case 'start':
      return start();
    case 'demo':
      return demo(rest);
    case '--version':
    case '-v':
      console.log(version());
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    },
  );
}

module.exports = { run, hookState };
