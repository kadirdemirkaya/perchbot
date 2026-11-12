'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LivenessWatch, processAlive, processStartTime, validPid } = require('../app/liveness');
const { FakeClock } = require('./helpers/fake-clock');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const clock = new FakeClock();
  const alive = new Set();
  const starts = new Map();
  const gone = [];
  let reads = 0;
  const watch = new LivenessWatch({
    clock,
    now: () => clock.now,
    isAlive: (pid) => alive.has(pid),
    startTimeOf: (pid) => {
      reads += 1;
      return Promise.resolve(starts.has(pid) ? starts.get(pid) : null);
    },
    cheapStartTime: false,
    onGone: (id, why) => gone.push([id, why]),
    ...options,
  });
  return { clock, watch, alive, starts, gone, reads: () => reads };
}

test('liveness: a session closes within one interval after its process dies', async () => {
  const { clock, watch, alive, gone } = setup();
  alive.add(100);
  watch.track('A', 100);
  await flush();
  clock.tick(5000);
  assert.deepEqual(gone, []);
  alive.delete(100);
  clock.tick(4999);
  assert.deepEqual(gone, []);
  clock.tick(1);
  assert.deepEqual(gone, [['A', 'exited']]);
  assert.equal(watch.size, 0);
  assert.equal(clock.timers.size, 0, 'no timer left once nothing is watched');
});

test('liveness: no timer while nothing is watched; untrack and invalid pids', () => {
  const { clock, watch } = setup();
  assert.equal(clock.timers.size, 0);
  watch.track('bad', 0);
  watch.track('bad2', -5);
  watch.track('bad3', 1.5);
  watch.track('bad4', '123');
  assert.equal(watch.size, 0);
  assert.equal(clock.timers.size, 0);
  watch.track('A', 100);
  assert.equal(clock.timers.size, 1);
  watch.untrack('A');
  assert.equal(clock.timers.size, 0);
});

test('liveness: pid reuse is caught by the start time of a silent session', async () => {
  const { clock, watch, alive, starts, gone, reads } = setup({ verifyMs: 60000 });
  alive.add(200);
  starts.set(200, '111');
  watch.track('A', 200);
  await flush();
  assert.equal(reads(), 1, 'read once when tracked');
  // The session keeps sending events: no start-time checks needed.
  for (let i = 0; i < 30; i += 1) {
    clock.tick(5000);
    watch.touch('A');
  }
  await flush();
  assert.equal(reads(), 1);
  // Silent for a minute, and meanwhile the pid went to another process.
  starts.set(200, '999');
  clock.tick(60000);
  await flush();
  assert.equal(reads(), 2);
  assert.deepEqual(gone, [['A', 'reused']]);
});

test('liveness: same start time keeps it; an unreadable start time falls back to the pid', async () => {
  const { clock, watch, alive, starts, gone } = setup({ verifyMs: 10000 });
  alive.add(300);
  starts.set(300, '5');
  watch.track('A', 300);
  alive.add(301); // start time cannot be read
  watch.track('B', 301);
  await flush();
  clock.tick(60000);
  await flush();
  assert.deepEqual(gone, []);
  alive.delete(301);
  clock.tick(5000);
  assert.deepEqual(gone, [['B', 'exited']]);
});

test('liveness: cheap start times (Linux) are compared at every check', async () => {
  const { clock, watch, alive, starts, gone, reads } = setup({ cheapStartTime: true });
  alive.add(400);
  starts.set(400, 'a');
  watch.track('A', 400);
  await flush();
  clock.tick(5000);
  await flush();
  assert.equal(reads(), 2);
  starts.set(400, 'b');
  clock.tick(5000);
  await flush();
  assert.deepEqual(gone, [['A', 'reused']]);
});

test('liveness: real helpers: this process is alive, a free pid is not', async () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(4194300), false);
  assert.equal(validPid(4294967295), true);
  assert.equal(validPid(4294967296), false);
  assert.equal(await processStartTime(0), null);
  assert.equal(await processStartTime(4194300), null, 'no such process: null, no throw');
});
