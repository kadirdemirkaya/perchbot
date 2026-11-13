'use strict';

/**
 * The idle story (lib/fun.js IdleStory): a long idle spell before a nap:
 * three things picked at random (a book, the cat, petting the cat, bubbles,
 * a paper plane, a visitor to chat and spar with), then sleepy.
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

test('idle story: three beats picked at random, one after another, then sleepy', () => {
  assert.deepEqual([...STORY.beats].sort(), ['bubbles', 'cat', 'guest', 'pat', 'plane', 'read']);
  assert.equal(STORY.count, 3);
  assert.equal(STORY.last, 'sleep');
  const { clock, s, log } = story({ sleep: 'skip' });
  s.start();
  clock.tick(STORY.firstMs - 1);
  assert.deepEqual(log, []);
  clock.tick(1);
  assert.equal(log.length, 1);
  assert.ok(STORY.beats.includes(log[0][0]));
  // The first one is still on: nothing else, however long it takes.
  clock.tick(120000);
  assert.equal(log.length, 1);
  s.done();
  const gap = STORY.gapMinMs + 0.5 * (STORY.gapMaxMs - STORY.gapMinMs);
  clock.tick(gap - 1);
  assert.equal(log.length, 1, 'a gap after each beat');
  clock.tick(1);
  assert.equal(log.length, 2);
  s.done();
  clock.tick(gap);
  s.done();
  clock.tick(gap);
  const names = log.map(([n]) => n);
  assert.equal(names.length, 4);
  assert.equal(names[3], 'sleep', 'three beats, then sleepy');
  assert.equal(new Set(names.slice(0, 3)).size, 3, 'no beat twice');
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

test('idle story: a different pick and order from one idle spell to the next', () => {
  const seen = new Set();
  const firsts = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    let r = seed / 41;
    const clock = new FakeClock();
    const names = [];
    const s = new IdleStory({
      clock,
      random: () => ((r = (r * 9301 + 0.49297) % 1), r),
      onBeat: (name) => {
        names.push(name);
        return name === 'sleep' ? 'skip' : 'busy';
      },
    });
    s.start();
    for (let i = 0; i < 4; i += 1) {
      clock.tick(STORY.gapMaxMs + STORY.firstMs);
      s.done();
    }
    assert.equal(names.length, 4, names.join());
    seen.add(names.slice(0, 3).join());
    firsts.add(names[0]);
  }
  assert.ok(seen.size >= 10, `varied (${seen.size} different stories)`);
  assert.equal(firsts.size, STORY.beats.length, 'any of them can come first');
});

test('idle story: "skip" moves on at once and does not count, "later" tries again a few times, stop() ends it', () => {
  // Only the book and the plane are possible: those two, then sleepy (fewer than three is fine).
  const answers = { cat: 'skip', pat: 'skip', guest: 'skip', bubbles: 'skip', sleep: 'skip' };
  const { clock, s, log } = story(answers);
  s.start();
  clock.tick(STORY.firstMs);
  const firstPlayed = log.findIndex(([n]) => n === 'read' || n === 'plane');
  assert.ok(firstPlayed >= 0);
  assert.ok(log.every(([, at]) => at === STORY.firstMs), 'skipped ones do not wait');
  s.done();
  clock.tick(STORY.gapMaxMs);
  s.done();
  clock.tick(STORY.gapMaxMs);
  const names = log.map(([n]) => n);
  assert.deepEqual(names.filter((n) => n === 'read' || n === 'plane').sort(), ['plane', 'read']);
  assert.equal(names.at(-1), 'sleep');
  assert.equal(s.finished, true);
  // Not now: again soon, a few times, then the next one.
  let busyNow = true;
  const t = story({ read: () => (busyNow ? 'later' : 'busy'), cat: 'later', pat: 'later', guest: 'later', bubbles: 'later', plane: 'later', sleep: 'skip' });
  t.s.start();
  t.clock.tick(STORY.firstMs + STORY.retryMs * 2);
  const first = t.log[0][0];
  assert.deepEqual(t.log.map(([n]) => n), [first, first, first], 'not now: again soon');
  t.clock.tick(STORY.retryMs * STORY.retries);
  assert.notEqual(t.log.at(-1)[0], first, 'given up after a few tries');
  busyNow = false;
  t.s.stop();
  const n = t.log.length;
  t.clock.tick(600000);
  assert.equal(t.s.running, false);
  assert.equal(t.log.length, n, 'nothing after stop()');
  // The demo: every wait a tenth as long.
  const f = story({ read: 'busy', cat: 'busy', pat: 'busy', guest: 'busy', bubbles: 'busy', plane: 'busy', sleep: 'skip' });
  f.s.start({ fast: true });
  f.clock.tick(STORY.firstMs / 10);
  assert.equal(f.log.length, 1);
  f.s.done();
  f.clock.tick(STORY.gapMaxMs / 10);
  assert.equal(f.log.length, 2);
});

test('the book, the bubbles and the plane are plays of the story only: never picked at random', () => {
  assert.deepEqual([...STORY_PLAYS], ['read', 'bubbles', 'plane']);
  assert.equal(PLAYS.read, 9000);
  assert.equal(PLAYS.bubbles, 7000);
  assert.equal(PLAYS.plane, 6000);
  const clock = new FakeClock();
  const picks = [];
  const a = new AmbientScheduler({ clock, random: Math.random, onPlay: (n) => n && picks.push(n), onTrip: () => {} });
  a.update({ enabled: true, trips: false });
  clock.tick(6 * 3600000);
  assert.ok(picks.length > 100);
  for (const name of STORY_PLAYS) assert.ok(!picks.includes(name), name);
  const css = read('characters', 'robot', 'robot.css');
  assert.ok(css.includes(".buddy-character[data-play='read'] .rb-book {"));
  for (const rule of [".buddy-character[data-play='bubbles'] .rb-wand {", ".buddy-character[data-play='bubbles'] .rb-bubble-6 {", ".buddy-character[data-play='plane'] .rb-plane-fly {", ".buddy-character[data-play='plane'] .rb-plane-held {"]) {
    assert.ok(css.includes(rule), rule);
  }
  assert.match(css, /\.rb-wand,\s*\.rb-bubble,\s*\.rb-plane-held,\s*\.rb-plane-fly \{\s*opacity: 0;/, 'hidden until their play');
  const svg = read('characters', 'robot', 'robot.svg');
  for (const prop of ['rb-wand', 'rb-bubbles', 'rb-plane-held', 'rb-plane-fly']) assert.match(svg, new RegExp(`class="${prop}" data-nohit=""`), prop);
  // Six bubbles, each one styled.
  for (let i = 1; i <= 6; i += 1) assert.ok(svg.includes(`rb-bubble rb-bubble-${i}`), `bubble ${i}`);
  for (const demo of ['bubbles', 'plane', 'pat']) assert.ok(DEMOS.has(demo), demo);
});

test('petting the cat: a story beat (Cat switch on); the cat comes close, the buddy turns to it and strokes it', () => {
  const page = read('app', 'renderer', 'renderer.js');
  for (const piece of [
    "if (name === 'pat') return startPat() ? 'busy' : 'skip';",
    'if (!settings.cat || !character || !character.pet || crewCount > 0 || !motionAllowed()) return false;',
    "window.buddy.fun('cat');",
    "if (name === 'cuddle') onCuddle(on);",
    "const ok = ambientOn() && AMBIENT_STATES.has(view.state) && motionAllowed() && pet.cuddle();",
    "later('pat-come', PAT_COME_MS, () => {",
    "quip('petCat', 1800);",
    '!raging && !guest && !cuddling && !guestPending && !lasering;',
  ]) {
    assert.ok(page.includes(piece), piece);
  }
  for (const spot of [placement.petSpots(0, 'left'), placement.petSpots(0, 'right'), placement.petSpots(2, 'left')]) {
    assert.ok(spot.cuddle < spot.play - 40, `close to the buddy (${spot.cuddle} < ${spot.play})`);
  }
  const css = read('characters', 'robot', 'robot.css');
  assert.ok(css.includes(".buddy-character[data-pet='cuddle']:not([data-rest]) .rb-forearm-front {"));
  const cat = read('characters', 'robot', 'cat.css');
  assert.ok(cat.includes(".buddy-pet[data-phase='cuddle']:not([data-walk]) .rbc-eyes-happy {"));
  assert.ok(read('characters', 'robot', 'cat.svg').includes('<g class="rbc-eyes-happy"'));
  const main = read('app', 'main.js');
  assert.ok(main.includes("'petCat'"), 'main passes the quip on');
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).quip.petCat, lang);
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
    // No stroll of its own while the visitor is on its way (it would send it away again).
    'guestPending = true;',
    "later('guest-pending', GUEST_PENDING_MS, () => {",
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
