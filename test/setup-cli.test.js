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

const ROOT = path.join(__dirname, '..');
const N = hooks.HOOK_SPECS.length;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-buddy-setup-'));
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    AGENT_BUDDY_HOME: path.join(dir, '.agent-buddy'),
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
  assert.match(again.out, /No Agent Buddy hooks found/);
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
