'use strict';

/**
 * Helpers out roaming the screen (the crew's "roam", app/renderer/lib/crew.js):
 * the pure parts of main.js's outings. A mini flies out of the buddy's window;
 * the page tells main where it stood (parseOuting); main gives it a little
 * window of its own (placement.helperWindow) and flies that around with
 * roam.planTrip legs (roam.pickOutingLeg); at the end it flies back over its
 * spot (returnPoint), the window goes and the mini drops in again.
 */

const { SLOT } = require('./placement');

const AGENT_ID_RE = /^[a-f0-9]{6,16}$/;

const OUTING = Object.freeze({
  /** At most this many helpers out at once (also the crew's own limit). */
  max: 2,
  /** Legs per roam (random in between), then home. */
  minLegs: 2,
  maxLegs: 4,
  /** A look round (or a little show) between two legs. */
  pauseMinMs: 700,
  pauseMaxMs: 2200,
  /** Fading out / in: to another screen, and at the very end. */
  fadeMs: 240,
  /** Never out longer than this (the crew calls it back after a minute anyway). */
  maxMs: 55000,
  /** The shows it may put on between legs (mini CSS data-play). */
  plays: Object.freeze(['spin', 'jump', 'wave', 'dance']),
});

/**
 * The page's message when a mini has left: { id, tint, off, x, y } with x / y
 * the mini's feet in page coordinates (CSS px) and off its spot (CSS px out
 * from the slot edge). Anything else: null.
 */
function parseOuting(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const { id, tint, off, x, y } = msg;
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) return null;
  if (!Number.isInteger(tint) || tint < 0 || tint > 11) return null;
  const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!inRange(off, 0, 4000) || !inRange(x, -500, 8000) || !inRange(y, -500, 8000)) return null;
  return { id, tint, off: Math.round(off), x: Math.round(x), y: Math.round(y) };
}

/** Page coordinates (CSS px) -> screen DIP, for a window at `bounds` with page zoom `scale`. */
function toScreen(point, bounds, scale = 1) {
  return { x: Math.round(bounds.x + point.x * scale), y: Math.round(bounds.y + point.y * scale) };
}

/**
 * Where a helper flies back to at the end: just above its spot in the buddy's
 * window (screen DIP, feet). The crew stands outwards from the slot edge on
 * the window's side column (side 'left': left of the slot).
 */
function returnPoint(bounds, side, off, scale = 1) {
  const s = Number(scale) || 1;
  const edge = side === 'right' ? bounds.x + SLOT.width * s : bounds.x + bounds.width - SLOT.width * s;
  const dir = side === 'right' ? 1 : -1;
  return { x: Math.round(edge + dir * off * s), y: Math.round(bounds.y + bounds.height - 60 * s) };
}

/** How many legs this roam has. */
function pickLegs(random = Math.random) {
  return OUTING.minLegs + Math.floor(random() * (OUTING.maxLegs - OUTING.minLegs + 1 - 1e-9));
}

/** What it does between two legs: a look round mostly, now and then a little show. */
function pickPause(random = Math.random) {
  const ms = Math.round(OUTING.pauseMinMs + random() * (OUTING.pauseMaxMs - OUTING.pauseMinMs));
  const show = random() < 0.35 ? OUTING.plays[Math.floor(random() * OUTING.plays.length) % OUTING.plays.length] : null;
  return { ms, pose: show ? 'play' : 'look', play: show };
}

module.exports = { OUTING, parseOuting, toScreen, returnPoint, pickLegs, pickPause };
