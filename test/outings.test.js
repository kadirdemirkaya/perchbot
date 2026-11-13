'use strict';

/** Helpers out roaming the screen (app/outings.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OUTING, parseOuting, toScreen, returnPoint, pickLegs, pickPause, pauseAfter } = require('../app/outings');
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

test('outings: next to the cursor a helper pokes at it, then darts off; otherwise its usual pause', () => {
  assert.deepEqual(pauseAfter('inspect', () => 0.5), { ms: OUTING.pokeMs, pose: 'prank', play: null, then: 'flee' });
  // The poke (mini.css rbm-poke: 0.3 s delay + 2 x 0.25 s) fits in the pause.
  assert.ok(OUTING.pokeMs >= 800);
  for (const kind of ['flee', 'hop', 'goto', null]) {
    const p = pauseAfter(kind, () => 0.9);
    assert.equal(p.then, null, `${kind}: the next leg is picked as usual`);
    assert.ok(['look', 'play'].includes(p.pose));
    assert.ok(p.ms >= OUTING.pauseMinMs && p.ms <= OUTING.pauseMaxMs);
  }
  // The pose is one the helper page knows (renderer/helper.js) and the mini draws (mini.css).
  const fs = require('node:fs');
  const path = require('node:path');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'helper.js'), 'utf8');
  const mini = fs.readFileSync(path.join(__dirname, '..', 'characters', 'robot', 'mini.css'), 'utf8');
  assert.ok(helper.includes("p.pose === 'prank' ? 'prank'"));
  assert.ok(mini.includes("[data-phase='prank']"));
});

test('outings: two to four legs at half speed, short pauses in between, now and then a little show', () => {
  assert.equal(OUTING.pace, 0.5, 'calmer than the buddy');
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
