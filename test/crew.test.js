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
  // Delay 0 -> minimum pause; then pick "visit" (chat is impossible with one mini).
  const { clock, d, log, views } = setup({ random: sequence(0.5, 0.5, 0, 0, 0.1) });
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
