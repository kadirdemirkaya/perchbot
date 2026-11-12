'use strict';

/** Trips around the screen (app/roam.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planTrip, positionAt, CURSOR_GAP, FLEE_GAP } = require('../app/roam');
const { SLOT, cornerAnchor } = require('../app/placement');

const workArea = { x: 0, y: 0, width: 1536, height: 912 };
const home = cornerAnchor(workArea, 'bottom-right', 1);
const inside = (a, scale = 1) =>
  a.x - (SLOT.width / 2) * scale >= workArea.x &&
  a.x + (SLOT.width / 2) * scale <= workArea.x + workArea.width &&
  a.y - SLOT.height * scale >= workArea.y &&
  a.y <= workArea.y + workArea.height;

function randoms(seed) {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

test('a stroll walks along the ground, inside the work area', () => {
  for (let seed = 1; seed < 40; seed += 1) {
    const trip = planTrip({ kind: 'stroll', from: home, home, workArea, random: randoms(seed) });
    assert.ok(trip, `seed ${seed}`);
    assert.equal(trip.mode, 'walk');
    assert.equal(trip.to.y, 912, 'on the ground');
    assert.ok(inside(trip.to), `seed ${seed}: ${JSON.stringify(trip.to)}`);
    assert.equal(trip.face, trip.to.x < home.x ? 'left' : 'right');
    assert.ok(trip.ms >= 700);
  }
});

test('hops and fleeing fly; "Always stand" keeps it on the ground', () => {
  const hop = planTrip({ kind: 'hop', from: home, home, workArea, random: randoms(3) });
  assert.equal(hop.mode, 'fly');
  assert.ok(hop.to.y < 912 && inside(hop.to));
  const standHop = planTrip({ kind: 'hop', from: home, home, workArea, hoverMode: 'stand', random: randoms(3) });
  assert.equal(standHop.mode, 'walk');
  assert.equal(standHop.to.y, 912);
  const cursor = { x: home.x, y: home.y - 100 };
  const spots = new Set();
  for (let seed = 1; seed < 30; seed += 1) {
    const flee = planTrip({ kind: 'flee', from: home, home, workArea, cursor, random: randoms(seed) });
    assert.equal(flee.mode, 'fly');
    assert.ok(Math.abs(home.x - flee.to.x) >= FLEE_GAP, `seed ${seed}: well away from where it was hit`);
    assert.ok(inside(flee.to), `seed ${seed}`);
    spots.add(Math.round(flee.to.x / 100));
  }
  assert.ok(spots.size >= 5, 'random places, not always the same one');
  const run = planTrip({ kind: 'flee', from: home, home, workArea, cursor, hoverMode: 'stand', random: randoms(5) });
  assert.equal(run.mode, 'walk');
  assert.equal(run.to.y, 912);
  assert.ok(run.ms < Math.abs(run.to.x - home.x) / 0.09, 'runs faster than it walks');
  assert.equal(planTrip({ kind: 'inspect', from: home, home, workArea, cursor, hoverMode: 'stand' }), null);
});

test('inspect: flies beside the cursor, never onto it', () => {
  const cursor = { x: 700, y: 400 };
  const trip = planTrip({ kind: 'inspect', from: home, home, workArea, cursor, random: randoms(1) });
  assert.equal(trip.mode, 'fly');
  const left = trip.to.x - SLOT.width / 2;
  const right = trip.to.x + SLOT.width / 2;
  assert.ok(cursor.x <= left - CURSOR_GAP / 2 || cursor.x >= right + CURSOR_GAP / 2, 'cursor stays outside the slot');
  assert.ok(Math.abs(trip.to.x - cursor.x) < SLOT.width + CURSOR_GAP * 2, 'but close by');
  assert.ok(trip.to.y - SLOT.height < cursor.y && trip.to.y > cursor.y, 'head about at cursor height');
  // Cursor near the right edge: it comes from the other side.
  const edge = planTrip({ kind: 'inspect', from: { x: 300, y: 912 }, home, workArea, cursor: { x: 1500, y: 300 }, random: randoms(1) });
  assert.ok(edge.to.x < 1500 && inside(edge.to));
  assert.equal(planTrip({ kind: 'inspect', from: home, home, workArea, cursor: null }), null);
});

test('a stroll or hop never ends with the cursor over the character', () => {
  for (let seed = 1; seed < 60; seed += 1) {
    const random = randoms(seed);
    const cursor = { x: 200 + Math.round(random() * 1100), y: 700 + Math.round(random() * 200) };
    for (const kind of ['stroll', 'hop']) {
      const trip = planTrip({ kind, from: home, home, workArea, cursor, random });
      if (!trip) continue;
      const over =
        cursor.x > trip.to.x - SLOT.width / 2 && cursor.x < trip.to.x + SLOT.width / 2 && cursor.y > trip.to.y - SLOT.height && cursor.y < trip.to.y;
      assert.ok(!over, `${kind} seed ${seed}`);
    }
  }
});

test('home: walks back along the ground when close, flies otherwise; nothing to do at home', () => {
  const near = planTrip({ kind: 'home', from: { x: home.x - 300, y: 912 }, home, workArea });
  assert.equal(near.mode, 'walk');
  assert.deepEqual(near.to, home);
  const far = planTrip({ kind: 'home', from: { x: 300, y: 600 }, home, workArea });
  assert.equal(far.mode, 'fly');
  assert.equal(planTrip({ kind: 'home', from: home, home, workArea }), null);
  assert.equal(planTrip({ kind: 'teleport', from: home, home, workArea }), null);
});

test('positions along a trip: steady walk, arced flight, exact ends; scaled sizes stay inside', () => {
  const walk = { mode: 'walk', from: { x: 0, y: 900 }, to: { x: 100, y: 900 }, ms: 1000 };
  assert.deepEqual(positionAt(walk, 0), { x: 0, y: 900 });
  assert.deepEqual(positionAt(walk, 500), { x: 50, y: 900 });
  assert.deepEqual(positionAt(walk, 5000), { x: 100, y: 900 });
  const fly = { mode: 'fly', from: { x: 0, y: 900 }, to: { x: 400, y: 900 }, ms: 1000 };
  assert.ok(positionAt(fly, 500).y < 900, 'up in an arc');
  assert.deepEqual(positionAt(fly, 1000), { x: 400, y: 900 });
  for (const scale of [0.8, 1.3]) {
    const from = cornerAnchor(workArea, 'bottom-left', scale);
    const trip = planTrip({ kind: 'hop', from, home: from, workArea, scale, random: randoms(9) });
    assert.ok(inside(trip.to, scale), `scale ${scale}`);
  }
});
