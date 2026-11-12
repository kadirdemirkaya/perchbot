'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PerfTrace, summarize, JANK_MS } = require('../app/renderer/lib/perf');

test('perf: frame summary (worst, p95, janky frames)', () => {
  assert.deepEqual(summarize([]), { frames: 0, worst: 0, p95: 0, janky: 0 });
  const s = summarize([16, 17, 16, 50, 17, 34, 16, 16, 17, 16]);
  assert.equal(s.frames, 10);
  assert.equal(s.worst, 50);
  assert.equal(s.janky, 2, `frames over ${JANK_MS} ms`);
  assert.equal(s.p95, 50);
});

test('perf: marks close together share one window; long entries are attributed to it', () => {
  let now = 0;
  const frames = [];
  const lines = [];
  const trace = new PerfTrace({ now: () => now, raf: (cb) => frames.push(cb), log: (l) => lines.push(l), windowMs: 100 });
  const run = (ms) => {
    // one frame every ms until no frame is requested any more
    while (frames.length) {
      now += ms;
      frames.shift()(now);
    }
  };
  trace.mark('idle→typing');
  trace.mark('idle→typing'); // repeated: listed once
  trace.longEntry({ entryType: 'longtask', duration: 72, startTime: 0 });
  now += 50;
  trace.mark('menu open'); // extends the window
  run(16);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^idle→typing \+ menu open: \d+ frames, worst 16 ms/);
  assert.match(lines[0], /long: task 72 ms$/);

  trace.longEntry({
    entryType: 'long-animation-frame',
    duration: 80,
    startTime: 1000,
    renderStart: 1040,
    styleAndLayoutStart: 1050,
    blockingDuration: 30,
    scripts: [{ duration: 25, sourceFunctionName: 'applyView' }],
  });
  assert.match(lines[1], /^outside any transition: frame 80 ms \[blocking 30, render 10, style\+layout 30, script 25 \(applyView\)\]$/);
});
