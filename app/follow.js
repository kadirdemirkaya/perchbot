'use strict';

/**
 * Following what the user looks at (ambient life): main.js samples the
 * cursor position now and then (the position only: nothing under it is read,
 * no window titles, no clipboard). When the cursor has moved somewhere and
 * then rests there for a while (ten seconds), the user is probably looking at
 * that spot: a "dwell". The page then sends the buddy over to have a look
 * through its magnifier (roam.js 'inspect' at that spot, robot.css data-lens).
 *
 * Once per spot: after the buddy has been there it does not come again until
 * the cursor has moved on and rests somewhere new. Until it has been (it was
 * busy with something else) the spot is offered again now and then, as long
 * as the cursor still rests there.
 *
 * Pure: the caller passes the samples and the time.
 */

const FOLLOW = Object.freeze({
  /** How often main.js looks where the cursor is (ms). */
  sampleMs: 600,
  /** The cursor moved at least this far (DIP) from the last spot it went to look at... */
  moveMin: 160,
  /** ...and then stayed within this many DIP... */
  stillPx: 14,
  /** ...for this long: a dwell. */
  dwellMs: 10000,
  /** Not been there yet, the cursor still rests there: offered again this often. */
  retryMs: 4000,
  /** Not right next to the buddy (the user is busy with the buddy itself then). */
  nearBuddy: 260,
  /** The least time between two looks (the page keeps this one). */
  gapMs: 15000,
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
    this.hold();
    /** The last spot it went to look at (or the first sample): a new dwell must be away from it. */
    this.base = null;
  }

  /** Not watching for a while (busy, on a trip...): the rest starts over, the spots it has been to stay seen. */
  hold() {
    /** Where the cursor rests now, and since when. */
    this.still = null;
    this.offered = -Infinity;
  }

  /**
   * One sample of the cursor.
   * @param {{x:number,y:number}} point  screen DIP
   * @param {number} now  ms
   * @param {{x:number,y:number}|null} [buddy]  the buddy's anchor (feet), screen DIP
   * @returns {{x:number,y:number}|null}  a dwell to offer (again every retryMs until visited())
   */
  sample(point, now, buddy = null) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const p = { x: Math.round(point.x), y: Math.round(point.y) };
    if (!this.base) this.base = p;
    if (!this.still || Math.hypot(p.x - this.still.x, p.y - this.still.y) > this.o.stillPx) {
      this.still = { ...p, since: now };
      this.offered = -Infinity;
      return null;
    }
    if (now - this.still.since < this.o.dwellMs) return null;
    const spot = { x: this.still.x, y: this.still.y };
    // Been there already (or it is where the cursor was at the start): not again.
    if (Math.hypot(spot.x - this.base.x, spot.y - this.base.y) < this.o.moveMin) return null;
    if (buddy && Math.hypot(spot.x - buddy.x, spot.y - buddy.y) < this.o.nearBuddy) return null;
    if (now - this.offered < this.o.retryMs) return null;
    this.offered = now;
    return spot;
  }

  /** The buddy went to look at that spot (or never can): not again until the cursor rests somewhere new. */
  visited(spot) {
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return;
    this.base = { x: Math.round(spot.x), y: Math.round(spot.y) };
    this.offered = -Infinity;
  }
}

module.exports = { FOLLOW, DwellWatch };
