/*
 * Performance trace for developers: frame times around transitions, long tasks
 * and long animation frames. Only with `npm run dev` and AGENT_BUDDY_PERF=1; it
 * is never created otherwise, so it costs nothing in normal use.
 *
 *   PerfTrace   the page calls mark('idle→typing') at each transition; the trace
 *               then times frames with requestAnimationFrame for windowMs (marks
 *               close together share one window) and logs one line:
 *               "idle→typing: 92 frames, worst 21 ms, p95 17 ms, >33 ms: 0, long tasks: none"
 *   summarize   the numbers for a list of frame times
 *
 * Injectable clock and frame callback, so it runs in node:test too.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyPerf = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /** A frame slower than this missed at least one vsync at 60 Hz (with some slack). */
  const JANK_MS = 33;

  /** @param {number[]} deltas  frame times in ms */
  function summarize(deltas) {
    const sorted = [...deltas].sort((a, b) => a - b);
    const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
    return {
      frames: deltas.length,
      worst: sorted.length ? sorted[sorted.length - 1] : 0,
      p95: at(0.95),
      janky: deltas.filter((d) => d > JANK_MS).length,
    };
  }

  const round = (ms) => Math.round(ms);

  class PerfTrace {
    /**
     * @param {object} o
     * @param {() => number} o.now
     * @param {(cb: (t: number) => void) => any} o.raf
     * @param {(line: string) => void} o.log
     * @param {number} [o.windowMs]  how long frames are timed after a mark
     */
    constructor({ now, raf, log, windowMs = 1500 }) {
      Object.assign(this, { now, raf, log, windowMs });
      this.active = false;
      this.labels = [];
      this.deltas = [];
      this.long = [];
      this.last = null;
      this.until = 0;
      this.onFrame = this.onFrame.bind(this);
    }

    /** A transition happened: time the frames around it. */
    mark(label) {
      if (!this.active) {
        this.active = true;
        this.labels = [];
        this.deltas = [];
        this.long = [];
        this.last = null;
        this.raf(this.onFrame);
      }
      if (this.labels[this.labels.length - 1] !== label && this.labels.length < 8) this.labels.push(label);
      this.until = this.now() + this.windowMs;
    }

    onFrame(t) {
      if (!this.active) return;
      if (this.last !== null) this.deltas.push(t - this.last);
      this.last = t;
      if (this.now() >= this.until) this.finish();
      else this.raf(this.onFrame);
    }

    /**
     * A PerformanceObserver entry: 'longtask' or 'long-animation-frame'.
     * @param {{ entryType: string, duration: number, blockingDuration?: number,
     *   styleAndLayoutStart?: number, renderStart?: number, startTime: number,
     *   scripts?: Array<{ duration: number, invoker?: string, sourceFunctionName?: string }> }} entry
     */
    longEntry(entry) {
      const text = describe(entry);
      if (this.active) this.long.push(text);
      else this.log(`outside any transition: ${text}`);
    }

    finish() {
      this.active = false;
      const s = summarize(this.deltas);
      this.log(
        `${this.labels.join(' + ')}: ${s.frames} frames, worst ${round(s.worst)} ms, p95 ${round(s.p95)} ms, ` +
          `>${JANK_MS} ms: ${s.janky}, long: ${this.long.length ? this.long.join('; ') : 'none'}`,
      );
    }
  }

  function describe(entry) {
    const kind = entry.entryType === 'long-animation-frame' ? 'frame' : 'task';
    let text = `${kind} ${round(entry.duration)} ms`;
    if (entry.entryType === 'long-animation-frame') {
      const parts = [];
      if (entry.blockingDuration) parts.push(`blocking ${round(entry.blockingDuration)}`);
      if (entry.styleAndLayoutStart && entry.renderStart) {
        const scripts = entry.styleAndLayoutStart - entry.renderStart;
        const layout = entry.startTime + entry.duration - entry.styleAndLayoutStart;
        parts.push(`render ${round(Math.max(0, scripts))}`, `style+layout ${round(Math.max(0, layout))}`);
      }
      const top = (entry.scripts || []).slice().sort((a, b) => b.duration - a.duration)[0];
      if (top) parts.push(`script ${round(top.duration)} (${top.sourceFunctionName || top.invoker || '?'})`);
      if (parts.length) text += ` [${parts.join(', ')}]`;
    }
    return text;
  }

  return { PerfTrace, summarize, JANK_MS };
});
