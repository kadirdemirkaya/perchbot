'use strict';

/**
 * The giant peek ("Giant peek" switch, off by default): before a nap, instead of
 * the small "Where are you?", it walks up to the glass from where it stands, bigger
 * with every step (up to ten times its size), knocks, listens, knocks again; no
 * answer: a shrug, it walks back to its spot and naps there. The pointer on it
 * meanwhile: "There you are!", and it runs back (no nap). app/giant.js plans it,
 * main.js opens a click-through window (renderer/giant.html) and watches only where
 * the cursor is, while it lasts.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const giantLib = require('../app/giant');
const { GIANT, SHAPE, BOX, HEARS, PHASES, timeline, foundTimeline, planGiant, toScreen, pointerFound, parseGiantRequest } = giantLib;
const { IdleStory, STORY } = require('../app/renderer/lib/fun');
const { normalizeSettings, DEFAULTS } = require('../app/settings');
const { buildMenuItems, MENU_IDS } = require('../app/menu-items');
const { buildFunMenuTemplate } = require('../app/tray');
const { DEMOS } = require('../app/validate');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SCREENS = [
  [1920, 1040],
  [1536, 824],
  [2400, 1300],
  [1280, 680],
  [900, 500],
];

test('timeline: walk up, knock, listen, knock again, wait, shrug, walk back; found: a hop, then it runs back', () => {
  const steps = timeline();
  assert.deepEqual(steps.map((s) => s.phase), ['walk', 'knock', 'listen', 'again', 'wait', 'shrug', 'back', null]);
  assert.equal(steps[0].at, 0);
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].at > steps[i - 1].at, 'one after the other');
  assert.equal(steps[1].at, GIANT.walkMs);
  // A short listen: up at the glass about eight seconds, the whole thing under twenty.
  const atGlass = steps.find((s) => s.phase === 'back').at - steps.find((s) => s.phase === 'knock').at;
  assert.ok(atGlass >= 6000 && atGlass <= 10000, `${atGlass} ms at the glass`);
  assert.ok(steps.at(-1).at < 20000);
  assert.deepEqual(foundTimeline().map((s) => s.phase), ['found', 'dash', null]);
  assert.equal(foundTimeline().at(-1).at, GIANT.foundMs + GIANT.dashMs);
  assert.ok(GIANT.dashMs < GIANT.backMs, 'found: it runs back, quicker than the walk');
  for (const s of [...steps, ...foundTimeline()]) assert.ok(s.phase === null || PHASES.includes(s.phase), s.phase);
  // The pointer counts only while it is up at the glass.
  assert.deepEqual([...HEARS].sort(), ['again', 'knock', 'listen', 'shrug', 'wait']);
});

test('plan: up to ten times its size, at least four, cut by the screen no higher than its shoulders', () => {
  for (const [width, height] of SCREENS) {
    const area = { x: 0, y: 0, width, height };
    const p = planGiant({ area });
    assert.ok(p, `${width}x${height}`);
    assert.ok(p.factor <= GIANT.factor && p.factor >= GIANT.minFactor, `${width}x${height}: ${p.factor}`);
    assert.ok(p.cut >= SHAPE.minCut - 1e-9 && p.cut <= SHAPE.maxCut + 1e-9, `cut ${p.cut}`);
    // What shows of it fits the work area; its body fits its width.
    const visible = (p.cut - SHAPE.top) * p.size;
    assert.ok(visible <= height * GIANT.heightShare + 1, `${visible} of ${height}`);
    assert.ok(p.size * (SHAPE.right - SHAPE.left) <= width * GIANT.widthShare + 1);
    // Its feet's axis in the middle; the work area's bottom edge crosses it at `cut`.
    assert.ok(Math.abs(p.left + p.size * SHAPE.axis - width / 2) < 0.2);
    assert.ok(Math.abs(p.top + p.size * p.cut - height) < 0.2);
    assert.deepEqual(p.clip, area);
  }
  // A full HD screen at medium size: about nine times; a big one: all ten.
  assert.ok(planGiant({ area: { x: 0, y: 0, width: 1920, height: 1040 } }).factor >= 8.5);
  assert.equal(planGiant({ area: { x: 0, y: 0, width: 2400, height: 1300 } }).factor, 10);
  // Too small for four times its size: no giant (the page plays the small "Where are you?").
  assert.equal(planGiant({ area: { x: 0, y: 0, width: 600, height: 300 } }), null);
  assert.equal(planGiant({ area: null }), null);
  assert.equal(planGiant({ area: { x: 0, y: 0, width: 0, height: 900 } }), null);
});

test('plan: it starts (and ends) on the small one\'s feet, at its size, so the two hand over in place', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  for (const from of [{ x: 1800, y: 1018 }, { x: 140, y: 1018 }, { x: 960, y: 600 }]) {
    const p = planGiant({ area, from });
    assert.equal(p.far.scale, Math.round((BOX / p.size) * 10000) / 10000, 'its own size');
    // The box scales about (axis, bottom): where its feet land at the far transform.
    const ox = p.left + p.size * SHAPE.axis;
    const oy = p.top + p.size;
    const feetX = ox + p.far.x;
    const feetY = oy - p.size * (1 - SHAPE.feet) * p.far.scale + p.far.y;
    assert.ok(Math.abs(feetX - from.x) < 0.2, `x ${feetX} vs ${from.x}`);
    assert.ok(Math.abs(feetY - from.y) < 0.2, `y ${feetY} vs ${from.y}`);
  }
  // From the right it walks left (towards the middle), back to the right; from the left the other way.
  const right = planGiant({ area, from: { x: 1800, y: 1018 } });
  assert.equal(right.face, 'left');
  assert.equal(right.backFace, 'right');
  const left = planGiant({ area, from: { x: 140, y: 1018 } });
  assert.equal(left.face, 'right');
  assert.equal(left.backFace, 'left');
  // Right below the middle: it keeps the way the small one faced.
  assert.equal(planGiant({ area, from: { x: 965, y: 1018 }, face: 'left' }).face, 'left');
  assert.equal(planGiant({ area, from: { x: 965, y: 1018 }, face: 'right' }).backFace, 'right');
  // Off the screen (a stale point): kept inside the work area.
  const off = planGiant({ area, from: { x: 5000, y: -400 } });
  assert.ok(off.left + off.size * SHAPE.axis + off.far.x <= area.width + 0.2);
  // Words come as given (already translated by main), never anything else.
  const said = planGiant({ area, say: { listen: 'Neredesin?', shrug: 42, found: 'Buradasın!' } }).say;
  assert.deepEqual(said, { listen: 'Neredesin?', shrug: '', found: 'Buradasın!' });
});

test('the pointer: on the giant, moved, while it is up at the glass', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const p = planGiant({ area });
  // Hit box: the visible part, from its antenna down to the screen's edge.
  assert.ok(p.hit.y >= 0 && p.hit.y + p.hit.height <= area.height + 0.2);
  assert.ok(p.hit.x >= 0 && p.hit.x + p.hit.width <= area.width + 0.2);
  // To the screen (a second display at x 1920, size large: zoom 1.3).
  const hit = toScreen(p.hit, { x: 1920, y: 0 }, 1.3);
  assert.equal(hit.x, 1920 + p.hit.x * 1.3);
  assert.equal(hit.width, p.hit.width * 1.3);
  const on = { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 };
  assert.equal(pointerFound({ phase: 'listen', cursor: on, hit, moved: true }), true);
  assert.equal(pointerFound({ phase: 'listen', cursor: on, hit, moved: false }), false, 'already there and never moved: no answer');
  assert.equal(pointerFound({ phase: 'walk', cursor: on, hit, moved: true }), false, 'not while it walks up');
  assert.equal(pointerFound({ phase: 'back', cursor: on, hit, moved: true }), false);
  assert.equal(pointerFound({ phase: 'shrug', cursor: { x: hit.x - 5, y: on.y }, hit, moved: true }), false);
  assert.equal(pointerFound({ phase: 'knock', cursor: null, hit, moved: true }), false);
});

test('the page\'s request is checked again: start / demo with its feet, nothing else', () => {
  assert.deepEqual(parseGiantRequest({ op: 'start', feet: { x: 108, y: 248 }, face: 'left' }), { op: 'start', feet: { x: 108, y: 248 }, face: 'left' });
  assert.deepEqual(parseGiantRequest({ op: 'demo', feet: { x: 1, y: 2 }, face: 'up' }), { op: 'demo', feet: { x: 1, y: 2 }, face: 'right' });
  for (const bad of [null, 'start', { op: 'start' }, { op: 'fly', feet: { x: 1, y: 2 } }, { op: 'start', feet: { x: 'a', y: 2 } }, { op: 'start', feet: { x: Infinity, y: 2 } }, { op: 'start', feet: { x: 1e9, y: 2 } }]) {
    assert.equal(parseGiantRequest(bad), null, JSON.stringify(bad));
  }
});

test('the story: nobody answered, sleepy right after (done with soonMs); otherwise the usual gap', () => {
  const clock = new FakeClock();
  const log = [];
  const s = new IdleStory({ clock, random: () => 0.5, onBeat: (name) => (log.push([name, clock.now]), name === 'sleep' ? 'skip' : 'busy') });
  s.start();
  clock.tick(STORY.firstMs);
  for (let i = 0; i < 3; i += 1) {
    s.done();
    clock.tick(STORY.gapMaxMs);
  }
  assert.equal(log.at(-1)[0], 'where');
  const at = clock.now;
  s.done({ soonMs: 700 });
  clock.tick(699);
  assert.equal(log.at(-1)[0], 'where');
  clock.tick(1);
  assert.deepEqual(log.at(-1), ['sleep', at + 700]);
});

test('switch: off by default, in the hover menu (a ball) and the menus, with the user\'s words', () => {
  assert.equal(DEFAULTS.giantPeek, false);
  assert.equal(normalizeSettings({}).giantPeek, false);
  assert.equal(normalizeSettings({ giantPeek: true }).giantPeek, true);
  assert.equal(normalizeSettings({ giantPeek: 'yes' }).giantPeek, false);
  assert.ok(MENU_IDS.has('giant'));
  const item = (s) => buildMenuItems({ ...DEFAULTS, ...s }).find((i) => i.id === 'giant');
  assert.deepEqual(item({}), { id: 'giant', icon: 'giant-off', label: 'Giant peek before a nap' });
  assert.deepEqual(item({ giantPeek: true }), { id: 'giant', icon: 'giant', label: 'No more giant peeks' });
  assert.deepEqual(item({ language: 'tr' }), { id: 'giant', icon: 'giant-off', label: 'Uyumadan önce dev gibi baksın' });
  assert.deepEqual(item({ language: 'tr', giantPeek: true }), { id: 'giant', icon: 'giant', label: 'Dev bakışı kapat' });
  // Last: every other ball keeps its place.
  const ids = buildMenuItems({ ...DEFAULTS, position: { x: 1, y: 2 } }, { soundAvailable: true, windows: true }).map((i) => i.id);
  assert.equal(ids.at(-1), 'giant');
  assert.equal(ids.at(-2), 'windows');
  const html = read('app', 'renderer', 'index.html');
  assert.ok(html.includes('id="i-giant"') && html.includes('id="i-giant-off"'));
  // Eleven balls: a sixth row, the menu higher up, still inside the 270 px window.
  const css = read('app', 'renderer', 'overlay.css');
  assert.ok(css.includes('.menu.six-rows {\n  top: 56px;\n}'));
  assert.ok(56 + 6 * 30 + 5 * 6 <= 270);
  assert.ok(read('app', 'renderer', 'renderer.js').includes("menuEl.classList.toggle('six-rows', buttons.length > 10);"));
  // The right-click menu (and the tray: the same switches).
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const box = buildFunMenuTemplate({ settings: { ...DEFAULTS }, away: false, on }).find((i) => i.label === 'Giant peek before a nap');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, false);
  box.click({ checked: true });
  assert.deepEqual(calls, [['setGiantPeek', true]]);
  // Words in both languages.
  for (const lang of ['en', 'tr']) {
    const loc = JSON.parse(read('app', 'locales', `${lang}.json`));
    for (const key of ['giantOn', 'giantOff']) assert.ok(loc.hover[key], `${lang} hover.${key}`);
    assert.ok(loc.menu.giantPeek, `${lang} menu.giantPeek`);
    for (const key of ['whereAreYou', 'giantHmm', 'hereYouAre']) assert.ok(loc.quip[key], `${lang} quip.${key}`);
  }
});

test('main.js: a click-through window that only listens; the cursor read only while it lasts; work, a lock or quitting end it', () => {
  const main = read('app', 'main.js');
  assert.ok(main.includes("const giantLib = require('./giant');"));
  const body = main.slice(main.indexOf('function startGiant('), main.indexOf('function endGiant(why)'));
  for (const piece of [
    "if (!demo && (!settings.giantPeek || !settings.ambientLife)) return refuse('switched off');",
    "if (!CALM_STATES.has(core.snapshot().state)) return refuse('at work');",
    "g.ew = effectWindow(display, 'Perchbot giant', 'giant-preload.js');",
    'g.ew.loadURL(`${ORIGIN}/renderer/giant.html`);',
    'g.ew.webContents.setZoomFactor(s);',
    'g.poll = setInterval(() => watchGiant(g), giantLib.GIANT.pollMs);',
    'const cursor = screen.getCursorScreenPoint();',
    'giantLib.pointerFound({ phase: g.phase, cursor, hit: g.hit, moved: g.moved })',
  ]) {
    assert.ok(body.includes(piece), piece);
  }
  // The cursor's position never leaves main: neither page gets it.
  assert.ok(!/send\([^)]*cursor/.test(body), 'no cursor sent anywhere');
  assert.ok(main.includes('const req = giantLib.parseGiantRequest(msg);'), 'the request is checked again');
  assert.ok(main.includes("if (giant && !CALM_STATES.has(snap.state)) endGiant('work came in');"));
  for (const why of ['paused', 'quit', 'renderer gone', 'window closed']) assert.ok(main.includes(`endGiant('${why}')`), why);
  assert.ok(main.includes("case 'giant':\n        actions.setGiantPeek(!settings.giantPeek);"));
  assert.ok(main.includes('giantPeek: Boolean(settings.giantPeek),'), 'the page knows the switch');
  // Declared up top: the first event may come in before the rest of start() has run.
  assert.ok(main.indexOf('  let giant = null;') < main.indexOf("if (initialEvent) dispatch(initialEvent, 'launch');"));
  // Nothing else starts while it is out.
  assert.ok(main.includes('if (!win || win.isDestroyed() || drag || trip || warping || paused || giant || !anchor || !pageLayout) return;'));
  assert.ok(main.includes('quitting || paused || rampage || giant || !anchor'));
  // Listen-only bridge.
  const bridge = read('app', 'giant-preload.js');
  assert.ok(!/\.send\(|invoke\(/.test(bridge), 'the giant page cannot send anything');
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onGiant: on('buddy:giant'),"));
  assert.ok(preload.includes("if ((op !== 'start' && op !== 'demo') || !feet || !num(feet.x) || !num(feet.y)) return;"));
});

test('the giant\'s page: strict CSP, the SVG cleaned, words as text, poses for every phase', () => {
  const html = read('app', 'renderer', 'giant.html');
  assert.ok(html.includes("default-src 'none'; script-src 'self'; style-src 'self'"));
  const page = read('app', 'renderer', 'giant.js');
  assert.ok(page.includes("svg.querySelectorAll('script, foreignObject, iframe, object, embed, image').forEach((n) => n.remove());"));
  assert.ok(page.includes('bubbleText.textContent = text;'));
  assert.ok(!page.includes('innerHTML'));
  for (const phase of PHASES) assert.ok(page.includes(`'${phase}'`), `page: ${phase}`);
  // Never faded in or out: it hands over with the small one in place.
  assert.ok(!read('app', 'renderer', 'giant.css').includes('.giant.shown {\n  opacity: 1;\n  transition'));
  const robot = read('characters', 'robot', 'robot.css');
  for (const phase of ['walk', 'knock', 'listen', 'again', 'wait', 'shrug', 'back', 'dash']) assert.ok(robot.includes(`[data-giant='${phase}']`), `robot.css: ${phase}`);
  // The knuckles hit the glass when the page draws its rings (keyframe % of the 1.5 s knock).
  assert.equal(GIANT.knockMs, 1500);
  assert.equal(GIANT.againMs, 1500);
  for (const [name, hits] of [['rb-giant-knock-forearm', GIANT.knockHits], ['rb-giant-again-forearm', GIANT.againHits]]) {
    const at = robot.indexOf(`@keyframes ${name} {`);
    const block = robot.slice(at, robot.indexOf('}\n}', at));
    for (const ms of hits) {
      const pct = Math.round((ms / 1500) * 100);
      assert.ok(block.includes(`${pct}% { transform: rotate(-8deg); }`), `${name} hits at ${pct}%`);
    }
  }
  // The small one hides while the giant is out, and the story's beat uses it only with the switch on.
  assert.ok(read('app', 'renderer', 'overlay.css').includes('.stage.giant-away .buddy-character {\n  visibility: hidden;\n}'));
  const renderer = read('app', 'renderer', 'renderer.js');
  assert.ok(renderer.includes("if (settings.giantPeek && crewCount === 0 && startGiant()) return 'busy';"));
  assert.ok(renderer.includes("story.done({ soonMs: GIANT_SLEEPY_MS });"), 'no answer: it naps right there');
  assert.ok(renderer.includes('story.finish();'), 'found: no nap');
  assert.ok(DEMOS.has('giant'));
});
