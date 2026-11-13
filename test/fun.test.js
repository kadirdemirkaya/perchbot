'use strict';

/** Fun mode logic (app/renderer/lib/fun.js): whip clicks, idle plays, cheers, the duel, the bug fight. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TapMeter,
  tapMood,
  TAP_LIKES,
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
