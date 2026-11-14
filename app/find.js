'use strict';

/**
 * "Come and tell me" (ambient life): a long piece of work is done while the user looks
 * somewhere else, far from the robot (the cursor far away, or on another screen). When the
 * "done" bubble is over (the old cheer at home stays as it was), it flies over to the cursor,
 * cheers ("All done! Over to you.") and flies back a few seconds later, as after a look at
 * where the cursor rests. main.js asks this file, the page decides whether it is free to go.
 *
 * Pure logic: what main.js already knows goes in (the turn's start and end from the hook
 * events, where the cursor is, whether the user is away); a yes (null) or the reason why not
 * comes out. Nothing is read or kept for it.
 */

const FIND = Object.freeze({
  /** A turn at least this long (ms) is worth it. */
  minTurnMs: 120000,
  /** The cursor at least this far (DIP at medium size) from the middle of the robot's slot. */
  farPx: 480,
  /** The "done" bubble ends within this long (ms) of the done event; later it is stale. */
  windowMs: 10000,
  /** The page answers an offer within this long (ms). */
  freshMs: 4000,
});

/** How long a turn took (ms), or NaN. */
function turnMs(turn) {
  if (!turn || !Number.isFinite(turn.startedAt) || !Number.isFinite(turn.endedAt)) return NaN;
  return turn.endedAt - turn.startedAt;
}

/**
 * Should it go and tell the user?
 * @param {object} o
 * @param {{ startedAt: number, endedAt: number } | null} o.turn  the turn that just ended
 * @param {{ x: number, y: number } | null} o.cursor  screen DIP
 * @param {{ x: number, y: number } | null} o.slot  the middle of the robot's slot, screen DIP
 * @param {number} [o.scale]  the robot's size (small 0.8, medium 1, large 1.3)
 * @param {boolean} [o.sameDisplay]  the cursor is on the robot's screen
 * @param {boolean} [o.away]  no input for a while, or the screen is locked (app/presence.js)
 * @returns {null | 'short' | 'away' | 'nocursor' | 'near'}  null: go
 */
function findReason({ turn, cursor, slot, scale = 1, sameDisplay = true, away = false }) {
  if (!(turnMs(turn) >= FIND.minTurnMs)) return 'short';
  if (away) return 'away';
  if (!cursor || !slot) return 'nocursor';
  if (!sameDisplay) return null;
  return Math.hypot(cursor.x - slot.x, cursor.y - slot.y) >= FIND.farPx * scale ? null : 'near';
}

module.exports = { FIND, findReason, turnMs };
