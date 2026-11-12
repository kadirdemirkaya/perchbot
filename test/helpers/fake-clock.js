'use strict';

/** Deterministic setTimeout/clearTimeout replacement for state-machine tests. */
class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
    this.setTimeout = (fn, ms) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.now + ms, fn });
      return id;
    };
    this.clearTimeout = (id) => {
      this.timers.delete(id);
    };
  }

  /** Advance time, firing due timers in order (including ones they schedule). */
  tick(ms) {
    const end = this.now + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.now = next.at;
      next.fn();
    }
    this.now = end;
  }
}

module.exports = { FakeClock };
