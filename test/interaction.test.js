'use strict';

/** Pure renderer logic (app/renderer/lib/interaction.js): mouse capture, hover menu, rest, eyes, rhythm. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CaptureController,
  HoverMenu,
  RestTimer,
  lookVector,
  createTapRhythm,
  Replay,
} = require('../app/renderer/lib/interaction');
const { FakeClock } = require('./helpers/fake-clock');

function capture() {
  const sent = [];
  return { c: new CaptureController((v) => sent.push(v)), sent };
}

test('capture: only while over the character, and only on changes', () => {
  const { c, sent } = capture();
  c.pointer(false);
  c.pointer(true);
  c.pointer(true);
  c.pointer(false);
  c.pointer(false);
  assert.deepEqual(sent, [true, false]);
});

test('capture: leaving the shape releases immediately (no click is swallowed)', () => {
  const { c, sent } = capture();
  c.pointer(true);
  c.pointer(false); // moved onto transparent space inside the window
  assert.equal(c.capturing, false);
  c.pointer(true);
  c.leave(); // left the window
  assert.deepEqual(sent, [true, false, true, false]);
});

test('capture: a drag holds the mouse even off the shape, then releases on drop', () => {
  const { c, sent } = capture();
  c.pointer(true);
  c.startDrag();
  c.pointer(false);
  c.leave();
  assert.equal(c.capturing, true, 'still dragging');
  c.endDrag(false);
  assert.equal(c.capturing, false);
  assert.deepEqual(sent, [true, false]);
});

test('capture: after the main-process safety net released, the next hit captures again', () => {
  const { c, sent } = capture();
  c.pointer(true);
  c.released();
  c.pointer(true);
  assert.deepEqual(sent, [true, true]);
});

test('hover menu: opens after a short rest on the character, closes after leaving both', () => {
  const clock = new FakeClock();
  const changes = [];
  const m = new HoverMenu({ clock, openDelay: 250, closeDelay: 600, onChange: (o) => changes.push(o) });
  m.set('character');
  clock.tick(249);
  assert.equal(m.open, false);
  clock.tick(1);
  assert.equal(m.open, true);

  m.set(null); // crossing the gap between character and menu
  clock.tick(300);
  m.set('menu');
  clock.tick(5000);
  assert.equal(m.open, true, 'stays open while on the menu');

  m.set(null);
  clock.tick(599);
  assert.equal(m.open, true);
  clock.tick(1);
  assert.equal(m.open, false);
  assert.deepEqual(changes, [true, false]);
});

test('hover menu: passing over quickly does not open it; closeNow closes at once', () => {
  const clock = new FakeClock();
  const m = new HoverMenu({ clock });
  m.set('character');
  clock.tick(100);
  m.set(null);
  clock.tick(1000);
  assert.equal(m.open, false);

  m.set('character');
  clock.tick(300);
  m.closeNow();
  assert.equal(m.open, false);
  clock.tick(5000);
  assert.equal(m.open, false);
});

test('rest: after a quiet idle minute; any activity or new state wakes at once', () => {
  const clock = new FakeClock();
  const changes = [];
  const r = new RestTimer({ clock, delay: 60000, onChange: (v) => changes.push(v) });
  r.setIdle(true);
  clock.tick(59999);
  assert.equal(r.resting, false);
  clock.tick(1);
  assert.equal(r.resting, true);

  r.activity(); // pointer arrives
  assert.equal(r.resting, false);
  clock.tick(60000);
  assert.equal(r.resting, true);

  r.setIdle(false); // an event arrives (e.g. typing)
  assert.equal(r.resting, false);
  clock.tick(600000);
  assert.equal(r.resting, false, 'never rests while busy');
  assert.deepEqual(changes, [true, false, true, false]);
});

test('rest: unlocking the screen does not wake it; awake, the countdown starts again', () => {
  const clock = new FakeClock();
  const changes = [];
  const r = new RestTimer({ clock, delay: 60000, onChange: (v) => changes.push(v) });
  r.setIdle(true);
  clock.tick(60000);
  assert.equal(r.resting, true);
  r.stop(); // screen locked
  r.resume(); // unlocked
  assert.equal(r.resting, true, 'still resting: only an event or the pointer wakes it');
  assert.deepEqual(changes, [true]);

  // Locked while awake: after unlocking it rests a full minute later.
  const s = new RestTimer({ clock, delay: 60000 });
  s.setIdle(true);
  clock.tick(30000);
  s.stop();
  clock.tick(600000);
  assert.equal(s.resting, false, 'nothing runs while locked');
  s.resume();
  clock.tick(59999);
  assert.equal(s.resting, false);
  clock.tick(1);
  assert.equal(s.resting, true);
});

test('eyes: direction normalised, full deflection at the radius, dead zone in the middle', () => {
  assert.deepEqual(lookVector(2, 2), { x: 0, y: 0 });
  const right = lookVector(320, 0, 160);
  assert.equal(right.x, 1);
  assert.equal(right.y, 0);
  const half = lookVector(0, -80, 160);
  assert.ok(Math.abs(half.y + 0.5) < 1e-9);
  const diag = lookVector(1000, 1000, 160);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - 1) < 1e-9);
  assert.deepEqual(lookVector(NaN, 1), { x: 0, y: 0 });
});

test('typing rhythm: bursts of quick taps with irregular pauses', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const next = createTapRhythm(random);
  const steps = Array.from({ length: 400 }, next);
  const taps = steps.filter((s) => !s.pause);
  const pauses = steps.filter((s) => s.pause);
  assert.ok(taps.every((s) => s.delay >= 70 && s.delay <= 180));
  assert.ok(pauses.every((s) => s.delay >= 220 && s.delay <= 1600));
  assert.ok(pauses.some((s) => s.delay > 900), 'some longer pauses');
  const tapDelays = new Set(taps.map((s) => Math.round(s.delay)));
  assert.ok(tapDelays.size > 30, 'not a fixed beat');
  // Bursts are 3-8 taps long.
  let run = 0;
  for (const s of steps.slice(1)) {
    if (s.pause) {
      assert.ok(run >= 3 && run <= 8, `burst of ${run}`);
      run = 0;
    } else run += 1;
  }
});

test('Replay: quick repeats queue one more round instead of restarting mid-way', () => {
  const clock = new FakeClock();
  const log = [];
  const r = new Replay({ clock, ms: 460, onStart: (again) => log.push(again ? 'again' : 'start'), onEnd: () => log.push('end') });
  assert.equal(r.trigger(), true);
  for (let i = 0; i < 4; i += 1) {
    clock.tick(110);
    assert.equal(r.trigger(), false, 'queued, not restarted');
  }
  assert.deepEqual(log, ['start']);
  clock.tick(20);
  assert.deepEqual(log, ['start', 'again'], 'one more round right after the first');
  clock.tick(460);
  assert.deepEqual(log, ['start', 'again', 'end']);
  assert.equal(r.running, false);

  // Ten seconds of taps every 110 ms (91 taps): rounds back to back at 460 ms, not 91 restarts.
  log.length = 0;
  for (let t = 0; t <= 10000; t += 110) {
    r.trigger();
    clock.tick(110);
  }
  clock.tick(1000);
  const rounds = log.filter((x) => x !== 'end').length;
  assert.ok(rounds >= 21 && rounds <= 23, `${rounds} rounds`);
  assert.equal(log.at(-1), 'end');

  // stop() ends at once, nothing queued afterwards.
  log.length = 0;
  r.trigger();
  r.trigger();
  r.stop();
  clock.tick(2000);
  assert.deepEqual(log, ['start', 'end']);
});

test('rest: the wait can change (livelier with ambient life); it counts from the next activity', () => {
  const clock = new FakeClock();
  const changes = [];
  const r = new RestTimer({ clock, delay: 60000, onChange: (v) => changes.push(v) });
  r.setIdle(true);
  r.setDelay(180000);
  clock.tick(60000);
  assert.deepEqual(changes, [true], 'the countdown already running keeps its minute');
  r.activity();
  clock.tick(179999);
  assert.deepEqual(changes, [true, false], 'awake again, now for three minutes');
  clock.tick(1);
  assert.deepEqual(changes, [true, false, true]);
  r.setDelay(-5);
  r.setDelay(Number.NaN);
  assert.equal(r.delay, 180000, 'nonsense is ignored');
});
