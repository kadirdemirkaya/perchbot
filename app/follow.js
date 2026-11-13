'use strict';

/**
 * Following what the user looks at (ambient life): main.js samples the
 * cursor position now and then (the position only: nothing under it is read,
 * no window titles, no clipboard). When the cursor has moved somewhere and
 * then rests there, the user is probably looking at that spot: a "dwell". The
 * page may then send the buddy over to have a look through its magnifier
 * (roam.js 'inspect' at that spot, robot.css data-lens).
 *
 * Pure: the caller passes the samples and the time.
 */

const FOLLOW = Object.freeze({
  /** How often main.js looks where the cursor is (ms). */
  sampleMs: 600,
  /** The cursor moved at least this far (DIP) since the last spot... */
  moveMin: 160,
  /** ...and then stayed within this many DIP... */
  stillPx: 14,
  /** ...for this long: a dwell. */
  dwellMs: 2400,
  /** Not right next to the buddy (the user is busy with the buddy itself then). */
  nearBuddy: 260,
  /** The page's chance to go and have a look at a dwell, and the least time between two looks. */
  chance: 0.5,
  cooldownMs: 40000,
  /** The magnifier pose on arrival. */
  lensMs: 5200,
  /** A dwell is still worth a trip this long after it was seen. */
  freshMs: 5000,
});

class DwellWatch {
  constructor(options = {}) {
    this.o = { ...FOLLOW, ...options };
    this.reset();
  }

  reset() {
    /** Where the cursor rests now, and since when. */
    this.still = null;
    /** The last spot reported (or the first sample): a new dwell must be away from it. */
    this.base = null;
    this.reported = false;
  }

  /**
   * One sample of the cursor.
   * @param {{x:number,y:number}} point  screen DIP
   * @param {number} now  ms
   * @param {{x:number,y:number}|null} [buddy]  the buddy's anchor (feet), screen DIP
   * @returns {{x:number,y:number}|null}  a dwell to report, once
   */
  sample(point, now, buddy = null) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const p = { x: Math.round(point.x), y: Math.round(point.y) };
    if (!this.base) this.base = p;
    if (!this.still || Math.hypot(p.x - this.still.x, p.y - this.still.y) > this.o.stillPx) {
      this.still = { ...p, since: now };
      this.reported = false;
      return null;
    }
    if (this.reported || now - this.still.since < this.o.dwellMs) return null;
    // It rests: a new spot only if it is far enough from the last one.
    this.reported = true;
    const spot = { x: this.still.x, y: this.still.y };
    if (Math.hypot(spot.x - this.base.x, spot.y - this.base.y) < this.o.moveMin) return null;
    this.base = spot;
    if (buddy && Math.hypot(spot.x - buddy.x, spot.y - buddy.y) < this.o.nearBuddy) return null;
    return spot;
  }
}

module.exports = { FOLLOW, DwellWatch };
