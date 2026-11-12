'use strict';

/**
 * Trips of the main character around the screen (fun mode), as pure
 * functions. The page decides WHEN to go (it knows the state, rest, duels);
 * main.js asks planTrip() WHERE and HOW, then moves the window frame by frame
 * with positionAt().
 *
 * Kinds of trip:
 *   stroll   walk along the ground (the bottom of the work area) a little way
 *   hop      a short flight to somewhere in the air nearby
 *   inspect  fly next to the mouse cursor (where the user is probably working)
 *            and have a look; never ON the cursor, so clicks still go through
 *   home     back to the place the user chose (corner or dragged position)
 *   flee     it was hit (clicked) too often: off to a random spot elsewhere on
 *            the screen, well away from where it was hit
 *
 * All positions are ANCHORS (bottom-centre of the slot, screen DIP), as in
 * placement.js. A trip never leaves the work area of the display it starts
 * on: not the target, not any point on the way (flights arc upwards, and the
 * whole window counts, helpers and the cat included: spanLeft / spanRight).
 */

const { SLOT } = require('./placement');

const WALK_SPEED = 0.09; // DIP per ms (90 px/s)
const RUN_SPEED = 0.22; // fleeing on foot ("Always stand" hover mode)
const FLY_SPEED = 0.42;
const MIN_TRIP_MS = 700;
const EDGE = 8;
/** Distance kept between the character's slot and the cursor (DIP at medium size). */
const CURSOR_GAP = 60;
const KINDS = new Set(['stroll', 'hop', 'inspect', 'home', 'flee']);
/** A flight lands at least this far (DIP at medium size) from where it was hit. */
const FLEE_GAP = 320;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Where the anchor may be so the whole window stays in the work area.
 * spanLeft / spanRight: how far the window reaches left / right of the anchor (DIP).
 */
function bounds(workArea, scale, spanLeft, spanRight) {
  const half = (SLOT.width / 2) * scale;
  const height = SLOT.height * scale;
  const left = Math.max(half, Number(spanLeft) || 0);
  const right = Math.max(half, Number(spanRight) || 0);
  const minX = workArea.x + left + EDGE;
  const maxX = Math.max(minX, workArea.x + workArea.width - right - EDGE);
  return {
    half,
    height,
    minX,
    maxX,
    minY: workArea.y + height,
    ground: workArea.y + workArea.height,
  };
}

/** Is the cursor inside the slot at `anchor` (with a margin)? */
function covers(anchor, cursor, b, margin) {
  if (!cursor) return false;
  return (
    cursor.x > anchor.x - b.half - margin &&
    cursor.x < anchor.x + b.half + margin &&
    cursor.y > anchor.y - b.height - margin &&
    cursor.y < anchor.y + margin
  );
}

/**
 * @param {object} p
 * @param {string} p.kind  stroll | hop | inspect | home | flee
 * @param {{x:number,y:number}} p.from  current anchor
 * @param {{x:number,y:number}} p.home  the user's chosen anchor
 * @param {{x,y,width,height}} p.workArea  of the display the character is on
 * @param {{x:number,y:number}|null} p.cursor
 * @param {number} p.scale
 * @param {string} p.hoverMode  'auto' | 'stand' (stand: never in the air)
 * @param {number} [p.spanLeft]  window width left of the anchor (DIP); default half a slot
 * @param {number} [p.spanRight]  window width right of the anchor (DIP)
 * @param {() => number} [p.random]
 * @returns {null | { kind, from, to, mode: 'walk'|'fly', ms, face: 'left'|'right', limits }}
 */
function planTrip({ kind, from, home, workArea, cursor = null, scale = 1, hoverMode = 'auto', spanLeft = 0, spanRight = 0, random = Math.random }) {
  if (!KINDS.has(kind) || !from || !workArea) return null;
  const b = bounds(workArea, scale, spanLeft, spanRight);
  const canFly = hoverMode !== 'stand';
  const onGround = from.y >= b.ground - 2;
  const gap = CURSOR_GAP * scale;
  let to;
  let mode = 'fly';

  switch (kind) {
    case 'stroll': {
      const distance = (140 + random() * 320) * scale;
      let dir = random() < 0.5 ? -1 : 1;
      if (from.x + dir * distance < b.minX || from.x + dir * distance > b.maxX) dir = -dir;
      to = { x: from.x + dir * distance, y: b.ground };
      mode = onGround ? 'walk' : 'fly';
      break;
    }
    case 'hop': {
      if (!canFly) return planTrip({ kind: 'stroll', from, home, workArea, cursor, scale, hoverMode, spanLeft, spanRight, random });
      to = { x: from.x + (random() - 0.5) * 700 * scale, y: b.ground - (60 + random() * 260) * scale };
      break;
    }
    case 'inspect': {
      if (!cursor || !canFly) return null;
      // Beside the cursor, on the side the character comes from; head about at cursor height.
      const side = cursor.x >= from.x ? -1 : 1;
      to = { x: cursor.x + side * (b.half + gap), y: cursor.y + b.height * 0.6 };
      if (to.x < b.minX || to.x > b.maxX) to.x = cursor.x - side * (b.half + gap);
      break;
    }
    case 'home': {
      if (!home) return null;
      to = { x: home.x, y: home.y };
      const sameGround = onGround && Math.abs(home.y - from.y) < 2;
      mode = sameGround && Math.abs(home.x - from.x) < 500 * scale ? 'walk' : canFly ? 'fly' : 'walk';
      break;
    }
    case 'flee': {
      // Anywhere on this screen, as long as it is well away from where it was hit.
      const minGap = Math.min(FLEE_GAP * scale, (b.maxX - b.minX) / 2);
      let x = from.x;
      for (let i = 0; i < 12 && Math.abs(x - from.x) < minGap; i += 1) x = b.minX + random() * (b.maxX - b.minX);
      if (Math.abs(x - from.x) < minGap) x = from.x - b.minX > b.maxX - from.x ? b.minX : b.maxX;
      const air = canFly && random() < 0.6;
      to = { x, y: air ? b.ground - (40 + random() * (b.ground - b.minY - 40)) : b.ground };
      mode = canFly ? 'fly' : 'walk';
      break;
    }
    default:
      return null;
  }

  to = { x: Math.round(clamp(to.x, b.minX, b.maxX)), y: Math.round(clamp(to.y, b.minY, b.ground)) };
  if (!canFly) to.y = b.ground;
  // Never park right under the cursor: the user may be about to click there.
  if (kind !== 'home' && covers(to, cursor, b, gap / 2)) {
    const shift = cursor.x > to.x ? -1 : 1;
    to.x = Math.round(clamp(cursor.x + shift * (b.half + gap), b.minX, b.maxX));
    if (covers(to, cursor, b, gap / 2)) to.x = Math.round(clamp(cursor.x - shift * (b.half + gap), b.minX, b.maxX));
  }
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 4) return null;
  const speed = mode === 'fly' ? FLY_SPEED : kind === 'flee' ? RUN_SPEED : WALK_SPEED;
  return {
    kind,
    from: { x: from.x, y: from.y },
    to,
    mode,
    ms: Math.max(MIN_TRIP_MS, Math.round(distance / (speed * scale))),
    face: to.x < from.x ? 'left' : 'right',
    limits: { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.ground },
  };
}

/**
 * Where the character is `t` ms into the trip. Walking is steady; flying
 * eases in and out along an arc.
 */
function positionAt(trip, t) {
  const p = clamp(trip.ms > 0 ? t / trip.ms : 1, 0, 1);
  const { from, to } = trip;
  if (trip.mode === 'walk') {
    return { x: Math.round(from.x + (to.x - from.x) * p), y: Math.round(from.y + (to.y - from.y) * p) };
  }
  const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  const arc = Math.min(90, Math.hypot(to.x - from.x, to.y - from.y) * 0.25) * Math.sin(Math.PI * p);
  const point = { x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e - arc) };
  // The arc must not lift the window above the top of the work area.
  const l = trip.limits;
  if (l) {
    point.x = Math.round(clamp(point.x, Math.min(l.minX, from.x), Math.max(l.maxX, from.x)));
    point.y = Math.round(clamp(point.y, Math.min(l.minY, from.y), Math.max(l.maxY, from.y)));
  }
  return point;
}

module.exports = { planTrip, positionAt, TRIP_KINDS: KINDS, CURSOR_GAP, FLEE_GAP, WALK_SPEED, FLY_SPEED };
