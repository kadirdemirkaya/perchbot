'use strict';

/**
 * Perching on a window's title bar (fun mode, Windows), as pure logic. main.js
 * gets the visible top-level windows from app/winscan.js: only their frames
 * (screen rectangles, already turned into DIP) and an opaque id, top-most
 * first; never a title, a process name or anything inside them.
 *
 *   pickPerch   a spot on the top edge of a window: wide enough, room above it
 *               on its screen, and not covered by a window in front of it
 *   followPerch while it sits there: 'stay', 'move' (the window moved: it rides
 *               along) or 'fall' (closed, minimised, covered, off its screen)
 *   ledgeDrop   once it is up there: how far the robot's window goes down so it
 *               sits ON the edge, legs dangling over the title bar (0: it stays
 *               standing on the edge, as before: near the caption buttons)
 *
 * A spot is an ANCHOR (bottom-centre of the slot, screen DIP), as in roam.js.
 * Sitting on the ledge, the anchor is `drop` DIP below the window's top edge.
 */

const { SLOT } = require('./placement');

const PERCH = Object.freeze({
  /** A window must be this much wider than the slot (DIP at medium size). */
  minExtra: 40,
  /** Places along a top edge it tries (spread over the edge). */
  tries: 7,
  /** How far in front of the edge a covering window must reach to count (DIP). */
  probe: 3,
  /** While it sits there: how often main.js looks again (ms). */
  followMs: 400,
  /** A window that jumps further than this between two looks (DIP): it falls off. */
  maxJump: 600,
  /**
   * Sitting on the ledge: the window goes down this far (DIP at medium size), so the
   * bottom of the body (y 157 of the artwork) is on the edge and the legs hang over it.
   * The anchor is 4 px below the artwork's box, its bottom 204 - 157 = 47; 2 px in.
   */
  ledge: 49,
  /** Keep the dangling legs this far from the window's right end (DIP): its caption buttons. */
  buttons: 150,
  /** How far the legs reach to either side of the anchor (DIP, either way it faces). */
  legReach: 50,
  /** Once up there it sits down after this long (ms), taking this long (ms). */
  sinkDelayMs: 150,
  sinkMs: 380,
});

const isRect = (r) =>
  r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v)) && r.w > 0 && r.h > 0;

function inside(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function areaOf(point, areas) {
  return areas.find((a) => point.x >= a.x && point.x <= a.x + a.width && point.y >= a.y && point.y <= a.y + a.height) || null;
}

/** Is the stretch of the top edge under the slot at x free of the windows in front (before index)? */
function edgeFree(windows, index, x, half, y, probe) {
  for (let i = 0; i < index; i += 1) {
    const w = windows[i];
    for (const px of [x - half, x, x + half]) if (inside(w, px, y + probe)) return false;
  }
  return true;
}

/**
 * A spot on a window's title bar, or null.
 * @param {object} p
 * @param {Array<{id: string, x: number, y: number, w: number, h: number}>} p.windows  top-most first, DIP
 * @param {Array<{x, y, width, height}>} p.areas  the work areas of the screens
 * @param {number} [p.scale]
 * @param {{x: number, y: number}|null} [p.from]  where it is now (a spot far from here is nicer)
 * @returns {null | { id: string, anchor: {x, y}, offset: number, rect: object }}
 */
function pickPerch({ windows, areas, scale = 1, from = null, random = Math.random }) {
  if (!Array.isArray(windows) || !Array.isArray(areas) || !areas.length) return null;
  const half = (SLOT.width / 2) * scale;
  const height = SLOT.height * scale;
  const spots = [];
  windows.forEach((w, index) => {
    if (!isRect(w) || typeof w.id !== 'string' || w.max) return;
    if (w.w < SLOT.width * scale + PERCH.minExtra * scale) return;
    const area = areaOf({ x: w.x + w.w / 2, y: w.y + 1 }, areas);
    if (!area) return;
    // Room above the edge, on that screen, for the whole slot.
    if (w.y - height < area.y || w.y > area.y + area.height - 4) return;
    for (let i = 0; i < PERCH.tries; i += 1) {
      const x = Math.round(w.x + half + ((w.w - 2 * half) * (i + 0.5)) / PERCH.tries);
      if (x - half < area.x || x + half > area.x + area.width) continue;
      if (!edgeFree(windows, index, x, half, w.y, PERCH.probe * scale)) continue;
      spots.push({ id: w.id, anchor: { x, y: Math.round(w.y) }, offset: x - w.x, rect: { x: w.x, y: w.y, w: w.w, h: w.h } });
    }
  });
  if (!spots.length) return null;
  // Rather somewhere new than right where it is.
  const away = from ? spots.filter((s) => Math.hypot(s.anchor.x - from.x, s.anchor.y - from.y) > 150 * scale) : spots;
  const pool = away.length ? away : spots;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

/**
 * While it sits on a window: what now?
 * @param {{ id: string, offset: number, rect: object }} perch
 * @returns {{ kind: 'stay' } | { kind: 'move', anchor: {x, y}, rect: object } | { kind: 'fall', why: string }}
 */
function followPerch(perch, { windows, areas, scale = 1 }) {
  if (!perch || !Array.isArray(windows)) return { kind: 'fall', why: 'gone' };
  const index = windows.findIndex((w) => w && w.id === perch.id);
  const w = index >= 0 ? windows[index] : null;
  if (!isRect(w)) return { kind: 'fall', why: 'gone' };
  if (w.max) return { kind: 'fall', why: 'maximised' };
  const half = (SLOT.width / 2) * scale;
  // Keep the same place along the edge (squeezed in if the window got narrower).
  const offset = Math.min(Math.max(perch.offset, half), Math.max(half, w.w - half));
  const edge = { x: Math.round(w.x + offset), y: Math.round(w.y) };
  // Sitting on the ledge: the anchor is below the edge by the same amount as before.
  const drop = Number.isFinite(perch.drop) && perch.drop > 0 ? perch.drop : 0;
  const anchor = { x: edge.x, y: edge.y + drop };
  const area = areaOf({ x: edge.x, y: edge.y + 1 }, areas || []);
  if (!area || edge.y - SLOT.height * scale < area.y) return { kind: 'fall', why: 'no room' };
  // On the ledge, its feet would go below the bottom of the screen's work area.
  if (drop && anchor.y > area.y + area.height) return { kind: 'fall', why: 'no room below' };
  if (!edgeFree(windows, index, anchor.x, half, w.y, PERCH.probe * scale)) return { kind: 'fall', why: 'covered' };
  const moved = w.x !== perch.rect.x || w.y !== perch.rect.y || w.w !== perch.rect.w;
  if (!moved) return { kind: 'stay' };
  if (Math.hypot(w.x - perch.rect.x, w.y - perch.rect.y) > PERCH.maxJump * scale) return { kind: 'fall', why: 'jumped' };
  return { kind: 'move', anchor, rect: { x: w.x, y: w.y, w: w.w, h: w.h }, offset };
}

/**
 * Up on a window's edge: sit on it with the legs over the title bar? How far
 * the robot's window goes down for that (DIP), or 0 when the legs would come
 * near the caption buttons at the window's right end (it stands there, as before).
 * @param {{ offset: number, rect: { w: number }, anchor?: { y: number } }} perch
 * @param {number} [scale]
 * @param {number} [bottom]  the bottom of the work area (DIP): the anchor must stay above it
 * @returns {number}
 */
function ledgeDrop(perch, scale = 1, bottom = Infinity) {
  if (!perch || !perch.rect || !Number.isFinite(perch.offset) || !Number.isFinite(perch.rect.w)) return 0;
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const toRightEnd = perch.rect.w - perch.offset;
  if (toRightEnd < (PERCH.buttons + PERCH.legReach) * scale) return 0;
  if (perch.offset < PERCH.legReach * scale) return 0;
  const drop = Math.round(PERCH.ledge * scale);
  if (perch.anchor && Number.isFinite(perch.anchor.y) && perch.anchor.y + drop > bottom) return 0;
  return drop;
}

/**
 * The scanner's line (app/winscan.js): a JSON array of { id, x, y, w, h, max }
 * in physical pixels. Anything else is dropped; at most `limit` windows.
 */
function parseScan(line, limit = 64) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out = [];
  for (const w of data) {
    if (out.length >= limit) break;
    if (!w || typeof w !== 'object') continue;
    const id = typeof w.id === 'number' || typeof w.id === 'string' ? String(w.id) : null;
    const rect = { x: Number(w.x), y: Number(w.y), w: Number(w.w), h: Number(w.h) };
    if (!id || !/^\d{1,20}$/.test(id) || !isRect(rect)) continue;
    out.push({ id, ...rect, max: w.max === true });
  }
  return out;
}

module.exports = { PERCH, pickPerch, followPerch, ledgeDrop, parseScan };
