'use strict';

/**
 * Window geometry, as pure functions.
 *
 * The character lives in a fixed-size "slot" (SLOT, CSS px at zoom 1). Next to
 * it, on the side facing the middle of the screen, is room for the hover menu
 * (and, later, helper characters): `side` says which side that is.
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

const SLOT = Object.freeze({ width: 220, height: 270 });
const SIDE_WIDTH = 64; // hover menu column
const SCALE = Object.freeze({ small: 0.8, medium: 1, large: 1.3 });
const MARGIN = 12;
const SNAP_DISTANCE = 48;
const CORNERS = ['bottom-right', 'bottom-left'];
/** Higher than this above the ground (DIP at medium size), the character hovers. */
const HOVER_THRESHOLD = 24;

function scaleFor(size) {
  return SCALE[size] || 1;
}

function cornerAnchor(workArea, corner, scale) {
  const half = (SLOT.width / 2) * scale;
  const x = corner === 'bottom-left' ? workArea.x + MARGIN + half : workArea.x + workArea.width - MARGIN - half;
  return { x: Math.round(x), y: workArea.y + workArea.height };
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
function resolveAnchor(settings, displays, primary, scale) {
  if (settings.position) {
    const display = displays.find((d) => contains(d.workArea, slotRect(settings.position, scale)));
    if (display) return { anchor: { ...settings.position }, workArea: display.workArea, mode: 'free' };
  }
  return { anchor: cornerAnchor(primary.workArea, settings.corner, scale), workArea: primary.workArea, mode: 'corner' };
}

/** Page layout (CSS px) and window bounds (DIP) for an anchor and side. */
function windowLayout(anchor, side, scale, sideWidth = SIDE_WIDTH) {
  const page = {
    width: SLOT.width + sideWidth,
    height: SLOT.height,
    slotLeft: side === 'left' ? sideWidth : 0,
    side,
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
function dropPlacement(anchor, displays, primary, scale) {
  const display = nearestDisplay(anchor, displays);
  const clamped = clampAnchor(anchor, display.workArea, scale);
  for (const corner of CORNERS) {
    const target = cornerAnchor(display.workArea, corner, scale);
    if (Math.hypot(target.x - clamped.x, target.y - clamped.y) <= SNAP_DISTANCE) {
      return display.id === primary.id ? { position: null, corner } : { position: target };
    }
  }
  return { position: clamped };
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

module.exports = {
  SLOT,
  SIDE_WIDTH,
  SNAP_DISTANCE,
  HOVER_THRESHOLD,
  groundFor,
  altitudeOf,
  isAirborne,
  scaleFor,
  cornerAnchor,
  slotRect,
  sideFor,
  resolveAnchor,
  windowLayout,
  clampAnchor,
  nearestDisplay,
  dropPlacement,
};
