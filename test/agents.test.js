'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentRegistry } = require('../app/agents');
const { FakeClock } = require('./helpers/fake-clock');

function setup(options = {}) {
  const clock = new FakeClock();
  const reg = new AgentRegistry({ clock, ...options });
  const changes = [];
  reg.on('change', (list) => changes.push(list));
  return { clock, reg, changes };
}

const statuses = (reg) => reg.list().map((a) => `${a.id}:${a.status}`);

test('start, tool activity, stop, release', () => {
  const { reg, changes } = setup();
  reg.start({ agent: 'a1', agentType: 'Explore', session: 'S' });
  assert.deepEqual(reg.list(), [{ id: 'a1', type: 'Explore', tool: null, file: null, skill: null, status: 'active' }]);
  reg.activity({ agent: 'a1', session: 'S', tool: 'Read', file: 'main.js', started: true });
  assert.deepEqual(reg.list()[0], { id: 'a1', type: 'Explore', tool: 'Read', file: 'main.js', skill: null, status: 'active' });
  const before = changes.length;
  reg.activity({ agent: 'a1', session: 'S', tool: 'Read', started: false });
  assert.equal(changes.length, before, 'PostToolUse changes nothing visible');
  reg.stop({ agent: 'a1' });
  assert.deepEqual(statuses(reg), ['a1:done']);
  reg.release('a1');
  assert.deepEqual(reg.list(), []);
});

test('repeated starts and stops for unseen agents are ignored', () => {
  const { reg, changes } = setup();
  reg.stop({ agent: 'ghost' });
  assert.equal(changes.length, 0);
  reg.start({ agent: 'a1', agentType: 'Explore', session: 'S' });
  reg.start({ agent: 'a1', agentType: 'Plan', session: 'S' });
  assert.equal(changes.length, 1);
  assert.equal(reg.list()[0].type, 'Explore');
  reg.stop({ agent: 'a1' });
  reg.stop({ agent: 'a1' });
  assert.equal(changes.length, 2);
  reg.activity({ agent: 'a1', tool: 'Read', started: true });
  assert.equal(reg.list()[0].status, 'done', 'late events do not revive a finished agent');
});

test('tool events from an unknown agent add it (the overlay started late)', () => {
  const { reg } = setup();
  reg.activity({ agent: 'b2', agentType: 'general-purpose', session: 'S', tool: 'Edit', file: 'a.ts', started: true });
  assert.deepEqual(reg.list(), [{ id: 'b2', type: 'general-purpose', tool: 'Edit', file: 'a.ts', skill: null, status: 'active' }]);
});

test('an agent without events for 30 minutes fades; activity keeps it alive', () => {
  const { clock, reg } = setup();
  reg.start({ agent: 'a1', agentType: 'Explore', session: 'S' });
  clock.tick(29 * 60 * 1000);
  reg.activity({ agent: 'a1', tool: 'Grep', started: true });
  clock.tick(29 * 60 * 1000);
  assert.equal(reg.list()[0].status, 'active');
  clock.tick(60 * 1000);
  assert.equal(reg.list()[0].status, 'gone');
  clock.tick(20 * 1000);
  assert.deepEqual(reg.list(), [], 'removed by the safety net when nobody releases it');
});

test('the main turn has no say; the session ending removes its agents', () => {
  const { reg } = setup();
  reg.start({ agent: 'a1', session: 'S' });
  reg.start({ agent: 'a2', session: 'T' });
  reg.endSession('S');
  assert.deepEqual(statuses(reg), ['a1:gone', 'a2:active']);
  assert.equal(reg.list()[0].type, 'agent', 'unknown type gets a neutral label');
});

test('arrival order is kept and memory is bounded', () => {
  const { reg } = setup({ maxAgents: 3 });
  for (const id of ['a', 'b', 'c']) reg.start({ agent: id, session: 'S' });
  reg.stop({ agent: 'b' });
  reg.start({ agent: 'd', session: 'S' });
  assert.deepEqual(statuses(reg), ['a:active', 'c:active', 'd:active'], 'a finished agent is dropped first');
  assert.equal(reg.activeCount, 3);
});

test('a sub-agent keeps the skill it opened until it finishes', () => {
  const { reg } = setup();
  reg.start({ agent: 'k1', agentType: 'Explore', session: 'S' });
  reg.activity({ agent: 'k1', session: 'S', tool: 'Skill', skill: 'pdf', started: true });
  assert.equal(reg.list()[0].skill, 'pdf');
  reg.activity({ agent: 'k1', session: 'S', tool: 'Read', file: 'a.pdf', skill: null, started: true });
  assert.equal(reg.list()[0].skill, 'pdf', 'the book stays open while it works');
  reg.activity({ agent: 'k1', session: 'S', tool: 'Read', skill: 'ignored', started: true });
  assert.equal(reg.list()[0].skill, 'pdf', 'only the Skill tool sets it');
  reg.stop({ agent: 'k1' });
  assert.equal(reg.list()[0].skill, null);
});
