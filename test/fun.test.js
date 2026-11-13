'use strict';

/** Fun mode logic (app/renderer/lib/fun.js): whip clicks, idle plays, cheers, the duel, the bug fight. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TapMeter,
  tapMood,
  TAP_LIKES,
  TAP_PATIENCE,
  Temper,
  TEMPER_HOLD,
  TEMPER_MAX,
  AmbientScheduler,
  AMBIENT_GAP: G,
  WEIGHTS,
  PLAYS,
  TRIPS,
  pickCheer,
  CHEERS,
  Duel,
  DUEL_TIMINGS: D,
  BugFight,
  BUG_FIGHT_TIMINGS: B,
} = require('../app/renderer/lib/fun');
const { FakeClock } = require('./helpers/fake-clock');

/** A small seeded random (mulberry32), so the statistics below never flake. */
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

test('tapMood: liked taps make it happy, unwelcome ones annoy it and then it leaves', () => {
  const at = (r) => () => r;
  // Liked: the first tap a boop or already a giggle, then happy.
  assert.equal(tapMood({ likes: true, streak: 1, random: at(0.1) }), 'happy');
  assert.equal(tapMood({ likes: true, streak: 1, random: at(0.9) }), 'boop');
  for (const streak of [2, 3, 7]) assert.equal(tapMood({ likes: true, streak, random: at(0.99) }), 'happy');
  // Unwelcome while calm: boop, annoyed, then mostly off it goes.
  assert.equal(tapMood({ likes: false, streak: 1, random: at(0.1) }), 'boop');
  assert.equal(tapMood({ likes: false, streak: 2, random: at(0.1) }), 'annoyed');
  assert.equal(tapMood({ likes: false, streak: 3, random: at(0.5) }), 'flee');
  assert.equal(tapMood({ likes: false, streak: 3, random: at(0.9) }), 'annoyed', 'calm: sometimes it only stays cross');
  // Unwelcome at work: often cross at the first tap, always leaves at the third.
  assert.equal(tapMood({ likes: false, busy: true, streak: 1, random: at(0.3) }), 'annoyed');
  assert.equal(tapMood({ likes: false, busy: true, streak: 1, random: at(0.9) }), 'boop');
  assert.equal(tapMood({ likes: false, busy: true, streak: 3, random: at(0.99) }), 'flee');
});

test('TapMeter: one mood per streak, rolled again after a pause or after leaving', () => {
  const clock = new FakeClock();
  let r = 0.75;
  const meter = new TapMeter({ clock: { now: () => clock.now }, random: () => r });
  const streak = (n, busy) =>
    Array.from({ length: n }, () => {
      const mood = meter.tap(busy);
      clock.tick(400);
      return mood;
    });
  // 0.75 < 0.8: idle, it likes this streak.
  assert.deepEqual(streak(4, false), ['boop', 'happy', 'happy', 'happy']);
  clock.tick(1500);
  // The same 0.75 at work (not below 0.15): unwelcome, and the third tap sends it off.
  assert.deepEqual(streak(4, true), ['boop', 'annoyed', 'flee', 'boop'], 'counting starts over after leaving');
  clock.tick(1500);
  r = 0.1;
  assert.deepEqual(streak(2, true), ['happy', 'happy'], 'sometimes it likes it even at work');
  clock.tick(1101 + 1500);
  r = 0.95;
  assert.deepEqual(streak(1, false), ['boop'], 'too slow: a new streak');
  assert.equal(meter.tap(false), 'annoyed', 'a quick second tap of an unwelcome streak');
  meter.reset();
  assert.equal(meter.tap(false), 'boop', 'reset starts over');
});

test('TapMeter: idle it mostly loves being tapped, at work it mostly does not', () => {
  const share = (busy) => {
    const clock = new FakeClock();
    const meter = new TapMeter({ clock: { now: () => clock.now }, random: seeded(busy ? 7 : 3) });
    const count = { happy: 0, boop: 0, annoyed: 0, flee: 0 };
    for (let s = 0; s < 1500; s += 1) {
      for (let i = 0; i < 3; i += 1) {
        count[meter.tap(busy)] += 1;
        clock.tick(300);
      }
      clock.tick(5000);
    }
    const total = 1500 * 3;
    return Object.fromEntries(Object.entries(count).map(([k, v]) => [k, v / total]));
  };
  const idle = share(false);
  assert.ok(idle.happy > 0.55, `idle happy ${idle.happy}`);
  assert.ok(idle.annoyed + idle.flee < 0.15, `idle cross ${idle.annoyed + idle.flee}`);
  assert.ok(idle.flee > 0, 'still, now and then it has had enough');
  const busy = share(true);
  assert.ok(busy.annoyed + busy.flee > 0.6, `busy cross ${busy.annoyed + busy.flee}`);
  assert.ok(busy.happy < 0.15, `busy happy ${busy.happy}`);
  assert.ok(busy.happy > 0, 'still, now and then it likes it');
  assert.ok(TAP_LIKES.calm > TAP_LIKES.busy);
});

test('TapMeter: while it is still hot it likes nothing and a tap is never just a boop', () => {
  const clock = new FakeClock();
  // 0.01: it would love every streak.
  const meter = new TapMeter({ clock: { now: () => clock.now }, random: () => 0.01 });
  assert.equal(meter.tap(false, true), 'annoyed', 'a new streak while hot: cross at once');
  clock.tick(300);
  assert.equal(meter.tap(false, true), 'annoyed');
  clock.tick(300);
  assert.equal(meter.tap(false, true), 'flee', 'third tap: off it goes');
  clock.tick(5000);
  assert.equal(meter.tap(false, false), 'happy', 'cooled down: back to its own mood');
});

test('TapMeter: even a tap it loves gets too much after TAP_PATIENCE taps in a row', () => {
  const clock = new FakeClock();
  const meter = new TapMeter({ clock: { now: () => clock.now }, random: () => 0.01 });
  const moods = [];
  for (let i = 0; i < TAP_PATIENCE + 3; i += 1) {
    moods.push(meter.tap(false));
    if (i === TAP_PATIENCE) assert.equal(meter.fedUp, true, 'the tap where it has had enough');
    else assert.equal(meter.fedUp, false);
    clock.tick(300);
  }
  assert.deepEqual(moods.slice(0, TAP_PATIENCE), Array(TAP_PATIENCE).fill('happy'));
  assert.deepEqual(moods.slice(TAP_PATIENCE), ['annoyed', 'annoyed', 'flee'], 'then the unwelcome ladder');
  // The usual streaks (a few taps) never get there.
  assert.ok(TAP_PATIENCE >= 10);
});

test('Temper: unwelcome taps heat it up, it cools one level at a time, and outlasts a flight', () => {
  const clock = new FakeClock();
  const temper = new Temper({ clock: { now: () => clock.now } });
  assert.equal(temper.level, 0);
  assert.equal(temper.coolsInMs(), 0);
  assert.deepEqual(temper.flare('annoyed'), { level: 1, erupt: false });
  assert.equal(temper.hot, false, 'just cross: taps may still be welcome later');
  assert.equal(temper.coolsInMs(), TEMPER_HOLD[1]);
  clock.tick(TEMPER_HOLD[1]);
  assert.equal(temper.level, 0, 'the plain cross mark lasts as long as it always did');

  temper.flare('annoyed');
  clock.tick(300);
  assert.deepEqual(temper.flare('flee'), { level: 2, erupt: false }, 'off it goes, fuming');
  assert.equal(temper.hot, true);
  clock.tick(2000); // caught it after its flight
  assert.equal(temper.hot, true, 'still fuming');
  assert.deepEqual(temper.flare('annoyed'), { level: 3, erupt: false }, 'blazing');
  assert.deepEqual(temper.flare('annoyed'), { level: TEMPER_MAX, erupt: false }, 'never above the top');
  assert.deepEqual(temper.flare('flee'), { level: TEMPER_MAX, erupt: true }, 'leaving while blazing: an eruption');

  // Cooling: 3 holds, then 2, then 1, then calm.
  assert.equal(temper.coolsInMs(), TEMPER_HOLD[3]);
  clock.tick(TEMPER_HOLD[3]);
  assert.equal(temper.level, 2);
  assert.equal(temper.coolsInMs(), TEMPER_HOLD[2]);
  clock.tick(TEMPER_HOLD[2] + TEMPER_HOLD[1] - 1);
  assert.equal(temper.level, 1);
  clock.tick(1);
  assert.equal(temper.level, 0);
  // Several levels at once after a long pause, and reset.
  temper.flare('annoyed');
  temper.flare('annoyed');
  clock.tick(60000);
  assert.equal(temper.level, 0);
  temper.flare('annoyed');
  temper.flare('annoyed');
  temper.reset();
  assert.equal(temper.level, 0);
  assert.equal(temper.hot, false);
});

function ambient(random = Math.random) {
  const clock = new FakeClock();
  const log = [];
  const a = new AmbientScheduler({
    clock,
    random,
    onPlay: (name) => log.push(['play', name, clock.now]),
    onTrip: (kind) => log.push(['trip', kind, clock.now]),
  });
  return { clock, a, log };
}

test('every ambient play is drawn by the robot, can be demoed, and its CSS ends before the play does', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { validateEvent } = require('../app/validate');
  const css = fs.readFileSync(path.join(__dirname, '..', 'characters', 'robot', 'robot.css'), 'utf8');
  for (const [name, ms] of Object.entries(PLAYS)) {
    const rules = css.match(new RegExp(`\\[data-play='${name}'\\][^{]*\\{[^}]*\\}`, 'g')) || [];
    assert.ok(rules.length > 0, `robot.css animates the play "${name}"`);
    // The longest single run of an animation of this play (duration + delay, times its count).
    let longest = 0;
    for (const rule of rules) {
      const m = rule.match(/animation:\s*[\w-]+\s+([\d.]+)s(?:\s+[\w-]+(?:\([^)]*\))?)?(?:\s+([\d.]+)s)?(?:\s+(\d+))?/);
      if (m) longest = Math.max(longest, (Number(m[1]) * Number(m[3] || 1) + Number(m[2] || 0)) * 1000);
    }
    assert.ok(longest > 0 && longest <= ms, `${name}: animations ${longest} ms within the play's ${ms} ms`);
    assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: name }), `${name} is a valid demo`);
  }
  // The props of the new plays are in the artwork and hidden by default.
  const svg = fs.readFileSync(path.join(__dirname, '..', 'characters', 'robot', 'robot.svg'), 'utf8');
  for (const prop of ['rb-cloth', 'rb-shine', 'rb-puff', 'rb-power']) {
    assert.match(svg, new RegExp(`class="${prop}" data-nohit=""`), prop);
    assert.match(css, new RegExp(`\\.${prop},?\\s`), `${prop} hidden by default`);
  }
});

test('the anger ladder is drawn by the robot, hidden until it is that angry, with its lines and a demo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { validateEvent } = require('../app/validate');
  const root = path.join(__dirname, '..');
  const svg = fs.readFileSync(path.join(root, 'characters', 'robot', 'robot.svg'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'characters', 'robot', 'robot.css'), 'utf8');
  for (const prop of ['rb-fume', 'rb-steam', 'rb-blaze']) {
    assert.match(svg, new RegExp(`class="${prop}" data-nohit=""`), `${prop} never catches the mouse`);
  }
  assert.match(css, /\.rb-fume,\s*\.rb-steam,\s*\.rb-blaze\s*\{\s*opacity: 0;/, 'hidden by default');
  // Level 1 keeps the old look; 2 and 3 only add to it.
  assert.match(css, /\.buddy-character\[data-annoyed\] \.rb-anger \{/);
  for (const level of ['2', '3']) assert.ok(css.includes(`[data-annoyed='${level}']`), `level ${level} styled`);
  assert.ok(css.includes('[data-erupt] .rb-blaze'), 'the eruption');
  assert.equal(TEMPER_MAX, 3);
  // Its lines, in every language, passed on by the main process.
  const main = fs.readFileSync(path.join(root, 'app', 'main.js'), 'utf8');
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, 'app', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['fedUp', 'fuming', 'blazing', 'erupt']) {
      assert.ok(strings.quip[key], `${lang}: quip ${key}`);
      assert.ok(main.includes(`'${key}'`), `main.js passes the quip ${key}`);
    }
  }
  assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: 'rage' }), 'rage is a valid demo');
});

test('ambient life: one behaviour every 15-60 s, never the same twice in a row', () => {
  let r = 0;
  const { clock, a, log } = ambient(() => ((r = (r + 0.377) % 1), r));
  clock.tick(120000);
  assert.deepEqual(log, [], 'nothing until allowed');
  a.update({ enabled: true, trips: true });
  clock.tick(3600000);
  const starts = log.filter(([, name]) => name !== null);
  assert.ok(starts.length > 40, `${starts.length} behaviours in an hour`);
  const names = starts.map(([kind, name]) => (kind === 'trip' ? Object.keys(TRIPS).find((k) => TRIPS[k] === name) : name));
  for (let i = 1; i < names.length; i += 1) assert.notEqual(names[i], names[i - 1], `repeat at ${i}`);
  assert.deepEqual([...new Set(names)].sort(), [...Object.keys(PLAYS), ...Object.keys(TRIPS)].sort(), 'every behaviour turns up');
  // Gaps between behaviours: at least 15 s after the previous one ended (or since enabling), at most 60 s.
  let end = 120000;
  for (const [kind, name, at] of log) {
    if (name === null) {
      end = at;
      continue;
    }
    assert.ok(at - end >= G.minMs && at - end <= G.maxMs + 1, `gap ${at - end}`);
    if (kind === 'trip') end = at;
  }
});

test('ambient life: trips only when allowed, never home by itself (it keeps wandering); disabling ends a play at once', () => {
  const { clock, a, log } = ambient(() => 0.999);
  a.update({ enabled: true, trips: false });
  clock.tick(3600000);
  assert.ok(log.every(([kind]) => kind === 'play'), 'no trips while helpers or the cat are around');
  log.length = 0;
  a.update({ enabled: true, trips: true });
  clock.tick(3600000);
  assert.ok(log.some(([kind]) => kind === 'trip'), 'it gets around');
  assert.ok(!log.some(([, name]) => name === 'home'), 'and never goes home by itself');
  assert.ok(!('home' in TRIPS));
  a.update({ enabled: false });
  a.run('stretch');
  a.update({ enabled: true });
  a.run('ball');
  assert.deepEqual(log.at(-1).slice(0, 2), ['play', 'ball']);
  a.update({ enabled: false });
  assert.deepEqual(log.at(-1).slice(0, 2), ['play', null], 'ended at once');
  const count = log.length;
  clock.tick(3600000);
  assert.equal(log.length, count, 'nothing while disabled');
});

test('ambient life and resting: nothing while it rests, a fresh countdown when it wakes', () => {
  const { clock, a, log } = ambient(() => 0); // always the shortest wait
  a.update({ enabled: true });
  clock.tick(G.minMs - 5000);
  // The page disables it the moment the character rests (a quiet minute)...
  a.update({ enabled: false });
  clock.tick(10 * 60 * 1000);
  assert.deepEqual(log, [], 'no behaviour during a long rest');
  // ...and enables it again when an event or the pointer wakes it: the wait starts over.
  a.update({ enabled: true });
  clock.tick(G.minMs - 1);
  assert.deepEqual(log, [], 'not after the 5 s that were left before resting');
  clock.tick(1);
  assert.equal(log.length, 1);
  // Further updates while awake do not restart the countdown.
  a.update({ enabled: true });
  a.update({ enabled: true, trips: true });
  clock.tick(G.minMs + PLAYS[log[0][1]]);
  assert.ok(log.length >= 3, 'the next one follows on schedule');
});

test('ambient life: it likes to get around, about half of what it does by itself is a trip', () => {
  const playWeight = Object.keys(PLAYS).length;
  const atHome = WEIGHTS.walk + WEIGHTS.fly + WEIGHTS.inspect;
  const share = atHome / (atHome + playWeight);
  assert.ok(share > 0.4 && share < 0.6, `trips at home: ${Math.round(share * 100)} %`);
  assert.ok(G.maxMs <= 60000, 'something happens at least once a minute');
  const { clock, a, log } = ambient(seeded(11));
  a.update({ enabled: true, trips: true });
  clock.tick(6 * 3600000);
  const trips = log.filter(([kind]) => kind === 'trip').length;
  const plays = log.filter(([kind, name]) => kind === 'play' && name !== null).length;
  assert.ok(trips / (trips + plays) > 0.35, `${trips} trips, ${plays} plays`);
});

test('cheers: the classic jump about half of the time, the others otherwise', () => {
  assert.equal(pickCheer(() => 0.1), 'jump');
  assert.ok(CHEERS.slice(1).includes(pickCheer(() => 0.7)));
  const seen = new Set();
  let r = 0;
  for (let i = 0; i < 40; i += 1) seen.add(pickCheer(() => ((r = (r + 0.137) % 1), r)));
  assert.deepEqual([...seen].sort(), [...CHEERS].sort(), 'every cheer shows up');
});

function duel(random = () => 0) {
  const clock = new FakeClock();
  const phases = [];
  let info = null;
  const d = new Duel({ clock, random, onPhase: (p, i) => { phases.push(p); info = i; } });
  return { clock, d, phases, info: () => info };
}

test('duel: draw, guard, windup, strike; an unanswered strike costs the player a heart', () => {
  const { clock, d, phases, info } = duel();
  d.start();
  assert.equal(d.phase, 'draw');
  clock.tick(D.drawMs);
  assert.equal(d.phase, 'guard');
  clock.tick(D.guardMinMs);
  assert.equal(d.phase, 'windup');
  clock.tick(D.windupMs + D.strikeMs);
  assert.equal(d.phase, 'hit');
  assert.equal(info().player, D.hearts - 1);
  clock.tick(D.hitMs);
  assert.equal(d.phase, 'recover');
  assert.deepEqual(phases.slice(0, 6), ['draw', 'guard', 'windup', 'strike', 'hit', 'recover']);
});

test('duel: parry the windup, then hit it while it is stunned; three hits win', () => {
  const { clock, d, phases, info } = duel();
  d.start();
  clock.tick(D.drawMs + D.guardMinMs);
  for (let round = 0; round < D.hearts; round += 1) {
    assert.equal(d.phase, 'windup', `round ${round}`);
    assert.equal(d.click(), 'parry');
    assert.equal(d.phase, 'stun');
    assert.equal(d.click(), 'hit');
    if (round < D.hearts - 1) {
      assert.equal(d.phase, 'hurt');
      clock.tick(D.hurtMs + D.guardMinMs);
    }
  }
  assert.equal(d.phase, 'lose', 'the robot lost');
  assert.equal(info().robot, 0);
  assert.equal(info().player, D.hearts, 'flawless');
  clock.tick(D.endMs);
  assert.equal(d.active, false);
  assert.equal(phases.at(-1), 'end');
});

test('duel: clicking while it guards is blocked and it strikes back; losing all hearts ends it', () => {
  const { clock, d, info } = duel();
  d.start();
  clock.tick(D.drawMs);
  assert.equal(d.click(), 'blocked');
  assert.equal(d.phase, 'block');
  clock.tick(D.blockMs);
  assert.equal(d.phase, 'windup', 'a quick counter');
  for (let i = 0; i < D.hearts; i += 1) {
    while (d.phase !== 'hit' && d.phase !== 'win') clock.tick(10);
    if (d.phase === 'win') break;
    clock.tick(D.hitMs + D.recoverMs);
  }
  assert.equal(d.phase, 'win', 'the robot won');
  assert.equal(info().player, 0);
  assert.equal(d.click(), 'none', 'clicks after the end do nothing');
});

test('duel: stop() ends it at once, and a duel never runs forever', () => {
  const { clock, d, phases } = duel();
  d.start();
  clock.tick(D.drawMs + 100);
  d.stop();
  assert.equal(d.active, false);
  assert.equal(phases.at(-1), 'end');
  d.stop(); // harmless
  // The 'end' callback already sees an inactive duel (the page hides the arena and
  // the duel's Play button there, and ambient life may run again).
  let activeAtEnd = null;
  const seen = new Duel({ clock, onPhase: (phase) => phase === 'end' && (activeAtEnd = seen.active) });
  seen.start();
  seen.stop();
  assert.equal(activeAtEnd, false);
  d.start();
  // Nobody plays: hits until the robot wins, well before the time limit.
  clock.tick(D.maxMs + D.endMs + 10);
  assert.equal(d.active, false);
});

function bugFight() {
  const clock = new FakeClock();
  const phases = [];
  const strikes = [];
  const f = new BugFight({ clock, random: () => 0, onPhase: (p) => phases.push(p), onStrike: (final) => strikes.push(final) });
  return { clock, f, phases, strikes };
}

test('bug fight: guard, windup, strike, recover, round and round; every strike lands on the bug', () => {
  const { clock, f, phases, strikes } = bugFight();
  f.start();
  assert.equal(f.phase, 'guard');
  f.start(); // already running: no restart
  assert.deepEqual(phases, ['guard']);
  clock.tick(B.guardMinMs);
  assert.equal(f.phase, 'windup');
  clock.tick(B.windupMs);
  assert.equal(f.phase, 'strike');
  assert.deepEqual(strikes, [false]);
  clock.tick(B.strikeMs + B.recoverMs);
  assert.equal(f.phase, 'guard');
  clock.tick(B.guardMinMs + B.windupMs + B.strikeMs + B.recoverMs);
  assert.deepEqual(phases, ['guard', 'windup', 'strike', 'recover', 'guard', 'windup', 'strike', 'recover', 'guard']);
  assert.deepEqual(strikes, [false, false]);
  assert.equal(f.finishing, false);
  // Claude Code needs the character (or it rests): stop at once.
  f.stop();
  assert.equal(f.active, false);
  assert.equal(phases.at(-1), 'end');
  f.stop(); // harmless
  assert.equal(phases.filter((p) => p === 'end').length, 1);
});

test('bug fight: finish() from guard winds up quickly, strikes the final blow, cheers and ends', () => {
  const { clock, f, phases, strikes } = bugFight();
  f.start();
  clock.tick(100);
  f.finish();
  assert.equal(f.phase, 'windup');
  assert.equal(f.finishing, true);
  f.finish(); // the fix landing twice changes nothing
  clock.tick(B.finishWindupMs);
  assert.equal(f.phase, 'strike');
  assert.deepEqual(strikes, [true], 'the finishing blow, no ordinary strike before it');
  clock.tick(B.strikeMs);
  assert.equal(f.phase, 'win');
  clock.tick(B.winMs);
  assert.equal(f.active, false);
  assert.equal(f.finishing, false);
  assert.deepEqual(phases, ['guard', 'windup', 'strike', 'win', 'end']);
});

test('bug fight: a windup already on its way becomes the final blow; finish() also works from rest', () => {
  const { clock, f, phases, strikes } = bugFight();
  f.start();
  clock.tick(B.guardMinMs + 100);
  assert.equal(f.phase, 'windup');
  f.finish();
  clock.tick(B.windupMs - 100);
  assert.equal(f.phase, 'strike');
  assert.deepEqual(strikes, [true]);
  clock.tick(B.strikeMs + B.winMs);
  assert.deepEqual(phases, ['guard', 'windup', 'strike', 'win', 'end']);
  // Not fighting when the fix lands (the page only does this with motion): straight to the final blow.
  phases.length = 0;
  strikes.length = 0;
  f.finish();
  assert.equal(f.phase, 'windup');
  clock.tick(B.finishWindupMs + B.strikeMs + B.winMs);
  assert.deepEqual(phases, ['windup', 'strike', 'win', 'end']);
  assert.deepEqual(strikes, [true]);
  // After that a new bug starts a fresh fight, not a finished one.
  f.start();
  assert.equal(f.finishing, false);
  clock.tick(B.guardMinMs + B.windupMs);
  assert.deepEqual(strikes, [true, false]);
});

test('bug fight: some strikes connect, the bug dodges the others; the finishing blow always connects', () => {
  const clock = new FakeClock();
  const hits = [];
  // random() is asked for the guard time, then for the strike: alternate a hit (0.1) and a miss (0.9).
  const rolls = [0, 0.1, 0, 0.9, 0, 0.1, 0, 0.9];
  const f = new BugFight({ clock, random: () => rolls.shift() ?? 0.99, onStrike: (final, hit) => hits.push([final, hit]) });
  f.start();
  const round = B.guardMinMs + B.windupMs + B.strikeMs + B.recoverMs;
  clock.tick(round * 4);
  assert.deepEqual(hits, [[false, true], [false, false], [false, true], [false, false]]);
  // Even when the dice say miss, the fix gets its hit.
  f.finish();
  clock.tick(B.finishWindupMs);
  assert.deepEqual(hits.at(-1), [true, true]);
  assert.ok(B.hitChance > 0.3 && B.hitChance < 0.9, 'mostly hits, but not every time');
});

test('ambient life: it sits down only on the ground, and from the top edge its next move is a trip away', () => {
  const { GROUND_PLAYS } = require('../app/renderer/lib/fun');
  assert.deepEqual(GROUND_PLAYS, ['sit']);
  const run = (opts) => {
    const { clock, a, log } = ambient(seeded(21));
    a.update({ enabled: true, ...opts });
    clock.tick(6 * 3600000);
    return log.filter(([, name]) => name !== null);
  };
  assert.ok(run({ trips: true }).some(([, name]) => name === 'sit'), 'on the ground it sits now and then');
  assert.ok(!run({ trips: true, grounded: false }).some(([, name]) => name === 'sit'), 'never in the air');
  const hanging = run({ trips: true, hanging: true });
  assert.ok(hanging.length > 0 && hanging.every(([kind]) => kind === 'trip'), 'hanging: only trips');
  // Hanging with trips not allowed (helpers came): nothing at all, and no busy loop either.
  assert.deepEqual(run({ trips: false, hanging: true }), []);
  // The new trips are in the mix.
  assert.ok(TRIPS.cruise === 'cruise' && TRIPS.hang === 'hang');
  assert.ok(WEIGHTS.cruise > 0 && WEIGHTS.hang > 0);
});

test('the robot draws hanging and the loop-the-loop, and they can be demoed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { validateEvent } = require('../app/validate');
  const css = fs.readFileSync(path.join(__dirname, '..', 'characters', 'robot', 'robot.css'), 'utf8');
  for (const rule of ['[data-hang] .rb-figure', '[data-hang] .rb-arm-back', '[data-hang]:not([data-rest]) .rb-react', '[data-loop] .rb-figure']) {
    assert.ok(css.includes(rule), rule);
  }
  assert.match(css, /animation: rb-loop var\(--loop-ms, \d+ms\) ease-in-out var\(--loop-delay, 0ms\)/);
  for (const demo of ['sit', 'cruise', 'hang', 'loop']) {
    assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo }), `${demo} is a valid demo`);
  }
});

test('the page may ask for every trip it plans: preload and main allow the same fun actions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'app', file), 'utf8');
  const actions = (text) => {
    const m = text.match(/const FUN_ACTIONS = new Set\(\[([^\]]*)\]\)/);
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  };
  const preload = actions(read('preload.js'));
  assert.deepEqual(preload, actions(read('main.js')));
  for (const kind of Object.values(TRIPS)) assert.ok(preload.includes(kind), `${kind} can be asked for`);
  assert.ok(preload.includes('loop'));
});


test('at work it shows what it works on: a book for a file, a magnifier for a search, a globe for the web', () => {
  const { taskFor, bubbleForTool } = require('../app/tools');
  const task = (tool, detail) => taskFor(bubbleForTool(tool, detail).key);
  assert.equal(task('Read', 'a.js'), 'book');
  assert.equal(task('Read'), 'book');
  assert.equal(task('Grep', 'TODO'), 'search');
  assert.equal(task('Glob', '*.js'), 'search');
  assert.equal(task('WebSearch'), 'web');
  assert.equal(task('WebFetch', 'example.com'), 'web');
  assert.equal(task('WebFetch'), 'web');
  for (const tool of ['Edit', 'Write', 'Bash', 'PowerShell', 'Task', 'Skill', 'mcp__x__y', 'Other']) {
    assert.equal(task(tool, 'x'), null, `${tool}: the plain look`);
  }
  assert.equal(taskFor(undefined), null);
  assert.equal(taskFor('constructor'), null);
  // The robot draws them, hidden until then, and never catches the mouse with them.
  const fs = require('node:fs');
  const path = require('node:path');
  const svg = fs.readFileSync(path.join(__dirname, '..', 'characters', 'robot', 'robot.svg'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'characters', 'robot', 'robot.css'), 'utf8');
  for (const prop of ['rb-signal', 'rb-bulb']) assert.match(svg, new RegExp(`class="${prop}" data-nohit=""`), prop);
  for (const prop of ['rb-find', 'rb-globe']) assert.ok(svg.includes(`class="${prop}"`), prop);
  assert.match(css, /\.rb-find,\s*\.rb-globe,\s*\.rb-signal,\s*\.rb-bulb\s*\{\s*opacity: 0;/);
  for (const rule of ["[data-state='reading'][data-task='book'] .rb-book", "[data-state='reading'][data-task='search'] .rb-find", "[data-state='working'][data-task='web']", "[data-think='bulb'] .rb-bulb", "[data-think='pace']"]) {
    assert.ok(css.includes(rule), rule);
  }
});

test('thinking: the pose changes, never twice the same in a row; no pacing in the air or at a bug', () => {
  const { pickThinkPose, THINK_POSES, THINK_MS } = require('../app/renderer/lib/fun');
  assert.deepEqual([...THINK_POSES], ['chin', 'bulb', 'pace']);
  assert.ok(THINK_MS >= 4000 && THINK_MS <= 12000);
  const random = seeded(5);
  const seen = new Set();
  let pose = null;
  for (let i = 0; i < 200; i += 1) {
    const next = pickThinkPose(pose, {}, random);
    assert.notEqual(next, pose);
    seen.add(next);
    pose = next;
  }
  assert.deepEqual([...seen].sort(), ['bulb', 'chin', 'pace']);
  for (let i = 0; i < 50; i += 1) {
    assert.notEqual(pickThinkPose('chin', { airborne: true }, random), 'pace');
    assert.notEqual(pickThinkPose('bulb', { hunting: true }, random), 'pace');
  }
  assert.equal(pickThinkPose('chin', { airborne: true }, () => 0.99), 'bulb');
});
