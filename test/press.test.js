'use strict';

/**
 * The press: PreCompact (a hook added in 0.6.0) shows it pumping a little
 * press until the compaction is over; then the old squeeze, plus a cube of
 * paper. Installs without the new hook keep the old squeeze only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hooks = require('../lib/hooks-config');
const send = require('../hooks/send.js');
const { validateEvent } = require('../app/validate');
const { MomentWatch } = require('../app/moments');
const { BuddyCore, DEFAULT_TIMINGS } = require('../app/core');
const { taskFor } = require('../app/tools');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const SEND_JS = path.join(ROOT, 'hooks', 'send.js');

test('hooks: PreCompact is registered (async); an install from before lacks only it', () => {
  const spec = hooks.HOOK_SPECS.find((s) => s.event === 'PreCompact');
  assert.ok(spec, 'registered');
  assert.equal(spec.sync, undefined, 'async like the others: Claude Code does not wait for it');
  const { settings } = hooks.addHooks({}, SEND_JS);
  assert.equal(settings.hooks.PreCompact[0].hooks[0].async, true);
  assert.match(settings.hooks.PreCompact[0].hooks[0].command, /send\.js" PreCompact --perchbot$/);
  assert.deepEqual(hooks.missingEvents(settings, SEND_JS), []);
  // As written by 0.5.0: everything but PreCompact.
  const before = structuredClone(settings);
  delete before.hooks.PreCompact;
  assert.equal(hooks.isInstalled(before, SEND_JS), false, 'setup and doctor will add it');
  assert.deepEqual(hooks.missingEvents(before, SEND_JS), ['PreCompact']);
  assert.deepEqual(hooks.missingEvents({}, SEND_JS), hooks.HOOK_SPECS.map((s) => s.event));
  // Setup on top of it: exactly our hooks again, nothing doubled.
  const again = hooks.addHooks(before, SEND_JS).settings;
  assert.equal(hooks.isInstalled(again, SEND_JS), true);
  assert.equal(hooks.countOurHandlers(again), hooks.HOOK_SPECS.length);
});

test('hook: PreCompact leaves with the event only (never its custom instructions or trigger)', () => {
  const input = {
    hook_event_name: 'PreCompact',
    session_id: 'abc123',
    transcript_path: 'C:/Users/someone/.claude/projects/x/abc123.jsonl',
    cwd: 'C:/Users/someone/secret-project',
    trigger: 'manual',
    custom_instructions: 'keep the API key sk-live-1234567890 and the customer list',
  };
  const payload = send.buildPayload(input, 'PreCompact', 1000, { account: 'claude-work' });
  assert.deepEqual(payload, { v: 1, event: 'PreCompact', session: 'abc123', ts: 1000, account: 'claude-work' });
  const text = JSON.stringify(payload);
  for (const secret of ['sk-live', 'customer', 'manual', 'secret-project', 'jsonl']) assert.ok(!text.includes(secret), secret);
  // The overlay takes it as it is.
  assert.deepEqual(validateEvent(payload), payload);
  // Not an event that starts the overlay.
  assert.ok(!/LAUNCH_EVENTS = new Set\([^)]*PreCompact/.test(read('hooks', 'send.js')));
});

test('moment watch: a cube only for the session whose press ran; the squeeze as before', () => {
  const w = new MomentWatch();
  assert.deepEqual(w.sessionStart('compact', 'a'), ['squeeze'], 'no PreCompact (an older install): as before');
  w.preCompact('a');
  assert.deepEqual(w.sessionStart('startup', 'b'), [], 'another session starting does not end it');
  assert.deepEqual(w.sessionStart('compact', 'a'), ['squeeze', 'cube']);
  assert.deepEqual(w.sessionStart('compact', 'a'), ['squeeze'], 'once');
  w.preCompact('c');
  assert.deepEqual(w.sessionStart('resume', 'c'), [], 'not a compaction after all: no cube, and it is over');
  assert.deepEqual(w.sessionStart('compact', 'c'), ['squeeze']);
});

test('core: PreCompact pumps the press until the compaction is over, then the squeeze and a cube', () => {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, now: () => clock.now });
  const moments = [];
  core.on('moment', (m) => moments.push(m));
  const ev = (event, extra = {}) => core.handle({ v: 1, event, session: 's1', ts: clock.now, ...extra });
  ev('SessionStart', { source: 'startup' });
  ev('UserPromptSubmit');
  clock.tick(5000);
  ev('PreCompact');
  assert.equal(core.state, 'working');
  assert.deepEqual(core.snapshot().message, { key: 'compacting' });
  assert.equal(taskFor('compacting'), 'compact');
  clock.tick(60000);
  assert.equal(core.state, 'working', 'it keeps pumping while Claude Code compacts');
  ev('SessionStart', { source: 'compact' });
  assert.equal(core.state, 'greeting', 'then the old greeting');
  assert.deepEqual(moments, ['squeeze', 'cube']);
  // A compaction that never reports back: it stops after compactMs.
  ev('PreCompact');
  clock.tick(DEFAULT_TIMINGS.compactMs - 1);
  assert.deepEqual(core.snapshot().message, { key: 'compacting' });
  clock.tick(1);
  assert.notEqual(core.snapshot().message && core.snapshot().message.key, 'compacting');
  core.dispose();
});

test('chat: "what are you doing?" during the press', () => {
  const src = read('app', 'chat.js');
  assert.ok(src.includes("if (f.message && f.message.key === 'compacting') return ['doingCompacting'];"));
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(read('app', 'locales', `${lang}.json`));
    assert.ok(strings.chat.doingCompacting, `${lang}: chat`);
    assert.ok(strings.bubble.compacting, `${lang}: bubble`);
    assert.ok(strings.bubble.compacting.length <= 24, `${lang}: the bubble fits`);
  }
});

test('perchbot status: an install from before PreCompact says what to add', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-press-'));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PERCHBOT_HOME: path.join(dir, '.perchbot'), INIT_CWD: dir, PERCHBOT_CLAUDE_VERSION: 'none' };
  delete env.CLAUDE_CONFIG_DIR;
  const fake = path.join(dir, 'fake-claude');
  fs.mkdirSync(fake);
  const { settings } = hooks.addHooks({}, SEND_JS);
  delete settings.hooks.PreCompact;
  fs.writeFileSync(path.join(fake, 'settings.json'), JSON.stringify(settings, null, 2));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'perchbot.js'), 'status', '--config-dir', fake], { env, encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /installed \(new hooks missing: PreCompact\): run "perchbot setup" to add them/);
});

test('the page and Robo: the press, the cube of paper, the demo', () => {
  const svg = read('characters', 'robot', 'robot.svg');
  for (const cls of ['rb-compactor', 'rb-press-ram', 'rb-press-stack', 'rb-press-loose-1', 'rb-press-loose-2']) assert.ok(svg.includes(`class="${cls}"`), cls);
  assert.match(svg, /<g class="rb-compactor" data-nohit="">/);
  const css = read('characters', 'robot', 'robot.css');
  for (const rule of [
    ".buddy-character[data-task='compact'] .rb-compactor {",
    ".buddy-character[data-task='compact'] .rb-laptop {",
    ".buddy-character[data-task='compact'] .rb-arm-front {",
    ".buddy-character[data-task='compact'] .rb-press-ram {",
  ]) {
    assert.ok(css.includes(rule), rule);
  }
  // Focus mode's screen of light stays off during the press and the popcorn (after its own rules: wins).
  const quiet = css.indexOf(".buddy-character[data-holo][data-state]:is([data-task='popcorn'], [data-task='compact']) .rb-holo {");
  assert.ok(quiet > css.indexOf('/* The laptop gives way. */'), 'after the focus-mode rules');
  assert.ok(css.includes(".buddy-character[data-holo][data-state][data-task='popcorn'] .rb-laptop {\n  opacity: 1;\n}"));
  const html = read('app', 'renderer', 'index.html');
  assert.ok(html.includes('<symbol id="i-cube" viewBox="0 0 24 24">'));
  const overlay = read('app', 'renderer', 'overlay.css');
  assert.ok(overlay.includes('.fx-cube {'));
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(/const TASKS = new Set\(\[[^\]]*'compact'/.test(page));
  assert.ok(page.includes("if (kind === 'cube') {"));
  assert.ok(page.includes("use.setAttribute('href', '#i-cube');"));
  assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: 'compact' }), 'demo');
});
