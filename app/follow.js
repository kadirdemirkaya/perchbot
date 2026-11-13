'use strict';

/**
 * Following what the user looks at (ambient life): main.js samples the
 * cursor position now and then (the position only: nothing under it is read,
 * no window titles, no clipboard). When the cursor has moved somewhere and
 * then rests there for a while (thirty seconds), the user is probably looking
 * at that spot: a "dwell". Now and then (not every time: a roll of the dice
 * per spot) the page sends the buddy over to have a look through its
 * magnifier (roam.js 'inspect' at that spot, robot.css data-lens), and then
 * it flies back to where it came from. Also while Claude Code works (it
 * leaves its laptop for a moment) and while it naps (it wakes up for it).
 *
 * Once per spot: it remembers the last few spots it has seen (been to, or
 * rolled "no" for) and does not come to them again. Until it has been (it
 * was busy with something else) a spot that rolled "yes" is offered again
 * now and then, as long as the cursor still rests there.
 *
 * Pure: the caller passes the samples and the time (and may pass the dice).
 */

const FOLLOW = Object.freeze({
  /** How often main.js looks where the cursor is (ms). */
  sampleMs: 600,
  /** The cursor rests at least this far (DIP) from every spot it has seen... */
  moveMin: 160,
  /** ...and stays within this many DIP... */
  stillPx: 14,
  /** ...for this long: a dwell. */
  dwellMs: 30000,
  /** Worth a look at this chance (rolled once per resting spot; a "no" counts as seen). */
  chance: 0.5,
  /** How many seen spots it remembers. */
  remember: 5,
  /** Not been there yet, the cursor still rests there: offered again this often. */
  retryMs: 4000,
  /** Not right next to the buddy (the user is busy with the buddy itself then). */
  nearBuddy: 260,
  /** The least time between two looks (the page keeps this one). */
  gapMs: 120000,
  /** The magnifier pose on arrival. */
  lensMs: 5200,
  /** ...then back to where it came from. */
  backAfterMs: 5800,
  /** A dwell is still worth a trip this long after it was seen. */
  freshMs: 5000,
});

/** What Claude Code may be doing meanwhile: idle, or at work (not while it waits for the user, or says goodbye). */
const FOLLOW_STATES = new Set(['idle', 'standby', 'greeting', 'typing', 'reading', 'running', 'working', 'thinking', 'done']);

class DwellWatch {
  constructor({ random = Math.random, ...options } = {}) {
    this.o = { ...FOLLOW, ...options };
    this.random = random;
    this.reset();
  }

  reset() {
    this.hold();
    /** The spots it has seen, newest last (the first sample counts: that is where the cursor started). */
    this.seen = [];
  }

  /** Not watching for a while (busy, on a trip...): the rest starts over, the spots it has seen stay seen. */
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
    if (!this.seen.length) this.seen.push(p);
    if (!this.still || Math.hypot(p.x - this.still.x, p.y - this.still.y) > this.o.stillPx) {
      this.still = { ...p, since: now };
      this.offered = -Infinity;
      return null;
    }
    if (now - this.still.since < this.o.dwellMs) return null;
    const spot = { x: this.still.x, y: this.still.y };
    // Seen already (been there, rolled "no", or where the cursor was at the start): not again.
    if (this.seen.some((q) => Math.hypot(spot.x - q.x, spot.y - q.y) < this.o.moveMin)) return null;
    if (buddy && Math.hypot(spot.x - buddy.x, spot.y - buddy.y) < this.o.nearBuddy) return null;
    if (now - this.offered < this.o.retryMs) return null;
    // Now and then, not every time: the first time this rest is worth a look, the dice decide.
    if (this.offered === -Infinity && !(this.random() < this.o.chance)) {
      this.visited(spot);
      return null;
    }
    this.offered = now;
    return spot;
  }

  /** The buddy went to look at that spot (or never will): not again while it remembers it. */
  visited(spot) {
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return;
    this.seen.push({ x: Math.round(spot.x), y: Math.round(spot.y) });
    if (this.seen.length > this.o.remember) this.seen.splice(0, this.seen.length - this.o.remember);
    this.offered = -Infinity;
  }
}

module.exports = { FOLLOW, FOLLOW_STATES, DwellWatch };
