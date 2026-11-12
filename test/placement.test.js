'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../app/placement');

// A 1920x1200 primary with a 48 px taskbar, and a second monitor to its right.
const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1152 } };
const second = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } };
const displays = [primary, second];

test('corner anchors sit on the work-area bottom, inset by the margin', () => {
  assert.deepEqual(p.cornerAnchor(primary.workArea, 'bottom-right', 1), { x: 1920 - 12 - 110, y: 1152 });
  assert.deepEqual(p.cornerAnchor(primary.workArea, 'bottom-left', 1), { x: 12 + 110, y: 1152 });
  assert.deepEqual(p.cornerAnchor(primary.workArea, 'bottom-left', 1.3), { x: 12 + 143, y: 1152 });
  // Taskbar on the left / top: the work area does not start at 0.
  assert.deepEqual(p.cornerAnchor({ x: 60, y: 40, width: 1860, height: 1160 }, 'bottom-left', 1), { x: 182, y: 1200 });
});

test('window layout keeps the slot at the anchor, menu on the inner side', () => {
  const anchor = p.cornerAnchor(primary.workArea, 'bottom-right', 1);
  assert.equal(p.sideFor(anchor, primary.workArea), 'left');
  const { page, bounds } = p.windowLayout(anchor, 'left', 1);
  assert.deepEqual(page, { width: 284, height: 270, slotLeft: 64, side: 'left' });
  assert.deepEqual(bounds, { x: 1920 - 12 - 220 - 64, y: 1152 - 270, width: 284, height: 270 });
  assert.equal(bounds.x + bounds.width, 1920 - 12, 'right edge keeps the margin');

  const left = p.cornerAnchor(primary.workArea, 'bottom-left', 1.3);
  assert.equal(p.sideFor(left, primary.workArea), 'right');
  const large = p.windowLayout(left, 'right', 1.3);
  assert.deepEqual(large.bounds, { x: 12, y: 1152 - 351, width: Math.round(284 * 1.3), height: 351 });
});

test('a saved free position is used while it is fully on some display', () => {
  const settings = { corner: 'bottom-right', position: { x: 2500, y: 900 } };
  const r = p.resolveAnchor(settings, displays, primary, 1);
  assert.equal(r.mode, 'free');
  assert.deepEqual(r.anchor, { x: 2500, y: 900 });
  assert.equal(r.workArea, second.workArea);
});

test('a position on an unplugged monitor falls back to the primary corner', () => {
  const settings = { corner: 'bottom-left', position: { x: 2500, y: 900 } };
  const r = p.resolveAnchor(settings, [primary], primary, 1);
  assert.equal(r.mode, 'corner');
  assert.deepEqual(r.anchor, p.cornerAnchor(primary.workArea, 'bottom-left', 1));
  // Half off-screen counts as not visible, too.
  const half = p.resolveAnchor({ corner: 'bottom-right', position: { x: 50, y: 900 } }, displays, primary, 1);
  assert.equal(half.mode, 'corner');
});

test('dropping: clamps into the nearest display, snaps to corners', () => {
  // Free spot in the middle of the primary display.
  assert.deepEqual(p.dropPlacement({ x: 900, y: 700 }, displays, primary, 1), { position: { x: 900, y: 700 } });
  // Dragged past the bottom-left edge: clamped, then close enough to snap.
  assert.deepEqual(p.dropPlacement({ x: 60, y: 1190 }, displays, primary, 1), { position: null, corner: 'bottom-left' });
  // Near the bottom-right corner of the primary display.
  const nearRight = p.cornerAnchor(primary.workArea, 'bottom-right', 1);
  assert.deepEqual(p.dropPlacement({ x: nearRight.x - 30, y: nearRight.y - 20 }, displays, primary, 1), {
    position: null,
    corner: 'bottom-right',
  });
  // Near a corner of the second monitor: snapped, but kept as a free position.
  const secondCorner = p.cornerAnchor(second.workArea, 'bottom-right', 1);
  assert.deepEqual(p.dropPlacement({ x: secondCorner.x - 10, y: secondCorner.y - 10 }, displays, primary, 1), {
    position: secondCorner,
  });
  // Way above the top: clamped so the whole character is visible.
  const top = p.dropPlacement({ x: 900, y: -500 }, displays, primary, 1);
  assert.deepEqual(top, { position: { x: 900, y: 270 } });
});

test('clamp keeps the full slot inside the work area at every size', () => {
  for (const scale of [0.8, 1, 1.3]) {
    const a = p.clampAnchor({ x: -1000, y: 99999 }, primary.workArea, scale);
    const r = p.slotRect(a, scale);
    assert.ok(r.x >= 0 && r.y >= 0, `scale ${scale}`);
    assert.ok(r.x + r.width <= 1920.5 && r.y + r.height <= 1152.5, `scale ${scale}`);
  }
});

test('ground is the bottom of the work area under the character; primary when off-screen', () => {
  assert.equal(p.groundFor({ x: 500, y: 900 }, displays, primary), 1152);
  assert.equal(p.groundFor({ x: 2500, y: 600 }, displays, primary), 1024, 'second monitor has its own ground');
  assert.equal(p.groundFor({ x: -4000, y: 600 }, displays, primary), 1152);
  assert.equal(p.altitudeOf({ x: 500, y: 1152 }, displays, primary), 0);
  assert.equal(p.altitudeOf({ x: 500, y: 1000 }, displays, primary), 152);
  assert.equal(p.altitudeOf({ x: 500, y: 1160 }, displays, primary), 0, 'never negative');
});

test('hovering: only above the threshold, scaled with size, never in "stand" mode', () => {
  assert.equal(p.isAirborne(p.HOVER_THRESHOLD, 1, 'auto'), false);
  assert.equal(p.isAirborne(p.HOVER_THRESHOLD + 1, 1, 'auto'), true);
  assert.equal(p.isAirborne(30, 1.3, 'auto'), false, 'large size needs more height');
  assert.equal(p.isAirborne(500, 1, 'stand'), false);
  // A corner placement is always on the ground.
  const corner = p.cornerAnchor(primary.workArea, 'bottom-right', 1);
  assert.equal(p.isAirborne(p.altitudeOf(corner, displays, primary), 1, 'auto'), false);
});
