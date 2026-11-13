'use strict';

/** Helpers out roaming the screen (app/outings.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OUTING, parseOuting, toScreen, returnPoint, pickLegs, pickPause } = require('../app/outings');
const { SLOT } = require('../app/placement');

test('outings: only a well-formed message from the page counts', () => {
  const ok = { id: 'a1b2c3d4e5', tint: 2, off: 112, x: 40.4, y: 251.6 };
  assert.deepEqual(parseOuting(ok), { id: 'a1b2c3d4e5', tint: 2, off: 112, x: 40, y: 252 });
  for (const bad of [
    null,
    'a1b2c3d4e5',
    [],
    { ...ok, id: 'not-an-id' },
    { ...ok, id: '../../etc' },
    { ...ok, tint: 1.5 },
    { ...ok, tint: 40 },
    { ...ok, off: -3 },
    { ...ok, x: Number.NaN },
    { ...ok, y: Infinity },
    { ...ok, x: '12' },
  ]) {
    assert.equal(parseOuting(bad), null, JSON.stringify(bad));
  }
});

test('outings: page points become screen points; the way home is just above its spot', () => {
  assert.deepEqual(toScreen({ x: 100, y: 200 }, { x: 400, y: 600 }, 1.25), { x: 525, y: 850 });
  const b = { x: 1000, y: 600, width: 400, height: 270 };
  // Side column on the left: the crew stands left of the slot (which is the right part of the window).
  const left = returnPoint(b, 'left', 112, 1);
  assert.equal(left.x, 1000 + 400 - SLOT.width - 112);
  assert.ok(left.y < b.y + b.height && left.y > b.y, 'a little above the ground, inside the window');
  const right = returnPoint({ ...b, x: 200 }, 'right', 112, 1);
  assert.equal(right.x, 200 + SLOT.width + 112);
});

test('outings: two to four legs, short pauses in between, now and then a little show', () => {
  assert.equal(pickLegs(() => 0), OUTING.minLegs);
  assert.equal(pickLegs(() => 0.999999), OUTING.maxLegs);
  const shows = new Set();
  let r = 0;
  for (let i = 0; i < 100; i += 1) {
    const p = pickPause(() => ((r = (r + 0.173) % 1), r));
    assert.ok(p.ms >= OUTING.pauseMinMs && p.ms <= OUTING.pauseMaxMs);
    if (p.pose === 'play') shows.add(p.play);
    else assert.equal(p.play, null);
  }
  assert.ok(shows.size >= 3, `shows: ${[...shows]}`);
  assert.ok(OUTING.max === 2);
});
