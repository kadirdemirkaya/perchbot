'use strict';

/**
 * The rampage: its head on fire twice in five minutes (lib/fun.js Fury) ->
 * laser eyes and missiles over the screen (app/rampage.js plans it, main.js
 * opens a click-through effect window), marks that fade five to ten seconds
 * after the last blast.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Fury, FURY, TEMPER_MAX } = require('../app/renderer/lib/fun');
const { RAMPAGE, parseRampage, planRampage, toEffect, aimPoint } = require('../app/rampage');
const { DEMOS } = require('../app/validate');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** A small seeded random (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fury: the second blaze within five minutes is a rampage, then it counts from zero', () => {
  let now = 0;
  const fury = new Fury({ clock: { now: () => now } });
  assert.equal(FURY.blazes, 2);
  assert.equal(FURY.windowMs, 5 * 60 * 1000);
  assert.equal(fury.blaze(), false, 'the first time only blazes');
  now += 4 * 60 * 1000;
  assert.equal(fury.blaze(), true, 'again within five minutes');
  now += 1000;
  assert.equal(fury.blaze(), false, 'counted from zero after a rampage');
  now += 5 * 60 * 1000 + 1;
  assert.equal(fury.blaze(), false, 'more than five minutes later: the first one again');
  fury.reset();
  assert.equal(fury.blaze(), false);
});

test('fury: three more unwelcome taps while its head burns count as catching fire again', () => {
  let now = 0;
  const fury = new Fury({ clock: { now: () => now } });
  assert.equal(FURY.stokes, 3);
  assert.equal(fury.blaze(), false, 'its head catches fire');
  now += 3000;
  assert.equal(fury.stoke(), false);
  assert.equal(fury.stoke(), false);
  assert.equal(fury.stoke(), true, 'kept burning: over the top');
  // Counted from zero after a rampage; stoking alone (no first fire) needs two rounds.
  assert.equal(fury.stoke(), false);
  assert.equal(fury.stoke(), false);
  assert.equal(fury.stoke(), false, 'the first round only counts as catching fire');
  // A fresh fire starts the fuel over.
  fury.reset();
  fury.stoke();
  fury.stoke();
  assert.equal(fury.blaze(), false);
  assert.equal(fury.stoke(), false, 'fuel starts over with each fire');
});

test('fury: someone who never stops tapping gets a rampage (Temper keeps it burning)', () => {
  const { TapMeter, Temper } = require('../app/renderer/lib/fun');
  for (const busy of [false, true]) {
    let now = 0;
    const clock = { now: () => now };
    const meter = new TapMeter({ clock, random: seeded(3) });
    const temper = new Temper({ clock });
    const fury = new Fury({ clock });
    let rampage = 0;
    // A tap every 300 ms; after it flees, 3 s to find it again.
    while (now < 60000 && !rampage) {
      const v = meter.tap(busy, temper.hot);
      if (v === 'happy') temper.reset();
      if (v === 'annoyed' || v === 'flee') {
        const before = temper.level;
        const { level } = temper.flare(v);
        if (level >= TEMPER_MAX && (before < TEMPER_MAX ? fury.blaze() : fury.stoke())) rampage = now;
      }
      now += v === 'flee' ? 3000 : 300;
    }
    assert.ok(rampage > 0 && rampage < 30000, `${busy ? 'busy' : 'idle'}: a rampage after ${rampage} ms of tapping`);
  }
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('if (level >= TEMPER_MAX && before >= TEMPER_MAX && fury.stoke() && goRampage()) return;'));
  assert.ok(DEMOS.has('pester'), 'a demo of it');
});

test('rampage request: two eyes and a hatch inside the window, nothing else', () => {
  const size = { width: 355, height: 340 };
  const ok = parseRampage({ eyes: [{ x: 100.4, y: 80 }, { x: 126, y: 80.6 }], hatch: { x: 113, y: 130 }, face: 'left', extra: 1 }, size);
  assert.deepEqual(ok, { eyes: [{ x: 100, y: 80 }, { x: 126, y: 81 }], hatch: { x: 113, y: 130 }, face: 'left' });
  assert.equal(parseRampage({ eyes: [{ x: 1, y: 1 }], hatch: { x: 1, y: 1 }, face: 'up' }, size).face, 'right');
  for (const bad of [
    null,
    'x',
    { eyes: [], hatch: { x: 1, y: 1 } },
    { eyes: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], hatch: { x: 1, y: 1 } },
    { eyes: [{ x: 1, y: Number.NaN }], hatch: { x: 1, y: 1 } },
    { eyes: [{ x: 1, y: 1 }], hatch: null },
    { eyes: [{ x: 99999, y: 1 }], hatch: { x: 1, y: 1 } },
    { eyes: [{ x: 1, y: 1 }], hatch: { x: 1, y: -9999 } },
  ]) {
    assert.equal(parseRampage(bad, size), null, JSON.stringify(bad));
  }
});

test('rampage: page px of the buddy window become the effect window px (DIP from the display corner)', () => {
  assert.deepEqual(toEffect({ x: 100, y: 50 }, { x: 2000, y: 700 }, 1.25, { x: 1920, y: 0 }), { x: 205, y: 763 });
});

test('rampage plan: the beams, four missiles away from the buddy and each other, marks that stay 5-10 s', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const inside = (p) => p.x >= RAMPAGE.margin && p.y >= RAMPAGE.margin && p.x <= 1920 - RAMPAGE.margin && p.y <= 1040 - RAMPAGE.margin;
  const holds = [];
  for (let seed = 1; seed <= 40; seed += 1) {
    const eyes = [{ x: 1700, y: 900 }, { x: 1726, y: 900 }];
    const hatch = { x: 1713, y: 950 };
    const plan = planRampage({ area, eyes, hatch, face: seed % 2 ? 'left' : 'right', random: seeded(seed) });
    const { laser, missiles } = plan;
    assert.deepEqual(laser.eyes, eyes);
    for (const p of [laser.from, laser.to, laser.ctrl]) assert.ok(inside(p), `beam point inside: ${JSON.stringify(p)}`);
    // No room to the right of a buddy in the bottom-right corner: it fires to the left.
    assert.ok(laser.from.x < 1700 && laser.to.x < 1700, 'in front, where there is room');
    assert.equal(laser.at, 0);
    assert.equal(laser.ms, RAMPAGE.laserMs);
    assert.equal(missiles.length, RAMPAGE.missiles);
    let previous = laser.ms;
    for (const m of missiles) {
      assert.deepEqual(m.from, hatch);
      assert.ok(inside(m.to), `target inside: ${JSON.stringify(m.to)}`);
      assert.ok(Math.hypot(m.to.x - hatch.x, m.to.y - hatch.y) >= RAMPAGE.clearance, 'away from the buddy');
      assert.ok(m.ctrl.y < Math.min(m.from.y, m.to.y), 'an arc up and over');
      assert.ok(m.ctrl.y >= area.y, 'the arc stays on the screen');
      assert.ok(m.at > previous, 'one after another, after the beams');
      assert.ok(m.ms >= RAMPAGE.flightMs[0] && m.ms <= RAMPAGE.flightMs[1]);
      previous = m.at;
    }
    for (let i = 0; i < missiles.length; i += 1) {
      for (let k = i + 1; k < missiles.length; k += 1) {
        const d = Math.hypot(missiles[i].to.x - missiles[k].to.x, missiles[i].to.y - missiles[k].to.y);
        assert.ok(d >= RAMPAGE.spacing, `marks apart (${Math.round(d)} px)`);
      }
    }
    const lastBlast = Math.max(...missiles.map((m) => m.at + m.ms), plan.chase.at + plan.chase.ms, ...plan.chase.launches.map((l) => l.at + l.ms));
    const hold = plan.healAt - lastBlast;
    assert.ok(hold >= 5000 && hold <= 10000, `the marks stay 5-10 s after the last blast (${hold} ms)`);
    holds.push(hold);
    assert.equal(plan.endAt, plan.healAt + RAMPAGE.healMs);
    assert.deepEqual(
      plan.phases.map((p) => p.phase),
      ['laser', 'missile', 'chase', 'smug', 'heal', null],
    );
    for (let i = 1; i < plan.phases.length; i += 1) assert.ok(plan.phases[i].at > plan.phases[i - 1].at, 'phases in order');
  }
  assert.deepEqual(RAMPAGE.holdMs, [5000, 10000]);
  assert.ok(Math.min(...holds) < 6500 && Math.max(...holds) > 8500, 'a different length each time');
});

test('rampage plan: then five seconds after the cursor, with a missile at it now and then', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  for (let seed = 1; seed <= 20; seed += 1) {
    const eyes = [{ x: 1700, y: 900 }, { x: 1726, y: 900 }];
    const hatch = { x: 1713, y: 950 };
    const plan = planRampage({ area, eyes, hatch, random: seeded(seed) });
    const { chase, missiles, laser } = plan;
    const lastLaunch = missiles.at(-1).at;
    assert.equal(chase.at, lastLaunch + RAMPAGE.chaseGapMs, 'after the last of the first missiles');
    assert.equal(chase.ms, 5000);
    assert.deepEqual(chase.eyes, eyes);
    assert.deepEqual(chase.hatch, hatch);
    assert.deepEqual(chase.from, laser.to, 'the beams start where the burn line ended');
    assert.ok(chase.speed > 0);
    assert.deepEqual(chase.area, area);
    assert.equal(chase.launches.length, 4);
    for (const l of chase.launches) {
      assert.ok(l.at > chase.at && l.at + l.ms <= chase.at + chase.ms, 'every chasing missile lands within the chase');
      assert.ok(l.ms >= RAMPAGE.chaseFlightMs[0] && l.ms <= RAMPAGE.chaseFlightMs[1]);
    }
    const phase = (name) => plan.phases.find((p) => p.phase === name).at;
    assert.equal(phase('chase'), chase.at);
    assert.equal(phase('smug'), chase.at + chase.ms + 300, 'smug once the chase is over');
    assert.ok(plan.healAt - (chase.at + chase.ms) >= 5000, 'the trail stays at least five seconds too');
    assert.ok(RAMPAGE.chargeMs + plan.endAt < 30000, 'within the page guard');
  }
});

test('rampage chase: the cursor, as page px of the effect window on its display; elsewhere: null', () => {
  const bounds = { x: 1920, y: 0, width: 2560, height: 1440 };
  assert.deepEqual(aimPoint({ x: 2000.4, y: 300.6 }, bounds), { x: 80, y: 301 });
  assert.equal(aimPoint({ x: 100, y: 300 }, bounds), null, 'on the other screen');
  assert.equal(aimPoint({ x: 1920 + 2560, y: 10 }, bounds), null);
  assert.equal(aimPoint({ x: Number.NaN, y: 1 }, bounds), null);
  assert.equal(aimPoint(null, bounds), null);
  const main = read('app', 'main.js');
  const at = main.indexOf('function startRampage(req)');
  const body = main.slice(at, main.indexOf('function endRampage(why)'));
  assert.ok(body.includes("r.ew.webContents.send('effects:aim', rampageLib.aimPoint(screen.getCursorScreenPoint(), display.bounds));"), 'the position only, to the effect window only');
  assert.ok(body.includes('}, rampageLib.RAMPAGE.aimMs);'));
  assert.ok(body.includes('r.timers.push(setTimeout(() => stopAim(r), plan.chase.ms));'), 'only during the chase');
  assert.ok(main.slice(main.indexOf('function endRampage(why)')).includes('stopAim(r);'), 'and never after the show');
  const effects = read('app', 'rampage-preload.js');
  assert.ok(effects.includes("onAim: on('effects:aim'),"));
  const page = read('app', 'renderer', 'rampage.js');
  assert.ok(page.includes('aim = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;'), 'checked on arrival');
  assert.ok(page.includes('at(c.at, () => chase(c));'));
  assert.ok(page.includes('for (const l of c.launches || []) at(l.at, () => launchAt(c, l));'));
  const buddy = read('app', 'renderer', 'renderer.js');
  assert.ok(buddy.includes('const RAMPAGE_GUARD_MS = 30000;'));
  assert.ok(read('characters', 'robot', 'robot.css').includes(".buddy-character[data-rampage='chase'] .rb-figure {"));
});

test('rampage plan: a small screen still gets a plan inside it', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const plan = planRampage({ area, eyes: [{ x: 400, y: 300 }], hatch: { x: 400, y: 340 }, random: seeded(7) });
  for (const p of [plan.laser.from, plan.laser.to, ...plan.missiles.map((m) => m.to)]) {
    assert.ok(p.x >= 50 && p.x <= 750 && p.y >= 50 && p.y <= 550, JSON.stringify(p));
  }
});

test('rampage wiring: a click-through effect window that only listens, ended by a lock or quitting', () => {
  const main = read('app', 'main.js');
  const at = main.indexOf('function startRampage(req)');
  assert.ok(at > 0);
  const body = main.slice(at, main.indexOf('function endRampage(why)'));
  for (const piece of ["preload: path.join(__dirname, 'rampage-preload.js')", 'focusable: false', 'ew.setIgnoreMouseEvents(true);', 'sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'r.ew.showInactive();', 'win.moveTop();']) {
    assert.ok(body.includes(piece), piece);
  }
  assert.ok(main.includes("if (value) endRampage('paused');"), 'a locked screen ends it');
  assert.ok(main.includes("endRampage('quit');"));
  assert.ok(main.includes("endRampage('renderer gone');"));
  assert.ok(main.includes('const req = rampageLib.parseRampage(msg,'), 'the request is checked again');
  const effects = read('app', 'rampage-preload.js');
  assert.ok(!/\.send\(|invoke\(/.test(effects), 'the effect page cannot send anything');
  const page = read('app', 'renderer', 'rampage.js');
  for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'innerHTML', 'eval(']) assert.ok(!page.includes(word), word);
  const html = read('app', 'renderer', 'rampage.html');
  assert.ok(html.includes("default-src 'none'; script-src 'self'"));
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onRampage: on('buddy:rampage')"));
  assert.ok(preload.includes("ipcRenderer.send('buddy:rampage', { eyes, hatch, face: msg.face === 'left' ? 'left' : 'right' });"));
  assert.ok(DEMOS.has('rampage'));
});

test('rampage on the page: the second blaze starts it instead of a flight; poses for every phase', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('if (level >= TEMPER_MAX && before < TEMPER_MAX && fury.blaze() && goRampage()) return;'));
  assert.ok(page.includes('if (raging) return;'), 'taps wait until it is over');
  assert.ok(page.includes("if (raging) leaveRampage();"), 'work comes first');
  assert.equal(TEMPER_MAX, 3);
  const svg = read('characters', 'robot', 'robot.svg');
  assert.equal((svg.match(/data-eye=""/g) || []).length, 2, 'two eyes the beams start from');
  assert.equal((svg.match(/data-launch=""/g) || []).length, 1, 'one hatch');
  for (const group of ['rb-laser', 'rb-hatch']) assert.ok(svg.includes(`<g class="${group}" data-nohit="">`), `${group} never takes the mouse`);
  const css = read('characters', 'robot', 'robot.css');
  for (const phase of ['charge', 'laser', 'missile', 'smug', 'heal']) assert.ok(css.includes(`[data-rampage='${phase}']`), phase);
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(read('app', 'locales', `${lang}.json`));
    for (const key of ['rampage', 'rampageFix']) assert.ok(strings.quip[key], `${lang}: ${key}`);
  }
  const main = read('app', 'main.js');
  assert.ok(main.includes("'rampage', 'rampageFix'"), 'main sends the quips');
});
