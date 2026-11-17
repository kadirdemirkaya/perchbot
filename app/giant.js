'use strict';

/**
 * The giant peek ("Giant peek" switch, off by default): before a nap, instead of
 * the small "Where are you?" at the glass, it walks up to the glass from where it
 * stands, bigger and bigger with every step (up to ten times its size, peeking up
 * from the bottom of the screen), knocks, listens, knocks again and waits a moment.
 * No answer: a shrug, it walks back to its spot, smaller and smaller, and naps
 * there. The pointer on it meanwhile: "There you are!", a happy hop, and it runs
 * back at once (no nap then).
 *
 * main.js draws it in a click-through window over the buddy's screen
 * (renderer/giant.html) and watches only where the cursor is, while it lasts.
 * It starts and ends exactly where the small one stands, at its size, so the two
 * hand over without a jump. This module plans it (no Electron): all sizes are page
 * px of that window (its zoom is the buddy's size, as for the helpers' windows),
 * relative to the display's top left.
 */

/** The character box of the page (overlay.css --char-size): the giant is up to `factor` times this. */
const BOX = 200;

/**
 * Where things are in the character box, as shares of it (robot.svg, viewBox 0 0 200 200):
 * the top of the antenna; how high the work area's bottom edge may cut it (minCut: just
 * below the shoulders, so its arms still come up; maxCut: about the waist); the feet; the
 * middle of the feet (the axis it turns round); its body's left and right with an arm up.
 */
const SHAPE = Object.freeze({ top: 0.035, minCut: 0.55, maxCut: 0.7, feet: 0.91, axis: 0.49, left: 0.12, right: 0.88 });

const GIANT = Object.freeze({
  /** At most this many times its size... */
  factor: 10,
  /** ...and never less (a screen too small for that: the small "Where are you?" instead). */
  minFactor: 4,
  /** What shows of it takes at most this share of the work area's height... */
  heightShare: 0.9,
  /** ...and its body at most this share of its width. */
  widthShare: 0.95,
  /** The page gets this long to draw it before the window shows (the small one hides then). */
  loadMs: 350,
  /** The phases while nobody answers, one after the other (ms each). */
  walkMs: 3400,
  knockMs: 1500,
  listenMs: 2400,
  againMs: 1500,
  waitMs: 1600,
  shrugMs: 1200,
  backMs: 2800,
  /** Found: a happy hop and "There you are!", then it runs back. */
  foundMs: 1400,
  dashMs: 1500,
  /** Its knuckles hit the glass this long into a knock (robot.css rb-giant-knock-forearm: 33 / 53 / 73 % of 1.5 s). */
  knockHits: Object.freeze([495, 795, 1095]),
  /** ...and into the second knock (rb-giant-again-forearm: 27 / 47 / 67 % of 1.5 s). */
  againHits: Object.freeze([405, 705, 1005]),
  /** While it lasts, the cursor is looked at this often (its position only). */
  pollMs: 100,
  /** Never twice within this long (the page asks at most every 10 minutes anyway: lib/fun.js whereDue). */
  cooldownMs: 60000,
  /** A backstop: the window never stays longer than the plan and this. */
  graceMs: 4000,
});

/** The pointer counts as an answer in these phases only (it is up at the glass). */
const HEARS = new Set(['knock', 'listen', 'again', 'wait', 'shrug']);

/** The phases from the main process to the giant's page and the buddy's page. */
const PHASES = Object.freeze(['walk', 'knock', 'listen', 'again', 'wait', 'shrug', 'back', 'found', 'dash']);

/** The phases while nobody answers: [{ phase, at }], at ms after the giant shows; null = over. */
function timeline(o = GIANT) {
  const steps = [
    ['walk', o.walkMs],
    ['knock', o.knockMs],
    ['listen', o.listenMs],
    ['again', o.againMs],
    ['wait', o.waitMs],
    ['shrug', o.shrugMs],
    ['back', o.backMs],
  ];
  const out = [];
  let at = 0;
  for (const [phase, ms] of steps) {
    out.push({ phase, at });
    at += ms;
  }
  out.push({ phase: null, at });
  return out;
}

/** After the pointer found it: [{ phase, at }], at ms after that moment. */
function foundTimeline(o = GIANT) {
  return [
    { phase: 'found', at: 0 },
    { phase: 'dash', at: o.foundMs },
    { phase: null, at: o.foundMs + o.dashMs },
  ];
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isRect = (r) => Boolean(r) && finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0;
const round = (n) => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {object} p
 * @param {{ x: number, y: number, width: number, height: number }} p.area  the work area (page px, from the display's top left)
 * @param {{ x: number, y: number }} [p.from]  where the small one's feet are: the giant starts (and ends) there
 * @param {'left' | 'right'} [p.face]  which way the small one faces
 * @param {{ listen?: string, shrug?: string, found?: string }} [p.say]  what it says (already in the user's language)
 * @returns {null | {
 *   size: number, factor: number, cut: number, left: number, top: number,
 *   clip: { x: number, y: number, width: number, height: number },
 *   far: { x: number, y: number, scale: number }, face: 'left' | 'right', backFace: 'left' | 'right',
 *   hit: { x: number, y: number, width: number, height: number },
 *   phases: Array<{ phase: string | null, at: number }>, say: object, knockHits: number[], againHits: number[], dashMs: number
 * }}
 *   size: its box at full size; left / top: that box (it reaches below the work area, which cuts
 *   it at `cut` of its height); far: the translation and scale of the box where the small one
 *   stands (at its size); face / backFace: which way it faces walking up and walking back;
 *   hit: where the pointer is "on it" at full size; null: the screen is too small
 */
function planGiant({ area, from = null, face = 'right', say = {} } = {}, o = GIANT) {
  if (!isRect(area)) return null;
  const wide = SHAPE.right - SHAPE.left;
  const room = area.height * o.heightShare;
  // As big as it may be: ten times, unless the screen cuts it higher than its shoulders (or it is too wide).
  const size = Math.min(BOX * o.factor, room / (SHAPE.minCut - SHAPE.top), (area.width * o.widthShare) / wide);
  if (size < BOX * o.minFactor) return null;
  const cut = Math.min(SHAPE.maxCut, SHAPE.top + room / size);
  const bottom = area.y + area.height;
  const middle = area.x + area.width / 2;
  // Where it starts and ends: the small one's feet, at its size.
  const scale = BOX / size;
  const feetX = clamp(from && finite(from.x) ? from.x : middle, area.x, area.x + area.width);
  const feetY = clamp(from && finite(from.y) ? from.y : bottom, area.y + BOX * SHAPE.feet, bottom);
  // Big right where it stands (it walks straight up to you, never over to the middle): its feet's
  // axis stays above the small one's, only moved in as far as its body needs to stay on the screen.
  const lo = area.x + size * (SHAPE.axis - SHAPE.left);
  const hi = area.x + area.width - size * (SHAPE.right - SHAPE.axis);
  const axisX = lo <= hi ? clamp(feetX, lo, hi) : middle;
  const left = axisX - size * SHAPE.axis;
  const top = bottom - size * cut;
  // The box scales about its bottom edge at the feet's axis: shift it so the feet land there.
  const farX = feetX - (left + size * SHAPE.axis);
  const farY = feetY - (top + size) + size * (1 - SHAPE.feet) * scale;
  // Walking up, it faces the way it goes (sideways at least a little: right by a screen's edge),
  // else the way it faced; walking back, the other way round.
  const sideways = Math.abs(farX) > BOX * 0.2;
  const way = sideways ? (farX > 0 ? 'left' : 'right') : face === 'left' ? 'left' : 'right';
  const hitTop = top + size * SHAPE.top;
  return {
    size: round(size),
    factor: round(size / BOX),
    cut: Math.round(cut * 1000) / 1000,
    left: round(left),
    top: round(top),
    clip: { x: area.x, y: area.y, width: area.width, height: area.height },
    far: { x: round(farX), y: round(farY), scale: Math.round(scale * 10000) / 10000 },
    face: way,
    backFace: sideways ? (way === 'left' ? 'right' : 'left') : way,
    hit: { x: round(left + size * SHAPE.left), y: round(hitTop), width: round(size * wide), height: round(bottom - hitTop) },
    phases: timeline(o),
    say: {
      listen: typeof say.listen === 'string' ? say.listen : '',
      shrug: typeof say.shrug === 'string' ? say.shrug : '',
      found: typeof say.found === 'string' ? say.found : '',
    },
    knockHits: [...o.knockHits],
    againHits: [...o.againHits],
    dashMs: o.dashMs,
  };
}

/** A rectangle in the giant's page px -> screen DIP (the window's top left is `origin`, its zoom `scale`). */
function toScreen(rect, origin, scale) {
  return { x: origin.x + rect.x * scale, y: origin.y + rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

function inside(p, r) {
  return Boolean(p) && finite(p.x) && finite(p.y) && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/**
 * The user answered: the pointer is on the giant while it is up at the glass. `moved`: the
 * cursor moved since the giant showed (one that was already there and never moved is not an answer).
 * @param {{ phase: string | null, cursor: { x: number, y: number }, hit: object, moved: boolean }} p  hit in screen DIP
 */
function pointerFound({ phase, cursor, hit, moved }) {
  return Boolean(moved) && HEARS.has(phase) && isRect(hit) && inside(cursor, hit);
}

/**
 * The page's start request: { op: 'start' | 'demo', feet: { x, y } (page px of the buddy's
 * window), face }. Anything else: null.
 */
function parseGiantRequest(msg) {
  if (!msg || typeof msg !== 'object' || (msg.op !== 'start' && msg.op !== 'demo')) return null;
  const f = msg.feet;
  const ok = (v) => finite(v) && Math.abs(v) < 1e5;
  if (!f || typeof f !== 'object' || !ok(f.x) || !ok(f.y)) return null;
  return { op: msg.op, feet: { x: f.x, y: f.y }, face: msg.face === 'left' ? 'left' : 'right' };
}

module.exports = { GIANT, SHAPE, BOX, HEARS, PHASES, timeline, foundTimeline, planGiant, toScreen, pointerFound, parseGiantRequest };
