'use strict';

/**
 * Stretch breaks (their switch is off by default): after about fifty minutes at the
 * computer without a real pause, a giant of it walks up and stretches with the user (arms
 * up, a lean to each side, the neck), then the eyes: "Look far away", twenty seconds counted
 * down, and it walks back and shows what Claude Code is doing again. The pointer on it: "Okay,
 * later!", and it asks again a quarter of an hour later.
 *
 * As pure logic: main.js feeds it the system's idle time (powerMonitor.getSystemIdleTime:
 * seconds since the last key press or mouse move, nothing else), the lock / unlock events,
 * and how a break went. It comes only while the user pauses for a moment (never mid-typing).
 */

const BREAK = Object.freeze({
  /** At the computer this long without a real pause: time for a break. */
  everyMs: 50 * 60 * 1000,
  /** No input this long (s), or the screen locked this long, counts as a pause (the clock starts again). */
  restS: 300,
  /** It comes only while the user has not touched the keyboard or the mouse for this long (s)... */
  pauseS: 3,
  /** ...but is still about (a longer quiet: maybe away; restS decides). */
  maxPauseS: 120,
  /** Offered and not taken (something else going on): again after this. */
  retryMs: 60 * 1000,
  /** Skipped (the pointer on it): again after this. */
  snoozeMs: 15 * 60 * 1000,
});

class BreakWatch {
  constructor(options = {}, now = Date.now()) {
    this.o = { ...BREAK, ...options };
    /** At the computer since (the last pause or break). */
    this.since = now;
    /** Not offered again before this. */
    this.nextTry = 0;
    this.lockedAt = null;
  }

  /** The idle time now. true: offer a break now. */
  feed(idleS, now = Date.now()) {
    const idle = Number(idleS);
    if (this.lockedAt !== null || !Number.isFinite(idle) || idle < 0) return false;
    if (idle >= this.o.restS) {
      this.since = now;
      return false;
    }
    if (now - this.since < this.o.everyMs || now < this.nextTry) return false;
    if (idle < this.o.pauseS || idle > this.o.maxPauseS) return false;
    this.nextTry = now + this.o.retryMs;
    return true;
  }

  /** How long until a break is due (0: due now). */
  dueIn(now = Date.now()) {
    return Math.max(0, this.since + this.o.everyMs - now);
  }

  /** The screen was locked (or the system went to sleep). */
  locked(now = Date.now()) {
    if (this.lockedAt === null) this.lockedAt = now;
  }

  /** Unlocked: a long enough lock was a pause. */
  unlocked(now = Date.now()) {
    if (this.lockedAt === null) return;
    if (now - this.lockedAt >= this.o.restS * 1000) this.since = now;
    this.lockedAt = null;
  }

  /** The break was taken (stretched, eyes rested). */
  done(now = Date.now()) {
    this.since = now;
    this.nextTry = 0;
  }

  /** Skipped: again in snoozeMs. */
  snooze(now = Date.now()) {
    this.since = now - this.o.everyMs + this.o.snoozeMs;
    this.nextTry = 0;
  }

  /** Switched on: the clock starts now. */
  restart(now = Date.now()) {
    this.since = now;
    this.nextTry = 0;
  }
}

module.exports = { BreakWatch, BREAK };
