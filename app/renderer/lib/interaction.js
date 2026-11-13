/*
 * Pure interaction logic for the overlay page. No DOM access, injectable
 * timers, so the same file runs in the renderer (as a classic script that
 * defines window.BuddyInteraction) and in node:test (via require).
 *
 *   CaptureController  decides when the window should take mouse input
 *   HoverMenu          open / close timing of the hover menu
 *   RestTimer          "resting" after a quiet minute, instant wake-up
 *   lookVector         where the eyes should look, from a cursor offset
 *   createTapRhythm    irregular typing rhythm (bursts and pauses)
 *   Replay             a one-shot reaction that quick repeats queue instead of restart
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyInteraction = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };

  /**
   * The window ignores the mouse (clicks go to the windows below) unless the
   * pointer is over something interactive, or a drag is in progress.
   * `send(capture)` is called only when the decision changes.
   */
  class CaptureController {
    constructor(send) {
      this.send = send;
      this.capturing = false;
      this.dragging = false;
    }

    /** Pointer moved; `hit` = it is over the character or an open menu item. */
    pointer(hit) {
      this.apply(Boolean(hit) || this.dragging);
    }

    /** Pointer left the window. */
    leave() {
      if (!this.dragging) this.apply(false);
    }

    startDrag() {
      this.dragging = true;
      this.apply(true);
    }

    endDrag(hit) {
      this.dragging = false;
      this.apply(Boolean(hit));
    }

    /** The main process released the mouse on its own (safety net). */
    released() {
      this.dragging = false;
      this.capturing = false;
    }

    apply(want) {
      if (want === this.capturing) return;
      this.capturing = want;
      this.send(want);
    }
  }

  /**
   * Hover menu timing. zone is 'character', 'menu' or null.
   * Opens after the pointer rests on the character for `openDelay`, stays open
   * while the pointer is on the character or the menu, closes `closeDelay`
   * after it leaves both.
   */
  class HoverMenu {
    constructor({ clock = realClock, openDelay = 250, closeDelay = 600, onChange = () => {} } = {}) {
      this.clock = clock;
      this.openDelay = openDelay;
      this.closeDelay = closeDelay;
      this.onChange = onChange;
      this.zone = null;
      this.open = false;
      this.openTimer = null;
      this.closeTimer = null;
    }

    set(zone) {
      if (zone === this.zone) return;
      this.zone = zone;
      if (zone === 'character' || zone === 'menu') {
        this.cancel('closeTimer');
        if (!this.open && zone === 'character' && !this.openTimer) {
          this.openTimer = this.clock.setTimeout(() => {
            this.openTimer = null;
            this.setOpen(true);
          }, this.openDelay);
        }
      } else {
        this.cancel('openTimer');
        if (this.open && !this.closeTimer) {
          this.closeTimer = this.clock.setTimeout(() => {
            this.closeTimer = null;
            this.setOpen(false);
          }, this.closeDelay);
        }
      }
    }

    /** Close immediately (drag started, page paused, ...). */
    closeNow() {
      this.cancel('openTimer');
      this.cancel('closeTimer');
      this.setOpen(false);
    }

    setOpen(open) {
      if (open === this.open) return;
      this.open = open;
      this.onChange(open);
    }

    cancel(name) {
      if (this[name]) {
        this.clock.clearTimeout(this[name]);
        this[name] = null;
      }
    }
  }

  /**
   * After `delay` ms in the idle state with no activity, the character rests
   * (no animation at all). Any activity or state change wakes it at once.
   */
  class RestTimer {
    constructor({ clock = realClock, delay = 60000, onChange = () => {} } = {}) {
      this.clock = clock;
      this.delay = delay;
      this.onChange = onChange;
      this.idle = false;
      this.resting = false;
      this.timer = null;
    }

    /** Call on every view change. */
    setIdle(idle) {
      this.idle = Boolean(idle);
      this.activity();
    }

    /** Hover, click, mouse movement over the character. */
    activity() {
      if (this.timer) {
        this.clock.clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.resting) {
        this.resting = false;
        this.onChange(false);
      }
      if (this.idle) {
        this.timer = this.clock.setTimeout(() => {
          this.timer = null;
          this.resting = true;
          this.onChange(true);
        }, this.delay);
      }
    }

    stop() {
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.timer = null;
    }

    /**
     * Back from a pause (screen unlocked): resting stays resting (only an event
     * or the pointer wakes it); awake and idle, the countdown starts again.
     */
    resume() {
      if (this.resting || this.timer || !this.idle) return;
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.resting = true;
        this.onChange(true);
      }, this.delay);
    }
  }

  /**
   * Eye direction for a cursor at (dx, dy) from the eyes, as a vector of
   * length <= 1. Full deflection at `radius` px and beyond; a small dead zone
   * keeps the eyes still when the cursor is right on them.
   */
  function lookVector(dx, dy, radius = 160, deadZone = 6) {
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance < deadZone) return { x: 0, y: 0 };
    const strength = Math.min(1, distance / radius);
    return { x: (dx / distance) * strength, y: (dy / distance) * strength };
  }

  /**
   * Irregular typing: bursts of 3-8 quick taps, short pauses between bursts,
   * and now and then a longer "thinking" pause.
   * Returns next() -> { delay, pause } where delay is ms until the next tap.
   */
  function createTapRhythm(random = Math.random) {
    let left = 0;
    return function next() {
      if (left <= 0) {
        left = 3 + Math.floor(random() * 6);
        const long = random() < 0.15;
        return { delay: long ? 900 + random() * 700 : 220 + random() * 480, pause: true };
      }
      left -= 1;
      return { delay: 70 + random() * 110, pause: false };
    };
  }

  /**
   * A short one-shot reaction (a boop, a happy hop) that quick repeats must
   * not cut short: restarting it on every tap of a fast streak looks like a
   * stutter. trigger() starts it when nothing runs; while it runs, more
   * triggers only ask for one more round right after it, so a streak of taps
   * plays it back to back at its own pace. onStart(again) restarts the
   * animation (again: a chained round), onEnd() clears it.
   */
  class Replay {
    constructor({ clock = realClock, ms, onStart = () => {}, onEnd = () => {} } = {}) {
      this.clock = clock;
      this.ms = ms;
      this.onStart = onStart;
      this.onEnd = onEnd;
      this.timer = null;
      this.again = false;
    }

    get running() {
      return this.timer !== null;
    }

    /** @returns {boolean} true when it started now, false when it was queued after the running round */
    trigger() {
      if (this.running) {
        this.again = true;
        return false;
      }
      this.start(false);
      return true;
    }

    start(again) {
      this.again = false;
      this.onStart(again);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        if (this.again) this.start(true);
        else this.onEnd();
      }, this.ms);
    }

    /** End at once (no further round). */
    stop() {
      if (!this.running) return;
      this.clock.clearTimeout(this.timer);
      this.timer = null;
      this.again = false;
      this.onEnd();
    }
  }

  return { CaptureController, HoverMenu, RestTimer, lookVector, createTapRhythm, Replay };
});
