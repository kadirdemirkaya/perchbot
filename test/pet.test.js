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

test('petted (the idle story): from its nap it walks up close, is petted for a while, then naps again', () => {
  const { clock, d, log, last } = setup();
  assert.equal(d.cuddle(), false, 'no cat yet');
  d.call();
  assert.equal(d.cuddle(), false, 'still walking in');
  clock.tick(last().walkMs);
  clock.tick(T.playMs);
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'nap');
  d.setGeometry({ play: 60, nap: 150, width: 200, cuddle: 18 });
  log.cues.length = 0;
  assert.equal(d.cuddle(), true);
  assert.equal(last().phase, 'cuddle');
  assert.equal(last().off, 18, 'close to the main character');
  assert.equal(last().face, 'in');
  assert.ok(last().walkMs > 0);
  assert.deepEqual(log.cues, [], 'petted once it is there');
  assert.equal(d.cuddle(), false, 'already on its way');
  clock.tick(last().walkMs);
  assert.equal(last().walkMs, 0);
  assert.deepEqual(log.cues, [['cuddle', true]]);
  clock.tick(T.cuddleMs);
  assert.deepEqual(log.cues, [['cuddle', true], ['cuddle', false]]);
  assert.equal(last().phase, 'aside');
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'nap');
  assert.deepEqual(log.phases, ['enter', 'play', 'aside', 'nap', 'cuddle', 'aside', 'nap']);
});

test('petted while it plays: the play ends first; work ends the petting at once', () => {
  const { clock, d, log, last } = setup();
  d.call();
  clock.tick(last().walkMs + 1000);
  assert.equal(d.cuddle(), true);
  assert.deepEqual(log.cues, [['play', true], ['play', false]]);
  clock.tick(last().walkMs);
  assert.deepEqual(log.cues.at(-1), ['cuddle', true]);
  d.interrupt();
  assert.deepEqual(log.cues.at(-1), ['cuddle', false]);
  assert.equal(last().phase, 'aside');
  // Sent away while petted: the petting ends too.
  const t = setup();
  t.d.call();
  t.clock.tick(t.last().walkMs);
  t.d.cuddle();
  t.clock.tick(t.last().walkMs);
  t.d.dismiss();
  assert.deepEqual(t.log.cues.at(-1), ['cuddle', false]);
  assert.equal(t.last().phase, 'leave');
});

test('asked to come and be petted from its own phase change (as it starts to play): it comes', () => {
  const clock = new FakeClock();
  const cues = [];
  const phases = [];
  let d = null;
  d = new PetDirector({
    clock,
    onUpdate: () => {},
    onCue: (name, on) => cues.push([name, on]),
    onPhase: (phase) => {
      phases.push(phase);
      if (phase === 'play') d.cuddle();
    },
  });
  d.setGeometry({ play: 60, nap: 150, width: 200, cuddle: -20 });
  d.call();
  clock.tick(d.pet.walkMs);
  assert.equal(d.pet.phase, 'cuddle');
  assert.deepEqual(cues, [], 'no play cue for a play that never happened');
  clock.tick(d.pet.walkMs);
  assert.deepEqual(cues, [['cuddle', true]]);
  clock.tick(T.cuddleMs);
  assert.deepEqual(phases, ['enter', 'play', 'cuddle', 'aside']);
});

test('the laser pointer: from its nap it chases the dot to its play spot, pounces there a while, then naps again', () => {
  const { clock, d, log, last } = setup();
  assert.equal(d.laser(), false, 'no cat yet');
  d.call();
  assert.equal(d.laser(), false, 'still walking in');
  clock.tick(last().walkMs);
  clock.tick(T.playMs);
  assert.equal(last().phase, 'aside', 'by default the ball only (the page turns the laser on)');
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'nap');
  log.cues.length = 0;
  assert.equal(d.laser(), true);
  assert.equal(last().phase, 'laser');
  assert.equal(last().off, 60, 'after the dot, to its play spot');
  assert.ok(last().walkMs > 0);
  assert.equal(d.laser(), false, 'already after it');
  clock.tick(last().walkMs);
  assert.deepEqual(log.cues, [['laser', true]]);
  clock.tick(T.laserMs);
  assert.deepEqual(log.cues, [['laser', true], ['laser', false]]);
  assert.equal(last().phase, 'aside');
  clock.tick(last().walkMs);
  assert.equal(last().phase, 'nap');
  assert.deepEqual(log.phases.slice(-3), ['laser', 'aside', 'nap']);
  // Work: straight to its nap spot.
  d.laser();
  clock.tick(last().walkMs);
  d.interrupt();
  assert.deepEqual(log.cues.at(-1), ['laser', false]);
  assert.equal(last().phase, 'aside');
});

test('the laser pointer after the ball: with laserAfterPlay, the ball, then the dot, then a nap', () => {
  const clock = new FakeClock();
  const cues = [];
  const phases = [];
  const d = new PetDirector({ clock, random: () => 0.2, timings: { laserAfterPlay: 0.5 }, onCue: (n, on) => cues.push([n, on]), onPhase: (p) => phases.push(p) });
  d.setGeometry({ play: 60, nap: 150, width: 200 });
  d.call();
  clock.tick(d.pet.walkMs);
  clock.tick(T.playMs);
  assert.equal(d.pet.phase, 'laser', 'the ball, then the laser pointer');
  clock.tick(0);
  clock.tick(T.laserMs);
  assert.deepEqual(cues, [['play', true], ['play', false], ['laser', true], ['laser', false]]);
  assert.deepEqual(phases, ['enter', 'play', 'laser', 'aside']);
  // A higher roll: the ball only.
  const e = new PetDirector({ clock, random: () => 0.8, timings: { laserAfterPlay: 0.5 } });
  e.setGeometry({ play: 60, nap: 150, width: 200 });
  e.call();
  clock.tick(e.pet.walkMs);
  clock.tick(T.playMs);
  assert.equal(e.pet.phase, 'aside');
});

test('the laser pointer on the page: the napping cat is woken now and then; the robot points it, the cat has the dot', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const page = read('app', 'renderer', 'renderer.js');
  for (const piece of [
    "if (phase === 'nap') later('cat-laser', CAT_LASER_MIN_MS + Math.random() * (CAT_LASER_MAX_MS - CAT_LASER_MIN_MS), tryCatLaser);",
    "if (free && pet.laser()) trace('cat: the laser pointer');",
    "else later('cat-laser', CAT_LASER_RETRY_MS, tryCatLaser);",
    "if (name === 'laser') onPetLaser(on);",
  ]) {
    assert.ok(page.includes(piece), piece);
  }
  assert.ok(read('app', 'renderer', 'pet-view.js').includes('timings: { laserAfterPlay: 0.5 },'), 'half the time after the ball');
  const robot = read('characters', 'robot', 'robot.css');
  assert.ok(robot.includes(".buddy-character[data-pet='laser'] .rb-pointer {"));
  assert.match(read('characters', 'robot', 'robot.svg'), /class="rb-pointer" data-nohit=""/);
  const cat = read('characters', 'robot', 'cat.css');
  assert.ok(cat.includes(".buddy-pet[data-phase='laser'] .rbc-dot {"));
  assert.match(read('characters', 'robot', 'cat.svg'), /class="rbc-dot" data-nohit=""/);
  assert.ok(require('../app/validate').DEMOS.has('cat-laser'));
});
