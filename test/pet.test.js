'use strict';

/** The cat's routine (app/renderer/lib/pet.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PetDirector, PET_TIMINGS: T } = require('../app/renderer/lib/pet');
const { FakeClock } = require('./helpers/fake-clock');

function setup() {
  const clock = new FakeClock();
  const log = { views: [], cues: [], gone: 0, phases: [] };
  const d = new PetDirector({
    clock,
    onUpdate: (v) => log.views.push(v),
    onCue: (name, on) => log.cues.push([name, on]),
    onGone: () => {
      log.gone += 1;
    },
    onPhase: (phase) => log.phases.push(phase),
  });
  d.setGeometry({ play: 60, nap: 150, width: 200 });
  const last = () => log.views.at(-1);
  return { clock, d, log, last };
}

test('called: walks in from outside, plays with the main character, then naps aside', () => {
  const { clock, d, log, last } = setup();
  d.call();
  assert.equal(log.views[0].off, 200 + T.outside, 'starts beyond the edge of the window');
  assert.equal(last().phase, 'enter');
  assert.equal(last().off, 60);
  assert.ok(last().walkMs >= T.minWalkMs);
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'play');
  assert.deepEqual(log.cues, [['play', true]], 'the main character joins in');
  clock.tick(T.playMs);
  assert.deepEqual(log.cues, [['play', true], ['play', false]]);
  assert.equal(last().phase, 'aside');
  assert.equal(last().off, 150);
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'nap');
  clock.tick(3600000);
  assert.equal(last().phase, 'nap', 'naps until sent away');
  assert.equal(d.here, true);
});

test('work interrupts the play at once; sending it away plays the exit, then it is gone', () => {
  const { clock, d, log, last } = setup();
  d.call();
  clock.tick(last().walkMs + 1000);
  assert.equal(last().phase, 'play');
  d.interrupt();
  assert.deepEqual(log.cues.at(-1), ['play', false]);
  assert.equal(last().phase, 'aside');
  d.interrupt(); // harmless while walking aside
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'nap');
  d.dismiss();
  assert.equal(last().phase, 'leave');
  assert.equal(d.here, false);
  clock.tick(last().walkMs);
  assert.equal(log.gone, 1);
  assert.equal(d.pet, null);
  d.dismiss(); // nothing to do
  assert.equal(log.gone, 1);
});

test('called twice: one cat; geometry changes move a resting cat', () => {
  const { clock, d, log, last } = setup();
  d.call();
  const count = log.views.length;
  d.call();
  assert.equal(log.views.length, count, 'already here');
  clock.tick(last().walkMs + T.playMs);
  clock.tick(last().walkMs);
  d.setGeometry({ play: 80, nap: 300, width: 360 });
  assert.equal(last().off, 300, 'naps beyond the helpers that arrived');
});

test('phases (for its sounds): told once per change, and null once the cat is gone', () => {
  const { clock, d, log, last } = setup();
  d.call();
  clock.tick(last().walkMs);
  clock.tick(T.playMs);
  clock.tick(last().walkMs);
  d.setGeometry({ play: 70, nap: 160, width: 210 }); // re-placed while napping: same phase
  assert.deepEqual(log.phases, ['enter', 'play', 'aside', 'nap']);
  d.dismiss();
  clock.tick(last().walkMs);
  assert.deepEqual(log.phases.slice(4), ['leave', null], 'walked out');
  d.call();
  d.dispose();
  assert.deepEqual(log.phases.slice(6), ['enter', null], 'the pet was changed');
  d.dispose();
  assert.equal(log.phases.length, 8, 'no second null');
});
