'use strict';

/** Throwing the character and settling after a drop (app/fling.js, placement.settleAnchor). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fling = require('../app/fling');
const placement = require('../app/placement');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const DISPLAYS = [{ id: 1, workArea: WA }];
const PRIMARY = DISPLAYS[0];
const settle = (p) => placement.settleAnchor(p, DISPLAYS, PRIMARY, 1);

test('fling: release speed from the last cursor samples; none when the cursor rested', () => {
  const moving = [
    { t: 0, x: 100, y: 500 },
    { t: 16, x: 120, y: 500 },
    { t: 32, x: 150, y: 490 },
    { t: 48, x: 190, y: 480 },
  ];
  const v = fling.velocityFrom(moving, 50);
  assert.ok(Math.abs(v.vx - 90 / 48) < 1e-9, `vx ${v.vx}`);
  assert.ok(Math.abs(v.vy - -20 / 48) < 1e-9);
  // Only the last stretch counts: an early slow part does not drag the speed down.
  const late = [{ t: 0, x: 0, y: 0 }, { t: 400, x: 10, y: 0 }, { t: 416, x: 40, y: 0 }, { t: 432, x: 70, y: 0 }];
  assert.ok(Math.abs(fling.velocityFrom(late, 432).vx - 60 / 32) < 1e-9);
  assert.deepEqual(fling.velocityFrom(moving, 48 + fling.FLING.restMs + 1), { vx: 0, vy: 0 }, 'held still, then let go');
  assert.deepEqual(fling.velocityFrom([{ t: 0, x: 0, y: 0 }], 0), { vx: 0, vy: 0 });
  assert.deepEqual(fling.velocityFrom(null, 0), { vx: 0, vy: 0 });
});

test('fling: a plain drop in a free spot stays put; next to a corner or the ground it eases in', () => {
  assert.equal(fling.planFling({ from: { x: 900, y: 600 }, velocity: { vx: 0, vy: 0 }, workArea: WA, settle }), null);
  assert.equal(fling.planFling({ from: { x: 900, y: 600 }, velocity: { vx: 0.2, vy: 0 }, workArea: WA, settle }), null, 'too slow to throw');

  // Just above the ground: it lands instead of standing in the air.
  const low = fling.planFling({ from: { x: 900, y: 1030 }, velocity: { vx: 0, vy: 0 }, workArea: WA, settle });
  assert.ok(low && !low.thrown);
  assert.deepEqual(low.to, { x: 900, y: 1040 });
  assert.ok(low.ms <= fling.FLING.settleMs + fling.FLING.stepMs);

  // Near the bottom-right corner: it slides in, it does not jump.
  const corner = placement.cornerAnchor(WA, 'bottom-right', 1);
  const near = fling.planFling({ from: { x: corner.x - 30, y: corner.y - 20 }, velocity: { vx: 0, vy: 0 }, workArea: WA, settle });
  assert.deepEqual(near.to, corner);
  let prev = near.path[0];
  for (const p of near.path.slice(1)) {
    assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) < 12, 'small steps all the way');
    prev = p;
  }
});

test('fling: a throw glides on, slows down and stays inside the work area', () => {
  const plan = fling.planFling({ from: { x: 800, y: 600 }, velocity: { vx: 2, vy: -0.5 }, workArea: WA, settle });
  assert.ok(plan.thrown);
  assert.equal(plan.face, 'right');
  assert.ok(plan.to.x > 800 + 300, `went on to ${plan.to.x}`);
  assert.ok(plan.to.y < 600, 'and upwards');
  // Decelerating: every step is shorter than (or as long as) the one before, until it settles.
  const steps = [];
  for (let i = 1; i < plan.path.length; i += 1) steps.push(Math.hypot(plan.path[i].x - plan.path[i - 1].x, plan.path[i].y - plan.path[i - 1].y));
  assert.ok(steps[0] > steps[Math.floor(steps.length / 2)]);
  const l = fling.limitsOf(WA, 1);
  for (const p of plan.path) {
    assert.ok(p.x >= l.minX - 0.5 && p.x <= l.maxX + 0.5 && p.y >= l.minY - 0.5 && p.y <= l.maxY + 0.5, `inside: ${p.x},${p.y}`);
  }
  assert.ok(plan.ms <= fling.FLING.maxMs + fling.FLING.settleMs + fling.FLING.stepMs);
  // positionAt follows the path and ends exactly on the target.
  assert.deepEqual(fling.positionAt(plan, 0), { x: 800, y: 600 });
  assert.deepEqual(fling.positionAt(plan, plan.ms + 100), plan.to);
  assert.ok(fling.speedAt(plan, 40) > 0.5, 'moving right early on');
});

test('fling: thrown hard at an edge it bounces back, and very fast throws are capped', () => {
  const plan = fling.planFling({ from: { x: 1500, y: 500 }, velocity: { vx: 50, vy: 0 }, workArea: WA, settle });
  const l = fling.limitsOf(WA, 1);
  const reach = fling.FLING.maxSpeed * fling.FLING.stepMs;
  assert.ok(plan.path.some((p) => p.x >= l.maxX - reach), 'reached the edge');
  assert.ok(plan.path.some((p, i) => i > 0 && p.x < plan.path[i - 1].x - 1), 'and turned round');
  assert.ok(plan.to.x < l.maxX - 10, `bounced back to ${plan.to.x}`);
  const maxStep = Math.max(...plan.path.slice(1).map((p, i) => Math.abs(p.x - plan.path[i].x)));
  assert.ok(maxStep <= fling.FLING.maxSpeed * fling.FLING.stepMs + 0.01, 'capped speed');
});

test('fling: where it ends is a stable home (saving it again changes nothing)', () => {
  for (const [from, velocity] of [
    [{ x: 300, y: 900 }, { vx: -3, vy: 2 }],
    [{ x: 1700, y: 1000 }, { vx: 1.5, vy: 1 }],
    [{ x: 960, y: 400 }, { vx: 0, vy: -4 }],
  ]) {
    const plan = fling.planFling({ from, velocity, workArea: WA, settle });
    const again = placement.anchorOfPatch(placement.dropPlacement(plan.to, DISPLAYS, PRIMARY, 1), PRIMARY, 1);
    assert.deepEqual(again, plan.to);
    assert.deepEqual(settle(plan.to), plan.to);
  }
});

test('placement: the menu side stays while there is room, and switches when there is not', () => {
  // Right half: the column would go left (towards the middle).
  const right = { x: 1500, y: 1040 };
  assert.equal(placement.sideWithRoom(right, WA, 1, null), 'left');
  assert.equal(placement.sideWithRoom(right, WA, 1, 'left'), 'left');
  // Dragged over to the left half: still left, there is plenty of room.
  assert.equal(placement.sideWithRoom({ x: 600, y: 1040 }, WA, 1, 'left'), 'left');
  // Right next to the left edge: no room for the column, it switches.
  const leftCorner = placement.cornerAnchor(WA, 'bottom-left', 1);
  assert.equal(placement.sideWithRoom(leftCorner, WA, 1, 'left'), 'right');
  // Room for the menu but not for the helpers that need it: switches as well.
  assert.equal(placement.sideWithRoom({ x: 260, y: 1040 }, WA, 1, 'left', 64), 'left');
  assert.equal(placement.sideWithRoom({ x: 260, y: 1040 }, WA, 1, 'left', placement.crewWidth(2, 'left')), 'right');
});
