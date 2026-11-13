'use strict';

/** Trips around the screen (app/roam.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planTrip, positionAt, tripDisplay, pickTrip, pickOutingLeg, planCrossing, OUTING_LEGS, SCREEN_CHANCE, CURSOR_GAP, FLEE_GAP } = require('../app/roam');
const { SLOT, cornerAnchor, helperWindow } = require('../app/placement');

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

test('the whole window stays inside: wide windows (helpers, cat), and the arc of a flight', () => {
  // Helpers make the window reach 460 DIP to the left of the anchor.
  for (let seed = 1; seed < 40; seed += 1) {
    const trip = planTrip({ kind: 'flee', from: home, home, workArea, spanLeft: 460, spanRight: 110, random: randoms(seed) });
    assert.ok(trip.to.x - 460 >= workArea.x, `seed ${seed}: left edge ${trip.to.x - 460}`);
    assert.ok(trip.to.x + 110 <= workArea.x + workArea.width);
    for (let t = 0; t <= trip.ms; t += trip.ms / 20) {
      const p = positionAt(trip, t);
      assert.ok(p.y - SLOT.height >= workArea.y, `seed ${seed}: top at ${t}`);
      assert.ok(p.x - 460 >= workArea.x - 1 && p.x + 110 <= workArea.x + workArea.width + 1, `seed ${seed}: x at ${t}`);
    }
  }
  // A flight close to the top of the work area: the arc is cut off at the top.
  const high = { x: 400, y: SLOT.height + 20 };
  const trip = planTrip({ kind: 'hop', from: high, home, workArea, random: () => 0.9 });
  for (let t = 0; t <= trip.ms; t += 20) assert.ok(positionAt(trip, t).y >= SLOT.height, `t ${t}`);
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

// Two screens side by side, like a laptop at 125 % and a monitor next to it.
const left = { id: 1, workArea: { x: 0, y: 0, width: 1536, height: 912 } };
const right = { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1032 } };
const screens = [left, right];

test('two screens: inspect follows the cursor, home goes home, "screen" picks the other one', () => {
  const here = left;
  assert.equal(tripDisplay({ kind: 'inspect', here, displays: screens, cursor: { x: 2500, y: 400 } }), right);
  assert.equal(tripDisplay({ kind: 'inspect', here, displays: screens, cursor: { x: 300, y: 400 } }), left);
  assert.equal(tripDisplay({ kind: 'home', here: right, displays: screens, home }), left);
  assert.equal(tripDisplay({ kind: 'screen', here, displays: screens }), right);
  assert.equal(tripDisplay({ kind: 'screen', here: right, displays: screens }), left);
  assert.equal(tripDisplay({ kind: 'stroll', here, displays: screens }), left, 'walks stay on their screen');
  // One screen: everything stays, and there is no other screen to visit.
  assert.equal(tripDisplay({ kind: 'inspect', here, displays: [left], cursor: { x: 2500, y: 400 } }), left);
  assert.equal(tripDisplay({ kind: 'screen', here, displays: [left] }), null);
});

test('two screens: now and then a walk or a hop becomes a visit to the other screen', () => {
  assert.equal(pickTrip('hop', 2, () => SCREEN_CHANCE / 2), 'screen');
  assert.equal(pickTrip('stroll', 2, () => SCREEN_CHANCE / 2), 'screen');
  assert.equal(pickTrip('hop', 2, () => 0.99), 'hop');
  assert.equal(pickTrip('hop', 1, () => 0), 'hop', 'never with one screen');
  for (const kind of ['inspect', 'home', 'flee']) assert.equal(pickTrip(kind, 2, () => 0), kind, kind);
  assert.ok(SCREEN_CHANCE > 0.1 && SCREEN_CHANCE < 0.5);
});

test('crossing: out at the edge that faces the other screen, in at its facing edge, same relative height', () => {
  const from = { x: 700, y: 912 };
  const c = planCrossing({ from, fromArea: left.workArea, toArea: right.workArea });
  assert.equal(c.face, 'right');
  assert.equal(c.exit.y, 912, 'on the ground it leaves along the ground');
  assert.equal(c.exit.x, 1536 - SLOT.width / 2 - 8, 'at the right edge, the whole slot still inside');
  assert.equal(c.entry.x, 1920 + SLOT.width / 2 + 8, 'comes in at the left edge of the other screen');
  assert.equal(c.entry.y, 1032, 'and on its ground');
  // Back the other way, from up in the air: the same height (relative) on the other side.
  const high = planCrossing({ from: { x: 3000, y: 300 }, fromArea: right.workArea, toArea: left.workArea });
  assert.equal(high.face, 'left');
  assert.equal(high.exit.x, 1920 + SLOT.width / 2 + 8);
  assert.equal(high.exit.y, 300);
  assert.equal(high.entry.x, 1536 - SLOT.width / 2 - 8);
  assert.ok(high.entry.y < 912 && high.entry.y > SLOT.height, `up in the air: ${high.entry.y}`);
  // "Always stand": on the ground at both ends.
  const stand = planCrossing({ from: { x: 3000, y: 300 }, fromArea: right.workArea, toArea: left.workArea, hoverMode: 'stand' });
  assert.equal(stand.exit.y, 1032);
  assert.equal(stand.entry.y, 912);
  // A screen above: out at the top, in at the bottom... of the one above (it drops in from below).
  const above = { x: 0, y: -1080, width: 1920, height: 1040 };
  const up = planCrossing({ from: { x: 700, y: 912 }, fromArea: left.workArea, toArea: above });
  assert.equal(up.exit.y, SLOT.height, 'the top of this screen');
  assert.equal(up.entry.y, -1080 + 1040, 'the ground of the one above');
});

test('goto: the first leg flies straight to the given point (inside the screen); stand walks', () => {
  const to = { x: 1536 - SLOT.width / 2 - 8, y: 600 };
  const leg = planTrip({ kind: 'goto', from: home, home, workArea, to, cursor: to });
  assert.equal(leg.mode, 'fly');
  assert.deepEqual(leg.to, to, 'even with the cursor right there: it only passes through');
  assert.equal(planTrip({ kind: 'goto', from: home, home, workArea }), null, 'needs a point');
  const walk = planTrip({ kind: 'goto', from: { x: 300, y: 912 }, home, workArea, to: { x: 1200, y: 912 }, hoverMode: 'stand' });
  assert.equal(walk.mode, 'walk');
});

test('walks and hops now reach much further across the screen', () => {
  let far = 0;
  for (let seed = 1; seed < 60; seed += 1) {
    const from = { x: 768, y: 912 };
    const hop = planTrip({ kind: 'hop', from, home, workArea, random: randoms(seed) });
    const walk = planTrip({ kind: 'stroll', from, home, workArea, random: randoms(seed + 100) });
    far = Math.max(far, Math.abs(hop.to.x - from.x), Math.abs(walk.to.x - from.x));
    assert.ok(inside(hop.to) && inside(walk.to), `seed ${seed}`);
  }
  assert.ok(far > 500, `the longest trip: ${far} px`);
});

test('helpers roaming: scattered legs, a peek only with the cursor on their screen, other screens only with two', () => {
  const seen = (opts) => {
    const out = new Set();
    let r = 0;
    for (let i = 0; i < 200; i += 1) out.add(pickOutingLeg({ ...opts, random: () => ((r = (r + 0.137) % 1), r) }));
    return [...out].sort();
  };
  assert.deepEqual(seen({ displayCount: 2, cursorHere: true }), Object.keys(OUTING_LEGS).sort());
  assert.deepEqual(seen({ displayCount: 1, cursorHere: true }), ['flee', 'hop', 'inspect']);
  assert.deepEqual(seen({ displayCount: 2, cursorHere: false }), ['flee', 'hop', 'screen']);
  assert.ok(OUTING_LEGS.flee >= 0.4, 'mostly anywhere on the screen: more scattered than the buddy');
});

test('helpers roaming: the little window sits around the feet of the mini and scales', () => {
  const w = helperWindow({ x: 500, y: 900 }, 1);
  assert.deepEqual(w.bounds, { x: 432, y: 770, width: 152, height: 152 });
  assert.equal(w.spanLeft + w.spanRight, 152);
  assert.equal(w.below, 22);
  const big = helperWindow({ x: 500, y: 900 }, 1.25);
  assert.equal(big.bounds.width, 190);
  assert.equal(big.bounds.x, Math.round(500 - 68 * 1.25));
});
