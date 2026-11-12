'use strict';

/** Fun mode logic (app/renderer/lib/fun.js): whip clicks, idle plays, cheers, the duel. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClickMeter, AmbientScheduler, PLAYS, TRIPS, pickCheer, CHEERS, Duel, DUEL_TIMINGS: D } = require('../app/renderer/lib/fun');
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

function ambient(random = Math.random) {
  const clock = new FakeClock();
  const log = [];
  const a = new AmbientScheduler({
    clock,
    random,
    onPlay: (name) => log.push(['play', name, clock.now]),
    onTrip: (kind) => log.push(['trip', kind, clock.now]),
  });
  return { clock, a, log };
}

test('ambient life: one behaviour every 20-90 s, never the same twice in a row', () => {
  let r = 0;
  const { clock, a, log } = ambient(() => ((r = (r + 0.377) % 1), r));
  clock.tick(120000);
  assert.deepEqual(log, [], 'nothing until allowed');
  a.update({ enabled: true, trips: true, away: true });
  clock.tick(3600000);
  const starts = log.filter(([, name]) => name !== null);
  assert.ok(starts.length > 40, `${starts.length} behaviours in an hour`);
  const names = starts.map(([kind, name]) => (kind === 'trip' ? Object.keys(TRIPS).find((k) => TRIPS[k] === name) : name));
  for (let i = 1; i < names.length; i += 1) assert.notEqual(names[i], names[i - 1], `repeat at ${i}`);
  assert.deepEqual([...new Set(names)].sort(), [...Object.keys(PLAYS), ...Object.keys(TRIPS)].sort(), 'every behaviour turns up');
  // Gaps between behaviours: at least 20 s after the previous one ended (or since enabling), at most 90 s.
  let end = 120000;
  for (const [kind, name, at] of log) {
    if (name === null) {
      end = at;
      continue;
    }
    assert.ok(at - end >= 20000 && at - end <= 90000 + 1, `gap ${at - end}`);
    if (kind === 'trip') end = at;
  }
});

test('ambient life: trips only when allowed, "home" only when away; disabling ends a play at once', () => {
  const { clock, a, log } = ambient(() => 0.999);
  a.update({ enabled: true, trips: false });
  clock.tick(3600000);
  assert.ok(log.every(([kind]) => kind === 'play'), 'no trips while helpers or the cat are around');
  log.length = 0;
  a.update({ enabled: true, trips: true, away: false });
  clock.tick(3600000);
  assert.ok(!log.some(([, name]) => name === 'home'), 'not when already home');
  a.update({ enabled: false });
  a.run('stretch');
  a.update({ enabled: true });
  a.run('ball');
  assert.deepEqual(log.at(-1).slice(0, 2), ['play', 'ball']);
  a.update({ enabled: false });
  assert.deepEqual(log.at(-1).slice(0, 2), ['play', null], 'ended at once');
  const count = log.length;
  clock.tick(3600000);
  assert.equal(log.length, count, 'nothing while disabled');
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
  // The 'end' callback already sees an inactive duel (the page hides the arena and
  // the duel's Play button there, and ambient life may run again).
  let activeAtEnd = null;
  const seen = new Duel({ clock, onPhase: (phase) => phase === 'end' && (activeAtEnd = seen.active) });
  seen.start();
  seen.stop();
  assert.equal(activeAtEnd, false);
  d.start();
  // Nobody plays: hits until the robot wins, well before the time limit.
  clock.tick(D.maxMs + D.endMs + 10);
  assert.equal(d.active, false);
});
