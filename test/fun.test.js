'use strict';

/** Fun mode logic (app/renderer/lib/fun.js): whip clicks, idle plays, cheers, the duel. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClickMeter, PlayScheduler, PLAYS, RoamScheduler, TRIP_WEIGHTS, pickCheer, CHEERS, Duel, DUEL_TIMINGS: D } = require('../app/renderer/lib/fun');
const { FakeClock } = require('./helpers/fake-clock');


test('quick hits: the second annoys, the third makes it leave; a pause starts over', () => {
  const clock = new FakeClock();
  const meter = new ClickMeter({ clock: { now: () => clock.now } });
  const seq = [];
  for (let i = 0; i < 3; i += 1) {
    seq.push(meter.click());
    clock.tick(500);
  }
  assert.deepEqual(seq, ['boop', 'annoyed', 'flee']);
  assert.equal(meter.click(), 'boop', 'counting starts over after leaving');
  clock.tick(3000);
  assert.equal(meter.click(), 'boop');
  clock.tick(1500);
  assert.equal(meter.click(), 'boop', 'too slow: not a streak');
});

test('idle plays: only while enabled, one at a time, never the same twice in a row; stop() ends one', () => {
  const clock = new FakeClock();
  const seen = [];
  const plays = new PlayScheduler({ clock, random: () => 0, minMs: 1000, maxMs: 1000, onPlay: (n) => seen.push(n) });
  clock.tick(5000);
  assert.deepEqual(seen, [], 'off by default');
  plays.set(true);
  clock.tick(1000);
  assert.equal(seen.length, 1);
  const first = seen[0];
  assert.ok(Object.keys(PLAYS).includes(first));
  clock.tick(PLAYS[first]);
  assert.deepEqual(seen, [first, null]);
  clock.tick(1000);
  assert.notEqual(seen[2], first, 'a different play next');
  plays.stop();
  assert.equal(seen.at(-1), null, 'ended at once');
  plays.set(false);
  const count = seen.length;
  clock.tick(60000);
  assert.equal(seen.length, count, 'nothing while disabled');
});

test('trips: asked for now and then while allowed, every kind turns up, none while not allowed', () => {
  const clock = new FakeClock();
  const trips = [];
  let r = 0;
  const roam = new RoamScheduler({ clock, random: () => ((r = (r + 0.173) % 1), r), minMs: 1000, maxMs: 2000, onTrip: (k) => trips.push(k) });
  clock.tick(60000);
  assert.deepEqual(trips, [], 'off by default');
  roam.set(true);
  clock.tick(60000);
  assert.ok(trips.length >= 30 && trips.length <= 60);
  assert.deepEqual([...new Set(trips)].sort(), Object.keys(TRIP_WEIGHTS).sort());
  roam.set(false);
  const count = trips.length;
  clock.tick(60000);
  assert.equal(trips.length, count);
});

test('cheers: the classic jump about half of the time, the others otherwise', () => {
  assert.equal(pickCheer(() => 0.1), 'jump');
  assert.ok(CHEERS.slice(1).includes(pickCheer(() => 0.7)));
  const seen = new Set();
  let r = 0;
  for (let i = 0; i < 40; i += 1) seen.add(pickCheer(() => ((r = (r + 0.137) % 1), r)));
  assert.deepEqual([...seen].sort(), [...CHEERS].sort(), 'every cheer shows up');
});

function duel(random = () => 0) {
  const clock = new FakeClock();
  const phases = [];
  let info = null;
  const d = new Duel({ clock, random, onPhase: (p, i) => { phases.push(p); info = i; } });
  return { clock, d, phases, info: () => info };
}

test('duel: draw, guard, windup, strike; an unanswered strike costs the player a heart', () => {
  const { clock, d, phases, info } = duel();
  d.start();
  assert.equal(d.phase, 'draw');
  clock.tick(D.drawMs);
  assert.equal(d.phase, 'guard');
  clock.tick(D.guardMinMs);
  assert.equal(d.phase, 'windup');
  clock.tick(D.windupMs + D.strikeMs);
  assert.equal(d.phase, 'hit');
  assert.equal(info().player, D.hearts - 1);
  clock.tick(D.hitMs);
  assert.equal(d.phase, 'recover');
  assert.deepEqual(phases.slice(0, 6), ['draw', 'guard', 'windup', 'strike', 'hit', 'recover']);
});

test('duel: parry the windup, then hit it while it is stunned; three hits win', () => {
  const { clock, d, phases, info } = duel();
  d.start();
  clock.tick(D.drawMs + D.guardMinMs);
  for (let round = 0; round < D.hearts; round += 1) {
    assert.equal(d.phase, 'windup', `round ${round}`);
    assert.equal(d.click(), 'parry');
    assert.equal(d.phase, 'stun');
    assert.equal(d.click(), 'hit');
    if (round < D.hearts - 1) {
      assert.equal(d.phase, 'hurt');
      clock.tick(D.hurtMs + D.guardMinMs);
    }
  }
  assert.equal(d.phase, 'lose', 'the robot lost');
  assert.equal(info().robot, 0);
  assert.equal(info().player, D.hearts, 'flawless');
  clock.tick(D.endMs);
  assert.equal(d.active, false);
  assert.equal(phases.at(-1), 'end');
});

test('duel: clicking while it guards is blocked and it strikes back; losing all hearts ends it', () => {
  const { clock, d, info } = duel();
  d.start();
  clock.tick(D.drawMs);
  assert.equal(d.click(), 'blocked');
  assert.equal(d.phase, 'block');
  clock.tick(D.blockMs);
  assert.equal(d.phase, 'windup', 'a quick counter');
  for (let i = 0; i < D.hearts; i += 1) {
    while (d.phase !== 'hit' && d.phase !== 'win') clock.tick(10);
    if (d.phase === 'win') break;
    clock.tick(D.hitMs + D.recoverMs);
  }
  assert.equal(d.phase, 'win', 'the robot won');
  assert.equal(info().player, 0);
  assert.equal(d.click(), 'none', 'clicks after the end do nothing');
});

test('duel: stop() ends it at once, and a duel never runs forever', () => {
  const { clock, d, phases } = duel();
  d.start();
  clock.tick(D.drawMs + 100);
  d.stop();
  assert.equal(d.active, false);
  assert.equal(phases.at(-1), 'end');
  d.stop(); // harmless
  d.start();
  // Nobody plays: hits until the robot wins, well before the time limit.
  clock.tick(D.maxMs + D.endMs + 10);
  assert.equal(d.active, false);
});
