'use strict';

/**
 * The rampage: its head caught fire twice within five minutes (lib/fun.js
 * Fury). Beams from its eyes burn a line into the screen, then missiles fly
 * out of a hatch in its chest and leave blast marks elsewhere on the screen;
 * five to ten seconds after the last blast (at random) the marks fade and the
 * screen is as it was.
 *
 * All of it is drawn in one click-through window over the buddy's screen
 * (renderer/rampage.html); nothing on the real screen is touched, the mouse
 * goes through, and the window closes when the show is over.
 *
 * Pure: this file only checks the page's request and plans the show (where
 * the beams sweep, where the missiles land, and when). Points are in the
 * effect window's page px: DIP from the top-left corner of the display.
 */

const RAMPAGE = Object.freeze({
  /** The buddy's eyes glow before the first beam (the effect window loads meanwhile). */
  chargeMs: 900,
  /** The beams sweep along the burn line. */
  laserMs: 1600,
  /** From the end of the beams to the first launch. */
  gapMs: 450,
  missiles: 4,
  /** Between two launches. */
  launchGapMs: 320,
  /** One missile's flight (shortest, longest). */
  flightMs: Object.freeze([850, 1150]),
  /** The marks stay this long after the last blast (shortest, longest; at random), then fade. */
  holdMs: Object.freeze([5000, 10000]),
  healMs: 1400,
  /** Marks keep this far from the buddy's eyes / hatch (DIP), and this far from each other. */
  clearance: 230,
  spacing: 210,
  /** ...and this far inside the work area. */
  margin: 50,
  /** The page's points must lie within this many px of its window. */
  slack: 400,
  /** Two rampages are at least this far apart (the page counts blazes too; this is a backstop). */
  cooldownMs: 30000,
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The page's request: where its eyes and its chest hatch are (page px) and
 * which way it faces. Anything else, or a point far outside the window: null.
 * @param {unknown} msg
 * @param {{ width: number, height: number }} size  the buddy window, page px
 */
function parseRampage(msg, size) {
  if (!msg || typeof msg !== 'object' || !size) return null;
  const inside = (p) =>
    p &&
    typeof p === 'object' &&
    finite(p.x) &&
    finite(p.y) &&
    p.x >= -RAMPAGE.slack &&
    p.y >= -RAMPAGE.slack &&
    p.x <= size.width + RAMPAGE.slack &&
    p.y <= size.height + RAMPAGE.slack;
  if (!Array.isArray(msg.eyes) || msg.eyes.length < 1 || msg.eyes.length > 2 || !msg.eyes.every(inside)) return null;
  if (!inside(msg.hatch)) return null;
  const point = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  return { eyes: msg.eyes.map(point), hatch: point(msg.hatch), face: msg.face === 'left' ? 'left' : 'right' };
}

/**
 * A page point of the buddy window -> the effect window's page px.
 * @param {{x:number,y:number}} p  page px in the buddy window
 * @param {{x:number,y:number}} bounds  the buddy window (screen DIP)
 * @param {number} scale  the buddy page's zoom
 * @param {{x:number,y:number}} origin  the display's top-left corner (screen DIP)
 */
function toEffect(p, bounds, scale, origin) {
  const s = Number(scale) || 1;
  return { x: Math.round(bounds.x + p.x * s - origin.x), y: Math.round(bounds.y + p.y * s - origin.y) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Plans the show.
 * @param {object} o
 * @param {{x:number,y:number,width:number,height:number}} o.area  the work area, effect page px
 * @param {{x:number,y:number}[]} o.eyes  effect page px
 * @param {{x:number,y:number}} o.hatch  effect page px
 * @param {'left'|'right'} [o.face]
 * @param {() => number} [o.random]
 * @returns {{ laser: object, missiles: object[], healAt: number, endAt: number, phases: {phase: string|null, at: number}[] }}
 */
function planRampage({ area, eyes, hatch, face = 'right', random = Math.random, timings = RAMPAGE }) {
  const t = { ...RAMPAGE, ...timings };
  const m = t.margin;
  const box = {
    left: area.x + m,
    top: area.y + m,
    right: area.x + area.width - m,
    bottom: area.y + area.height - m,
  };
  const inBox = (p) => ({ x: Math.round(clamp(p.x, box.left, box.right)), y: Math.round(clamp(p.y, box.top, box.bottom)) });
  const mid = { x: eyes.reduce((s, e) => s + e.x, 0) / eyes.length, y: eyes.reduce((s, e) => s + e.y, 0) / eyes.length };

  // The beams: a slash in front of it (the way it faces; the other way when there is no room).
  let dir = face === 'left' ? -1 : 1;
  const reach = 300 + random() * 240;
  if ((dir > 0 && mid.x + reach > box.right) || (dir < 0 && mid.x - reach < box.left)) dir = -dir;
  const centre = inBox({ x: mid.x + dir * reach, y: mid.y + (random() - 0.65) * 300 });
  const angle = (random() - 0.5) * 1.1 + Math.PI / 2 + (random() < 0.5 ? 0.5 : -0.5);
  const half = (210 + random() * 110) / 2;
  const along = { x: Math.cos(angle), y: Math.sin(angle) };
  const from = inBox({ x: centre.x - along.x * half, y: centre.y - along.y * half });
  const to = inBox({ x: centre.x + along.x * half, y: centre.y + along.y * half });
  const bend = (random() - 0.5) * 90;
  const ctrl = inBox({ x: (from.x + to.x) / 2 - along.y * bend, y: (from.y + to.y) / 2 + along.x * bend });
  const laser = { eyes: eyes.map((e) => ({ ...e })), from, ctrl, to, at: 0, ms: t.laserMs };

  // The missiles: spread over the screen, away from the buddy, the burn line and each other.
  const taken = [centre];
  const missiles = [];
  for (let i = 0; i < t.missiles; i += 1) {
    let best = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 40; k += 1) {
      const p = { x: box.left + random() * Math.max(1, box.right - box.left), y: box.top + random() * Math.max(1, box.bottom - box.top) };
      const near = Math.min(dist(p, hatch) - t.clearance, ...taken.map((q) => dist(p, q) - t.spacing));
      if (near >= 0) {
        best = p;
        break;
      }
      if (near > bestScore) {
        bestScore = near;
        best = p;
      }
    }
    const target = inBox(best);
    taken.push(target);
    const top = Math.min(hatch.y, target.y) - (150 + random() * 220);
    const control = { x: Math.round((hatch.x + target.x) / 2 + (random() - 0.5) * 220), y: Math.round(Math.max(area.y + 12, top)) };
    const at = t.laserMs + t.gapMs + i * t.launchGapMs;
    const ms = Math.round(t.flightMs[0] + random() * (t.flightMs[1] - t.flightMs[0]));
    missiles.push({ from: { ...hatch }, ctrl: control, to: target, at, ms });
  }

  const lastBlast = missiles.reduce((max, x) => Math.max(max, x.at + x.ms), t.laserMs);
  const healAt = lastBlast + Math.round(t.holdMs[0] + random() * (t.holdMs[1] - t.holdMs[0]));
  const endAt = healAt + t.healMs;
  const lastLaunch = missiles.length ? missiles[missiles.length - 1].at : t.laserMs;
  const phases = [{ phase: 'laser', at: 0 }];
  if (missiles.length) phases.push({ phase: 'missile', at: missiles[0].at - 150 });
  phases.push({ phase: 'smug', at: lastLaunch + 450 }, { phase: 'heal', at: healAt }, { phase: null, at: endAt });
  return { laser, missiles, healAt, endAt, phases };
}

module.exports = { RAMPAGE, parseRampage, planRampage, toEffect };
