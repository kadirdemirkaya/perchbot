'use strict';

/**
 * Hooks that keep up with the version (app/hook-refresh.js): after an update the
 * overlay adds the hooks the new version listens to, only in accounts that
 * already have this copy's hooks, a backup first; never without Claude Code's
 * version, never in a test home, never in an account hooked to another copy.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hooks = require('../lib/hooks-config');
const refresh = require('../app/hook-refresh');
const { DEFAULTS, normalizeSettings } = require('../app/settings');
const { buildTrayTemplate } = require('../app/tray');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const SEND = 'C:\\Users\\Some One\\AppData\\Roaming\\npm\\node_modules\\perchbot\\hooks\\send.js';
const OTHER = 'C:\\Users\\Some One\\GitHub Projects\\perchbot\\hooks\\send.js';
const NEW = '2.1.300';
const OLD = '2.1.200';

const otherTools = () => ({
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
  },
});

/** An install from before PreCompact and PostModelSwitch: every other hook, for `send`. */
function olderInstall(send = SEND, marker = '--perchbot') {
  const base = otherTools();
  const out = hooks.addHooks(base, send, OLD).settings;
  // Drop PreCompact (added in 0.6.0), as an install from before it has no such entry.
  out.hooks.PreCompact = out.hooks.PreCompact.filter((g) => !g.hooks.some(hooks.isOurHandler));
  if (!out.hooks.PreCompact.length) delete out.hooks.PreCompact;
  if (marker !== '--perchbot') {
    for (const groups of Object.values(out.hooks)) {
      for (const g of groups) for (const h of g.hooks) if (hooks.isOurHandler(h)) h.command = h.command.replace('--perchbot', marker);
    }
  }
  return out;
}

test('hook refresh: the script path of a hook command, and the same file however it is written', () => {
  assert.equal(refresh.scriptOf(hooks.hookCommand(SEND, 'Stop')), SEND.replace(/\\/g, '/'));
  assert.equal(refresh.scriptOf('node /home/me/perchbot/hooks/send.js Stop --perchbot'), '/home/me/perchbot/hooks/send.js');
  assert.equal(refresh.scriptOf('my-guard.sh'), null);
  assert.equal(refresh.scriptOf(42), null);
  assert.ok(refresh.samePath(SEND, SEND.replace(/\\/g, '/'), true));
  assert.ok(refresh.samePath(SEND, SEND.toLowerCase(), true), 'Windows: case does not matter');
  assert.ok(!refresh.samePath('/home/Me/send.js', '/home/me/send.js', false), 'elsewhere it does');
  assert.ok(!refresh.samePath(SEND, OTHER, true));
  assert.ok(!refresh.samePath(SEND, null, true));
});

test('hook refresh: an older install of this copy gets PreCompact and PostModelSwitch, other hooks stay', () => {
  const settings = olderInstall();
  const plan = refresh.planRefresh({ settings, sendJs: SEND, claudeVersion: NEW, caseless: true });
  assert.equal(plan.action, 'refresh');
  assert.deepEqual(plan.missing, ['PreCompact', 'PostModelSwitch']);
  assert.ok(hooks.isInstalled(plan.settings, SEND, NEW), 'exactly the current hooks afterwards');
  assert.equal(hooks.countOtherHandlers(plan.settings), 2, 'other tools keep their hooks');
  assert.equal(plan.settings.model, 'opus', 'the rest of the file is kept');
  assert.equal(hooks.countOurHandlers(settings), hooks.specsFor(OLD).length - 1, 'the input is not changed');
  // Up to date now: nothing more to do.
  assert.deepEqual(refresh.planRefresh({ settings: plan.settings, sendJs: SEND, claudeVersion: NEW, caseless: true }), { action: 'skip', why: 'up to date' });
});

test('hook refresh: the handlers from before the rename (--agent-buddy) get the new tag too', () => {
  const settings = olderInstall(SEND, '--agent-buddy');
  const plan = refresh.planRefresh({ settings, sendJs: SEND, claudeVersion: NEW, caseless: true });
  assert.equal(plan.action, 'refresh');
  assert.ok(hooks.isInstalled(plan.settings, SEND, NEW));
  assert.ok(!JSON.stringify(plan.settings).includes('--agent-buddy'));
});

test('hook refresh: an older Claude Code gets no PostModelSwitch; already complete for it: nothing to do', () => {
  const full = hooks.addHooks(otherTools(), SEND, OLD).settings;
  assert.deepEqual(refresh.planRefresh({ settings: full, sendJs: SEND, claudeVersion: OLD, caseless: true }), { action: 'skip', why: 'up to date' });
  const plan = refresh.planRefresh({ settings: olderInstall(), sendJs: SEND, claudeVersion: OLD, caseless: true });
  assert.deepEqual(plan.missing, ['PreCompact']);
  assert.ok(!plan.settings.hooks.PostModelSwitch);
});

test('hook refresh: never without the version, never an account without our hooks or hooked to another copy', () => {
  // Version unknown: an account with PostModelSwitch would lose it, so nothing is touched.
  const current = hooks.addHooks(otherTools(), SEND, NEW).settings;
  for (const claudeVersion of [null, undefined, '']) {
    assert.deepEqual(refresh.planRefresh({ settings: current, sendJs: SEND, claudeVersion, caseless: true }), { action: 'skip', why: 'Claude Code version unknown' });
  }
  assert.deepEqual(refresh.planRefresh({ settings: otherTools(), sendJs: SEND, claudeVersion: NEW, caseless: true }), {
    action: 'skip',
    why: 'no Perchbot hooks in this account',
  });
  assert.deepEqual(refresh.planRefresh({ settings: {}, sendJs: SEND, claudeVersion: NEW, caseless: true }).why, 'no Perchbot hooks in this account');
  assert.deepEqual(refresh.planRefresh({ settings: olderInstall(OTHER), sendJs: SEND, claudeVersion: NEW, caseless: true }), {
    action: 'skip',
    why: 'hooked to another copy of Perchbot',
  });
  // Some of ours here, one of another copy: left alone as well.
  const mixed = olderInstall();
  mixed.hooks.Stop.push({ hooks: [{ type: 'command', command: hooks.hookCommand(OTHER, 'Stop'), async: true }] });
  assert.equal(refresh.planRefresh({ settings: mixed, sendJs: SEND, claudeVersion: NEW, caseless: true }).why, 'hooked to another copy of Perchbot');
  // A file in a shape we do not know.
  assert.equal(refresh.planRefresh({ settings: { hooks: { Stop: 'x' } }, sendJs: SEND, claudeVersion: NEW, caseless: true }).why, 'unexpected settings format');
});

/** Fake files for refreshAccounts: { file: settings | { error } | undefined (missing) }. */
function fakeIo(files, { failWrite = false } = {}) {
  const calls = [];
  return {
    calls,
    io: {
      read: (file) => {
        const v = files[file];
        if (v === undefined) return { exists: false, data: {} };
        if (v.error) return { exists: true, error: v.error };
        return { exists: true, data: structuredClone(v) };
      },
      backupPath: (file) => `${file}.perchbot-test.bak`,
      backup: (file, target) => calls.push(['backup', file, target]),
      write: (file, data) => {
        if (failWrite) throw new Error('disk full');
        calls.push(['write', file, data]);
      },
    },
  };
}

test('hook refresh: per account, a backup first and then the write; the others only reported', () => {
  const accounts = [
    { dir: 'C:\\Users\\x\\.claude', file: 'A\\settings.json' },
    { dir: 'C:\\Users\\x\\.claude-work', file: 'B\\settings.json' },
    { dir: 'C:\\Users\\x\\.claude-personal', file: 'C\\settings.json' },
    { dir: 'C:\\Users\\x\\.claude-new', file: 'D\\settings.json' },
    { dir: 'C:\\Users\\x\\.claude-broken', file: 'E\\settings.json' },
  ];
  const files = {
    'A\\settings.json': olderInstall(),
    'B\\settings.json': hooks.addHooks({}, SEND, NEW).settings,
    'C\\settings.json': olderInstall(OTHER),
    'E\\settings.json': { error: 'the file is not valid JSON' },
  };
  const { io, calls } = fakeIo(files);
  const results = refresh.refreshAccounts({ accounts, sendJs: SEND, claudeVersion: NEW, io, caseless: true });
  assert.deepEqual(
    results.map((r) => [r.file, r.action, r.why || r.missing.join(',')]),
    [
      ['A\\settings.json', 'refresh', 'PreCompact,PostModelSwitch'],
      ['B\\settings.json', 'skip', 'up to date'],
      ['C\\settings.json', 'skip', 'hooked to another copy of Perchbot'],
      ['D\\settings.json', 'skip', 'no settings file'],
      ['E\\settings.json', 'skip', 'the file is not valid JSON'],
    ],
  );
  assert.deepEqual(
    calls.map((c) => c.slice(0, 2)),
    [
      ['backup', 'A\\settings.json'],
      ['write', 'A\\settings.json'],
    ],
    'only A is touched: its backup before the write',
  );
  assert.equal(results[0].backup, 'A\\settings.json.perchbot-test.bak');
  assert.ok(hooks.isInstalled(calls[1][2], SEND, NEW));

  // One buddy per account: only its own account's folder.
  const own = fakeIo(files);
  const mine = refresh.refreshAccounts({ accounts, sendJs: SEND, claudeVersion: NEW, account: 'claude-work', io: own.io, caseless: true });
  assert.deepEqual(mine.map((r) => r.file), ['B\\settings.json']);
  assert.equal(refresh.accountOf('C:\\Users\\x\\.claude-work'.replace(/\\/g, '/')), 'claude-work');
  assert.equal(refresh.accountOf('/home/x/.claude'), 'claude');

  // A write that fails is reported, nothing thrown.
  const failing = fakeIo(files, { failWrite: true });
  const failed = refresh.refreshAccounts({ accounts: accounts.slice(0, 1), sendJs: SEND, claudeVersion: NEW, io: failing.io, caseless: true });
  assert.deepEqual(failed.map((r) => [r.action, r.why]), [['failed', 'disk full']]);
});

test('hook refresh: switched off, or a test home (PERCHBOT_HOME): the accounts are not looked at', () => {
  assert.equal(refresh.blocked({ settings: { refreshHooks: true }, env: {} }), null);
  assert.equal(refresh.blocked({ settings: {}, env: {} }), null);
  assert.equal(refresh.blocked({ settings: { refreshHooks: false }, env: {} }), 'switched off');
  assert.match(refresh.blocked({ settings: {}, env: { PERCHBOT_HOME: 'C:\\t' } }), /test home/);
  assert.match(refresh.blocked({ settings: {}, env: { AGENT_BUDDY_HOME: 'C:\\t' } }), /test home/);
});

test("hook refresh: Claude Code's version in the background (or from PERCHBOT_CLAUDE_VERSION)", async () => {
  assert.equal(await refresh.claudeVersionLater({ env: { PERCHBOT_CLAUDE_VERSION: '2.1.251' } }), '2.1.251');
  assert.equal(await refresh.claudeVersionLater({ env: { PERCHBOT_CLAUDE_VERSION: 'none' } }), null);
  let asked = null;
  const run = (cmd, opts, cb) => {
    asked = { cmd, opts };
    setImmediate(() => cb(null, '2.1.326 (Claude Code)\n'));
  };
  assert.equal(await refresh.claudeVersionLater({ env: {}, run }), '2.1.326');
  assert.equal(asked.cmd, 'claude --version');
  assert.ok(asked.opts.timeout > 0 && asked.opts.windowsHide);
  assert.equal(await refresh.claudeVersionLater({ env: {}, run: (c, o, cb) => cb(new Error('not found')) }), null);
  assert.equal(
    await refresh.claudeVersionLater({
      env: {},
      run: () => {
        throw new Error('spawn failed');
      },
    }),
    null,
  );
});

test('hook refresh wiring: a switch (on by default) in the tray, once a little after the start, this copy\'s send.js', () => {
  assert.equal(DEFAULTS.refreshHooks, true);
  assert.equal(normalizeSettings({}).refreshHooks, true);
  assert.equal(normalizeSettings({ refreshHooks: false }).refreshHooks, false);
  assert.equal(normalizeSettings({ refreshHooks: 'no' }).refreshHooks, true);
  const seen = [];
  const on = new Proxy({}, { get: (_, key) => (value) => seen.push([key, value]) });
  const item = buildTrayTemplate({ settings: { ...DEFAULTS }, characters: new Map(), sessionCount: 0, on }).find((i) => i.label === 'Keep hooks up to date');
  assert.ok(item, 'tray item');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);
  item.click({ checked: false });
  assert.deepEqual(seen, [['setRefreshHooks', false]]);
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).menu.refreshHooks, lang);

  const main = read('app', 'main.js');
  assert.ok(main.includes("const SEND_JS = path.join(ROOT, 'hooks', 'send.js');"), 'the same script setup points the hooks at');
  assert.equal(path.join(ROOT, 'hooks', 'send.js'), require('../setup').SEND_JS);
  assert.ok(main.includes('hookRefreshTimer = setTimeout(refreshHooks, hookRefresh.HOOK_REFRESH.delayMs);'), 'once, after the start');
  assert.ok(main.includes('const why = hookRefresh.blocked({ settings });'), 'switch and test home first');
  assert.ok(main.includes('await hookRefresh.claudeVersionLater()'), 'the version without blocking');
  assert.ok(main.includes('sendJs: SEND_JS, claudeVersion, account: ACCOUNT'), 'one buddy per account: its own account');
  assert.ok(main.includes('clearTimeout(hookRefreshTimer);'), 'quitting stops it');
  assert.ok(main.includes('if (value) refreshHooks();'), 'turned on: a look right away');
  assert.ok(refresh.HOOK_REFRESH.delayMs >= 3000, 'out of the way of the start');
  // The hook script and setup stay as they were: Node built-ins only, nothing new in the hook.
  assert.ok(!read('hooks', 'send.js').includes('hook-refresh'));
});
