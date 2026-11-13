'use strict';

/** Moments of the work (app/moments.js) and how the overlay shows them. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MomentWatch, gitMoments, greetingKey, doneMessage, SWEAT_AFTER, SUMMARY } = require('../app/moments');
const { BuddyCore } = require('../app/core');
const { FakeClock } = require('./helpers/fake-clock');
const { validateEvent } = require('../app/validate');
const send = require('../hooks/send.js');

const ROOT = path.join(__dirname, '..');

test('git moments: commit and push, as the hook shortens the command', () => {
  const cases = [
    ['git commit -m "fix it"', ['commit']],
    ['git add -A && git commit -m "x"', ['commit']],
    ['git commit -m x && git push', ['commit', 'push']],
    ['git -C repo commit -am x', ['commit']],
    ['git -c user.name=x push', ['push']],
    ['git --no-pager push -u origin main', ['push']],
    ['git push -u *** main', ['push']],
    ['git log -1 --format=x', []],
    ['git status; npm test', []],
    ['echo git commit', []],
    ['npm test', []],
    ['', []],
  ];
  for (const [command, want] of cases) assert.deepEqual(gitMoments(command), want, command);
  assert.deepEqual(gitMoments(undefined), []);
  // As it really arrives (hooks/send.js summarizeCommand).
  assert.deepEqual(gitMoments(send.summarizeCommand('cd repo && git push -u origin main')), ['push']);
  assert.deepEqual(gitMoments(send.summarizeCommand('git add -A && git commit -m "add a thing"')), ['commit']);
});

test('moment watch: a flag or a rocket only when the command worked; sweat after a streak, then phew', () => {
  const w = new MomentWatch();
  w.toolStart('s', 't1', 'Bash', 'git commit -m x');
  assert.deepEqual(w.toolEnd('s', 't1', true), ['commit']);
  w.toolStart('s', 't2', 'PowerShell', 'git push');
  assert.deepEqual(w.toolEnd('s', 't2', false), [], 'a failed push: no rocket');
  w.toolStart('s', 't3', 'Read', 'git push');
  assert.deepEqual(w.toolEnd('s', 't3', true), [], 'not a command tool');
  w.calm();
  // The streak
  for (let i = 1; i < SWEAT_AFTER; i += 1) assert.deepEqual(w.toolEnd('s', `f${i}`, false), []);
  assert.equal(w.sweating, false);
  assert.deepEqual(w.toolEnd('s', 'f3', false), ['sweat']);
  assert.equal(w.sweating, true);
  assert.deepEqual(w.toolEnd('s', 'f4', false), [], 'once');
  w.toolStart('s', 't4', 'Bash', 'git commit -m fixed');
  assert.deepEqual(w.toolEnd('s', 't4', true), ['phew', 'commit']);
  assert.equal(w.sweating, false);
  // calm() ends a streak too (a new prompt, a stop).
  for (let i = 0; i < SWEAT_AFTER; i += 1) w.toolEnd('s', `g${i}`, false);
  w.calm();
  assert.equal(w.sweating, false);
  assert.deepEqual(w.sessionStart('compact'), ['squeeze']);
  assert.deepEqual(w.sessionStart('startup'), []);
  // The memory of started tools stays small.
  for (let i = 0; i < 200; i += 1) w.toolStart('s', `x${i}`, 'Bash', 'git push');
  assert.ok(w.pending.size <= 64);
});

test('greeting by the time of day; a summary for a longer turn', () => {
  assert.equal(greetingKey(8), 'greetingMorning');
  assert.equal(greetingKey(14), 'greeting');
  assert.equal(greetingKey(20), 'greetingEvening');
  assert.equal(greetingKey(23), 'greetingNight');
  assert.equal(greetingKey(2), 'greetingNight');
  assert.equal(greetingKey(5), 'greetingMorning');
  assert.equal(greetingKey('x'), 'greeting');
  assert.deepEqual(doneMessage(null, 5), { key: 'done' });
  assert.deepEqual(doneMessage({ tools: 1, startedAt: 0 }, 5000), { key: 'done' }, 'short and small');
  assert.deepEqual(doneMessage({ tools: SUMMARY.tools, startedAt: 0 }, 5000), { key: 'doneSummary', vars: { count: '3', ms: 5000 } });
  assert.deepEqual(doneMessage({ tools: 0, startedAt: 0 }, SUMMARY.ms), { key: 'doneSummary', vars: { count: '0', ms: SUMMARY.ms } });
});

test('core: moments from the hook events, the sweat mood, and the done summary', () => {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, now: () => clock.now });
  const moments = [];
  core.on('moment', (m) => moments.push(m));
  const ev = (event, extra = {}) => core.handle({ v: 1, event, session: 's1', ts: clock.now, ...extra });
  ev('SessionStart', { source: 'compact' });
  assert.deepEqual(moments, ['squeeze']);
  clock.tick(10);
  ev('UserPromptSubmit');
  ev('PreToolUse', { tool: 'Bash', id: 'a', detail: 'git commit -m x' });
  ev('PostToolUse', { tool: 'Bash', id: 'a' });
  assert.deepEqual(moments, ['squeeze', 'commit']);
  for (const id of ['b', 'c', 'd']) {
    ev('PreToolUse', { tool: 'Bash', id, detail: 'npm test' });
    ev('PostToolUseFailure', { tool: 'Bash', id });
  }
  assert.equal(moments.at(-1), 'sweat');
  ev('PreToolUse', { tool: 'Bash', id: 'e', detail: 'npm test' });
  assert.equal(core.snapshot().mood, 'sweat', 'sweats at work');
  ev('PostToolUse', { tool: 'Bash', id: 'e' });
  assert.equal(moments.at(-1), 'phew');
  ev('PreToolUse', { tool: 'Bash', id: 'f', detail: 'git push' });
  assert.notEqual(core.snapshot().mood, 'sweat');
  ev('PostToolUse', { tool: 'Bash', id: 'f' });
  assert.equal(moments.at(-1), 'push');
  clock.tick(90000);
  ev('Stop');
  assert.equal(core.snapshot().message.key, 'doneSummary', 'six tools: a summary');
  assert.equal(core.snapshot().message.vars.count, '6');
  core.dispose();
});

test('the page shows the moments: flag and rocket symbols, the robot sweats, phews, squeezes and knocks', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), 'utf8');
  for (const id of ['i-flag', 'i-rocket']) assert.ok(html.includes(`<symbol id="${id}"`), id);
  const overlay = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'overlay.css'), 'utf8');
  for (const cls of ['.fx-flag', '.fx-rocket', '.fx-puff', '.fx-knock']) assert.ok(overlay.includes(`${cls} {`), cls);
  const svg = fs.readFileSync(path.join(ROOT, 'characters', 'robot', 'robot.svg'), 'utf8');
  assert.match(svg, /class="rb-sweat" data-nohit=""/);
  const css = fs.readFileSync(path.join(ROOT, 'characters', 'robot', 'robot.css'), 'utf8');
  for (const rule of ["[data-mood='sweat'] .rb-sweat", "[data-moment='phew']", "[data-moment='squeeze'] .rb-head", "[data-nudge='psst']", "[data-nudge='knock'] .rb-arm-front"]) {
    assert.ok(css.includes(rule), rule);
  }
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['greetingMorning', 'greetingEvening', 'greetingNight', 'doneSummary']) assert.ok(strings.bubble[key], `${lang}: ${key}`);
    assert.ok(strings.bubble.doneSummary.includes('{count}') && strings.bubble.doneSummary.includes('{time}'));
    for (const key of ['commit', 'push', 'phew', 'squeeze', 'nudge', 'knock']) {
      assert.ok(strings.quip[key], `${lang}: quip ${key}`);
      assert.ok(main.includes(`'${key}'`), `main.js passes the quip ${key}`);
    }
  }
  for (const demo of ['commit', 'push', 'sweat', 'phew', 'squeeze', 'psst', 'knock']) {
    assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo }), `${demo} is a valid demo`);
  }
  const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');
  assert.ok(preload.includes("onMoment: on('buddy:moment')"));
});
