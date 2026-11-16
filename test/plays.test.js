'use strict';

/**
 * Three more ambient plays (lib/fun.js PLAYS, picked at random while idle like the
 * backflip): fog (it breathes on the glass and draws a heart in the fog), yoyo and
 * juggle (the last ball lands on its head: "Ouch!"). The plays that were there
 * before stay as they were.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAYS, STORY_PLAYS, GROUND_PLAYS, AmbientScheduler } = require('../app/renderer/lib/fun');
const { CUES } = require('../app/renderer/lib/sound');
const { DEMOS } = require('../app/validate');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const NEW = ['fog', 'yoyo', 'juggle'];

test('fog, yoyo and juggle: picked at random while idle; the plays from before are as they were', () => {
  assert.equal(PLAYS.fog, 6000);
  assert.equal(PLAYS.yoyo, 5000);
  assert.equal(PLAYS.juggle, 6000);
  for (const name of NEW) {
    assert.ok(!STORY_PLAYS.includes(name), `${name} is not a story play`);
    assert.ok(!GROUND_PLAYS.includes(name), `${name} also while it hovers`);
    assert.ok(DEMOS.has(name), `${name} can be demoed`);
  }
  const before = {
    stretch: 2600, look: 2400, peek: 2800, hum: 3200, jump: 1400, ball: 4200, antenna: 3200, flip: 1700,
    reboot: 3000, polish: 3600, sneeze: 2700, moonwalk: 3400, sit: 4200, read: 9000, bubbles: 7000, plane: 6000,
    coffee: 6000, where: 6000,
  };
  for (const [name, ms] of Object.entries(before)) assert.equal(PLAYS[name], ms, `${name} as it was`);
  assert.deepEqual(Object.keys(PLAYS).sort(), [...Object.keys(before), ...NEW].sort(), 'nothing else changed');
  assert.deepEqual([...STORY_PLAYS], ['read', 'bubbles', 'plane', 'coffee', 'where']);
  // A few idle hours: each of them turns up, among the others.
  const clock = new FakeClock();
  const picks = [];
  const a = new AmbientScheduler({ clock, random: Math.random, onPlay: (n) => n && picks.push(n), onTrip: () => {} });
  a.update({ enabled: true, trips: true });
  clock.tick(12 * 3600000);
  for (const name of NEW) assert.ok(picks.includes(name), `${name} picked at random`);
  // The simulator's tour of ambient life shows them too.
  const sim = read('scripts', 'simulate.js');
  for (const name of NEW) assert.ok(sim.includes(`await act(s, '${name}', `), `simulate: ${name}`);
});

test('the robot draws them: props hidden until their play, never catching the mouse; the fog stays on the glass', () => {
  const svg = read('characters', 'robot', 'robot.svg');
  const css = read('characters', 'robot', 'robot.css');
  for (const prop of ['rb-fog', 'rb-yoyo', 'rb-juggle']) assert.match(svg, new RegExp(`class="${prop}" data-nohit=""`), prop);
  assert.match(css, /\.rb-fog,\s*\.rb-yoyo,\s*\.rb-juggle \{\s*opacity: 0;/, 'hidden by default');
  // The yo-yo hangs from the far hand (it moves with the forearm).
  const far = svg.indexOf('<g class="rb-forearm rb-forearm-back">');
  assert.ok(far > 0 && svg.indexOf('class="rb-yoyo"') > far && svg.indexOf('class="rb-yoyo"') < svg.indexOf('<g class="rb-ball"'));
  // The fog is drawn last, outside the rig: the glass does not move with the robot.
  assert.ok(svg.indexOf('class="rb-fog"') > svg.indexOf('rb-bubble-6'));
  assert.match(svg, /<g class="rb-fog" data-nohit="">[\s\S]*<\/g>\s*<\/svg>\s*$/);
  assert.equal((svg.match(/id="rb-fog-grad"/g) || []).length, 1);
  assert.ok(svg.includes('fill="url(#rb-fog-grad)"'));
  // The heart is drawn stroke by stroke.
  assert.ok(svg.includes('class="rb-fog-heart" pathLength="100"'));
  assert.ok(css.includes('stroke-dasharray: 100;'));
  // Their own rules only: under their own data-play.
  for (const name of NEW) assert.ok(css.includes(`.buddy-character[data-play='${name}']`), name);
  // The near hand needs to be free for the fog and the balls: the laptop goes down as for the bubbles.
  assert.ok(css.includes(".buddy-character:is([data-play='fog'], [data-play='juggle']) .rb-laptop {\n  transform: translate(18px, 30px) scale(0.72);"));
});

test('yoyo: the string is as long as the drop', () => {
  const css = read('characters', 'robot', 'robot.css');
  const drop = Number(/@keyframes rb-yoyo-drop \{[\s\S]*?20% \{ transform: translateY\(([\d.]+)px\); \}/.exec(css)[1]);
  const scale = Number(/@keyframes rb-yoyo-string \{[\s\S]*?20% \{ transform: scaleY\(([\d.]+)\); \}/.exec(css)[1]);
  assert.ok(Math.abs(scale - (2.4 + drop) / 24) < 0.001, `${scale} for ${drop}px`);
  assert.ok(158 + drop + 5.6 <= 187, 'it stops above the floor');
});

test('juggle: "Ouch!" just when the last ball lands on its head', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("if (name === 'juggle') later('juggle-bonk', JUGGLE_BONK_MS, () => holder.dataset.play === 'juggle' && quip('ouch', 1100));"));
  const bonk = Number(/const JUGGLE_BONK_MS = (\d+);/.exec(page)[1]);
  const css = read('characters', 'robot', 'robot.css');
  // On its head: the ball at the top of the head, the head jolts from there.
  const at = (bonk / 5800) * 100;
  assert.ok(css.includes(`${at.toFixed(2)}% { transform: translate(-45px, -46px); opacity: 1; }`), `the ball on its head at ${at.toFixed(2)} %`);
  assert.ok(css.includes(`0%, ${at.toFixed(2)}% { transform: translateY(0) rotate(0deg); }`), 'the head jolts from then');
  // On its head: the ball starts on the near hand (133, 86); 45 to the left and 46 up is the top of the head.
  assert.ok(read('characters', 'robot', 'robot.svg').includes('class="rb-juggle-ball rb-juggle-3" cx="133" cy="86"'));
  assert.ok(CUES.play.juggle.some((c) => c.sound === 'bonk' && c.at === bonk), 'the bonk sound then');
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).quip.ouch, lang);
  assert.ok(read('app', 'main.js').includes("'ouch'"));
});
