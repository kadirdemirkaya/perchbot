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
  assert.deepEqual(page, { width: 284, height: 270, slotLeft: 64, side: 'left', sideWidth: 64 });
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

test('crew: spots grow outwards from the report point, width covers the outermost mini', () => {
  assert.equal(p.crewWidth(0, 'left'), 0);
  assert.equal(p.crewSpot(0, 'left'), p.CREW.report.left + p.CREW.firstGap);
  assert.equal(p.crewSpot(2, 'right') - p.crewSpot(1, 'right'), p.CREW.spacing);
  assert.equal(p.crewWidth(1, 'left'), p.crewSpot(0, 'left') + p.CREW.tail);
  assert.equal(p.crewWidth(9, 'left'), p.crewWidth(p.CREW.max, 'left'), 'never wider than the maximum crew');
  assert.ok(p.CREW.report.right > p.CREW.report.left, 'the laptop side needs more room');
  // Minis never stand on each other: a spot is wider than a mini's painted body.
  assert.ok(p.CREW.spacing >= p.CREW.miniSize * 0.75);
  const geo = p.crewGeometry('right', 3);
  assert.deepEqual(geo.spots, [p.crewSpot(0, 'right'), p.crewSpot(1, 'right'), p.crewSpot(2, 'right')]);
  assert.equal(geo.report, p.CREW.report.right);
});

test('cat: plays next to the main character, naps beyond the helpers; the column makes room for it', () => {
  const alone = p.petSpots(0, 'left');
  assert.equal(alone.play, p.CREW.report.left + p.PET.play);
  assert.ok(alone.nap > alone.play);
  assert.ok(alone.width > alone.nap);
  const crowded = p.petSpots(3, 'right');
  assert.ok(crowded.nap > p.crewWidth(3, 'right'), 'naps beyond the outermost helper');
  assert.equal(crowded.play, p.CREW.report.right + p.PET.play, 'still plays next to the main character');
});

test('crew: the window grows inwards and keeps the anchor; capacity follows the free room', () => {
  const anchor = p.cornerAnchor(primary.workArea, 'bottom-right', 1);
  const base = p.windowLayout(anchor, 'left', 1);
  const wide = p.windowLayout(anchor, 'left', 1, p.crewWidth(4, 'left'));
  assert.equal(wide.bounds.x + wide.bounds.width, base.bounds.x + base.bounds.width, 'right edge (slot side) stays');
  assert.equal(wide.page.slotLeft, p.crewWidth(4, 'left'));
  assert.equal(p.crewCapacity(anchor, 'left', primary.workArea, 1), p.CREW.max);
  // Bottom-left corner, crew on the right: plenty of room as well.
  const left = p.cornerAnchor(primary.workArea, 'bottom-left', 1.3);
  assert.equal(p.crewCapacity(left, 'right', primary.workArea, 1.3), p.CREW.max);
  // Squeezed against the edge of a small screen: only what fits.
  const small = { x: 0, y: 0, width: 800, height: 600 };
  const near = { x: 110 + 200, y: 600 };
  const fit = p.crewCapacity(near, 'left', small, 1);
  assert.ok(fit < p.CREW.max);
  assert.ok(p.crewWidth(fit, 'left') <= near.x - 110, 'what is shown fits');
  assert.ok(p.crewWidth(fit + 1, 'left') > near.x - 110, 'one more would not');
  assert.equal(p.crewCapacity({ x: 110, y: 600 }, 'left', small, 1), 0, 'no room at all');
});

test('bug hunt: the bug sits at the feet, where the sword comes down, give or take a little', () => {
  for (const side of ['left', 'right']) {
    const near = p.bugSpot(side, 0);
    const far = p.bugSpot(side, 1);
    assert.equal(far.x - near.x, p.BUG.jitter, side);
    assert.equal(p.bugSpot(side, 0.5).x, p.BUG.reach[side], `${side}: the middle is the sword's reach`);
    assert.equal(near.width, near.x + p.BUG.tail);
    assert.ok(near.x > 0, `${side}: outside the main slot`);
    assert.ok(far.width <= p.SIDE_WIDTH, `${side}: fits in the side column, the window does not grow`);
    assert.deepEqual(p.bugSpot(side, 7), far, 'offset is clamped');
  }
});

// ---------------------------------------------------------------- the window frame (room beside the page)

/** Every width the side column can have (CSS px), with the column on `side`. */
function columnWidths(side) {
  const widths = [p.SIDE_WIDTH, p.CHAT_WIDTH, p.guestSpot(side).width, p.bugSpot(side, 0).width, p.bugSpot(side, 1).width];
  for (let n = 1; n <= p.CREW.max; n++) widths.push(p.crewWidth(n, side));
  for (let n = 0; n <= p.CREW.max; n++) widths.push(p.petSpots(n, side).width);
  return widths;
}

test('window frame: the room kept on the left fits every column the page can have', () => {
  for (const w of columnWidths('left')) assert.ok(w <= p.COLUMN_ROOM, `${w} px fits`);
  const widest = p.petSpots(p.CREW.max, 'left').width;
  assert.ok(p.COLUMN_ROOM >= widest && p.COLUMN_ROOM < widest + 4, 'four helpers with the cat beyond them');
  assert.equal(p.COLUMN_ROOM % 4, 0, 'whole pixels at 125 % like the page');
  // Medium size at 125 %: the window's right edge (where the character stands) is on the
  // same pixel as a window as wide as the page: both edges are whole pixels.
  const at = p.cornerAnchor({ x: 0, y: 0, width: 1536, height: 912 }, 'bottom-right', 1);
  const frame = p.windowFrame(at, 'left', 1, p.SIDE_WIDTH).bounds;
  const page = p.windowLayout(at, 'left', 1).bounds;
  for (const v of [frame.x, frame.width, page.x, page.width]) assert.ok(Number.isInteger(v * 1.25), `${v} DIP is whole pixels`);
  assert.equal((frame.x + frame.width) * 1.25, (page.x + page.width) * 1.25);
});

test('window frame: with the column on the left the window stays put however the column changes', () => {
  for (const scale of [0.8, 1, 1.25, 1.3]) {
    const at = p.cornerAnchor(primary.workArea, 'bottom-right', scale);
    const base = p.windowFrame(at, 'left', scale, p.SIDE_WIDTH, displays);
    for (const w of columnWidths('left')) {
      const frame = p.windowFrame(at, 'left', scale, w, displays);
      assert.deepEqual(frame.bounds, base.bounds, `same window for a ${w} px column at ${scale}`);
      assert.equal(frame.spare, p.COLUMN_ROOM - w);
      // The page is the frame's right-hand part: same right edge (rounding aside), inside it.
      const page = p.windowLayout(at, 'left', scale, w).bounds;
      assert.ok(Math.abs(page.x + page.width - (frame.bounds.x + frame.bounds.width)) <= 1, 'right edges meet');
      assert.ok(frame.bounds.x <= page.x, 'the page is inside the window');
      assert.equal(frame.bounds.y, page.y);
      assert.equal(frame.bounds.height, page.height);
    }
    assert.equal(base.bounds.width, Math.round((p.SLOT.width + p.COLUMN_ROOM) * scale));
  }
});

test('window frame: with the column on the right the window is the page, exactly as before', () => {
  for (const scale of [0.8, 1, 1.3]) {
    const at = p.cornerAnchor(primary.workArea, 'bottom-left', scale);
    for (const w of columnWidths('right')) {
      const frame = p.windowFrame(at, 'right', scale, w, displays);
      assert.deepEqual(frame.bounds, p.windowLayout(at, 'right', scale, w).bounds);
      assert.equal(frame.spare, 0);
    }
  }
});

// A 125 % laptop screen with a 100 % monitor to its right, in DIP (as Electron reports them).
const laptop = { id: 1, workArea: { x: 0, y: 0, width: 1536, height: 912 }, bounds: { x: 0, y: 0, width: 1536, height: 960 }, scaleFactor: 1.25 };
const monitor = { id: 2, workArea: { x: 1536, y: 0, width: 1920, height: 1040 }, bounds: { x: 1536, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

test('window frame: the room never reaches into a display with another scale', () => {
  const screens = [laptop, monitor];
  // On the monitor, a little way from the laptop: only the room up to the laptop's edge.
  const near = { x: 1536 + 400, y: 1040 };
  const frame = p.windowFrame(near, 'left', 1, p.SIDE_WIDTH, screens);
  assert.equal(frame.bounds.x, 1536, 'stops at the edge of the monitor');
  assert.equal(frame.spare, 400 - 110 - p.SIDE_WIDTH);
  // Closer than the page itself needs: the page as before, never narrower.
  const tight = { x: 1536 + 150, y: 1040 };
  assert.deepEqual(p.windowFrame(tight, 'left', 1, p.SIDE_WIDTH, screens).bounds, p.windowLayout(tight, 'left', 1).bounds);
  // Far from it: all the room.
  assert.equal(p.windowFrame({ x: 1536 + 1500, y: 1040 }, 'left', 1, p.SIDE_WIDTH, screens).spare, p.COLUMN_ROOM - p.SIDE_WIDTH);
  // On the laptop (nothing on its left): all the room, even where it reaches past the screen edge.
  assert.equal(p.windowFrame({ x: 400, y: 912 }, 'left', 1.25, p.SIDE_WIDTH, screens).spare, p.COLUMN_ROOM - p.SIDE_WIDTH);
  // The same scale on the left: no harm in reaching over it.
  const twin = { ...laptop, scaleFactor: 1 };
  assert.equal(p.windowFrame(near, 'left', 1, p.SIDE_WIDTH, [twin, monitor]).spare, p.COLUMN_ROOM - p.SIDE_WIDTH);
  // A display above or below, not beside it, does not count.
  const above = { id: 3, workArea: { x: 0, y: -1200, width: 1536, height: 1152 }, bounds: { x: 0, y: -1200, width: 1536, height: 1200 }, scaleFactor: 1.5 };
  assert.equal(p.frameLimit(near, [above, { ...monitor, bounds: { ...monitor.bounds } }]), -Infinity);
  // Displays without bounds (or none at all): no limit.
  assert.equal(p.frameLimit(near, displays), -Infinity);
  assert.equal(p.frameLimit(near, []), -Infinity);
});

test('window frame: on the way towards that edge the window narrows bit by bit, it never jumps', () => {
  const screens = [laptop, monitor];
  let last = null;
  for (let x = 1536 + 1600; x >= 1536 + 110 + p.SIDE_WIDTH; x -= 3) {
    const { bounds } = p.windowFrame({ x, y: 1040 }, 'left', 1, p.SIDE_WIDTH, screens);
    assert.ok(bounds.x >= 1536 || bounds.width === p.SLOT.width + p.SIDE_WIDTH, `inside the monitor at ${x}`);
    if (last) {
      assert.ok(Math.abs(bounds.x - last.x) <= 3, `left edge moves at most as far as the character (${x})`);
      assert.ok(Math.abs(bounds.x + bounds.width - (last.x + last.width)) <= 3, `right edge too (${x})`);
    }
    last = bounds;
  }
});

test('room beside the page: the window always moves by its frame; the page draws and listens only to its own part', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const main = read('app', 'main.js');
  // Every move or resize of the buddy window goes through the frame (a page-sized window
  // whose left edge moves under a character that stays put is the jump this fixes)...
  const sets = main.match(/win\.setBounds\(([^;]*)\);/g) || [];
  assert.ok(sets.length >= 4, 'found the window moves');
  for (const call of sets) assert.ok(/frameFor\(|next\.bounds|initial\.bounds|\(bounds\)/.test(call) && !/windowLayout/.test(call), call);
  // ...while trips and the mouse watchdog go by the page, as before.
  assert.ok(!/spanLeft: anchor\.x - b\.x/.test(main.replace(/function pageSpans[\s\S]*?\n  }\n/, '')), 'trip spans come from pageSpans');
  const css = read('app', 'renderer', 'overlay.css');
  assert.ok(css.includes('html.column-left body {\n  clip-path: inset(0 0 0 max(0px, calc(100% - var(--page-width, 100%))));'), 'nothing drawn beside the page');
  assert.ok(css.includes('html.column-left .duel-pad {\n  left: max(0px, calc(100% - var(--page-width, 100%)));'), 'the duel arena is the page');
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("root.style.setProperty('--page-width', `${next.width}px`);"));
  assert.ok(page.includes("root.classList.toggle('column-left', next.side === 'left');"));
  assert.ok(page.includes('e.clientX < pageLeft(root.clientWidth, layout)'), 'a cursor beside the page is outside');
});
