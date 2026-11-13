'use strict';

/**
 * Focus mode: intense work (lib/fun.js FocusMeter) -> a headband, and a
 * screen of light projected from its eye instead of the laptop (data-holo).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FocusMeter, FOCUS } = require('../app/renderer/lib/fun');
const { DEMOS } = require('../app/validate');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('focus: six quick edits (or twelve other steps) in two minutes, out again when it slows down', () => {
  let now = 0;
  const meter = new FocusMeter({ clock: { now: () => now } });
  assert.deepEqual(FOCUS.weights, { typing: 2, running: 1, reading: 1, working: 1 });
  for (let i = 0; i < 5; i += 1) {
    now += 10000;
    assert.equal(meter.step('typing'), false, `edit ${i + 1}: not yet`);
  }
  now += 10000;
  assert.equal(meter.step('typing'), true, 'the sixth edit: focus mode');
  // Thinking or waiting between tools counts nothing and changes nothing.
  assert.equal(meter.step('thinking'), true);
  // Slower now: the old steps fall out of the window, but it stays on down to `off` points.
  now += FOCUS.windowMs - 30000;
  assert.equal(meter.step('reading'), true, `still ${meter.score()} points`);
  now += 25000;
  assert.equal(meter.score() < FOCUS.off, true);
  assert.equal(meter.step('reading'), false, 'below the off mark: out of focus mode');
  meter.reset();
  assert.equal(meter.focused, false);
  for (let i = 0; i < FOCUS.on; i += 1) meter.step('running');
  assert.equal(meter.focused, true, 'twelve commands do it too');
});

test('focus: steps spread over more than two minutes never add up', () => {
  let now = 0;
  const meter = new FocusMeter({ clock: { now: () => now } });
  for (let i = 0; i < 40; i += 1) {
    now += 25000;
    assert.equal(meter.step('typing'), false);
  }
});

test('focus on the page: data-holo from new work steps, a calm spell ends it; the robot draws it', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('noteFocus(previous, next);'));
  assert.ok(page.includes("later('focus-calm', FOCUS.calmMs, endFocus);"));
  assert.ok(page.includes("flag('holo', focus.focused);"));
  assert.ok(DEMOS.has('focus'));
  const svg = read('characters', 'robot', 'robot.svg');
  for (const group of ['rb-holo', 'rb-band', 'rb-holo-eye']) assert.ok(svg.includes(`<g class="${group}" data-nohit=""`), `${group} never takes the mouse`);
  assert.ok(svg.includes('<clipPath id="rb-holo-clip">'));
  const css = read('characters', 'robot', 'robot.css');
  assert.ok(css.includes(".buddy-character[data-holo][data-state='typing'] .rb-holo-code {"), 'code scrolls with the taps');
  assert.ok(/\[data-holo\]:is\(\[data-state='typing'\][^{]*\.rb-laptop \{\s*opacity: 0;/.test(css), 'the laptop gives way');
  assert.ok(css.includes("[data-state='reading']:not([data-task])"), 'the book, search and web looks stay');
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).quip.focusOn, lang);
  assert.ok(read('app', 'main.js').includes("'focusOn'"));
});
