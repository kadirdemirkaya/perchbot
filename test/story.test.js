'use strict';

/**
 * The idle story (lib/fun.js IdleStory): a long idle spell before a nap: a
 * book, the cat, a visitor to chat and spar with, then sleepy.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IdleStory, STORY, PLAYS, STORY_PLAYS, AmbientScheduler } = require('../app/renderer/lib/fun');
const placement = require('../app/placement');
const { DEMOS } = require('../app/validate');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function story(answers = {}) {
  const clock = new FakeClock();
  const log = [];
  const s = new IdleStory({
    clock,
    random: () => 0.5,
    onBeat: (name) => {
      log.push([name, clock.now]);
      const a = answers[name];
      return typeof a === 'function' ? a() : a || 'busy';
    },
  });
  return { clock, s, log };
}

test('idle story: book, cat, visitor, sleep, in that order, each after the one before is over', () => {
  assert.deepEqual([...STORY.beats], ['read', 'cat', 'guest', 'sleep']);
  const { clock, s, log } = story({ sleep: 'skip' });
  s.start();
  clock.tick(STORY.firstMs - 1);
  assert.deepEqual(log, []);
  clock.tick(1);
  assert.deepEqual(log.map(([n]) => n), ['read']);
  // The book is still out: nothing else, however long it takes.
  clock.tick(120000);
  assert.equal(log.length, 1);
  s.done();
  const gap = STORY.gapMinMs + 0.5 * (STORY.gapMaxMs - STORY.gapMinMs);
  clock.tick(gap);
  assert.deepEqual(log.map(([n]) => n), ['read', 'cat']);
  s.done();
  clock.tick(gap);
  s.done();
  clock.tick(gap);
  assert.deepEqual(log.map(([n]) => n), ['read', 'cat', 'guest', 'sleep']);
  assert.equal(s.running, false);
  assert.equal(s.finished, true);
  // Once per idle spell: start() again does nothing until work ended it (stop).
  s.start();
  clock.tick(600000);
  assert.equal(log.length, 4);
  s.stop();
  s.start();
  clock.tick(STORY.firstMs);
  assert.equal(log.length, 5, 'a new idle spell, a new story');
});

test('idle story: "skip" moves on, "later" tries again a few times, stop() ends it', () => {
  let busyNow = true;
  const { clock, s, log } = story({ read: () => (busyNow ? 'later' : 'busy'), cat: 'skip', guest: 'skip', sleep: 'skip' });
  s.start();
  clock.tick(STORY.firstMs + STORY.retryMs * 2);
  assert.deepEqual(log.map(([n]) => n), ['read', 'read', 'read'], 'not now: again soon');
  busyNow = false;
  clock.tick(STORY.retryMs);
  assert.equal(s.playing, 'read');
  s.done();
  clock.tick(3 * STORY.gapMaxMs);
  assert.deepEqual(log.map(([n]) => n).slice(4), ['cat', 'guest', 'sleep'], 'skipped ones do not wait for done()');
  const t = story({ read: 'later' });
  t.s.start();
  t.clock.tick(STORY.firstMs + STORY.retries * STORY.retryMs);
  assert.equal(t.log.filter(([n]) => n === 'read').length, STORY.retries + 1);
  t.clock.tick(STORY.gapMaxMs);
  assert.equal(t.log.at(-1)[0], 'cat', 'given up on the book after a few tries');
  t.s.stop();
  t.clock.tick(600000);
  assert.equal(t.s.running, false);
  assert.equal(t.log.at(-1)[0], 'cat', 'nothing after stop()');
  // The demo: every wait a tenth as long.
  const f = story({ read: 'skip', cat: 'skip', guest: 'skip', sleep: 'skip' });
  f.s.start({ fast: true });
  f.clock.tick(STORY.firstMs / 10 + 3 * (STORY.gapMaxMs / 10));
  assert.equal(f.log.length, 4);
});

test('the book is a play of the story only: never picked at random', () => {
  assert.deepEqual([...STORY_PLAYS], ['read']);
  assert.equal(PLAYS.read, 9000);
  const clock = new FakeClock();
  const picks = [];
  const a = new AmbientScheduler({ clock, random: Math.random, onPlay: (n) => n && picks.push(n), onTrip: () => {} });
  a.update({ enabled: true, trips: false });
  clock.tick(6 * 3600000);
  assert.ok(picks.length > 100);
  assert.ok(!picks.includes('read'));
  assert.ok(read('characters', 'robot', 'robot.css').includes(".buddy-character[data-play='read'] .rb-book {"));
});

test('the visitor: room beside the buddy, close enough for the swords to meet', () => {
  for (const side of ['left', 'right']) {
    const spot = placement.guestSpot(side);
    assert.ok(spot.off > 0 && spot.off < 60, `${side}: ${spot.off}`);
    assert.ok(spot.width > spot.off + 60, 'the whole little robot fits');
  }
  const main = read('app', 'main.js');
  assert.ok(main.includes('const guest = guestOn && character && character.mini ? placement.guestSpot(side) : null;'));
  assert.ok(main.includes('guest ? guest.width : 0,'));
  assert.ok(main.includes('layout.page.guest = guest;'));
  assert.ok(main.includes("else if (action === 'cat') settings.ambientLife && setPet(true);"), 'the cat only with its switch on (setPet checks it)');
  assert.ok(main.includes('cat: Boolean(settings.cat),'), 'the page knows the Cat switch');
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onGuest: on('buddy:guest')"));
  const view = read('app', 'renderer', 'crew-view.js');
  assert.ok(view.includes("el.className = 'buddy-mini buddy-guest';"));
  assert.ok(read('app', 'renderer', 'overlay.css').includes('.buddy-mini.buddy-guest > svg * {\n  pointer-events: none;'), 'it never takes the mouse');
});

test('the visitor on the page: sit and chat, spar, bow and off; work or a drag sends it away', () => {
  const page = read('app', 'renderer', 'renderer.js');
  for (const piece of [
    "flag('seated', 'down', true);",
    "set('phase', 'spar');",
    "flag('duel', 'strike');",
    "set('spar', 'block');",
    "quip('guestBow', 1600);",
    "endGuest('interrupted');",
    "window.buddy.fun('guest-away');",
    "window.buddy.fun('cat-away');",
    'if (pet.here && !storyCat) return \'skip\';',
  ]) {
    assert.ok(page.includes(piece), piece);
  }
  assert.ok(page.includes('rest.setDelay(sleepy && ambientOn() ? SLEEPY_MS : ambientOn() ? REST_LIVELY_MS : REST_MS);'), 'sleepy at the end');
  const svg = read('characters', 'robot', 'mini.svg');
  assert.ok(svg.includes('<g class="rbm-sword" data-nohit="">'));
  const css = read('characters', 'robot', 'mini.css');
  for (const rule of [".buddy-mini[data-phase='sit'] .rbm-figure", "[data-spar='strike'] .rbm-arm-front", "[data-spar='block'] .rbm-arm-front", ".buddy-mini[data-phase='spar'] .rbm-sword"]) {
    assert.ok(css.includes(rule), rule);
  }
  assert.ok(read('characters', 'robot', 'robot.css').includes(".buddy-character[data-seated] .rb-figure {"));
  for (const lang of ['en', 'tr']) {
    const quips = JSON.parse(read('app', 'locales', `${lang}.json`)).quip;
    for (const key of ['guestHi', 'guestSpar', 'guestBow', 'sleepy']) assert.ok(quips[key], `${lang}: ${key}`);
  }
  for (const demo of ['read', 'guest', 'story']) assert.ok(DEMOS.has(demo), demo);
});
