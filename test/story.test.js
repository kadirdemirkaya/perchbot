'use strict';

/**
 * The idle story (lib/fun.js IdleStory): a long idle spell before a nap:
 * three things picked at random (a book, the cat, petting the cat, bubbles,
 * a paper plane, a visitor to chat and spar with), "Where are you?" (up to the
 * glass, a knock), then sleepy.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IdleStory, STORY, PLAYS, STORY_PLAYS, AmbientScheduler, whereDue, WHERE } = require('../app/renderer/lib/fun');
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

test('idle story: three beats picked at random, one after another, then "Where are you?", then sleepy', () => {
  assert.deepEqual([...STORY.beats].sort(), ['bubbles', 'cat', 'coffee', 'guest', 'pat', 'plane', 'read']);
  assert.equal(STORY.count, 3);
  assert.deepEqual([...STORY.finale], ['where']);
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
  assert.equal(names[3], 'where', 'three beats, then "Where are you?"');
  assert.equal(new Set(names.slice(0, 3)).size, 3, 'no beat twice');
  // The knock is still on: nothing else until it is over.
  clock.tick(120000);
  assert.equal(log.length, 4);
  s.done();
  clock.tick(gap - 1);
  assert.equal(log.length, 4, 'a gap after it too');
  clock.tick(1);
  assert.equal(log.at(-1)[0], 'sleep', '...then sleepy');
  assert.equal(log.length, 5);
  assert.equal(s.running, false);
  assert.equal(s.finished, true);
  // Once per idle spell: start() again does nothing until work ended it (stop).
  s.start();
  clock.tick(600000);
  assert.equal(log.length, 5);
  s.stop();
  s.start();
  clock.tick(STORY.firstMs);
  assert.equal(log.length, 6, 'a new idle spell, a new story');
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
  const answers = { cat: 'skip', pat: 'skip', guest: 'skip', bubbles: 'skip', coffee: 'skip', where: 'skip', sleep: 'skip' };
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
  const t = story({ read: () => (busyNow ? 'later' : 'busy'), cat: 'later', pat: 'later', guest: 'later', bubbles: 'later', plane: 'later', coffee: 'later', sleep: 'skip' });
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
  assert.deepEqual([...STORY_PLAYS], ['read', 'bubbles', 'plane', 'coffee', 'where']);
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
    "return startPat() ? 'busy' : 'skip';",
    'return Boolean(settings.cat && character && character.pet && crewCount === 0 && motionAllowed());',
    'if (!canPat()) return false;',
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

test('"Where are you?": after the beats, before the nap; skipped (away, too soon) it naps at once; finish() means no nap', () => {
  // Played: it waits for the knock, and the nap comes after it.
  const a = story({ sleep: 'skip' });
  a.s.start();
  for (let i = 0; i < 3; i += 1) {
    a.clock.tick(STORY.firstMs + STORY.gapMaxMs);
    a.s.done();
  }
  a.clock.tick(STORY.gapMaxMs);
  assert.equal(a.log.at(-1)[0], 'where');
  assert.equal(a.s.playing, 'where');
  // The user came (the pointer on it): over for this spell, no nap at its end.
  a.s.finish();
  assert.equal(a.s.running, false);
  assert.equal(a.s.finished, true);
  a.clock.tick(600000);
  assert.ok(!a.log.some(([n]) => n === 'sleep'), 'no nap after "There you are!"');
  a.s.start();
  a.clock.tick(600000);
  assert.equal(a.log.at(-1)[0], 'where', 'once per idle spell, as when it played to the end');
  a.s.stop();
  a.s.start();
  a.clock.tick(STORY.firstMs);
  assert.notEqual(a.log.at(-1)[0], 'where', 'a new idle spell, a new story');
  // finish() when nothing runs does nothing.
  const idle = story();
  idle.s.finish();
  assert.equal(idle.s.finished, false);
  idle.s.start();
  idle.clock.tick(STORY.firstMs);
  assert.equal(idle.log.length, 1);
  // Skipped (the user away, asked not long ago): straight on to the nap, no wait.
  const b = story({ where: 'skip', sleep: 'skip' });
  b.s.start();
  for (let i = 0; i < 3; i += 1) {
    b.clock.tick(STORY.firstMs + STORY.gapMaxMs);
    b.s.done();
  }
  b.clock.tick(STORY.gapMaxMs);
  const tail = b.log.slice(-2);
  assert.deepEqual(tail.map(([n]) => n), ['where', 'sleep']);
  assert.equal(tail[0][1], tail[1][1], 'the nap at once after a skipped "Where are you?"');
  // Nothing else possible (no cat, no visitor...): it still comes, then the nap.
  const none = Object.fromEntries(STORY.beats.map((n) => [n, 'skip']));
  const c = story({ ...none, sleep: 'skip' });
  c.s.start();
  c.clock.tick(STORY.firstMs);
  assert.equal(c.log.at(-1)[0], 'where');
  c.s.done();
  c.clock.tick(STORY.gapMaxMs);
  assert.equal(c.log.at(-1)[0], 'sleep');
  // An IdleStory without a finale is the story as it was: the beats, then sleepy.
  const old = new IdleStory({ clock: new FakeClock(), random: () => 0.5, finale: [], onBeat: () => 'skip' });
  old.start();
  assert.deepEqual(old.list.slice(-2), [old.list.at(-2), 'sleep']);
  assert.ok(!old.list.includes('where'));
});

test('whereDue: not while the user is away, and at most every ten minutes', () => {
  assert.equal(WHERE.gapMs, 10 * 60000);
  assert.equal(whereDue({ now: 5000 }), true, 'never asked: now');
  assert.equal(whereDue({ now: 5000, away: true }), false, 'away: no one to see it');
  assert.equal(whereDue({ now: 5000 + WHERE.gapMs - 1, lastAt: 5000 }), false, 'asked not long ago');
  assert.equal(whereDue({ now: 5000 + WHERE.gapMs, lastAt: 5000 }), true);
  assert.equal(whereDue({ now: 5000 + WHERE.gapMs, lastAt: 5000, away: true }), false);
  assert.equal(whereDue({ now: 2000, lastAt: 1000, gapMs: 1000 }), true, 'its own gap');
});

test('"Where are you?" on the page: up to the glass, a knock, the question; the pointer on it: "There you are!"', () => {
  assert.equal(PLAYS.where, 6000);
  assert.ok(STORY_PLAYS.includes('where'), 'never picked at random');
  assert.ok(DEMOS.has('where'));
  const page = read('app', 'renderer', 'renderer.js');
  for (const piece of [
    "if (!whereDue({ now: Date.now(), lastAt: whereAt, away: userAway })) return 'skip';",
    "if (change && (change.kind === 'away' || change.kind === 'back')) userAway = change.kind === 'away';",
    "if (!name && was === 'where' && zone !== null) whereFound();",
    'story.finish();',
    "quip('hereYouAre', 1600);",
    "later('where-ask', WHERE_ASK_MS, () => holder.dataset.play === 'where' && quip('whereAreYou', WHERE_ASK_SHOW_MS));",
    'function knockRings(at = figurePoint(0.66, 0.5)) {',
  ]) {
    assert.ok(page.includes(piece), piece);
  }
  // The waiting knock (Claude Code waits for the user) is as it was: its rings where they were.
  assert.ok(page.includes("if (kind === 'knock') knockRings();"));
  const css = read('characters', 'robot', 'robot.css');
  for (const rule of [
    ".buddy-character[data-play='where'] .rb-figure {",
    ".buddy-character[data-play='where'] .rb-arm-front {",
    ".buddy-character[data-play='where'] .rb-forearm-front {",
    ".buddy-character[data-play='where'] .rb-question {",
  ]) {
    assert.ok(css.includes(rule), rule);
  }
  // Up close: bigger, but its head stays clear of the speech bubble; its knuckles (the rings) up and out
  // from where the waiting knock's are (0.66, 0.5), on the near side of the figure.
  const scale = Number(/38%, 80% \{ transform: translateY\(0\) scale\(([\d.]+)\); \}/.exec(css)[1]);
  assert.ok(scale > 1 && scale <= 1.15, `bigger, but its head stays clear of the speech bubble (${scale})`);
  const hand = /const WHERE_HAND = Object\.freeze\(\{ x: ([\d.]+), y: ([\d.]+) \}\);/.exec(page).slice(1).map(Number);
  assert.ok(hand[0] > 0.66 && hand[0] < 0.9, `knuckles x ${hand[0]}`);
  assert.ok(hand[1] > 0.25 && hand[1] < 0.5, `knuckles y ${hand[1]}`);
  // The rings come when the knuckles hit the glass (the first hit at 44.83 % of 5.8 s).
  const knockMs = Number(/const WHERE_KNOCK_MS = (\d+);/.exec(page)[1]);
  assert.ok(css.includes('44.83% { transform: rotate(-10deg); }'));
  assert.ok(Math.abs(knockMs + 250 - 0.4483 * 5800) < 15, `first ring at ${knockMs + 250} ms`);
  const main = read('app', 'main.js');
  assert.ok(main.includes("'whereAreYou', 'hereYouAre'"), 'main passes the quips on');
  for (const lang of ['en', 'tr']) {
    const quips = JSON.parse(read('app', 'locales', `${lang}.json`)).quip;
    for (const key of ['whereAreYou', 'hereYouAre']) assert.ok(quips[key], `${lang}: ${key}`);
  }
  assert.equal(JSON.parse(read('app', 'locales', 'tr.json')).quip.whereAreYou, 'Neredesin?');
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

test('out and about: about once a minute a trip of its own while idle, up in the air too; never in the middle of something', () => {
  const { Wander, WANDER, TRIPS } = require('../app/renderer/lib/fun');
  assert.ok(WANDER.gapMinMs >= 45000 && WANDER.gapMaxMs <= 75000, 'about once a minute');
  assert.ok(WANDER.weights.cruise > 0 && WANDER.weights.fly > 0, 'up in the air');
  assert.ok(WANDER.weights.walk > 0, 'and down to the ground somewhere else');
  const clock = new FakeClock();
  const trips = [];
  const w = new Wander({ clock, random: () => 0.5, onTrip: (kind) => trips.push(kind) });
  // Not allowed (work, the cat, helpers, "Stay here"): nothing at all.
  w.update({ on: false, free: true });
  clock.tick(5 * 60000);
  assert.equal(trips.length, 0);
  // Idle: the first one about a minute in.
  const gap = WANDER.gapMinMs + 0.5 * (WANDER.gapMaxMs - WANDER.gapMinMs);
  w.update({ on: true, free: true });
  clock.tick(gap - 1);
  assert.equal(trips.length, 0, 'not before about a minute');
  clock.tick(1);
  assert.equal(trips.length, 1);
  // Something going on (a play, a story beat, the pointer on it): it waits, never cuts it short.
  w.update({ on: true, free: false });
  clock.tick(gap + WANDER.retryMs * 3);
  assert.equal(trips.length, 1);
  w.update({ on: true, free: true });
  clock.tick(WANDER.retryMs);
  assert.equal(trips.length, 2, 'off as soon as it is free');
  // Any trip (an ambient one, a look at the cursor) starts the wait over.
  clock.tick(gap - 1000);
  w.moved();
  clock.tick(gap - 1);
  assert.equal(trips.length, 2);
  clock.tick(1);
  assert.equal(trips.length, 3);
  // Trips the page may ask for, never the same one twice in a row.
  for (const kind of trips) assert.ok(Object.values(TRIPS).includes(kind), kind);
  for (let i = 1; i < trips.length; i++) assert.notEqual(trips[i], trips[i - 1]);
  // Not allowed any more (work): none meanwhile.
  w.update({ on: false, free: true });
  clock.tick(10 * 60000);
  assert.equal(trips.length, 3);
  // ...and allowed again after the minute was up: off soon, not a whole minute later.
  w.update({ on: true, free: true });
  clock.tick(WANDER.retryMs);
  assert.equal(trips.length, 4, 'soon after it is allowed again');
  // The cat for a while (or a nap) halfway through the minute does not start it over.
  clock.tick(gap / 2);
  w.update({ on: false, free: true });
  clock.tick(gap / 2);
  assert.equal(trips.length, 4);
  w.update({ on: true, free: true });
  clock.tick(WANDER.retryMs);
  assert.equal(trips.length, 5);
});

test('out and about on the page: idle, no cat or helpers, not "Stay here"; the cat, the visitor and "Where are you?" only on the ground', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('wander.update({ on: wanderOn(), free: wanderFree() });'));
  assert.ok(page.includes('return ambientOn() && AMBIENT_STATES.has(view.state) && !rest.resting && !paused && crewCount === 0 && !catStays && !settings.stayPut;'));
  assert.ok(page.includes('return calm && !fisting && !ambient.playing && !story.playing && !patPending;'), 'never in the middle of a play or a story beat');
  // The cat cannot come along: the story's napping cat goes first (as for a visitor), any other cat keeps it down.
  assert.ok(page.includes('const catStays = pet.here && !(storyCat && !cuddling && !patPending);'));
  assert.ok(page.includes("later('wander-go', WANDER_CAT_AWAY_MS, () => {"));
  assert.ok(page.includes('if (!pet.here && wanderOn() && wanderFree()) window.buddy.fun(kind);'));
  assert.ok(page.includes('if (!moving) wander.moved();'), 'any trip starts the wait over');
  // Hovering after a flight: down to the ground first for the cat, the petting, the visitor and "Where are you?".
  assert.ok(page.includes("if (canPat() && landFirst()) return 'later';"));
  assert.equal((page.match(/if \(landFirst\(\)\) return 'later';/g) || []).length, 3, 'the cat, the visitor and "Where are you?"');
  assert.ok(page.includes("window.buddy.fun('land');"));
  assert.ok(page.includes('if (!flight.airborne) return false;'));
  // main.js: 'land' is a trip like the others ("Stay here" keeps it where it is).
  const main = read('app', 'main.js');
  assert.ok(/const FUN_ACTIONS = new Set\(\[[^\]]*'land'/.test(main));
  assert.ok(/const STAY_PUT_BLOCKS = new Set\(\[[^\]]*'land'/.test(main));
});
