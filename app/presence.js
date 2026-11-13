'use strict';

/**
 * Is the user at the computer? As pure logic: main.js feeds it the system's
 * idle time (powerMonitor.getSystemIdleTime: seconds since the last key press
 * or mouse move, nothing else) and the lock / unlock events. Nothing about
 * what the user does is read or kept.
 *
 *   away  no input for awayS seconds, or the screen was locked
 *   back  input again after being away (awayMs: how long), or unlocked after
 *         at least lockedMs
 */

const PRESENCE = Object.freeze({
  /** No input this long (s): the user is away. */
  awayS: 300,
  /** Input within this (s) after being away: the user is back. */
  backS: 5,
  /** A lock shorter than this (ms) is not worth a "welcome back". */
  lockedMs: 60000,
  /** How often main.js asks for the idle time (ms). */
  pollMs: 10000,
});

class PresenceWatch {
  constructor(options = {}) {
    this.o = { ...PRESENCE, ...options };
    this.away = false;
    this.since = 0;
    this.lockedAt = null;
  }

  /**
   * The idle time now. Returns { kind: 'away' } or { kind: 'back', awayMs }
   * when that changes, otherwise null.
   */
  feed(idleS, now = Date.now()) {
    const idle = Number(idleS);
    if (!Number.isFinite(idle) || idle < 0 || this.lockedAt !== null) return null;
    if (!this.away && idle >= this.o.awayS) {
      this.away = true;
      this.since = now - idle * 1000;
      return { kind: 'away' };
    }
    if (this.away && idle < this.o.backS) {
      this.away = false;
      return { kind: 'back', awayMs: Math.max(0, now - this.since) };
    }
    return null;
  }

  /** The screen was locked (or the system suspended). */
  locked(now = Date.now()) {
    if (this.lockedAt !== null) return null;
    this.lockedAt = now;
    if (this.away) return null;
    this.away = true;
    this.since = now;
    return { kind: 'away' };
  }

  /** Unlocked (or resumed): back, if it was long enough to say so. */
  unlocked(now = Date.now()) {
    if (this.lockedAt === null) return null;
    const lockedFor = now - this.lockedAt;
    this.lockedAt = null;
    this.away = false;
    if (lockedFor < this.o.lockedMs) return null;
    return { kind: 'back', awayMs: Math.max(0, now - this.since) };
  }
}

module.exports = { PresenceWatch, PRESENCE };
