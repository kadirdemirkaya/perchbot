'use strict';

/**
 * The rocket fist (hands, app/hands.js): now and then, instead of flying over
 * to a Chrome button, the buddy stays where it is, points its near arm at the
 * button and fires its forearm at it: the forearm comes off at the elbow,
 * flies on a jet of flame, presses the button and flies back onto the arm.
 * Drawn in a click-through window over the buddy's screen
 * (renderer/fist.html), like the rampage; nothing on the real screen is
 * touched (the press itself is the same UI Automation press as always).
 *
 * Pure: the dice, which way the buddy faces and how far its arm turns, where
 * the forearm comes off, and the flight's timing. Points in: screen DIP; the
 * plan's points: the effect window's page px (DIP from the display's
 * top-left corner).
 */

const FIST = Object.freeze({
  /** How often a press goes by rocket fist instead of a flight. */
  chance: 0.4,
  /** A button closer than this to the elbow (DIP at medium size): it just flies over. */
  minReach: 140,
  /**
   * The near arm's shoulder from the anchor (robot.svg: shoulder at 118,112,
   * anchor at 100,204; 1 unit = 1 DIP at medium size). Facing left the figure
   * is mirrored about x = 98 (overlay.css), so the shoulder is at 78.
   */
  shoulder: Object.freeze({ right: 18, left: -22, y: -92 }),
  /** Shoulder to elbow: the forearm comes off there. */
  upperArm: 16,
  /** Elbow to the middle of the hand. */
  forearm: 20,
  /** The arm turns towards the button and the jet lights before it fires. */
  aimMs: 450,
  /** Flight speed (DIP per second), and the shortest / longest flight. */
  speed: 1500,
  minFlightMs: 320,
  maxFlightMs: 1100,
  /** On the button: the push. */
  holdMs: 320,
  /** The way back takes a little longer. */
  backFactor: 1.15,
  /** Back on the arm: the clunk, then the pose ends. */
  dockMs: 380,
  /** The effect window must be up by then, or it flies over instead. */
  loadMs: 2500,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Which way it faces, the arm's turn (CSS degrees, clockwise from hanging
 * down, in the figure's own frame: mirrored when it faces left) and where the
 * forearm comes off (screen DIP).
 * @param {{x:number,y:number}} anchor  the buddy's anchor (feet), screen DIP
 * @param {{x:number,y:number}} target  the button's middle, screen DIP
 * @param {number} scale  the size setting's zoom
 */
function armPose(anchor, target, scale = 1) {
  const s = Number(scale) || 1;
  const face = target.x < anchor.x ? 'left' : 'right';
  const shoulder = { x: anchor.x + FIST.shoulder[face] * s, y: anchor.y + FIST.shoulder.y * s };
  const angle = Math.atan2(target.y - shoulder.y, target.x - shoulder.x);
  // Hanging down is 90 deg on the screen; mirrored, the arm's own angle is 180 deg minus the screen's.
  const own = face === 'left' ? Math.PI - angle : angle;
  let rot = (own * 180) / Math.PI - 90;
  rot = ((((rot + 180) % 360) + 360) % 360) - 180;
  const elbow = {
    x: Math.round(shoulder.x + Math.cos(angle) * FIST.upperArm * s),
    y: Math.round(shoulder.y + Math.sin(angle) * FIST.upperArm * s),
  };
  return { face, rot: Math.round(rot), elbow, angle: Math.round((angle * 180) / Math.PI) };
}

/**
 * Rocket fist this time? Only on the buddy's own screen, with the button far
 * enough away, and then at FIST.chance.
 * @param {{ sameScreen: boolean, elbow: {x:number,y:number}, target: {x:number,y:number}, scale?: number, random?: () => number }} o
 */
function useFist({ sameScreen, elbow, target, scale = 1, random = Math.random }) {
  if (!sameScreen || !elbow || !target) return false;
  if (dist(elbow, target) < FIST.minReach * (Number(scale) || 1)) return false;
  return random() < FIST.chance;
}

/**
 * The flight, in the effect window's px.
 * @param {{ from: {x:number,y:number}, to: {x:number,y:number}, scale?: number }} o
 *   from: the elbow; to: the button's middle (the middle of the hand lands there)
 * @returns {{ kind: 'fist', from: object, to: object, angle: number, size: number,
 *   outMs: number, holdMs: number, backMs: number, hitAt: number, dockAt: number }}
 *   hitAt: when it touches the button (main presses it then); dockAt: back on the arm
 */
function planFist({ from, to, scale = 1 }) {
  const s = Number(scale) || 1;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const travel = Math.max(0, dist(from, to) - FIST.forearm * s);
  const outMs = Math.round(clamp((travel / FIST.speed) * 1000, FIST.minFlightMs, FIST.maxFlightMs));
  const backMs = Math.round(outMs * FIST.backFactor);
  return {
    kind: 'fist',
    from: { x: Math.round(from.x), y: Math.round(from.y) },
    to: { x: Math.round(to.x), y: Math.round(to.y) },
    angle: Math.round((angle * 180) / Math.PI),
    size: s,
    outMs,
    holdMs: FIST.holdMs,
    backMs,
    hitAt: outMs,
    dockAt: outMs + FIST.holdMs + backMs,
  };
}

module.exports = { FIST, armPose, useFist, planFist };
