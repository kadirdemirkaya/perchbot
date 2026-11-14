'use strict';

/**
 * The rename (Agent Buddy -> Perchbot, lib/names.js): the new names everywhere,
 * and an install from before the rename keeps working as it was.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const names = require('../lib/names');
const hooks = require('../lib/hooks-config');
const send = require('../hooks/send.js');

const ROOT = path.join(__dirname, '..');
const SEND_JS = path.join(ROOT, 'hooks', 'send.js');

test('names: Perchbot, its command, its folder, its hook tag', () => {
  assert.equal(names.NAME, 'Perchbot');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'perchbot');
  assert.deepEqual(pkg.bin, { perchbot: 'bin/perchbot.js' });
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'perchbot.js')));
  assert.ok(/github\.com\/kadirdemirkaya\/perchbot\.git/.test(pkg.repository.url), 'the same name as the repository');
  assert.equal(names.MARKER, '--perchbot');
  assert.equal(hooks.MARKER, '--perchbot');
  assert.equal(names.HOME_DIR, '.perchbot');
});

test('environment: PERCHBOT_* first, the old AGENT_BUDDY_* still read', () => {
  assert.equal(names.envValue('PORT', { PERCHBOT_PORT: '7790', AGENT_BUDDY_PORT: '7791' }), '7790');
  assert.equal(names.envValue('PORT', { AGENT_BUDDY_PORT: '7791' }), '7791');
  assert.equal(names.envValue('PORT', { PERCHBOT_PORT: '', AGENT_BUDDY_PORT: '7791' }), '7791', 'an empty one counts as unset');
  assert.equal(names.envValue('PORT', {}), undefined);
  // The hook reads them the same way.
  const config = send.readConfig({ AGENT_BUDDY_HOME: path.join(ROOT, 'no-such-home'), AGENT_BUDDY_PORT: '7795', AGENT_BUDDY_NO_PID: '1' });
  assert.equal(config.port, 7795);
  assert.equal(config.noPid, true);
  assert.equal(config.home, path.join(ROOT, 'no-such-home'));
});

test('settings folder: ~/.perchbot; an existing ~/.agent-buddy is kept while there is no ~/.perchbot', () => {
  const homedir = path.join('C:', 'Users', 'u');
  const current = path.join(homedir, '.perchbot');
  const old = path.join(homedir, '.agent-buddy');
  const has = (...dirs) => (p) => dirs.includes(p);
  assert.equal(names.homeDir({}, { homedir, exists: has() }), current, 'a fresh install');
  assert.equal(names.homeDir({}, { homedir, exists: has(old) }), old, 'from before the rename: nothing moves');
  assert.equal(names.homeDir({}, { homedir, exists: has(old, current) }), current, 'once the new one exists, that one');
  assert.equal(names.homeDir({ PERCHBOT_HOME: 'x' }, { homedir, exists: has(old) }), path.resolve('x'), 'the variable wins');
});

test('hooks from before the rename: recognised, replaced by setup, removed by uninstall, ignored by the hook', () => {
  const oldCommand = (event) => `node "${SEND_JS.replace(/\\/g, '/')}" ${event} --agent-buddy`;
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: oldCommand('PreToolUse'), async: true }] }],
      Stop: [
        { hooks: [{ type: 'command', command: oldCommand('Stop'), async: true }] },
        { hooks: [{ type: 'command', command: 'echo someone-else' }] },
      ],
    },
  };
  assert.equal(hooks.countOurHandlers(settings), 2, 'still ours');
  assert.equal(hooks.isInstalled(settings, SEND_JS), false, 'not up to date: setup has work to do');
  const { settings: next, replaced } = hooks.addHooks(settings, SEND_JS);
  assert.equal(replaced, 2);
  const commands = Object.values(next.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(!commands.some((c) => c.includes('--agent-buddy')), 'no old tag left');
  assert.ok(commands.includes('echo someone-else'), "other tools' hooks stay");
  assert.equal(hooks.isInstalled(next, SEND_JS), true);
  const { removed } = hooks.removeHooks(settings);
  assert.equal(removed, 2);
  // The hook picks the event name, never a tag, from its arguments.
  const page = fs.readFileSync(SEND_JS, 'utf8');
  assert.ok(page.includes("const argEvent = process.argv.slice(2).find((a) => !a.startsWith('-'));"));
});

test('no old name left in what ships, except where it is read for an older install', () => {
  const allowed = new Set([path.join('lib', 'names.js'), path.join('hooks', 'send.js'), path.join('lib', 'hooks-config.js')]);
  const walk = (dir) =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) return walk(rel);
      return /\.(js|json|html|css|svg|md|ps1)$/.test(e.name) ? [rel] : [];
    });
  for (const rel of [...walk('app'), ...walk('bin'), ...walk('hooks'), ...walk('lib'), ...walk('characters'), 'setup.js', 'uninstall.js', 'README.md', 'package.json']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (allowed.has(rel)) continue;
    assert.ok(!/agent[ -_]?buddy/i.test(text), `${rel} still says Agent Buddy`);
  }
});
