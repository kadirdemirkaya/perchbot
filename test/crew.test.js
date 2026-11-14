'use strict';

/** Sub-agent choreography (app/renderer/lib/crew.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CrewDirector, crewLabel, CREW_TIMINGS: T } = require('../app/renderer/lib/crew');
const { FakeClock } = require('./helpers/fake-clock');

const GEO = { report: 6, spots: [112, 216, 320, 424], capacity: 4 };
const agent = (id, status = 'active', extra = {}) => ({ id, type: 'Explore', tool: null, file: null, skill: null, status, ...extra });
const ID = (n) => `a${n}`.padEnd(10, '0');

function setup({ random = () => 0.5, geo = GEO, tints = 5 } = {}) {
  const clock = new FakeClock();
  const log = { removed: [], released: [], cues: [], overflow: [] };
  const views = new Map();
  const d = new CrewDirector({
    clock,
    random,
    tints,
    onUpdate: (m) => views.set(m.id, m),
    onRemove: (id) => {
      views.delete(id);
      log.removed.push(id);
    },
    onRelease: (id) => log.released.push(id),
    onCue: (name, data) => log.cues.push([name, data]),
    onOverflow: (n) => log.overflow.push(n),
  });
  d.setGeometry(geo);
  return { clock, d, log, views, phase: (id) => views.get(id) && views.get(id).phase };
}

test('a new agent drops in at the report point, gets briefed, walks to its spot and works', () => {
  const { clock, d, log, views, phase } = setup();
  d.setAgents([agent(ID(1))]);
  assert.equal(phase(ID(1)), 'arrive');
  assert.equal(views.get(ID(1)).off, GEO.report);
  assert.equal(views.get(ID(1)).fly, true, 'drops in with its thrusters');
  clock.tick(T.arriveMs);
  assert.equal(phase(ID(1)), 'brief');
  assert.deepEqual(log.cues[0], ['brief', { id: ID(1) }], 'the main character explains the task');
  clock.tick(T.briefMs);
  assert.equal(phase(ID(1)), 'walk');
  assert.equal(views.get(ID(1)).off, GEO.spots[0]);
  assert.equal(views.get(ID(1)).face, 'out', 'walks away from the main character');
  clock.tick(views.get(ID(1)).walkMs);
  assert.equal(phase(ID(1)), 'work');
  assert.equal(views.get(ID(1)).face, 'in');
});

test('done: waits for the report point, reports with a note, flies off, then is released', () => {
  const { clock, d, log, views, phase } = setup();
  d.setAgents([agent(ID(1)), agent(ID(2))]);
  clock.tick(10000);
  assert.equal(phase(ID(1)), 'work');
  assert.equal(phase(ID(2)), 'work', 'the second one skipped the briefing (report point was busy) and dropped in at its spot');
  assert.equal(views.get(ID(2)).off, GEO.spots[1]);

  d.setAgents([agent(ID(1), 'done'), agent(ID(2), 'done')]);
  assert.equal(phase(ID(1)), 'done');
  clock.tick(T.doneMs);
  assert.equal(phase(ID(1)), 'walk', 'first one walks to the report point');
  assert.equal(phase(ID(2)), 'done', 'second one waits its turn');
  assert.equal(views.get(ID(2)).fly, false);
  clock.tick(views.get(ID(1)).walkMs);
  assert.equal(phase(ID(1)), 'report');
  assert.ok(log.cues.some(([n, x]) => n === 'receive' && x.id === ID(1)));
  clock.tick(T.handoffAtMs);
  assert.ok(log.cues.some(([n, x]) => n === 'handoff' && x.from === ID(1) && x.to === null), 'note goes to the main character');
  clock.tick(T.reportMs - T.handoffAtMs);
  assert.equal(phase(ID(1)), 'leave');
  assert.equal(phase(ID(2)), 'walk', 'next in line goes to report');
  assert.equal(views.get(ID(2)).fly, false, 'nobody in the way: on foot');
  clock.tick(T.leaveMs);
  assert.deepEqual(log.released, [ID(1)]);
  assert.ok(!views.has(ID(1)));
  // The app still lists it until it processes the release: no second scene.
  d.setAgents([agent(ID(1), 'done'), agent(ID(2), 'done')]);
  assert.ok(!views.has(ID(1)));
  assert.deepEqual(log.released, [ID(1)]);
});

test('a mini that walks past other minis flies over them; a lone walk is on foot', () => {
  const { clock, d, views } = setup();
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3))]);
  clock.tick(10000);
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3), 'done')]);
  clock.tick(T.doneMs);
  assert.equal(views.get(ID(3)).phase, 'walk');
  assert.equal(views.get(ID(3)).fly, true, 'spots 0 and 1 are in the way');
});

test('when a neighbour leaves, the others slide towards the main character', () => {
  const { clock, d, views } = setup();
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3))]);
  clock.tick(10000);
  d.setAgents([agent(ID(2)), agent(ID(3))]); // the app forgot agent 1
  assert.equal(views.get(ID(2)).phase, 'walk');
  assert.equal(views.get(ID(2)).off, GEO.spots[0]);
  assert.equal(views.get(ID(3)).off, GEO.spots[1]);
  clock.tick(2000);
  assert.equal(views.get(ID(2)).phase, 'work');
});

test('more agents than spots: "+N", and an agent that finished while waiting is never shown', () => {
  const { clock, d, log, views } = setup({ geo: { ...GEO, capacity: 2, spots: GEO.spots.slice(0, 2) } });
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3)), agent(ID(4))]);
  assert.equal(views.size, 2);
  assert.deepEqual(log.overflow, [2]);
  clock.tick(10000);
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3), 'done'), agent(ID(4))]);
  assert.deepEqual(log.released, [ID(3)], 'finished behind the "+N": released without a scene');
  assert.deepEqual(log.overflow, [2, 1]);
  assert.ok(!views.has(ID(3)));
});

test('a "gone" agent (session ended) leaves quietly, without reporting', () => {
  const { clock, d, log, phase } = setup();
  d.setAgents([agent(ID(1))]);
  clock.tick(10000);
  d.setAgents([agent(ID(1), 'gone')]);
  assert.equal(phase(ID(1)), 'leave');
  clock.tick(T.goneMs);
  assert.deepEqual(log.released, [ID(1)]);
  assert.ok(!log.cues.some(([n]) => n === 'receive'));
});

test('an agent that finishes during its briefing reports right after it', () => {
  const { clock, d, phase } = setup();
  d.setAgents([agent(ID(1))]);
  clock.tick(T.arriveMs + 100);
  assert.equal(phase(ID(1)), 'brief');
  d.setAgents([agent(ID(1), 'done')]);
  assert.equal(phase(ID(1)), 'brief', 'the briefing is not cut short');
  clock.tick(T.briefMs);
  assert.equal(phase(ID(1)), 'done');
  clock.tick(T.doneMs);
  assert.equal(phase(ID(1)), 'report', 'already standing at the report point');
});

test('social: neighbours chat, the outer one walks over, a note changes hands, both go back', () => {
  const { clock, d, log, views } = setup({ random: () => 0 });
  d.setAgents([agent(ID(1)), agent(ID(2))]);
  clock.tick(5000);
  assert.equal(views.get(ID(2)).phase, 'work');
  for (let i = 0; i < 4000 && views.get(ID(1)).phase !== 'chat'; i += 1) clock.tick(10);
  assert.equal(views.get(ID(1)).phase, 'chat');
  assert.ok(clock.now >= T.socialMinMs, 'not before the minimum pause');
  assert.equal(views.get(ID(1)).face, 'out', 'the inner one turns round');
  assert.equal(views.get(ID(2)).phase, 'walk');
  assert.equal(views.get(ID(2)).off, GEO.spots[0] + T.chatGap);
  clock.tick(views.get(ID(2)).walkMs);
  assert.equal(views.get(ID(2)).phase, 'chat');
  clock.tick(T.handoffAtMs);
  const handoff = log.cues.find(([n, x]) => n === 'handoff' && x.to);
  assert.ok(handoff, 'a note changes hands');
  clock.tick(T.chatMs - T.handoffAtMs);
  assert.equal(views.get(ID(1)).phase, 'work');
  assert.equal(views.get(ID(2)).phase, 'walk', 'walks back to its spot');
  clock.tick(1000);
  assert.equal(views.get(ID(2)).phase, 'work');
  assert.equal(views.get(ID(2)).off, GEO.spots[1]);
});

test('no chats while quiet; a partner that disappears mid-chat sends the other back to work', () => {
  const { clock, d, views } = setup({ random: () => 0 });
  d.setQuiet(true);
  d.setAgents([agent(ID(1)), agent(ID(2))]);
  clock.tick(60000);
  assert.equal(views.get(ID(1)).phase, 'work');
  assert.equal(views.get(ID(2)).phase, 'work');
  d.setQuiet(false);
  clock.tick(T.socialMinMs + 1000);
  assert.equal(views.get(ID(1)).phase, 'chat');
  d.setAgents([agent(ID(1))]); // agent 2 vanished from the app's list
  clock.tick(5000);
  assert.equal(views.get(ID(1)).phase, 'work');
});

test('colours: neighbours wear different tints, freed tints are reused', () => {
  const { clock, d, views } = setup({ tints: 3 });
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3))]);
  assert.deepEqual([1, 2, 3].map((n) => views.get(ID(n)).tint), [0, 1, 2]);
  clock.tick(10000);
  d.setAgents([agent(ID(2)), agent(ID(3)), agent(ID(4))]);
  assert.equal(views.get(ID(4)).tint, 0, 'the tint of the agent that left');
});

test('a smaller capacity takes minis off at once; invalid ids are ignored', () => {
  const { clock, d, views, log } = setup();
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3)), agent('not-a-hash'), agent('<script>')]);
  assert.equal(views.size, 3);
  clock.tick(10000);
  d.setGeometry({ ...GEO, capacity: 1, spots: GEO.spots.slice(0, 1) });
  assert.deepEqual([...views.keys()], [ID(1)]);
  assert.deepEqual(log.overflow.at(-1), 2);
  assert.deepEqual(log.released, [], 'still running: only hidden, not forgotten');
});

test('the tooltip shows type, tool and file name only', () => {
  assert.equal(crewLabel({ type: 'Explore', tool: 'Read', file: 'main.js' }), 'Explore · Read · main.js');
  assert.equal(crewLabel({ type: 'general-purpose', tool: null, file: null }), 'general-purpose');
});

/** random() that returns the given values in turn, then 0. */
const sequence = (...values) => () => (values.length ? values.shift() : 0);

test('social: a lone mini visits the main character for a word, then goes back', () => {
  // A pause; then 0 picks the first option, "visit" (chat is impossible with one mini).
  const { clock, d, log, views } = setup({ random: sequence(0.5, 0, 0, 0, 0.1) });
  d.setAgents([agent(ID(1))]);
  clock.tick(5000);
  assert.equal(views.get(ID(1)).phase, 'work');
  for (let i = 0; i < 6000 && views.get(ID(1)).phase === 'work'; i += 1) clock.tick(10);
  assert.equal(views.get(ID(1)).phase, 'walk');
  assert.equal(views.get(ID(1)).off, GEO.report, 'off to the report point');
  clock.tick(views.get(ID(1)).walkMs);
  assert.equal(views.get(ID(1)).phase, 'chat');
  assert.ok(log.cues.some(([n]) => n === 'talk'), 'the main character talks back');
  clock.tick(T.chatMs);
  assert.equal(views.get(ID(1)).phase, 'walk');
  clock.tick(2000);
  assert.equal(views.get(ID(1)).phase, 'work');
  assert.equal(views.get(ID(1)).off, GEO.spots[0]);
});

test('social: a stroll goes somewhere else in the crew area, looks around, comes back', () => {
  // random 0.99 always picks the last option of chat / visit / stroll.
  const { clock, d, views } = setup({ random: () => 0.99 });
  d.setAgents([agent(ID(1)), agent(ID(2))]);
  clock.tick(5000);
  for (let i = 0; i < 6000 && views.get(ID(1)).phase === 'work' && views.get(ID(2)).phase === 'work'; i += 1) clock.tick(10);
  const walker = [ID(1), ID(2)].map((id) => views.get(id)).find((v) => v.phase === 'walk');
  assert.ok(walker, 'one of them got up');
  assert.ok(walker.off >= GEO.report + T.strollMargin && walker.off <= GEO.spots[1], 'stays inside the crew area');
  clock.tick(walker.walkMs);
  assert.equal(views.get(walker.id).phase, 'look');
  clock.tick(T.lookMs + 2000);
  assert.equal(views.get(walker.id).phase, 'work');
});

test('drag: picked up, dropped somewhere else, it lands and keeps that spot', () => {
  const { clock, d, views } = setup();
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3))]);
  clock.tick(10000);
  assert.equal(d.grab(ID(3)), true);
  assert.equal(views.get(ID(3)).phase, 'held');
  assert.equal(views.get(ID(3)).fly, true, 'thrusters on while held');
  d.dropAt(ID(3), 160);
  assert.equal(views.get(ID(3)).phase, 'land');
  clock.tick(T.landMs);
  assert.equal(views.get(ID(3)).phase, 'work');
  assert.equal(views.get(ID(3)).off, 160);
  // A neighbour leaves: the others slide, but not the one the user placed.
  d.setAgents([agent(ID(2)), agent(ID(3))]);
  clock.tick(3000);
  assert.equal(views.get(ID(2)).off, GEO.spots[0]);
  assert.equal(views.get(ID(3)).off, 160);
  // Dropped beyond the crew area: clamped to the outermost spot that is shown.
  d.grab(ID(2));
  d.dropAt(ID(2), 9999);
  assert.equal(views.get(ID(2)).off, GEO.spots[1]);
  assert.equal(d.grab('nope'), false);
});

test('shooed: a huff, then off to a random other spot, which it keeps', () => {
  const { clock, d, views } = setup({ random: () => 0.99 });
  d.setAgents([agent(ID(1)), agent(ID(2)), agent(ID(3))]);
  clock.tick(10000);
  const before = views.get(ID(1)).off;
  assert.equal(d.shoo(ID(1)), true);
  assert.equal(views.get(ID(1)).phase, 'huff');
  clock.tick(T.huffMs);
  assert.equal(views.get(ID(1)).phase, 'walk');
  const target = views.get(ID(1)).off;
  assert.ok(Math.abs(target - before) >= T.shooGap, 'somewhere else');
  assert.ok(target <= GEO.spots[2] && target >= GEO.report + T.strollMargin, 'inside the crew area');
  clock.tick(5000);
  assert.equal(views.get(ID(1)).phase, 'work');
  assert.equal(views.get(ID(1)).off, target, 'that is its spot now');
  d.setAgents([agent(ID(1), 'done'), agent(ID(2)), agent(ID(3))]);
  assert.equal(d.shoo(ID(1)), false, 'a finished one is not shooed');
  assert.equal(d.shoo('nope'), false);
});

test('drag: an agent that finishes while held reports after landing', () => {
  const { clock, d, views } = setup();
  d.setAgents([agent(ID(1))]);
  clock.tick(10000);
  d.grab(ID(1));
  d.setAgents([agent(ID(1), 'done')]);
  assert.equal(views.get(ID(1)).phase, 'held');
  d.dropAt(ID(1), 300);
  clock.tick(T.landMs);
  assert.equal(views.get(ID(1)).phase, 'done');
});

test('naughty kids: they get up every 8 to 20 s, livelier than the main character', () => {
  assert.ok(T.socialMinMs >= 8000 && T.socialMaxMs <= 20000);
  const { clock, d, views } = setup({ random: () => 0.99 });
  d.setAgents([agent(ID(1))]);
  clock.tick(T.arriveMs + T.briefMs + 2000);
  assert.equal(views.get(ID(1)).phase, 'work');
  const start = clock.now;
  while (views.get(ID(1)).phase === 'work' && clock.now - start < 30000) clock.tick(10);
  assert.ok(clock.now - start <= T.socialMaxMs + 10, `up after ${clock.now - start} ms`);
});

function working(count, random = () => 0.5) {
  const ctx = setup({ random });
  ctx.d.setAgents(Array.from({ length: count }, (_, i) => agent(ID(i + 1))));
  ctx.clock.tick(10000);
  return ctx;
}

test('naughty kids: a little show where it stands, then back to work', () => {
  const { clock, d, views } = working(1);
  const mini = d.minis.get(ID(1));
  d.play(mini);
  const v = views.get(ID(1));
  assert.equal(v.phase, 'play');
  assert.ok(['spin', 'jump', 'wave', 'dance'].includes(v.play), v.play);
  assert.equal(v.off, GEO.spots[0], 'right where it stands');
  clock.tick(T.playMs);
  assert.equal(views.get(ID(1)).phase, 'work');
  assert.equal(views.get(ID(1)).play, null);
});

test('naughty kids: a zoom on the thrusters to the far end, a look round, and back', () => {
  const { clock, d, views } = working(3);
  d.zoom(d.minis.get(ID(1)));
  let v = views.get(ID(1));
  assert.equal(v.phase, 'walk');
  assert.equal(v.fly, true, 'thrusters on');
  assert.equal(v.off, GEO.spots[2], 'off to the far end of the crew area');
  clock.tick(v.walkMs);
  assert.equal(views.get(ID(1)).phase, 'look');
  clock.tick(T.zoomLookMs);
  v = views.get(ID(1));
  assert.equal(v.fly, true);
  assert.equal(v.off, GEO.spots[0], 'and home again');
  clock.tick(v.walkMs);
  assert.equal(views.get(ID(1)).phase, 'work');
});

test('naughty kids: a prank pokes the main character, then it runs back quickly', () => {
  const { clock, d, log, views } = working(2);
  const mini = d.minis.get(ID(2));
  d.prank(mini);
  let v = views.get(ID(2));
  assert.equal(v.off, GEO.report, 'sneaks up to the main character');
  clock.tick(v.walkMs);
  assert.equal(views.get(ID(2)).phase, 'prank');
  clock.tick(T.pokeMs / 2);
  assert.ok(log.cues.some(([name, data]) => name === 'poke' && data.id === ID(2)), 'poke');
  clock.tick(T.pokeMs / 2);
  v = views.get(ID(2));
  assert.equal(v.phase, 'walk');
  assert.equal(v.off, GEO.spots[1]);
  const walking = Math.round((GEO.spots[1] - GEO.report) / T.walkSpeed);
  assert.ok(v.walkMs < walking, `runs (${v.walkMs} ms instead of ${walking})`);
  // The report point is free again: a finished helper can report.
  assert.equal(d.reportHolder, null);
  clock.tick(v.walkMs);
  assert.equal(views.get(ID(2)).phase, 'work');
});

test('roaming: off out of the window, away (cue "outing"), and back at its spot when called', () => {
  const { clock, d, log, views } = working(2);
  d.setRoam(true);
  d.roam(d.minis.get(ID(2)));
  let v = views.get(ID(2));
  assert.equal(v.phase, 'outing');
  assert.equal(v.fly, true, 'thrusters on, up and away');
  clock.tick(T.outingMs);
  v = views.get(ID(2));
  assert.equal(v.phase, 'away');
  const outing = log.cues.find(([name]) => name === 'outing');
  assert.deepEqual(outing[1], { id: ID(2), tint: v.tint, off: GEO.spots[1] }, 'the app learns who left and from where');
  assert.equal(d.outCount(), 1);
  // Nobody counts it as working meanwhile (no chats with it, no other moments for it).
  assert.ok(!d.idleWorkers().some((m) => m.id === ID(2)));
  d.comeBack(ID(2));
  v = views.get(ID(2));
  assert.equal(v.phase, 'arrive', 'drops in');
  assert.equal(v.off, GEO.spots[1], 'at its own spot');
  clock.tick(T.arriveMs);
  assert.equal(views.get(ID(2)).phase, 'work');
  d.comeBack(ID(2)); // not out: nothing happens
  assert.equal(views.get(ID(2)).phase, 'work');
});

test('roaming: only when allowed, at most two out; it is part of the naughty moments', () => {
  const { clock, d, views } = working(4, () => 0.97); // 0.97: the last option, roaming
  clock.tick(30000);
  assert.ok([...views.values()].every((v) => v.phase !== 'outing' && v.phase !== 'away'), 'not while not allowed');
  d.setRoam(true);
  clock.tick(120000);
  const out = [...views.values()].filter((v) => v.phase === 'outing' || v.phase === 'away').length;
  assert.equal(out, T.maxOut, 'two out, no more');
});

test('roaming: called back when its agent finishes, when roaming is switched off, or when resting', () => {
  const { clock, d, log, views } = working(3);
  d.setRoam(true);
  for (const n of [1, 2]) d.roam(d.minis.get(ID(n)));
  clock.tick(T.outingMs);
  const recalls = () => log.cues.filter(([name]) => name === 'recall').map(([, data]) => data.id);
  // Its agent finishes while it is out: called back, and it reports once it is home.
  d.setAgents([agent(ID(1), 'done'), agent(ID(2)), agent(ID(3))]);
  assert.deepEqual(recalls(), [ID(1)]);
  d.comeBack(ID(1));
  clock.tick(T.arriveMs);
  assert.notEqual(views.get(ID(1)).phase, 'work', 'home, then on to its report');
  // Roaming switched off (ambient life off, reduced motion): the other one is called back too.
  d.setRoam(false);
  assert.deepEqual(recalls(), [ID(1), ID(2)]);
  d.setRoam(false); // no change: no second call
  assert.equal(recalls().length, 2);
  d.comeBack(ID(2));
  // Resting / screen locked: anyone out comes home.
  d.setRoam(true);
  clock.tick(T.arriveMs + 100);
  d.roam(d.minis.get(ID(3)));
  clock.tick(T.outingMs);
  d.setQuiet(true);
  assert.equal(recalls().at(-1), ID(3));
});

test('roaming: never out for longer than awayMaxMs; taken off the page while out, its window is closed', () => {
  const { clock, d, log, views } = working(2);
  d.setRoam(true);
  d.roam(d.minis.get(ID(1)));
  clock.tick(T.outingMs + T.awayMaxMs);
  assert.equal(views.get(ID(1)).phase, 'arrive', 'back by itself');
  assert.ok(log.cues.some(([name, data]) => name === 'recall' && data.id === ID(1)), 'and the app is told to close its window');
  clock.tick(T.arriveMs);
  d.roam(d.minis.get(ID(2)));
  clock.tick(T.outingMs);
  log.cues.length = 0;
  d.setAgents([agent(ID(1))]); // the app forgot agent 2
  assert.deepEqual(log.cues, [['recall', { id: ID(2) }]]);
});

/** Steps the clock in small ticks and records each mini's phase changes (and a few details). */
function track(clock, views, ids, ms, step = 10) {
  const seen = Object.fromEntries(ids.map((id) => [id, []]));
  for (let t = 0; t < ms; t += step) {
    clock.tick(step);
    for (const id of ids) {
      const v = views.get(id);
      const last = seen[id][seen[id].length - 1];
      const now = v ? `${v.phase}${v.play ? `:${v.play}` : ''}` : 'gone';
      if (!last || last.phase !== now) seen[id].push({ phase: now, off: v && v.off, fly: v && v.fly, lift: v && v.lift, face: v && v.face });
    }
  }
  return seen;
}

test('games: tag, a tap sends the other one running, a chase, caught at the last tap, both jump for joy', () => {
  const { clock, d, views } = working(2);
  d.setQuiet(true); // nothing else in between
  const chaser = d.minis.get(ID(1));
  const runner = d.minis.get(ID(2));
  d.tag(chaser, runner);
  assert.equal(views.get(ID(2)).phase, 'look', 'the one about to be tagged looks round');
  assert.equal(views.get(ID(1)).phase, 'walk');
  assert.equal(views.get(ID(1)).off, GEO.spots[1] - T.tagReach, 'up beside it, on its own side');
  const seen = track(clock, views, [ID(1), ID(2)], 15000);
  const taps = seen[ID(1)].filter((s) => s.phase === 'tag');
  assert.equal(taps.length, T.tagRounds + 1, 'a tap for each run, then the catch');
  const runs = seen[ID(2)].filter((s) => s.phase === 'walk');
  assert.equal(runs.length, T.tagRounds, 'it runs off after each tap but the last');
  assert.ok(runs.every((s) => s.off >= GEO.report && s.off <= GEO.spots[1]), 'inside the crew area');
  assert.ok(runs.some((s) => s.fly), 'cornered, it hops over the other one');
  for (const id of [ID(1), ID(2)]) {
    assert.ok(seen[id].some((s) => s.phase === 'play:jump'), `${id}: jumps for joy`);
    assert.equal(views.get(id).phase, 'work', `${id}: back to work`);
    assert.equal(d.minis.get(id).game, null);
    assert.equal(d.minis.get(id).partner, null);
  }
  assert.equal(views.get(ID(1)).off, GEO.spots[0]);
  assert.equal(views.get(ID(2)).off, GEO.spots[1]);
});

test('games: tag cut short (the runner picked up, an agent done): the other one goes back to work', () => {
  const { clock, d, views } = working(3);
  d.setQuiet(true);
  d.tag(d.minis.get(ID(1)), d.minis.get(ID(3)));
  clock.tick(2000);
  assert.equal(d.grab(ID(3)), true);
  clock.tick(3000);
  assert.equal(views.get(ID(1)).phase, 'work', 'the chaser stops and goes back');
  assert.equal(views.get(ID(1)).off, GEO.spots[0]);
  d.dropAt(ID(3), 300);
  clock.tick(T.landMs);
  assert.equal(views.get(ID(3)).phase, 'work');
  // An agent that finishes during a game plays on, then reports.
  d.tag(d.minis.get(ID(1)), d.minis.get(ID(2)));
  clock.tick(500);
  d.setAgents([agent(ID(1)), agent(ID(2), 'done'), agent(ID(3))]);
  assert.notEqual(views.get(ID(2)).phase, 'done', 'not in the middle of the game');
  const seen = track(clock, views, [ID(2)], 15000);
  assert.ok(seen[ID(2)].some((s) => s.phase === 'play:jump'), 'the game ends as usual');
  assert.ok(seen[ID(2)].some((s) => s.phase === 'done' || s.phase === 'report' || s.phase === 'gone'), 'then it finishes');
});

test('games: a tower, one hops up onto the head of the other, they wobble, it hops down', () => {
  const { clock, d, views } = working(2);
  d.setQuiet(true);
  d.tower(d.minis.get(ID(1)), d.minis.get(ID(2)));
  assert.equal(views.get(ID(1)).phase, 'look');
  assert.equal(views.get(ID(1)).face, 'out', 'turns to the one coming');
  assert.equal(views.get(ID(2)).off, GEO.spots[0] + T.climbFrom, 'up beside it first');
  clock.tick(views.get(ID(2)).walkMs);
  const climb = views.get(ID(2));
  assert.equal(climb.phase, 'climb');
  assert.equal(climb.off, GEO.spots[0], 'onto its head');
  assert.equal(climb.lift, T.towerLift);
  assert.equal(climb.fly, true, 'on its thrusters');
  assert.equal(climb.walkMs, T.climbMs);
  clock.tick(T.climbMs);
  assert.equal(views.get(ID(1)).phase, 'tower');
  assert.equal(views.get(ID(2)).phase, 'tower-top');
  assert.equal(views.get(ID(2)).lift, T.towerLift, 'stays up there');
  assert.equal(views.get(ID(2)).face, views.get(ID(1)).face, 'both face the same way (their sway mirrors with them)');
  clock.tick(T.towerMs);
  assert.equal(views.get(ID(1)).phase, 'work');
  const down = views.get(ID(2));
  assert.equal(down.lift, 0, 'hops down');
  assert.equal(down.fly, true);
  assert.equal(down.walkMs, T.hopDownMs);
  assert.equal(down.off, GEO.spots[0] + T.climbFrom, 'a little way towards its spot');
  clock.tick(5000);
  assert.equal(views.get(ID(2)).phase, 'work');
  assert.equal(views.get(ID(2)).off, GEO.spots[1]);
  assert.equal(views.get(ID(2)).lift, 0);
});

test('games: the one below picked up mid-tower: the one on top hops down and goes back to work', () => {
  const { clock, d, views } = working(2);
  d.setQuiet(true);
  d.tower(d.minis.get(ID(1)), d.minis.get(ID(2)));
  clock.tick(views.get(ID(2)).walkMs + T.climbMs + 500);
  assert.equal(views.get(ID(2)).phase, 'tower-top');
  d.grab(ID(1));
  assert.equal(views.get(ID(2)).lift, 0, 'down at once');
  clock.tick(5000);
  assert.equal(views.get(ID(2)).phase, 'work');
  assert.equal(views.get(ID(2)).off, GEO.spots[1]);
  // The one on top picked up: off the head, the pointer holds it.
  d.dropAt(ID(1), GEO.spots[0]);
  clock.tick(T.landMs + 100);
  d.tower(d.minis.get(ID(1)), d.minis.get(ID(2)));
  clock.tick(views.get(ID(2)).walkMs + T.climbMs + 500);
  d.grab(ID(2));
  assert.equal(views.get(ID(2)).lift, 0);
  clock.tick(3000);
  assert.equal(views.get(ID(1)).phase, 'work');
});

test('the pointer rests over the crew: the nearest one at work runs over, pokes at it, runs back', () => {
  const { clock, d, views } = working(2, () => 0.99);
  const at = GEO.spots[0] + 40;
  assert.equal(d.tease(at), true);
  assert.equal(views.get(ID(1)).phase, 'walk', 'the nearest one');
  assert.equal(views.get(ID(2)).phase, 'work');
  assert.equal(views.get(ID(1)).off, at - T.teaseArm, 'just short of it');
  clock.tick(views.get(ID(1)).walkMs);
  assert.equal(views.get(ID(1)).phase, 'tease');
  assert.equal(views.get(ID(1)).face, 'out', 'facing the pointer');
  clock.tick(T.teaseMs);
  assert.equal(views.get(ID(1)).phase, 'walk', 'runs back');
  clock.tick(1000);
  assert.equal(views.get(ID(1)).phase, 'work');
  assert.equal(views.get(ID(1)).off, GEO.spots[0]);
  // Not when nobody is near enough, nowhere near the crew, not quiet, nothing odd.
  assert.equal(d.tease(GEO.spots[1] + T.teaseReach), false, 'beyond the crew area');
  assert.equal(d.tease(GEO.report - 100), false, 'over the main character');
  assert.equal(d.tease(Number.NaN), false);
  d.setQuiet(true);
  assert.equal(d.tease(at), false, 'resting');
});

test('social moments: two at work may play tag or make a tower; one alone never does', () => {
  const sequenceOf = (...values) => () => (values.length ? values.shift() : 0);
  {
    const { d } = working(2);
    d.setQuiet(true);
    // Options: chat 3, visit 2, prank 2, play 4, zoom 3, tag 3, tower 2, stroll 2 (21): 0.75 -> tag.
    d.random = sequenceOf(0.75, 0, 0.5);
    d.socialMoment();
    assert.equal(d.minis.get(ID(1)).game, 'tag');
    assert.equal(d.minis.get(ID(2)).game, 'tag');
  }
  {
    const { d } = working(2);
    d.setQuiet(true);
    d.random = sequenceOf(0.86, 0);
    d.socialMoment();
    assert.equal(d.minis.get(ID(1)).game, 'tower', 'the inner one below');
    assert.equal(d.minis.get(ID(2)).game, 'tower');
  }
  {
    const { d } = working(1);
    d.setQuiet(true);
    for (const r of [0, 0.3, 0.6, 0.75, 0.86, 0.99]) {
      d.random = sequenceOf(r, 0, 0);
      d.socialMoment();
      assert.equal(d.minis.get(ID(1)).game, null, `random ${r}`);
      d.backToWork(d.minis.get(ID(1)));
    }
  }
});

test('the games on the page: drawn lifted, a poke at the resting pointer (ambient life), demos, poses', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const view = read('app', 'renderer', 'crew-view.js');
  assert.ok(view.includes("el.style.setProperty('--lift', `${view.lift || 0}px`);"), 'up on the other one: --lift');
  assert.ok(view.includes("view.fly || view.phase === 'leave' || view.lift > 0 ? 20 : 10 - view.slot"), 'drawn above the one below');
  assert.ok(view.includes('if (!director.tease(off)) return;'));
  assert.ok(view.includes('const TEASE = Object.freeze({ restMs: 1300, moveTol: 14, gapMs: 30000, height: 230 });'), 'resting a moment, at most every 30 s');
  const page = read('app', 'renderer', 'renderer.js');
  // Only over the empty crew area (not on a mini: its tooltip and the drag stay as they were), with ambient life.
  assert.ok(page.includes('const teaseOk = next === null && crewCount > 0 && ambientOn() && !drag && !moving && !duel.active && !raging && !chatOpen && !paused;'));
  assert.ok(page.includes('crew.pointer(teaseOk ? clientX : null, clientY);'));
  assert.ok(page.includes('    crew.pointer(null);\n    if (drag) return;'), 'leaving the page forgets it');
  assert.ok(page.includes("} else if (name === 'tag' || name === 'tower') {"));
  const demos = read('app', 'validate.js');
  for (const name of ['tag', 'tower', 'tease']) assert.ok(demos.includes(`  '${name}',`), name);
  const css = read('characters', 'robot', 'mini.css');
  for (const phase of ['tag', 'tower', 'tower-top', 'tease']) assert.ok(css.includes(`.buddy-mini[data-phase='${phase}']`), phase);
});
