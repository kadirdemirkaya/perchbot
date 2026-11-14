'use strict';

/**
 * End-to-end tests for setup.js / uninstall.js. Every run points HOME,
 * USERPROFILE and CLAUDE_CONFIG_DIR at a temp folder, so the real
 * ~/.claude settings are never touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hooks = require('../lib/hooks-config');
const cli = require('../lib/cli');

const ROOT = path.join(__dirname, '..');
const N = hooks.HOOK_SPECS.length;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-setup-'));
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    PERCHBOT_HOME: path.join(dir, '.perchbot'),
    INIT_CWD: dir,
  };
  return { dir, env };
}

function run(script, args, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { env, encoding: 'utf8', input: '' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const backups = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));

test('creates the settings file under CLAUDE_CONFIG_DIR when missing', () => {
  const { dir, env } = sandbox();
  const r = run('setup.js', ['--yes'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /from CLAUDE_CONFIG_DIR/);
  const file = path.join(dir, 'claude-config', 'settings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(hooks.countOurHandlers(data), N);
  assert.deepEqual(backups(path.dirname(file)), [], 'nothing to back up');
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false, '~/.claude untouched');
});

test('backs up, merges, is idempotent, and uninstall restores the original', () => {
  const { dir, env } = sandbox();
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  const file = path.join(cfg, 'settings.json');
  const original = { model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));

  const dry = run('setup.js', ['--config-dir', cfg, '--dry-run'], env);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, new RegExp(`Will add ${N} hooks`));
  assert.match(dry.out, /nothing was written/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);

  const first = run('setup.js', ['--config-dir', cfg, '--yes'], env);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /1 other handler\(s\), kept/);
  assert.equal(backups(cfg).length, 1);
  const backupText = fs.readFileSync(path.join(cfg, backups(cfg)[0]), 'utf8');
  assert.deepEqual(JSON.parse(backupText), original, 'backup holds the original');
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(installed.model, 'sonnet');
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(hooks.countOurHandlers(installed), N);

  const second = run('setup.js', ['--config-dir', cfg, '--yes'], env);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /already installed/);
  assert.equal(backups(cfg).length, 1, 'no new backup when nothing changes');

  const removed = run('uninstall.js', ['--config-dir', cfg, '--yes'], env);
  assert.equal(removed.code, 0, removed.out);
  assert.match(removed.out, new RegExp(`Removed ${N} hook`));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  assert.equal(backups(cfg).length, 2);

  const again = run('uninstall.js', ['--config-dir', cfg, '--yes'], env);
  assert.match(again.out, /No Perchbot hooks found/);
});

test('invalid JSON is left untouched and reported', () => {
  const { dir, env } = sandbox();
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  const file = path.join(cfg, 'settings.json');
  fs.writeFileSync(file, '{ "model": "opus", // a comment\n }');
  const before = fs.readFileSync(file, 'utf8');
  for (const script of ['setup.js', 'uninstall.js']) {
    const r = run(script, ['--config-dir', cfg, '--yes'], env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not valid JSON/);
    assert.match(r.out, /NOT changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  assert.deepEqual(backups(cfg), []);
});

test('without --yes and without a terminal, nothing is written', () => {
  const { dir, env } = sandbox();
  const r = run('setup.js', [], env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Re-run with --yes/);
  assert.equal(fs.existsSync(path.join(dir, 'claude-config', 'settings.json')), false);
});

test('--project and --local write into <dir>/.claude', () => {
  const { dir, env } = sandbox();
  const project = path.join(dir, 'my project');
  fs.mkdirSync(project);
  assert.equal(run('setup.js', ['--project', project, '--yes'], env).code, 0);
  assert.equal(hooks.countOurHandlers(JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'))), N);
  assert.equal(run('setup.js', ['--local', project, '--yes'], env).code, 0);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'settings.local.json')));
  const bad = run('setup.js', ['--project', '--local'], env);
  assert.equal(bad.code, 2);
});

test('accounts: ~/.claude and every ~/.claude-<name> Claude Code has used, plus CLAUDE_CONFIG_DIR, once each', () => {
  const { dir } = sandbox();
  const mk = (name, marker) => {
    fs.mkdirSync(path.join(dir, name));
    if (marker) fs.mkdirSync(path.join(dir, name, marker));
  };
  mk('.claude');
  mk('.claude-personal', 'projects');
  mk('.claude-work', 'todos');
  mk('.claude-code-router'); // another tool's folder: nothing of Claude Code's in it
  fs.writeFileSync(path.join(dir, '.claude.json'), '{}'); // a file, not an account
  const names = (found) => found.map((a) => path.basename(a.dir));
  assert.deepEqual(names(cli.findAccounts({ env: {}, home: dir })), ['.claude', '.claude-personal', '.claude-work']);
  // CLAUDE_CONFIG_DIR comes first; pointing at one of them does not list it twice.
  const withEnv = cli.findAccounts({ env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude-work') }, home: dir });
  assert.deepEqual(names(withEnv), ['.claude-work', '.claude', '.claude-personal']);
  assert.match(withEnv[0].why, /CLAUDE_CONFIG_DIR/);
  assert.match(withEnv[1].why, /account "claude"/);
  // Nothing at all yet: ~/.claude (created by setup).
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-empty-'));
  assert.deepEqual(cli.resolveTargets({}, {}, empty), [{ file: path.join(empty, '.claude', 'settings.json'), why: 'default user settings' }]);
  // An option names one file: only that one.
  assert.equal(cli.resolveTargets({ configDir: path.join(dir, 'x') }, {}, dir).length, 1);
});

test('setup without options covers every account with one confirmation; status shows it; uninstall removes it everywhere', () => {
  const { dir, env } = sandbox();
  delete env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.mkdirSync(path.join(dir, '.claude-personal'));
  fs.writeFileSync(path.join(dir, '.claude-personal', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  fs.mkdirSync(path.join(dir, '.claude-work', 'projects'), { recursive: true });

  const dry = run('setup.js', ['--dry-run'], env);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Accounts {6}: 3 found/);
  assert.equal((dry.out.match(new RegExp(`Will add ${N} hooks`, 'g')) || []).length, 3);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.json')), false, 'dry run writes nothing');

  const r = run('setup.js', ['--yes'], env);
  assert.equal(r.code, 0, r.out);
  for (const name of ['.claude', '.claude-personal', '.claude-work']) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, name, 'settings.json'), 'utf8'));
    assert.equal(hooks.countOurHandlers(data), N, name);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude-personal', 'settings.json'), 'utf8')).theme, 'dark', 'other settings kept');
  assert.equal(backups(path.join(dir, '.claude-personal')).length, 1, 'the existing file was backed up');

  const status = run('bin/perchbot.js', ['status'], env);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /accounts found: 3/);
  // One line per account (not the "Electron : installed" line above them).
  assert.equal((status.out.match(/^ {4}claude\S* +installed\r?$/gm) || []).length, 3, status.out);

  const removed = run('bin/perchbot.js', ['uninstall', '--yes'], env);
  assert.equal(removed.code, 0, removed.out);
  for (const name of ['.claude', '.claude-personal', '.claude-work']) {
    assert.equal(hooks.countOurHandlers(JSON.parse(fs.readFileSync(path.join(dir, name, 'settings.json'), 'utf8'))), 0, name);
  }
  assert.match(run('bin/perchbot.js', ['status'], env).out, /not installed/);
});

test('the perchbot command: help, version, unknown commands', () => {
  const { env } = sandbox();
  const help = run('bin/perchbot.js', [], env);
  assert.equal(help.code, 0);
  assert.match(help.out, /perchbot <command>/);
  assert.match(run('bin/perchbot.js', ['--version'], env).out, /^\d+\.\d+\.\d+/);
  assert.equal(run('bin/perchbot.js', ['frobnicate'], env).code, 2);
  const setupHelp = run('bin/perchbot.js', ['setup', '--help'], env);
  assert.match(setupHelp.out, /every Claude Code account/);
});
