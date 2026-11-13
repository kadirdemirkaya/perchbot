#!/usr/bin/env node
'use strict';

/**
 * The agent-buddy command (npm install -g agent-buddy):
 *
 *   agent-buddy setup       add the hooks to every Claude Code account on this computer
 *   agent-buddy uninstall   remove them again (only Agent Buddy's)
 *   agent-buddy status      which accounts have the hooks, is the overlay running
 *   agent-buddy start       start the overlay now (normally the first Claude Code event does)
 *   agent-buddy demo        play a short tour of every state, no Claude Code needed
 *
 * setup / uninstall take --dry-run, --yes, --config-dir <dir>, --project, --local
 * (see "agent-buddy setup --help"). Node built-ins only, like the hook.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const cli = require('../lib/cli');
const hooks = require('../lib/hooks-config');
const { electronBinary, readConfig } = require('../hooks/send');

const SEND_JS = path.join(ROOT, 'hooks', 'send.js');

const HELP = `Agent Buddy: a tiny animated desktop companion for Claude Code.

Usage: agent-buddy <command> [options]

  setup       add the hooks to every Claude Code account on this computer
              (~/.claude, ~/.claude-<name>, $CLAUDE_CONFIG_DIR); asks once, backs up each file
  uninstall   remove Agent Buddy's hooks again (nothing else)
  status      which accounts have the hooks; is the overlay running
  doctor      check and fix: hooks everywhere, a live test per account, sessions
              opened before the hooks (--account <name> tests one, --yes)
  start       start the overlay now (normally the first Claude Code event starts it)
  demo        a short tour of every state, without Claude Code

Options for setup / uninstall: --dry-run, --yes, --config-dir <dir>, --project [dir],
--local [dir]. Details: agent-buddy setup --help`;

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
  if (hooks.countOurHandlers(current.data) > 0) return 'installed for another copy of Agent Buddy: run "agent-buddy setup" to switch';
  return 'not installed';
}

async function status() {
  const { port } = readConfig();
  console.log(`Agent Buddy ${version()}\n`);
  console.log(`  This copy  : ${ROOT}`);
  console.log(`  Electron   : ${electronBinary() ? 'installed' : 'MISSING (run npm install, or node node_modules/electron/install.js)'}`);
  console.log(`  Overlay    : ${(await overlayRunning(port)) ? `running on 127.0.0.1:${port}` : 'not running (the first Claude Code event starts it)'}`);
  const accounts = cli.findAccounts();
  console.log(`\n  Claude Code accounts found: ${accounts.length}`);
  for (const a of accounts) console.log(`    ${path.basename(a.dir).replace(/^\./, '').padEnd(20)} ${hookState(a.file)}`);
  if (!accounts.length) console.log('    (none yet: run Claude Code once, then "agent-buddy setup")');
  return 0;
}

function start() {
  const binary = electronBinary();
  if (!binary) {
    console.error('Electron is not installed. Run "npm install" in the Agent Buddy folder first.');
    return 1;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [ROOT], { cwd: ROOT, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  console.log('Agent Buddy started. It goes away by itself after a while without Claude Code events.');
  return 0;
}

function demo(args) {
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
      return status();
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
