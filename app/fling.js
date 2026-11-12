'use strict';

/**
 * Throwing the character, and settling it after a drop, as pure functions.
 *
 * The user drags the character and lets go. main.js samples the cursor while
 * dragging; velocityFrom() turns the last few samples into a release speed.
 * planFling() then plans what happens next:
 *
 *   a throw   released while moving fast enough: it glides on in that
 *             direction, slows down (air friction, its thrusters), bounces
 *             softly off the edges of the work area and comes to rest
 *             wherever its speed runs out, in the air or on the ground
 *   settling  wherever it came to rest (or was simply dropped), `settle` may
 *             move it a little: into the work area, onto a nearby corner,
 *             down to the ground when it is just above it. That last bit is an
 *             eased move too, never a jump.
 *
 * The plan is a list of samples; positionAt() reads it frame by frame, like
 * the trips in roam.js. All positions are ANCHORS (bottom-centre of the slot,
 * screen DIP), as in placement.js.
 */

const { SLOT } = require('./placement');

const FLING = Object.freeze({
  /** Released slower than this (DIP per ms): a plain drop, no glide. */
  minSpeed: 0.35,
  /** Faster throws are capped (DIP per ms). */
  maxSpeed: 4.5,
  /** Air friction: the speed falls to 1/e in this long. */
  tauMs: 240,
  /** The glide ends below this speed (DIP per ms). */
  stopSpeed: 0.03,
  /** Share of the speed kept when it bounces off an edge. */
  bounce: 0.45,
  /** Simulation step and the longest glide. */
  stepMs: 8,
  maxMs: 2600,
  /** The release speed is measured over the cursor samples of this last stretch. */
  sampleMs: 90,
  /** The cursor rested at least this long before the release: no throw. */
  restMs: 70,
  /** Easing into the settled place. */
  settleMs: 260,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Release velocity (DIP per ms) from cursor samples [{ t, x, y }], oldest first.
 * Zero when the cursor stood still before the release, or there is too little to go on.
 */
function velocityFrom(samples, now) {
  const list = Array.isArray(samples) ? samples.filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y)) : [];
  if (list.length < 2) return { vx: 0, vy: 0 };
  const last = list[list.length - 1];
  if (now - last.t > FLING.restMs) return { vx: 0, vy: 0 };
  let first = last;
  for (let i = list.length - 2; i >= 0 && last.t - list[i].t <= FLING.sampleMs; i -= 1) first = list[i];
  const dt = last.t - first.t;
  if (dt < 12) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/** Where the anchor may go so the whole slot stays inside the work area. */
function limitsOf(workArea, scale) {
  const half = (SLOT.width / 2) * scale;
  const height = SLOT.height * scale;
  return {
    minX: workArea.x + half,
    maxX: Math.max(workArea.x + half, workArea.x + workArea.width - half),
    minY: workArea.y + height,
    maxY: workArea.y + workArea.height,
  };
}

/**
 * @param {object} p
 * @param {{x:number,y:number}} p.from  the anchor at the release
 * @param {{vx:number,vy:number}} p.velocity  release velocity (DIP per ms)
 * @param {{x,y,width,height}} p.workArea  of the display it is on
 * @param {number} [p.scale]
 * @param {(point: {x:number,y:number}) => {x:number,y:number}} [p.settle]
 *   where it finally belongs, given where it came to rest (clamping, corner snap, ground)
 * @returns {null | { kind: 'fling', from, to, ms, face, thrown: boolean, path: Array<{x:number,y:number}>, stepMs: number }}
 *   null: nothing to animate (it stays where it was dropped)
 */
function planFling({ from, velocity, workArea, scale = 1, settle = (point) => point }) {
  if (!from || !workArea) return null;
  const l = limitsOf(workArea, scale);
  let vx = Number(velocity && velocity.vx) || 0;
  let vy = Number(velocity && velocity.vy) || 0;
  const speed = Math.hypot(vx, vy);
  if (speed > FLING.maxSpeed) {
    vx *= FLING.maxSpeed / speed;
    vy *= FLING.maxSpeed / speed;
  }
  const thrown = speed >= FLING.minSpeed;
  const step = FLING.stepMs;
  const path = [{ x: from.x, y: from.y }];
  let x = from.x;
  let y = from.y;

  if (thrown) {
    const decay = Math.exp(-step / FLING.tauMs);
    for (let t = step; t <= FLING.maxMs; t += step) {
      vx *= decay;
      vy *= decay;
      x += vx * step;
      y += vy * step;
      // Off an edge it bounces back (only while it moves outwards: a drop that
      // started outside is brought in by settling, not thrown about).
      if (x < l.minX && vx < 0) {
        x = l.minX + (l.minX - x) * FLING.bounce;
        vx = -vx * FLING.bounce;
      } else if (x > l.maxX && vx > 0) {
        x = l.maxX - (x - l.maxX) * FLING.bounce;
        vx = -vx * FLING.bounce;
      }
      if (y < l.minY && vy < 0) {
        y = l.minY + (l.minY - y) * FLING.bounce;
        vy = -vy * FLING.bounce;
      } else if (y > l.maxY && vy > 0) {
        y = l.maxY - (y - l.maxY) * FLING.bounce;
        vy = -vy * FLING.bounce;
      }
      path.push({ x, y });
      if (Math.hypot(vx, vy) < FLING.stopSpeed) break;
    }
  }

  const rest = { x: Math.round(x), y: Math.round(y) };
  const target = settle(rest) || rest;
  const to = { x: Math.round(target.x), y: Math.round(target.y) };
  const distance = Math.hypot(to.x - x, to.y - y);
  if (distance >= 1) {
    // Ease out into the settled place.
    const n = Math.max(2, Math.round(FLING.settleMs / step));
    for (let i = 1; i <= n; i += 1) {
      const p = i / n;
      const e = 1 - (1 - p) ** 3;
      path.push({ x: x + (to.x - x) * e, y: y + (to.y - y) * e });
    }
  }
  path[path.length - 1] = { ...to };
  if (path.length < 2 || (!thrown && distance < 1)) return null;
  return {
    kind: 'fling',
    from: { x: from.x, y: from.y },
    to,
    thrown,
    ms: (path.length - 1) * step,
    stepMs: step,
    face: to.x < from.x ? 'left' : 'right',
    path,
  };
}

/** Where the character is `t` ms into a fling. */
function positionAt(plan, t) {
  const { path, stepMs } = plan;
  if (!(t > 0)) return { x: Math.round(path[0].x), y: Math.round(path[0].y) };
  const at = t / stepMs;
  const i = Math.floor(at);
  if (i >= path.length - 1) return { ...plan.to };
  const f = at - i;
  const a = path[i];
  const b = path[i + 1];
  return { x: Math.round(a.x + (b.x - a.x) * f), y: Math.round(a.y + (b.y - a.y) * f) };
}

/** Horizontal speed at `t` (DIP per ms): the flames lean against it. */
function speedAt(plan, t) {
  const a = positionAt(plan, Math.max(0, t - plan.stepMs * 2));
  const b = positionAt(plan, t);
  return (b.x - a.x) / (plan.stepMs * 2);
}

module.exports = { FLING, velocityFrom, planFling, positionAt, speedAt, limitsOf, clamp };
