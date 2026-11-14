'use strict';

/** The rocket fist (app/fist.js): now and then a Chrome button is pressed from afar with a flying forearm. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FIST, armPose, useFist, planFist } = require('../app/fist');
const { DEMOS } = require('../app/validate');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('the arm points at the button: facing it, turned from hanging down', () => {
  const anchor = { x: 1000, y: 900 };
  // Up and to the right: the press pose's own angle (robot.css data-press: -130 deg) for 40 deg up.
  const shoulder = { x: 1018, y: 808 };
  const upRight = { x: shoulder.x + Math.cos((-40 * Math.PI) / 180) * 500, y: shoulder.y + Math.sin((-40 * Math.PI) / 180) * 500 };
  const right = armPose(anchor, upRight, 1);
  assert.equal(right.face, 'right');
  assert.equal(right.rot, -130);
  assert.equal(right.angle, -40);
  // The forearm comes off at the elbow: the upper arm's length from the shoulder, towards the button.
  assert.ok(Math.abs(Math.hypot(right.elbow.x - shoulder.x, right.elbow.y - shoulder.y) - FIST.upperArm) < 1);
  // Up and to the left: it turns round (mirrored), the arm's own turn is the same.
  const shoulderL = { x: 978, y: 808 };
  const upLeft = { x: shoulderL.x - Math.cos((-40 * Math.PI) / 180) * 500, y: shoulderL.y + Math.sin((-40 * Math.PI) / 180) * 500 };
  const left = armPose(anchor, upLeft, 1);
  assert.equal(left.face, 'left');
  assert.equal(left.rot, -130);
  assert.ok(left.elbow.x < shoulderL.x && left.elbow.y < shoulderL.y);
  // Straight up: the arm turns half round; bigger sizes reach further.
  assert.equal(Math.abs(armPose(anchor, { x: 1018, y: 0 }, 1).rot), 180);
  const big = armPose(anchor, upRight, 1.5);
  assert.ok(big.elbow.y < right.elbow.y);
});

test('the dice: same screen and far enough only, then about four times in ten', () => {
  const elbow = { x: 1000, y: 800 };
  const far = { x: 1000, y: 60 };
  assert.equal(useFist({ sameScreen: false, elbow, target: far, random: () => 0 }), false, 'never to another screen');
  assert.equal(useFist({ sameScreen: true, elbow, target: { x: 1050, y: 750 }, random: () => 0 }), false, 'too close: it flies over');
  assert.equal(useFist({ sameScreen: true, elbow, target: far, random: () => FIST.chance - 0.01 }), true);
  assert.equal(useFist({ sameScreen: true, elbow, target: far, random: () => FIST.chance }), false);
  let hits = 0;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i += 1) if (useFist({ sameScreen: true, elbow, target: far, random })) hits += 1;
  assert.ok(hits > 650 && hits < 950, String(hits));
});

test('the flight: the hand lands on the button, quicker far away than slow, back a little slower', () => {
  const near = planFist({ from: { x: 500, y: 500 }, to: { x: 500, y: 300 } });
  assert.equal(near.kind, 'fist');
  assert.equal(near.angle, -90);
  assert.equal(near.outMs, FIST.minFlightMs, 'a short hop still takes a moment');
  const far = planFist({ from: { x: 1900, y: 1000 }, to: { x: 100, y: 40 } });
  assert.equal(far.outMs, FIST.maxFlightMs);
  const mid = planFist({ from: { x: 0, y: 0 }, to: { x: 920, y: 0 } });
  assert.equal(mid.outMs, 600, '(920 - 20) px at 1500 px/s');
  assert.equal(mid.backMs, Math.round(600 * FIST.backFactor));
  assert.equal(mid.hitAt, mid.outMs);
  assert.equal(mid.dockAt, mid.outMs + FIST.holdMs + mid.backMs);
  assert.ok(mid.dockAt + FIST.dockMs < 3500, 'over in a few seconds');
  assert.equal(planFist({ from: { x: 0, y: 0 }, to: { x: 900, y: 0 }, scale: 1.25 }).size, 1.25);
});

test('wiring: main fires it only for a press, presses when it hits, ends it on a drag, a lock or quitting', () => {
  const main = read('app', 'main.js');
  assert.ok(main.includes('if (fireFist(at, target, next, fist)) return undefined;'));
  const body = main.slice(main.indexOf('function fireFist(at, target, next, force)'), main.indexOf('function endFist(why'));
  for (const piece of [
    "const ew = effectWindow(display, 'Perchbot fist');",
    'const sameScreen = pointInside(display.bounds, at);',
    "ff.press = hands.press(target).then((done) => {",
    '}, plan.hitAt),',
    "ew.loadURL(`${EFFECTS_ORIGIN}/renderer/fist.html`);",
    'goReach(handPoint(at), () => pressNow(target, next));',
  ]) {
    assert.ok(body.includes(piece), piece);
  }
  for (const why of ['paused', 'quit', 'drag', 'renderer gone']) assert.ok(main.includes(`endFist('${why}')`), why);
  // A dev demo forces it; otherwise only a hands command (the user) starts it.
  assert.ok(main.includes("else if (name === 'fist' && isDev) runHands('newtab', { confirmed: true, fist: true });"));
  assert.ok(DEMOS.has('fist'));
});

test('the effect page: listen-only, strict CSP, no network, no HTML strings', () => {
  const html = read('app', 'renderer', 'fist.html');
  assert.ok(html.includes("default-src 'none'; script-src 'self'"));
  assert.ok(html.includes('<script src="fist.js" defer></script>'));
  const page = read('app', 'renderer', 'fist.js');
  for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'innerHTML', 'eval(', 'ipcRenderer']) assert.ok(!page.includes(word), word);
  assert.ok(page.includes("if (!plan || plan.kind !== 'fist' || stopped) return;"));
  const effects = read('app', 'rampage-preload.js');
  assert.ok(!/\.send\(|invoke\(/.test(effects), 'the effect page cannot send anything');
});

test('the pose on the page: aim, out (the forearm is gone), dock; ambient trips wait', () => {
  const css = read('characters', 'robot', 'robot.css');
  for (const piece of [
    '.buddy-character[data-fist] .rb-arm-front {',
    'transform: rotate(var(--fist-rot, -130deg));',
    ".buddy-character[data-fist='out'] .rb-forearm-front {",
    ".buddy-character[data-fist='dock']:not([data-rest]) .rb-forearm-front {",
  ]) {
    assert.ok(css.includes(piece), piece);
  }
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("if ('fist' in msg) applyFist(msg);"));
  assert.ok(page.includes("const phase = ['aim', 'out', 'dock'].includes(msg.fist) ? msg.fist : null;"));
  assert.ok(page.includes('enabled: calm && !fisting && AMBIENT_STATES.has(view.state),'));
});
