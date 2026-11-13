'use strict';

/** The user away and back (app/presence.js), and "What's this?" on the page. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PresenceWatch, PRESENCE } = require('../app/presence');
const { validateEvent } = require('../app/validate');

const ROOT = path.join(__dirname, '..');

test('presence: away after a quiet while, back at the first input, with how long', () => {
  const w = new PresenceWatch();
  let now = 1_000_000;
  assert.equal(w.feed(10, now), null);
  assert.equal(w.feed(PRESENCE.awayS - 1, now), null);
  assert.deepEqual(w.feed(PRESENCE.awayS, now), { kind: 'away' });
  assert.equal(w.feed(PRESENCE.awayS + 100, (now += 100000)), null, 'once');
  now += 200000;
  const back = w.feed(1, now);
  assert.equal(back.kind, 'back');
  assert.equal(back.awayMs, now - (1_000_000 - PRESENCE.awayS * 1000), 'counted from the last input');
  assert.equal(w.feed(1, now + 10000), null, 'once');
  // Not back yet while the input is not fresh.
  w.feed(PRESENCE.awayS, now);
  assert.equal(w.feed(PRESENCE.backS + 1, now + 5000), null);
  for (const bad of [NaN, -1, 'x', undefined]) assert.equal(new PresenceWatch().feed(bad, now), null);
});

test('presence: a lock is away at once; unlocking after a while is back, a short lock is not', () => {
  const w = new PresenceWatch();
  assert.deepEqual(w.locked(0), { kind: 'away' });
  assert.equal(w.locked(10), null, 'locked twice');
  assert.equal(w.feed(0, 1000), null, 'no idle readings while locked');
  const back = w.unlocked(PRESENCE.lockedMs + 5);
  assert.deepEqual(back, { kind: 'back', awayMs: PRESENCE.lockedMs + 5 });
  assert.equal(w.unlocked(99), null, 'not locked');
  w.locked(1000);
  assert.equal(w.unlocked(1000 + PRESENCE.lockedMs - 1), null, 'a short lock: nothing to say');
  assert.equal(w.away, false);
  // Already away when it was locked: the time counts from the last input.
  const v = new PresenceWatch();
  v.feed(PRESENCE.awayS, 400000);
  assert.equal(v.locked(500000), null);
  assert.equal(v.unlocked(700000).awayMs, 700000 - (400000 - PRESENCE.awayS * 1000));
  assert.ok(PRESENCE.pollMs >= 5000, 'a cheap poll');
});

test('the page asks "What\'s this?" with answers to click, and says welcome back', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('id="bubble-choices"'));
  const css = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'overlay.css'), 'utf8');
  for (const rule of ['.bubble.ask .bubble-choices', '.bubble.ask.show', '.bubble-choice {']) assert.ok(css.includes(rule), rule);
  const page = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(page.includes("if (el.closest('.bubble.ask.show .bubble-choice')) return 'bubble';"), 'the answers take the mouse');
  assert.ok(page.includes('button.textContent = quipString(c.label);'), 'as text, never markup');
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['welcomeBack', 'welcomeBackLong', 'whatsThis', 'choiceCode', 'choiceGame', 'choiceNone', 'curiousCode', 'curiousGame', 'curiousNone']) {
      assert.ok(strings.quip[key], `${lang}: ${key}`);
      assert.ok(main.includes(`'${key}'`), `main.js passes ${key}`);
    }
    const choices = ['choiceCode', 'choiceGame', 'choiceNone'].map((k) => strings.quip[k]).join('');
    assert.ok(choices.length <= 24, `${lang}: the three answers fit in the bubble (${choices.length} characters)`);
  }
  const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');
  assert.ok(preload.includes("onPresence: on('buddy:presence')"));
  for (const demo of ['curious', 'welcome']) assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo }), demo);
});
