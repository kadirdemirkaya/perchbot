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

test('pageLeft: with the column on the left the page is the right-hand part of a wider window', () => {
  const { pageLeft } = require('../app/renderer/lib/interaction');
  assert.equal(pageLeft(770, { side: 'left', width: 284 }), 486);
  assert.equal(pageLeft(284, { side: 'left', width: 284 }), 0, 'window as wide as the page');
  assert.equal(pageLeft(283.6, { side: 'left', width: 284 }), 0, 'never negative (rounding)');
  assert.equal(pageLeft(770, { side: 'right', width: 284 }), 0, 'column on the right: the window is the page');
  assert.equal(pageLeft(770, { side: 'left' }), 0, 'no layout yet');
  assert.equal(pageLeft(770, null), 0);
  assert.equal(pageLeft(0, { side: 'left', width: 284 }), 0);
});

test('trail: the chips fit above the bubble; with a skill tag too they did not (cut at the top), then beside it', () => {
  const { trailFits, besideRow } = require('../app/renderer/lib/interaction');
  // The robot: slot 270 high, the stack starts 202 px up (head top 78 + 10), chips 19 high.
  const base = 202;
  const chips = 19;
  const bubble = 31 + 4;
  const skill = 21 + 4;
  assert.equal(trailFits(base + bubble, chips, 270), true, 'bubble + chips: as before (top at 256)');
  assert.equal(trailFits(base, chips, 270), true, 'chips alone');
  assert.equal(trailFits(base + skill, chips, 270), true, 'skill tag + chips (no bubble): as before');
  assert.equal(trailFits(base + skill + bubble, chips, 270), false, 'skill tag + bubble + chips: top at 281, past 270');
  assert.equal(trailFits(249, 19, 270), true, 'exactly 2 px to spare');
  assert.equal(trailFits(250, 19, 270), false);

  // Side by side, centred over the head (x 98) and inside the 220 px slot.
  const row = besideRow({ slotWidth: 220, headX: 98, skillWidth: 100, skillHeight: 21, skillBottom: 198, chipWidth: 80, chipHeight: 19 });
  assert.deepEqual(row, { skillLeft: 6, chipLeft: 110, chipBottom: 199 });
  assert.ok(row.chipLeft + 80 <= 220 - 4, 'the chip stays inside the slot');
  // The widest row (tag 108 + 4 + chip 100) is kept inside the slot, also with the head off-centre.
  for (const headX of [20, 98, 200]) {
    const wide = besideRow({ slotWidth: 220, headX, skillWidth: 108, skillHeight: 21, skillBottom: 198, chipWidth: 100, chipHeight: 19 });
    assert.ok(wide.skillLeft >= 4, `head at ${headX}: left edge`);
    assert.ok(wide.chipLeft + 100 <= 216, `head at ${headX}: right edge`);
  }
  // A narrow row sits centred over the head.
  const narrow = besideRow({ slotWidth: 220, headX: 110, skillWidth: 60, skillHeight: 21, skillBottom: 198, chipWidth: 40, chipHeight: 21 });
  assert.equal(narrow.skillLeft, 58);
  assert.equal(narrow.chipBottom, 198, 'same height: same bottom');
});

test('trail on the page: beside the skill tag only when it does not fit; otherwise the old stack', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(page.includes('if (skillOn && !trailFits(bottom, trail.offsetHeight, SLOT_HEIGHT)) {'));
  // The old stack, unchanged: above the bubble (or where it would be), above the skill tag.
  assert.ok(page.includes('let bottom = SLOT_HEIGHT - head.top + 10 + lift;'));
  assert.ok(page.includes("if (bubble.classList.contains('show')) bottom += bubble.offsetHeight + 4;"));
  assert.ok(page.includes('trail.style.bottom = `${Math.round(bottom)}px`;'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'overlay.css'), 'utf8');
  for (const rule of ['.trail.beside {', '.trail.beside .trail-chip.older {', '.skill-tag.beside {']) assert.ok(css.includes(rule), rule);
});
