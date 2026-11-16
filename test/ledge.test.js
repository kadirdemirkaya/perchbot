'use strict';

/**
 * Perched on a window, it sits ON the edge with its legs over the title bar
 * (app/perch.js ledgeDrop, followPerch with `drop`; main.js sinks the window,
 * the page draws data-ledge). Old perches without `drop` behave as before
 * (test/perch.test.js stays as it was).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PERCH, followPerch, ledgeDrop } = require('../app/perch');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const areas = [area];
const win = (id, x, y, w, h, max = false) => ({ id, x, y, w, h, max });

test('ledgeDrop: sits on the edge in the middle of a window, not near its caption buttons', () => {
  const rect = { x: 600, y: 500, w: 700, h: 400 };
  assert.equal(ledgeDrop({ offset: 300, rect }), PERCH.ledge);
  assert.equal(ledgeDrop({ offset: 300, rect }, 1.25), Math.round(PERCH.ledge * 1.25), 'bigger robot, longer legs');
  // The legs would reach the caption buttons at the right end: it stands there, as before.
  const nearButtons = rect.w - (PERCH.buttons + PERCH.legReach) + 1;
  assert.equal(ledgeDrop({ offset: nearButtons, rect }), 0);
  assert.equal(ledgeDrop({ offset: nearButtons - 1, rect }), PERCH.ledge, 'just clear of them');
  // Its feet would go below the bottom of the work area.
  assert.equal(ledgeDrop({ offset: 300, rect, anchor: { x: 900, y: 1000 } }, 1, 1040), 0);
  assert.equal(ledgeDrop({ offset: 300, rect, anchor: { x: 900, y: 900 } }, 1, 1040), PERCH.ledge);
  // Bad input: no ledge.
  for (const bad of [null, {}, { offset: 'a', rect }, { offset: 300 }, { offset: 300, rect: { w: NaN } }]) {
    assert.equal(ledgeDrop(bad), 0);
  }
  assert.equal(ledgeDrop({ offset: 300, rect }, 0), 0);
  assert.ok(PERCH.sinkDelayMs + PERCH.sinkMs < 1000, 'sits down at once');
});

test('followPerch with a drop: rides along that far below the edge, the old checks unchanged', () => {
  const drop = PERCH.ledge;
  const perch = { id: '1', offset: 300, rect: { x: 600, y: 500, w: 700, h: 400 }, drop };
  assert.deepEqual(followPerch(perch, { windows: [win('1', 600, 500, 700, 400)], areas }), { kind: 'stay' });
  const moved = followPerch(perch, { windows: [win('1', 650, 520, 700, 400)], areas });
  assert.equal(moved.kind, 'move');
  assert.deepEqual(moved.anchor, { x: 950, y: 520 + drop }, 'same place along the edge, still sitting on it');
  // Same answers as without a drop for the old reasons.
  const fall = (windows) => followPerch(perch, { windows, areas });
  assert.deepEqual(fall([]), { kind: 'fall', why: 'gone' });
  assert.deepEqual(fall([win('1', 0, 0, 1920, 1040, true)]), { kind: 'fall', why: 'maximised' });
  assert.deepEqual(fall([win('1', 600, 50, 700, 400)]), { kind: 'fall', why: 'no room' });
  assert.deepEqual(fall([win('9', 0, 0, 1920, 1040), win('1', 600, 500, 700, 400)]), { kind: 'fall', why: 'covered' });
  // New: the window went so low that its feet would be below the work area.
  assert.deepEqual(fall([win('1', 600, 1010, 700, 400)]), { kind: 'fall', why: 'no room below' });
  // Without a drop that window is still fine to stand on (as before).
  assert.equal(followPerch({ ...perch, drop: undefined }, { windows: [win('1', 600, 1010, 700, 400)], areas }).kind, 'move');
  // A broken drop counts as none.
  assert.deepEqual(followPerch({ ...perch, drop: 'x' }, { windows: [win('1', 650, 520, 700, 400)], areas }).anchor, { x: 950, y: 520 });
});

test('ledge: the page draws it from the flight state, clears it on a trip or a drag; robot.css has the pose', () => {
  const main = read('app/main.js');
  assert.match(main, /if \(perched && perching\.drop > 0\) next\.ledge = true;/, 'flightAt says so');
  assert.match(main, /Boolean\(next\.ledge\) === Boolean\(flight\.ledge\)/, 'a change is sent');
  assert.match(main, /if \(trip \|\| drag \|\| paused \|\| ledgeSink\) \{/, 'no look at the window while it sits down');
  const page = read('app/renderer/renderer.js');
  assert.match(page, /flag\('ledge', flight\.ledge && !moving && !drag \? 'sit' : null\);/);
  assert.equal((page.match(/flag\('ledge', null\);/g) || []).length, 2, 'off on a trip and when picked up');
  assert.match(page, /grounded: !flight\.airborne && !flight\.ledge,/, 'no sit-down play on the edge');
  assert.match(page, /m\.kind === 'perch' && m\.arrived && !m\.ledge && /, 'the old sit-down only without the ledge');
  const css = read('characters/robot/robot.css');
  assert.match(css, /\.buddy-character\[data-ledge\] \.rb-shadow \{\s*visibility: hidden;/);
  assert.match(css, /\.buddy-character\[data-ledge\] :is\(\.rb-legs, \.rb-legs \*\) \{\s*pointer-events: none;/, 'legs let clicks through');
  // The swing is the weakest rule: plays and work poses win over it.
  for (const leg of ['l', 'r']) {
    assert.match(css, new RegExp(`\\.buddy-character:where\\(\\[data-ledge\\]\\) \\.rb-leg-${leg} \\{\\s*animation: rb-ledge-swing `));
  }
  assert.match(css, /@keyframes rb-ledge-swing \{/);
});
