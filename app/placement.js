'use strict';

/**
 * Window geometry, as pure functions.
 *
 * The character lives in a fixed-size "slot" (SLOT, CSS px at zoom 1). Next to
 * it, on the side facing the middle of the screen, is room for the hover menu
 * and the sub-agent minis (CREW): `side` says which side that is.
 *
 * Positions are stored as an ANCHOR: the bottom-centre of the slot, in screen
 * DIPs. That point stays put when the window grows or shrinks.
 *
 *   corner mode   anchor derived from the primary display's work area
 *   free mode     settings.position = anchor saved after a drag
 *
 * A free position that is no longer fully on any display (monitor unplugged,
 * resolution changed) falls back to corner mode on the primary display.
 */

const { shiftAnchor } = require('./instances');

const SLOT = Object.freeze({ width: 220, height: 270 });
const SIDE_WIDTH = 64; // hover menu column
/** The side column while the chat panel is open (CSS px; see overlay.css .chat). */
const CHAT_WIDTH = 176;
const SCALE = Object.freeze({ small: 0.8, medium: 1, large: 1.3 });
const MARGIN = 12;
const SNAP_DISTANCE = 48;
const CORNERS = ['bottom-right', 'bottom-left'];
/** Higher than this above the ground (DIP at medium size), the character hovers. */
const HOVER_THRESHOLD = 24;

/**
 * Sub-agent "minis" stand in a row on the same side as the hover menu.
 * All values are CSS px at zoom 1, measured OUTWARDS from the slot edge that
 * faces the crew to a mini's foot centre:
 *
 *   [ ... mini 3 | mini 2 | mini 1 | mini 0 |  report point  ][ main slot ]
 *                                                   ^ briefs and reports happen here
 *
 * The report point differs per side because the main character is not
 * symmetric (its laptop sticks out on the right).
 */
const CREW = Object.freeze({
  max: 4,
  /** A mini is drawn in a box this big (two thirds of the 200 px character box). */
  miniSize: 132,
  report: Object.freeze({ left: 6, right: 26 }),
  /** From the report point to the first work spot (room for an open laptop). */
  firstGap: 106,
  /** Between two work spots. */
  spacing: 104,
  /** Behind the outermost mini: its back plus a margin. */
  tail: 40,
});

function scaleFor(size) {
  return SCALE[size] || 1;
}

/**
 * The corner spot. slot > 0: one buddy per account, the next one stands beside
 * the first (instances.shiftAnchor) instead of on top of it.
 */
function cornerAnchor(workArea, corner, scale, slot = 0) {
  const half = (SLOT.width / 2) * scale;
  const x = corner === 'bottom-left' ? workArea.x + MARGIN + half : workArea.x + workArea.width - MARGIN - half;
  const anchor = { x: Math.round(x), y: workArea.y + workArea.height };
  return slot ? shiftAnchor(anchor, corner, slot, SLOT.width * scale, workArea) : anchor;
}

/** Screen rectangle covered by the character slot. */
function slotRect(anchor, scale) {
  const width = SLOT.width * scale;
  const height = SLOT.height * scale;
  return { x: anchor.x - width / 2, y: anchor.y - height, width, height };
}

function contains(outer, inner, tolerance = 1) {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Menu goes towards the middle of the display the character is on. */
function sideFor(anchor, workArea) {
  return anchor.x > workArea.x + workArea.width / 2 ? 'left' : 'right';
}

/**
 * Where the character should be, given settings and the current displays.
 * @param {{ position: {x:number,y:number}|null, corner: string }} settings
 * @param {Array<{ id: number, workArea: object }>} displays
 * @param {{ id: number, workArea: object }} primary
 */
function resolveAnchor(settings, displays, primary, scale, slot = 0) {
  if (settings.position) {
    const display = displays.find((d) => contains(d.workArea, slotRect(settings.position, scale)));
    if (display) return { anchor: { ...settings.position }, workArea: display.workArea, mode: 'free' };
  }
  return { anchor: cornerAnchor(primary.workArea, settings.corner, scale, slot), workArea: primary.workArea, mode: 'corner' };
}

/**
 * Page layout (CSS px) and window bounds (DIP) for an anchor and side.
 * sideWidth: the column next to the slot (menu, minis); it grows inwards, so
 * the slot, and with it the anchor, never moves.
 */
function windowLayout(anchor, side, scale, sideWidth = SIDE_WIDTH) {
  const page = {
    width: SLOT.width + sideWidth,
    height: SLOT.height,
    slotLeft: side === 'left' ? sideWidth : 0,
    side,
    sideWidth,
  };
  const bounds = {
    x: Math.round(anchor.x - (page.slotLeft + SLOT.width / 2) * scale),
    y: Math.round(anchor.y - SLOT.height * scale),
    width: Math.round(page.width * scale),
    height: Math.round(page.height * scale),
  };
  return { page, bounds };
}

function distanceToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function nearestDisplay(point, displays) {
  let best = displays[0];
  let bestDistance = Infinity;
  for (const display of displays) {
    const d = distanceToRect(point, display.workArea);
    if (d < bestDistance) {
      best = display;
      bestDistance = d;
    }
  }
  return best;
}

/** Move the anchor so the whole slot is inside the work area. */
function clampAnchor(anchor, workArea, scale) {
  const half = (SLOT.width / 2) * scale;
  const height = SLOT.height * scale;
  const minX = workArea.x + half;
  const maxX = workArea.x + workArea.width - half;
  const minY = workArea.y + height;
  const maxY = workArea.y + workArea.height;
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, anchor.x))),
    y: Math.round(Math.min(maxY, Math.max(minY, anchor.y))),
  };
}

/**
 * Result of dropping the character after a drag: clamp to the nearest
 * display; snap to a bottom corner when within SNAP_DISTANCE. A corner of the
 * primary display becomes corner mode; anything else is a free position.
 * @returns {{ position: {x,y}|null, corner?: string }}  a settings patch
 */
function dropPlacement(anchor, displays, primary, scale, slot = 0) {
  const display = nearestDisplay(anchor, displays);
  const clamped = clampAnchor(anchor, display.workArea, scale);
  for (const corner of CORNERS) {
    const target = cornerAnchor(display.workArea, corner, scale, slot);
    if (Math.hypot(target.x - clamped.x, target.y - clamped.y) <= SNAP_DISTANCE) {
      return display.id === primary.id ? { position: null, corner } : { position: target };
    }
  }
  return { position: clamped };
}

/** The anchor a drop patch (see dropPlacement) stands for. */
function anchorOfPatch(patch, primary, scale, slot = 0) {
  return patch.position ? { ...patch.position } : cornerAnchor(primary.workArea, patch.corner, scale, slot);
}

/**
 * Where the character belongs when it comes to rest at `point` after a drag
 * or a throw: just above the ground it lands on it, then as dropPlacement
 * (inside the nearest work area, snapped to a corner nearby).
 */
function settleAnchor(point, displays, primary, scale, slot = 0) {
  const p = { x: point.x, y: point.y };
  const workArea = nearestDisplay(p, displays).workArea;
  const ground = workArea.y + workArea.height;
  if (ground - p.y > 0 && ground - p.y <= HOVER_THRESHOLD * scale && p.x >= workArea.x && p.x <= workArea.x + workArea.width) {
    p.y = ground;
  }
  return anchorOfPatch(dropPlacement(p, displays, primary, scale, slot), primary, scale, slot);
}

/**
 * Which side the menu column goes on. Towards the middle of the display, but
 * the current side stays as long as there is room for `need` CSS px there:
 * switching sides moves the window under the character, and the page can
 * only redraw a moment later.
 */
function sideWithRoom(anchor, workArea, scale, current, need = SIDE_WIDTH) {
  const preferred = sideFor(anchor, workArea);
  if (!current || current === preferred) return preferred;
  const half = (SLOT.width / 2) * scale;
  const room = current === 'right' ? workArea.x + workArea.width - (anchor.x + half) : anchor.x - half - workArea.x;
  return room >= need * scale ? current : preferred;
}

/**
 * The ground under an anchor: the bottom edge of the work area of the display
 * the character is on (taskbar excluded). The primary display's work area is
 * used when the anchor is on no display.
 */
function groundFor(anchor, displays, primary) {
  const on = displays.find((d) => {
    const w = d.workArea;
    return anchor.x >= w.x && anchor.x < w.x + w.width && anchor.y > w.y && anchor.y <= w.y + w.height + 1;
  });
  const workArea = (on || primary).workArea;
  return workArea.y + workArea.height;
}

/** Height of the anchor (the character's feet) above the ground, in DIP. Never negative. */
function altitudeOf(anchor, displays, primary) {
  return Math.max(0, groundFor(anchor, displays, primary) - anchor.y);
}

/**
 * Should the character hover? Only in "auto" hover mode, and only when it is
 * clearly above the ground (the threshold grows with the character size).
 */
function isAirborne(altitude, scale, hoverMode) {
  return hoverMode !== 'stand' && altitude > HOVER_THRESHOLD * scale;
}

/**
 * The cat (when called): it plays right next to the main character, then
 * naps further out, beyond the helpers. Same outward offsets as the crew.
 */
const PET = Object.freeze({
  /** Drawn in a box this big. */
  size: 96,
  /** Its play spot: this far beyond the report point. */
  play: 56,
  /** Its nap spot: this far beyond the play spot, or beyond the outermost helper. */
  nap: 80,
  /** Room behind it. */
  tail: 46,
  /**
   * Where it comes to be petted (the idle story): this far beyond the slot edge, per side
   * (inside it: the cat's head under the main character's hand, which reaches out past the edge).
   */
  cuddle: Object.freeze({ left: -28, right: -32 }),
});

/**
 * Bug hunt: where the bug sits. Right at the main character's feet, where its
 * sword comes down when it lunges (robot.css: data-hunt), so every strike
 * really reaches it; in front of any helpers. reach is per side for the same
 * reason as CREW.report (the drawing is not symmetric about its mirror axis).
 * offset 0..1 moves it a little (jitter), so no two bugs sit on the same spot.
 */
const BUG = Object.freeze({ size: 44, reach: Object.freeze({ left: 18, right: 14 }), jitter: 12, tail: 34 });

function bugSpot(side, offset = 0.5) {
  const reach = BUG.reach[side === 'right' ? 'right' : 'left'];
  const shift = (Math.max(0, Math.min(1, Number(offset) || 0)) - 0.5) * BUG.jitter;
  const x = Math.round(reach + shift);
  return { x, width: x + BUG.tail, size: BUG.size };
}

/**
 * A helper out roaming the screen (main.js outings) flies in a little window
 * of its own: the 132 px mini box with a 10 px margin. Its anchor is the
 * mini's feet (x = 88 / 200, y = 182 / 200 of the box), in screen DIP.
 */
const HELPER = Object.freeze({ size: 152, footX: 68, footY: 130 });

function helperWindow(feet, scale = 1) {
  const s = Number(scale) || 1;
  const size = Math.round(HELPER.size * s);
  return {
    bounds: { x: Math.round(feet.x - HELPER.footX * s), y: Math.round(feet.y - HELPER.footY * s), width: size, height: size },
    /** For roam.planTrip: how far the window reaches left / right of the feet, and below them. */
    spanLeft: HELPER.footX * s,
    spanRight: (HELPER.size - HELPER.footX) * s,
    below: (HELPER.size - HELPER.footY) * s,
  };
}

function petSpots(crewCount, side) {
  const play = CREW.report[side === 'right' ? 'right' : 'left'] + PET.play;
  const nap = crewCount > 0 ? crewWidth(crewCount, side) + PET.nap / 2 : play + PET.nap;
  const cuddle = PET.cuddle[side === 'right' ? 'right' : 'left'];
  return { play, nap, width: nap + PET.tail, size: PET.size, cuddle };
}

/**
 * A visitor (the idle story): it stands this far beyond the report point,
 * close enough for the toy swords to meet; the column is as wide as `width`.
 */
const GUEST = Object.freeze({ gap: 22, tail: 84 });

function guestSpot(side) {
  const off = CREW.report[side === 'right' ? 'right' : 'left'] + GUEST.gap;
  return { off, width: off + GUEST.tail };
}

/** Outward offset of work spot `index` (0 = next to the report point). */
function crewSpot(index, side) {
  return CREW.report[side === 'right' ? 'right' : 'left'] + CREW.firstGap + index * CREW.spacing;
}

/** Width of the column needed for `count` minis (0 when there are none). */
function crewWidth(count, side) {
  if (!(count > 0)) return 0;
  return crewSpot(Math.min(count, CREW.max) - 1, side) + CREW.tail;
}

/**
 * How many minis fit between the slot and the edge of the work area on the
 * crew side (0..CREW.max). The rest are shown as "+N".
 */
function crewCapacity(anchor, side, workArea, scale) {
  const half = (SLOT.width / 2) * scale;
  const room =
    side === 'right'
      ? workArea.x + workArea.width - (anchor.x + half)
      : anchor.x - half - workArea.x;
  let fit = 0;
  while (fit < CREW.max && crewWidth(fit + 1, side) * scale <= room) fit += 1;
  return fit;
}

/** The crew geometry the page needs to place minis (CSS px). */
function crewGeometry(side, capacity) {
  return {
    capacity,
    miniSize: CREW.miniSize,
    report: CREW.report[side === 'right' ? 'right' : 'left'],
    spots: Array.from({ length: capacity }, (_, i) => crewSpot(i, side)),
  };
}

/**
 * Room the window keeps for the side column when the column is on the left (CSS px): the
 * widest the column ever gets, four helpers with the cat napping beyond them (windowFrame).
 * Rounded up to a multiple of 4, as the page widths are: at 125 % or 175 % display scaling
 * the window then still spans whole pixels and the character stays on the very pixel it
 * stood on with a window as wide as the page.
 */
const COLUMN_ROOM =
  Math.ceil(
    Math.max(
      SIDE_WIDTH,
      CHAT_WIDTH,
      crewWidth(CREW.max, 'left'),
      petSpots(CREW.max, 'left').width,
      guestSpot('left').width,
      bugSpot('left', 1).width,
    ) / 4,
  ) * 4;

/**
 * The left edge (DIP) the window may not reach past: the right edge of a display beside the
 * anchor's one, on its left, with another scale factor (a window mostly over there would
 * take on that scale). -Infinity when there is none. Displays without bounds are left out.
 */
function frameLimit(anchor, screens) {
  if (!Array.isArray(screens) || !screens.length) return -Infinity;
  const here = nearestDisplay(anchor, screens);
  if (!here || !here.bounds) return -Infinity;
  const h = here.bounds;
  let limit = -Infinity;
  for (const s of screens) {
    if (s === here || !s.bounds || s.scaleFactor === here.scaleFactor) continue;
    const b = s.bounds;
    if (b.y >= h.y + h.height || b.y + b.height <= h.y) continue; // above or below, not beside
    const right = b.x + b.width;
    if (right <= anchor.x) limit = Math.max(limit, right);
  }
  return limit;
}

/**
 * The window itself (DIP), around the page of windowLayout.
 *
 * With the column on the left the window reaches as far left as the widest column would
 * (COLUMN_ROOM), whatever is in the column now: helpers, the cat, a bug, a visitor or the
 * chat come and go inside it, and the window neither moves nor changes size. The page draws
 * only its own width and lets the mouse through beside it (renderer: pageLeft, overlay.css).
 * Why: Windows shows a resized window's last picture from its new top-left corner until the
 * page has drawn the new size, so a left edge that moved under a character that stays put
 * showed everything a frame off, now and then (a jump as a helper came or went).
 * With the column on the right the window grows to the right, its left edge stays anyway:
 * the frame is the page.
 *
 * The room stops at frameLimit and never makes the window narrower than the page. Near that
 * limit it narrows bit by bit as the character comes closer (a trip, a drag): no jump there.
 * @param {Array<{ workArea: object, bounds?: object, scaleFactor?: number }>} [screens]
 * @returns {{ bounds: object, spare: number }}  spare: CSS px of window left of the page
 */
function windowFrame(anchor, side, scale, sideWidth = SIDE_WIDTH, screens = []) {
  if (side !== 'left') return { bounds: windowLayout(anchor, side, scale, sideWidth).bounds, spare: 0 };
  const limit = frameLimit(anchor, screens);
  const reach = limit === -Infinity ? Infinity : Math.floor((anchor.x - (SLOT.width / 2) * scale - limit) / scale);
  const width = Math.max(sideWidth, Math.min(COLUMN_ROOM, reach));
  return { bounds: windowLayout(anchor, 'left', scale, width).bounds, spare: width - sideWidth };
}

module.exports = {
  SLOT,
  SIDE_WIDTH,
  CHAT_WIDTH,
  COLUMN_ROOM,
  windowFrame,
  frameLimit,
  SNAP_DISTANCE,
  HOVER_THRESHOLD,
  CREW,
  PET,
  petSpots,
  GUEST,
  guestSpot,
  BUG,
  bugSpot,
  HELPER,
  helperWindow,
  crewSpot,
  crewWidth,
  crewCapacity,
  crewGeometry,
  groundFor,
  altitudeOf,
  isAirborne,
  scaleFor,
  cornerAnchor,
  slotRect,
  contains,
  sideFor,
  sideWithRoom,
  settleAnchor,
  anchorOfPatch,
  resolveAnchor,
  windowLayout,
  clampAnchor,
  nearestDisplay,
  dropPlacement,
};
