'use strict';

/**
 * Two layers on top of the old moments (app/moments.js, app/core.js): the
 * rubber duck when it is stuck (a failure streak past the sweat), and popcorn
 * while a command runs on and on. The old reactions stay as they were.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MomentWatch, SWEAT_AFTER, DUCK_AFTER } = require('../app/moments');
const { BuddyCore, DEFAULT_TIMINGS } = require('../app/core');
const { taskFor } = require('../app/tools');
const { validateEvent } = require('../app/validate');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function setup(timings = {}) {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, timings, now: () => clock.now });
  const moments = [];
  core.on('moment', (m) => moments.push(m));
  const ev = (event, extra = {}) => core.handle({ v: 1, event, session: 's1', ts: clock.now, ...extra });
  return { clock, core, moments, ev };
}

function fail(ev, id, tool = 'Edit') {
  ev('PreToolUse', { tool, id, detail: 'core.js' });
  ev('PostToolUseFailure', { tool, id });
}

test('moment watch: the duck comes out after the sweat, once, and goes with the streak', () => {
  assert.ok(DUCK_AFTER > SWEAT_AFTER, 'a layer after the sweat');
  const w = new MomentWatch();
  const out = [];
  for (let i = 1; i <= DUCK_AFTER + 2; i += 1) out.push(...w.toolEnd('s', `f${i}`, false));
  assert.deepEqual(out, ['sweat', 'duck'], 'sweat at 3 as before, the duck at 5, each once');
  assert.equal(w.ducking, true);
  assert.equal(w.sweating, true);
  assert.deepEqual(w.toolEnd('s', 'ok', true), ['phew'], 'a tool that works: the old phew (the page thanks the duck)');
  assert.equal(w.ducking, false);
  for (let i = 0; i < DUCK_AFTER; i += 1) w.toolEnd('s', `g${i}`, false);
  assert.equal(w.ducking, true);
  w.calm();
  assert.equal(w.ducking, false, 'a new prompt or a stop puts it away');
  for (let i = 0; i < DUCK_AFTER - 1; i += 1) w.toolEnd('s', `h${i}`, false);
  assert.equal(w.ducking, false, 'not before DUCK_AFTER');
});

test('core: stuck, the duck sits on its head at work until a tool works; the turn ending puts it away', () => {
  const { core, moments, ev } = setup();
  ev('UserPromptSubmit');
  for (let i = 1; i < DUCK_AFTER; i += 1) fail(ev, `f${i}`);
  assert.equal(core.snapshot().duck, false, 'only sweating so far');
  assert.equal(core.snapshot().mood, 'sweat', 'the old sweat from the third failure on');
  fail(ev, 'f5');
  assert.equal(moments.filter((m) => m === 'duck').length, 1);
  assert.deepEqual(moments, ['sweat', 'duck']);
  assert.equal(core.snapshot().duck, true);
  ev('PreToolUse', { tool: 'Read', id: 'r1', detail: 'core.js' });
  assert.equal(core.snapshot().duck, true, 'still out at work');
  assert.equal(core.snapshot().mood, 'sweat', 'the old sweat is unchanged');
  ev('Notification', { kind: 'permission_prompt' });
  assert.equal(core.snapshot().duck, true, 'and while it waits for the user');
  ev('PostToolUse', { tool: 'Read', id: 'r1' });
  assert.equal(moments.at(-1), 'phew');
  assert.equal(core.snapshot().duck, false, 'a tool worked: off it goes');

  for (let i = 1; i <= DUCK_AFTER; i += 1) fail(ev, `g${i}`);
  assert.equal(core.snapshot().duck, true);
  ev('Stop');
  assert.equal(core.state, 'done');
  assert.equal(core.snapshot().duck, false, 'the turn is over');
  core.dispose();
});

test('core: a refresh carries the duck even when the failure brings no new mood', () => {
  const { core, ev } = setup();
  const seen = [];
  core.on('state', (s) => seen.push(s.duck));
  ev('UserPromptSubmit');
  // Parallel tools: the later failures find the view already worried.
  for (let i = 1; i <= DUCK_AFTER; i += 1) ev('PreToolUse', { tool: 'Bash', id: `p${i}`, detail: 'npm test' });
  for (let i = 1; i <= DUCK_AFTER; i += 1) ev('PostToolUseFailure', { tool: 'Bash', id: `p${i}` });
  assert.equal(seen.at(-1), true, 'the page heard about the duck');
  core.dispose();
});

test('core: a command that runs on and on turns into popcorn after snackMs, the bubble keeps the command', () => {
  assert.equal(DEFAULT_TIMINGS.snackMs, 20000);
  const { clock, core, ev } = setup();
  const keys = [];
  core.on('state', (s) => keys.push(s.message && s.message.key));
  ev('UserPromptSubmit');
  ev('PreToolUse', { tool: 'Bash', id: 'b1', detail: 'npm install' });
  clock.tick(19999);
  assert.deepEqual(core.snapshot().message, { key: 'running', vars: { command: 'npm install' }, mono: true });
  clock.tick(1);
  assert.equal(core.state, 'running', 'still the running state: the old revert logic is untouched');
  assert.deepEqual(core.snapshot().message, { key: 'runningLong', vars: { command: 'npm install' }, mono: true });
  assert.equal(taskFor(core.snapshot().message.key), 'popcorn');
  assert.equal(keys.at(-1), 'runningLong', 'emitted');
  // The command ends: the old hold, then back to thinking.
  ev('PostToolUse', { tool: 'Bash', id: 'b1' });
  clock.tick(DEFAULT_TIMINGS.holdMs);
  assert.equal(core.state, 'thinking');
  // PowerShell, without a command: the plain text, popcorn all the same.
  ev('PreToolUse', { tool: 'PowerShell', id: 'p1' });
  clock.tick(20000);
  assert.deepEqual(core.snapshot().message, { key: 'runningLongNoCommand' });
  assert.equal(taskFor('runningLongNoCommand'), 'popcorn');
  core.dispose();
});

test('core: no popcorn when something else happens, the command ends in time, or for other tools', () => {
  const { clock, core, ev } = setup();
  ev('UserPromptSubmit');
  // Ends at 19 s: the hold must not turn into popcorn at 20 s.
  ev('PreToolUse', { tool: 'Bash', id: 'a', detail: 'npm test' });
  clock.tick(19000);
  ev('PostToolUse', { tool: 'Bash', id: 'a' });
  clock.tick(1000);
  assert.equal(core.snapshot().message.key, 'running', 'held as before, no popcorn');
  clock.tick(1000);
  assert.equal(core.state, 'thinking');
  // Another event meanwhile (a notification): no popcorn.
  ev('PreToolUse', { tool: 'Bash', id: 'b', detail: 'npm test' });
  clock.tick(5000);
  ev('Notification', { kind: 'permission_prompt' });
  clock.tick(30000);
  assert.equal(core.state, 'waiting');
  assert.equal(core.snapshot().message.key, 'waiting');
  // A new command restarts the wait.
  ev('PreToolUse', { tool: 'Bash', id: 'c', detail: 'npm test' });
  clock.tick(15000);
  ev('PreToolUse', { tool: 'Bash', id: 'd', detail: 'npm run build' });
  clock.tick(15000);
  assert.equal(core.snapshot().message.key, 'running');
  clock.tick(5000);
  assert.deepEqual(core.snapshot().message.vars, { command: 'npm run build' });
  assert.equal(core.snapshot().message.key, 'runningLong');
  // Not for file tools or the web.
  ev('PostToolUse', { tool: 'Bash', id: 'c' });
  ev('PostToolUse', { tool: 'Bash', id: 'd' });
  ev('PreToolUse', { tool: 'WebFetch', id: 'w', detail: 'example.com' });
  clock.tick(60000);
  assert.equal(core.snapshot().message.key, 'webFetch');
  core.dispose();
});

test('core: snackMs 0 turns popcorn off', () => {
  const { clock, core, ev } = setup({ snackMs: 0 });
  ev('PreToolUse', { tool: 'Bash', id: 'a', detail: 'sleep 60' });
  clock.tick(60000);
  assert.equal(core.snapshot().message.key, 'running');
  core.dispose();
});

test('the page and Robo show the duck and the popcorn', () => {
  // Strings in both languages; main.js passes the lines to the page.
  const main = read('app', 'main.js');
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(read('app', 'locales', `${lang}.json`));
    assert.equal(strings.bubble.runningLong, strings.bubble.running, `${lang}: the bubble keeps the command`);
    assert.equal(strings.bubble.runningLongNoCommand, strings.bubble.runningNoCommand, lang);
    for (const key of ['popcorn', 'duck', 'duckThanks']) {
      assert.ok(strings.quip[key], `${lang}: quip ${key}`);
      // The bubble cuts longer lines (max-width); the longest old ones are ~26 characters.
      assert.ok(strings.quip[key].length <= 24, `${lang}: quip ${key} fits the bubble`);
      assert.ok(main.includes(`'${key}'`), `main.js passes ${key}`);
    }
  }
  assert.ok(main.includes('duck: Boolean(snap.duck),'), 'the view carries the duck');
  // The page: popcorn is a task, the duck a flag, thanks when it works.
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(/const TASKS = new Set\(\[[^\]]*'popcorn'/.test(page));
  assert.ok(page.includes("flag('duck', next.duck ? 'on' : holder.dataset.duck === 'bye' ? 'bye' : null);"));
  assert.ok(page.includes("if (kind === 'phew' && holder.dataset.duck === 'on') {"));
  assert.ok(page.includes("quip('duckThanks', 1800);"));
  assert.ok(page.includes("if (next.task === 'popcorn' && previous.task !== 'popcorn') {"));
  assert.ok(page.includes("if (!next.duck) quip('popcorn', 2600);"));
  // Robo: the duck (drawn once, used on the head and in the hand) and the bucket.
  const svg = read('characters', 'robot', 'robot.svg');
  assert.ok(svg.includes('<g id="rb-duck-art">'));
  assert.match(svg, /<g class="rb-duck" data-nohit="">\s*<use href="#rb-duck-art"\/>/);
  assert.match(svg, /<g class="rb-duck-held" data-nohit="">\s*<use href="#rb-duck-art" transform=/);
  for (const cls of ['rb-popcorn', 'rb-kernel rb-kernel-1', 'rb-kernel rb-kernel-2', 'rb-kernel-held']) assert.ok(svg.includes(`class="${cls}"`), cls);
  const css = read('characters', 'robot', 'robot.css');
  for (const rule of [
    ".buddy-character[data-duck='on'] .rb-duck {",
    ".buddy-character[data-duck='bye'] .rb-duck {",
    ".buddy-character[data-moment='duck'] .rb-duck {",
    ".buddy-character[data-moment='duck'] .rb-arm-back {",
    ".buddy-character[data-task='popcorn'] .rb-popcorn {",
    ".buddy-character[data-task='popcorn']:not([data-fly]) .rb-torso {",
    ".buddy-character[data-task='popcorn'] .rb-arm-front {",
  ]) {
    assert.ok(css.includes(rule), rule);
  }
  // The hop's rules come after the duck's own, so they win while it plays.
  assert.ok(css.indexOf(".buddy-character[data-moment='duck'] .rb-duck {") > css.indexOf(".buddy-character[data-duck='on'] .rb-duck {"));
  // The simulator can show both.
  for (const demo of ['duck', 'popcorn']) assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo }), demo);
});
