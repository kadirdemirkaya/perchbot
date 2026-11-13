'use strict';

/**
 * Following the cursor (app/follow.js): where the cursor rests, the buddy may
 * fly over and look through its magnifier. And "Stay here": no trips of its own.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DwellWatch, FOLLOW } = require('../app/follow');
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

test('follow: the cursor moves somewhere and rests there: one dwell, once', () => {
  const watch = new DwellWatch();
  const spots = feed(watch, [...rest({ x: 100, y: 100 }, 3000), ...rest({ x: 900, y: 500 }, 6000)]);
  assert.equal(spots.length, 1, 'the first resting place is where it started: no dwell there');
  assert.equal(spots[0].x, 900);
  assert.equal(spots[0].y, 500);
  assert.ok(spots[0].at >= 3000 + FOLLOW.dwellMs, 'after it rested long enough');
});

test('follow: small moves, quick moves and spots next to the buddy are no dwell', () => {
  const watch = new DwellWatch();
  // Wandering all the time: never still long enough.
  const wander = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 40, y: 300 }));
  assert.deepEqual(feed(watch, wander), []);
  // A rest close to the last spot: no new dwell.
  const w2 = new DwellWatch();
  const near = feed(w2, [...rest({ x: 500, y: 500 }, 3000), ...rest({ x: 560, y: 520 }, 4000)]);
  assert.deepEqual(near, []);
  // Next to the buddy (the user is busy with it): no dwell.
  const w3 = new DwellWatch();
  const byBuddy = feed(w3, [...rest({ x: 0, y: 0 }, 1000), ...rest({ x: 1500, y: 900 }, 4000)], { buddy: { x: 1520, y: 1000 } });
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
  assert.ok(main.includes("startTrip('inspect', { at: { x: spot.x, y: spot.y }, lens: true });"));
  assert.ok(main.includes('...(lens ? { lens: true } : {}),'), 'the page hears about the magnifier on arrival');
  assert.ok(main.includes('clearInterval(followTimer);'));
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onFollow: on('buddy:follow')"));
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("window.buddy.fun('peek');"));
  assert.ok(page.includes('if (!demo && (Date.now() - lastFollow < FOLLOW_GAP_MS || Math.random() >= FOLLOW_CHANCE)) return;'));
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
