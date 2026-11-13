'use strict';

/**
 * Following the cursor (app/follow.js): where the cursor rests, the buddy may
 * fly over and look through its magnifier. And "Stay here": no trips of its own.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DwellWatch, FOLLOW, FOLLOW_STATES } = require('../app/follow');
const { normalizeSettings, DEFAULTS } = require('../app/settings');
const { buildTrayTemplate, buildFunMenuTemplate } = require('../app/tray');
const { DEMOS } = require('../app/validate');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** Feeds samples every FOLLOW.sampleMs; returns the dwells reported. */
function feed(watch, points, { start = 0, buddy = null } = {}) {
  const out = [];
  let now = start;
  for (const p of points) {
    const spot = watch.sample(p, now, buddy);
    if (spot) out.push({ ...spot, at: now });
    now += FOLLOW.sampleMs;
  }
  return out;
}

const rest = (p, ms) => Array.from({ length: Math.ceil(ms / FOLLOW.sampleMs) + 1 }, (_, i) => ({ x: p.x + (i % 2), y: p.y }));

/** The dice always say yes (the chance has a test of its own). */
const yes = () => new DwellWatch({ random: () => 0 });

test('follow: the cursor moves somewhere and rests there for thirty seconds: a dwell', () => {
  assert.equal(FOLLOW.dwellMs, 30000);
  const watch = yes();
  const spots = feed(watch, [...rest({ x: 100, y: 100 }, 32000), ...rest({ x: 900, y: 500 }, 29000), ...rest({ x: 900, y: 500 }, 2000)]);
  assert.ok(spots.length >= 1, 'the first resting place is where it started: no dwell there');
  for (const s of spots) assert.deepEqual([s.x, s.y], [900, 500]);
  assert.ok(spots[0].at >= 32600 + FOLLOW.dwellMs, 'after it rested thirty seconds');
  // Twenty-nine seconds is not enough.
  assert.deepEqual(feed(yes(), [...rest({ x: 100, y: 100 }, 1000), ...rest({ x: 900, y: 500 }, 29000)]), []);
});

test('follow: now and then, not every time: the dice once per spot, a "no" counts as seen', () => {
  assert.equal(FOLLOW.chance, 0.5);
  const no = new DwellWatch({ random: () => 0.99 });
  assert.deepEqual(feed(no, [...rest({ x: 100, y: 100 }, 1000), ...rest({ x: 900, y: 500 }, 60000)]), [], 'a "no": not offered at all');
  assert.ok(no.seen.some((s) => s.x === 900 && s.y === 500), 'and that spot is seen');
  // Rolled once per spot, not once per sample.
  let rolls = 0;
  const counted = new DwellWatch({
    random: () => {
      rolls += 1;
      return 0;
    },
  });
  const offers = feed(counted, [...rest({ x: 100, y: 100 }, 1000), ...rest({ x: 900, y: 500 }, 45000)]);
  assert.ok(offers.length >= 2, 'a "yes" is offered again while it has not been');
  assert.equal(rolls, 1);
  // About half of the spots.
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let looks = 0;
  for (let i = 0; i < 400; i += 1) {
    const w = new DwellWatch({ random });
    if (feed(w, [...rest({ x: 100, y: 100 }, 1000), ...rest({ x: 900, y: 500 }, 31000)]).length) looks += 1;
  }
  assert.ok(looks > 160 && looks < 240, String(looks));
});

test('follow: once per spot: offered again until it has been, never after; a new spot gets its own visit', () => {
  const watch = yes();
  const s0 = feed(watch, [...rest({ x: 100, y: 100 }, 1000), ...rest({ x: 900, y: 500 }, 40000)]);
  // It was busy: the spot comes again every retryMs while the cursor still rests there.
  assert.ok(s0.length >= 2, `offered again (${s0.length})`);
  for (let i = 1; i < s0.length; i += 1) assert.ok(s0[i].at - s0[i - 1].at >= FOLLOW.retryMs);
  // It went to look: not again, however long the cursor rests there (or near it).
  watch.visited({ x: 900, y: 500 });
  assert.deepEqual(feed(watch, rest({ x: 905, y: 500 }, 60000), { start: 50000 }), []);
  watch.hold();
  assert.deepEqual(feed(watch, rest({ x: 960, y: 560 }, 60000), { start: 120000 }), [], 'a hold (busy, a trip) keeps it seen');
  // Somewhere new: one more visit.
  const s1 = feed(watch, rest({ x: 300, y: 700 }, 32000), { start: 200000 });
  assert.ok(s1.length >= 1);
  assert.deepEqual([s1[0].x, s1[0].y], [300, 700]);
  watch.visited(s1[0]);
  assert.deepEqual(feed(watch, rest({ x: 300, y: 700 }, 40000), { start: 240000 }), []);
  // It remembers the last few spots: back to the first one after five others, it may come again.
  const many = yes();
  feed(many, rest({ x: 0, y: 0 }, 1000));
  for (let i = 1; i <= FOLLOW.remember; i += 1) many.visited({ x: i * 300, y: 300 });
  assert.equal(many.seen.length, FOLLOW.remember);
  assert.ok(!many.seen.some((s) => s.x === 0 && s.y === 0), 'the oldest is forgotten');
  // A hold restarts the thirty seconds.
  const w2 = yes();
  feed(w2, [...rest({ x: 100, y: 100 }, 1000), ...rest({ x: 900, y: 500 }, 20000)]);
  w2.hold();
  assert.deepEqual(feed(w2, rest({ x: 900, y: 500 }, 20000), { start: 22000 }), [], 'twenty more seconds after a hold are not thirty');
});

test('follow: small moves, quick moves and spots next to the buddy are no dwell', () => {
  const watch = new DwellWatch();
  // Wandering all the time: never still long enough.
  const wander = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 40, y: 300 }));
  assert.deepEqual(feed(watch, wander), []);
  // A rest close to where it started: no new dwell.
  const w2 = yes();
  const near = feed(w2, [...rest({ x: 500, y: 500 }, 3000), ...rest({ x: 560, y: 520 }, 34000)]);
  assert.deepEqual(near, []);
  // Next to the buddy (the user is busy with it): no dwell.
  const w3 = yes();
  const byBuddy = feed(w3, [...rest({ x: 0, y: 0 }, 1000), ...rest({ x: 1500, y: 900 }, 34000)], { buddy: { x: 1520, y: 1000 } });
  assert.deepEqual(byBuddy, []);
  // Bad samples are ignored.
  assert.equal(new DwellWatch().sample({ x: Number.NaN, y: 1 }, 0), null);
  assert.equal(new DwellWatch().sample(null, 0), null);
});

test('follow wiring: main samples the position only, the page decides, a trip with the magnifier', () => {
  const main = read('app', 'main.js');
  const tick = main.slice(main.indexOf('function followTick()'), main.indexOf('function demoFollow()'));
  assert.ok(tick.includes('dwell.sample(screen.getCursorScreenPoint(), Date.now(), anchor)'));
  assert.ok(tick.includes('settings.stayPut'), 'never with "Stay here"');
  assert.ok(!/clipboard|getTitle|readText/.test(tick), 'nothing but the position');
  assert.ok(main.includes("startTrip('inspect', { at: { x: spot.x, y: spot.y }, lens: true, peek: true, then: () => lookThenBack(from) });"));
  // Then back to where it came from (home, or its spot out on the screen); work does not cut it short.
  const back = main.slice(main.indexOf('function lookThenBack(from)'), main.indexOf('}, FOLLOW.backAfterMs);'));
  assert.ok(back.includes("if (!from) return startTrip('home', { peek: true });"));
  assert.ok(back.includes("if (plan) beginTrip(plan, 'goto', null, { peek: true });"));
  assert.ok(back.includes('if (Math.hypot(anchor.x - there.x, anchor.y - there.y) > 3) return;'), 'not if it was moved meanwhile');
  assert.ok(main.includes("trip.plan.kind !== 'reach' && !trip.peek && !CALM_STATES.has(snap.state)"));
  assert.ok(FOLLOW.backAfterMs > FOLLOW.lensMs, 'it looks first');
  assert.ok(tick.includes('dwell.hold();') && !tick.includes('dwell.reset();'), 'busy or on a trip: the spots it has been to stay seen');
  assert.ok(/!FOLLOW_STATES\.has\(core\.snapshot\(\)\.state\)\s+\) \{\s+dwell\.hold\(\);/.test(tick), 'idle or at work, not while Claude Code waits');
  for (const state of ['idle', 'typing', 'thinking', 'running']) assert.ok(FOLLOW_STATES.has(state), state);
  for (const state of ['waiting', 'asking', 'goodbye']) assert.ok(!FOLLOW_STATES.has(state), state);
  const peek = main.slice(main.indexOf('function peekAtDwell()'), main.indexOf("startTrip('inspect', { at: { x: spot.x, y: spot.y }, lens: true, peek: true"));
  assert.ok(peek.includes('dwell.visited(spot);'), 'once per spot');
  assert.ok(main.includes('...(lens ? { lens: true } : {}),'), 'the page hears about the magnifier on arrival');
  assert.ok(main.includes('clearInterval(followTimer);'));
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onFollow: on('buddy:follow')"));
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("window.buddy.fun('peek');"));
  assert.ok(page.includes('if (!demo && Date.now() - lastFollow < FOLLOW_GAP_MS) return;'), 'at most every two minutes (the dice are in app/follow.js)');
  assert.ok(page.includes('const FOLLOW_GAP_MS = 120000;') && FOLLOW.gapMs === 120000, 'page and app/follow.js agree');
  assert.ok(!page.includes('FOLLOW_CHANCE'));
  const listed = page.match(/const FOLLOW_STATES = new Set\((\[[^\]]*\])\);/);
  assert.deepEqual(JSON.parse(listed[1].replace(/'/g, '"')), [...FOLLOW_STATES], 'the page knows the same states');
  assert.ok(page.includes('if (rest.resting) rest.activity();'), 'napping, it wakes up for a look');
  assert.ok(page.includes("if (m.kind === 'inspect' && m.arrived && motionAllowed() && m.lens) {"));
  for (const demo of ['follow', 'lens']) assert.ok(DEMOS.has(demo), demo);
  const svg = read('characters', 'robot', 'robot.svg');
  assert.ok(svg.includes('<g class="rb-magnifier" data-nohit="">'));
  const css = read('characters', 'robot', 'robot.css');
  assert.ok(css.indexOf('.buddy-character[data-lens] .rb-face') > css.indexOf(".buddy-character[data-inspect='right'] .rb-face"), 'the lens pose wins over inspect');
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).quip.lensHmm, lang);
});

test('stay here: a setting (off by default), in the tray and the right-click menu', () => {
  assert.equal(DEFAULTS.stayPut, false);
  assert.equal(normalizeSettings({ stayPut: true }).stayPut, true);
  assert.equal(normalizeSettings({ stayPut: 'yes' }).stayPut, false);
  const on = new Proxy({}, { get: () => () => {} });
  for (const template of [buildTrayTemplate({ settings: { ...DEFAULTS, stayPut: true }, on, characters: [], accounts: [] }), buildFunMenuTemplate({ settings: { ...DEFAULTS, stayPut: true }, away: false, on })]) {
    const flat = JSON.stringify(template, (k, v) => (typeof v === 'function' ? undefined : v));
    assert.ok(flat.includes('"label":"Stay here","type":"checkbox","checked":true'), flat.slice(0, 200));
  }
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).menu.stayPut, lang);
});

test('stay here: no trips of its own, no fleeing; main refuses them too, the menu still works', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('trips: crewCount === 0 && !pet.here && !settings.stayPut,'));
  assert.ok(page.includes("if (!settings.stayPut) later('flee', erupt ? ERUPT_MS : 450, () => window.buddy.fun('flee'));"));
  const main = read('app', 'main.js');
  assert.ok(main.includes('if (settings.stayPut && STAY_PUT_BLOCKS.has(action)) {'));
  const blocks = /const STAY_PUT_BLOCKS = new Set\(\[([^\]]+)\]\)/.exec(main)[1];
  for (const kind of ['flee', 'stroll', 'hop', 'inspect', 'cruise', 'hang', 'loop', 'perch', 'peek']) assert.ok(blocks.includes(`'${kind}'`), kind);
  assert.ok(!blocks.includes("'home'") && !blocks.includes("'context'"), 'home and the menu stay');
  assert.ok(main.includes('stayPut: Boolean(settings.stayPut),'), 'the page knows');
  assert.ok(main.includes('if (stayPut && roamAnchor && !trip) saveDrop(roamAnchor);'), 'where it is becomes its place');
});
