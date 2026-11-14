'use strict';

/** By the clock (app/renderer/lib/fun.js daytime): morning coffee, a nightcap, "It's late...", Friday. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { daytime, DAYTIME, PLAYS, STORY, STORY_PLAYS } = require('../app/renderer/lib/fun');
const { validateEvent } = require('../app/validate');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
// Local time; 13 November 2026 is a Friday.
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);

test('the time of day: morning, night (after midnight: late), Friday afternoon', () => {
  assert.equal(at(13, 4, 59).getDay(), 5, 'a Friday');
  assert.equal(daytime(at(12, 4, 59)).morning, false);
  assert.equal(daytime(at(12, 5, 0)).morning, true);
  assert.equal(daytime(at(12, 10, 59)).morning, true);
  assert.equal(daytime(at(12, 11, 0)).morning, false);
  assert.equal(daytime(at(12, 22, 59)).night, false);
  assert.equal(daytime(at(12, 23, 0)).night, true);
  assert.equal(daytime(at(12, 23, 0)).late, false, 'before midnight it is not "late" yet');
  assert.equal(daytime(at(13, 0, 30)).late, true);
  assert.equal(daytime(at(13, 4, 59)).night, true);
  assert.equal(daytime(at(13, 5, 0)).night, false);
  assert.equal(daytime(at(13, 15, 59)).friday, false);
  assert.equal(daytime(at(13, 16, 0)).friday, true);
  assert.equal(daytime(at(13, 23, 30)).friday, true);
  assert.equal(daytime(at(14, 16, 0)).friday, false, 'Saturday');
  assert.equal(daytime(at(12, 16, 0)).friday, false, 'Thursday');
  // Once a day / once a night: a night belongs to the evening it began on.
  assert.equal(daytime(at(13, 9)).day, '2026-11-13');
  assert.equal(daytime(at(12, 23, 30)).nightOf, '2026-11-12');
  assert.equal(daytime(at(13, 2, 0)).nightOf, '2026-11-12', 'after midnight: still the same night');
  assert.equal(daytime(at(13, 23, 30)).nightOf, '2026-11-13');
  assert.equal(daytime(new Date(2026, 0, 1, 1, 0)).nightOf, '2025-12-31', 'across the year');
  assert.ok(DAYTIME.coffeeGapMs >= 30 * 60000, 'a cup now and then');
});

test('coffee: a play of the idle story only, mornings only, drawn and hidden until then', () => {
  assert.equal(PLAYS.coffee, 6000);
  assert.ok(STORY_PLAYS.includes('coffee'), 'never picked at random');
  assert.ok(STORY.beats.includes('coffee'));
  assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: 'coffee' }), 'a demo');
  const svg = read('characters', 'robot', 'robot.svg');
  for (const prop of ['rb-mug', 'rb-nightcap']) assert.match(svg, new RegExp(`class="${prop}" data-nohit=""`), prop);
  assert.ok(svg.includes('class="rb-coffee-steam"'));
  const css = read('characters', 'robot', 'robot.css');
  assert.match(css, /\.rb-mug \{\s*opacity: 0;/, 'the mug is hidden until its play');
  for (const rule of ["[data-play='coffee'] .rb-mug {", "[data-play='coffee'] .rb-arm-front {", "[data-play='coffee'] .rb-coffee-steam {", "[data-play='coffee'] .rb-laptop {"]) {
    assert.ok(css.includes(`.buddy-character${rule}`), rule);
  }
  // The page: mornings only, and not every idle spell; "Ahh, coffee!" after the last sip.
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("if (!daytime(now).morning || now.getTime() - coffeeAt < DAYTIME.coffeeGapMs) return 'skip';"));
  assert.ok(page.includes("if (name === 'coffee') later('coffee-ahh', COFFEE_AH_MS, () => holder.dataset.play === 'coffee' && quip('coffee', 1400));"));
  // The old story plays go the way they always went.
  assert.ok(page.includes("const STORY_PLAY_BEATS = new Set(['read', 'bubbles', 'plane']);"));
});

test('a nightcap for a nap late at night; "It\'s late" once a night; a Friday dance once a day', () => {
  const css = read('characters', 'robot', 'robot.css');
  assert.match(css, /\.rb-nightcap \{\s*opacity: 0;/, 'hidden by day and while awake');
  assert.ok(css.includes(".buddy-character[data-night][data-rest] .rb-nightcap {"), 'only napping at night');
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes("flag('night', daytime().night ? true : null);"));
  assert.ok(page.includes('updateNight();\n  setInterval(updateNight, 60000);'), 'kept up to date');
  // A prompt after midnight (calm to thinking), once a night.
  assert.ok(page.includes("if (next.state === 'thinking' && (CALM.has(previous.state) || previous.state === 'done')) noteLate();"));
  assert.ok(page.includes('if (!now.late || lateSaidFor === now.nightOf) return;'));
  // The done cheer: a dance on Friday afternoons (ambient life on), otherwise exactly as before.
  assert.ok(page.includes("flag('cheer', doneCheer());"));
  assert.ok(page.includes("if (!ambientOn() || !(now.friday || demo)) return ambientOn() ? pickCheer() : 'jump';"));
  assert.ok(page.includes("later('friday', FRIDAY_AT_MS, () => view.state === 'done' && quip('happyFriday', 1500));"), 'after the summary');
  // Its lines, in both languages, passed on by main.js; the demos.
  const main = read('app', 'main.js');
  for (const key of ['coffee', 'lateNight', 'happyFriday']) {
    assert.ok(main.includes(`'${key}'`), `main.js passes ${key}`);
    for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).quip[key], `${lang}: ${key}`);
  }
  for (const demo of ['nightcap', 'late', 'friday']) assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo }), demo);
});
