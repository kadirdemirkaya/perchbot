'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const hooks = require('../lib/hooks-config');

const SEND = 'C:\\Users\\Some One\\GitHub Projects\\perchbot\\hooks\\send.js';

const otherTools = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    PostCompact: [{ hooks: [{ type: 'command', command: 'echo compacted' }] }],
  },
});

test('commands quote the path with forward slashes and carry the tag', () => {
  assert.equal(
    hooks.hookCommand(SEND, 'PreToolUse'),
    'node "C:/Users/Some One/GitHub Projects/perchbot/hooks/send.js" PreToolUse --perchbot',
  );
  assert.equal(hooks.hookCommand('/home/me/perchbot/hooks/send.js', 'Stop'), 'node "/home/me/perchbot/hooks/send.js" Stop --perchbot');
  assert.throws(() => hooks.hookCommand('C:\\$weird\\send.js', 'Stop'), /cannot be quoted/);
  assert.throws(() => hooks.hookCommand('/a/`b`/send.js', 'Stop'), /cannot be quoted/);
});

test('adds one group per event, async except SessionEnd, matcher only on tool events', () => {
  const { settings, added } = hooks.addHooks({}, SEND);
  assert.deepEqual(Object.keys(settings.hooks), hooks.HOOK_SPECS.map((s) => s.event));
  assert.equal(added.length, hooks.HOOK_SPECS.length);
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: '*', hooks: [{ type: 'command', command: hooks.hookCommand(SEND, 'PreToolUse'), async: true }] },
  ]);
  assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', command: hooks.hookCommand(SEND, 'SessionStart'), async: true }] }]);
  assert.deepEqual(settings.hooks.SessionEnd, [{ hooks: [{ type: 'command', command: hooks.hookCommand(SEND, 'SessionEnd') }] }]);
});

test('existing settings and other hooks are preserved, input is not mutated', () => {
  const original = otherTools();
  const snapshot = JSON.stringify(original);
  const { settings } = hooks.addHooks(original, SEND);
  assert.equal(JSON.stringify(original), snapshot, 'input untouched');
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, original.permissions);
  assert.deepEqual(settings.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(settings.hooks.PostCompact, original.hooks.PostCompact);
  assert.equal(hooks.countOtherHandlers(settings), 3);
  assert.equal(hooks.countOurHandlers(settings), hooks.HOOK_SPECS.length);
});

test('running add twice does not duplicate; a moved repo replaces old entries', () => {
  const once = hooks.addHooks(otherTools(), SEND).settings;
  const twice = hooks.addHooks(once, SEND).settings;
  assert.equal(hooks.countOurHandlers(twice), hooks.HOOK_SPECS.length);
  assert.ok(hooks.isInstalled(twice, SEND));

  const moved = hooks.addHooks(once, 'D:\\elsewhere\\perchbot\\hooks\\send.js');
  assert.equal(moved.replaced, hooks.HOOK_SPECS.length);
  assert.equal(hooks.countOurHandlers(moved.settings), hooks.HOOK_SPECS.length);
  assert.ok(!JSON.stringify(moved.settings).includes('Some One'));
  assert.ok(!hooks.isInstalled(moved.settings, SEND));
});

test('remove takes out only our handlers and restores the original structure', () => {
  const original = otherTools();
  const installed = hooks.addHooks(original, SEND).settings;
  const { settings, removed } = hooks.removeHooks(installed);
  assert.equal(removed, hooks.HOOK_SPECS.length);
  assert.deepEqual(settings, original);

  const fresh = hooks.removeHooks(hooks.addHooks({ theme: 'dark' }, SEND).settings).settings;
  assert.deepEqual(fresh, { theme: 'dark' }, 'empty hooks object is removed again');
});

test('a shared matcher group keeps the other handler when ours is removed', () => {
  const ours = hooks.buildGroups(SEND).find((g) => g.event === 'Stop').group.hooks[0];
  const mixed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }, ours] }] } };
  const { settings, removed } = hooks.removeHooks(mixed);
  assert.equal(removed, 1);
  assert.deepEqual(settings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('only tagged send.js commands count as ours', () => {
  assert.ok(hooks.isOurHandler({ type: 'command', command: 'node "/x/hooks/send.js" Stop --perchbot' }));
  assert.ok(!hooks.isOurHandler({ type: 'command', command: 'node "/x/hooks/send.js" Stop' }));
  assert.ok(!hooks.isOurHandler({ type: 'command', command: 'echo --perchbot-ish send.js' }));
  assert.ok(!hooks.isOurHandler({ type: 'http', url: 'http://x' }));
  assert.ok(!hooks.isOurHandler(null));
});

test('refuses to edit unexpected shapes', () => {
  assert.throws(() => hooks.addHooks({ hooks: [] }, SEND), /"hooks" is not an object/);
  assert.throws(() => hooks.addHooks({ hooks: { Stop: {} } }, SEND), /"hooks.Stop" is not an array/);
  assert.throws(() => hooks.addHooks([], SEND), /JSON object/);
  // Odd entries under events we do not use are left alone.
  const odd = { hooks: { Custom: 'whatever', Stop: [null, { hooks: 'x' }] } };
  const { settings } = hooks.addHooks(odd, SEND);
  assert.equal(settings.hooks.Custom, 'whatever');
  assert.deepEqual(settings.hooks.Stop.slice(0, 2), [null, { hooks: 'x' }]);
});
