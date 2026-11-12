'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BuddyCore } = require('../app/core');
const { FakeClock } = require('./helpers/fake-clock');

function setup(timings = {}) {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, timings });
  const quits = [];
  core.on('quit', (reason) => quits.push(reason));
  let ts = 1000;
  const send = (event, extra = {}) => {
    ts += 10;
    core.handle({ v: 1, event, session: 'A', ts, ...extra });
  };
  return { clock, core, quits, send };
}

test('SessionStart greets, then falls back to idle', () => {
  const { clock, core, send } = setup();
  send('SessionStart', { source: 'startup' });
  assert.equal(core.state, 'greeting');
  assert.deepEqual(core.snapshot().message, { key: 'greeting' });
  clock.tick(2499);
  assert.equal(core.state, 'greeting');
  clock.tick(1);
  assert.equal(core.state, 'idle');
});

test('prompt -> thinking, tool -> typing, then holds 1.5 s after the tool finishes', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  assert.equal(core.state, 'thinking');

  send('PreToolUse', { tool: 'Edit', id: 't1', detail: 'main.js' });
  assert.equal(core.state, 'typing');
  assert.deepEqual(core.snapshot().message, { key: 'typing', vars: { file: 'main.js' } });

  send('PostToolUse', { tool: 'Edit', id: 't1' });
  assert.equal(core.state, 'typing', 'does not drop immediately');
  clock.tick(1499);
  assert.equal(core.state, 'typing');
  clock.tick(1);
  assert.equal(core.state, 'thinking', 'turn still active, so back to thinking');
});

test('a new tool during the hold cancels the fallback', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', { tool: 'Read', id: 't1', detail: 'a.js' });
  send('PostToolUse', { tool: 'Read', id: 't1' });
  clock.tick(1000);
  send('PreToolUse', { tool: 'Bash', id: 't2', detail: 'npm test' });
  clock.tick(1000);
  assert.equal(core.state, 'running');
  assert.equal(core.snapshot().message.mono, true);
});

test('parallel tools: the fallback waits for the last one to finish', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', { tool: 'Read', id: 't1' });
  send('PreToolUse', { tool: 'Grep', id: 't2' });
  send('PostToolUse', { tool: 'Read', id: 't1' });
  clock.tick(5000);
  assert.equal(core.state, 'reading', 't2 is still running');
  send('PostToolUseFailure', { tool: 'Grep', id: 't2' });
  clock.tick(1500);
  assert.equal(core.state, 'thinking');
});

test('a PreToolUse that arrives after its own PostToolUse is ignored', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  send('PostToolUse', { tool: 'Read', id: 't1' });
  send('PreToolUse', { tool: 'Read', id: 't1', detail: 'late.js' });
  assert.equal(core.state, 'thinking');
  clock.tick(5000);
  assert.equal(core.state, 'thinking');
});

test('Stop -> done for 3 s -> idle; events stamped before Stop are ignored', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  send('Stop', { ts: 5000 });
  assert.equal(core.state, 'done');
  send('PreToolUse', { tool: 'Edit', id: 'late', ts: 4990 });
  assert.equal(core.state, 'done', 'stale event dropped');
  clock.tick(3000);
  assert.equal(core.state, 'idle');
});

test('notifications: approval waits until the next event, idle reminder times out', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  send('Notification', { kind: 'permission_prompt' });
  assert.equal(core.state, 'waiting');
  assert.deepEqual(core.snapshot().message, { key: 'waiting' });
  clock.tick(60000);
  assert.equal(core.state, 'waiting', 'stays until something happens');
  send('PreToolUse', { tool: 'Bash', id: 't1' });
  assert.equal(core.state, 'running');

  send('Stop');
  clock.tick(3000);
  send('Notification', { kind: 'idle_prompt' });
  assert.equal(core.state, 'standby', 'idle reminder is calm, not the approval pose');
  assert.deepEqual(core.snapshot().message, { key: 'waitingForYou' });
  clock.tick(10000);
  assert.equal(core.state, 'idle');

  send('Notification', { kind: 'auth_success' });
  assert.equal(core.state, 'idle', 'known types that do not need the user are ignored');
});

test('notifications: only permission prompts ask for approval', () => {
  const { clock, core, send } = setup();
  const cases = [
    ['permission_prompt', 'waiting', 'waiting', true],
    ['elicitation_dialog', 'asking', 'question', true],
    ['elicitation_url_dialog', 'asking', 'question', true],
    ['agent_needs_input', 'asking', 'needsInput', true],
    ['idle_prompt', 'standby', 'waitingForYou', false],
    ['something_new', 'standby', 'notice', false],
    [undefined, 'standby', 'notice', false],
  ];
  for (const [kind, state, key, sticky] of cases) {
    send('Notification', kind ? { kind } : {});
    assert.equal(core.state, state, String(kind));
    assert.deepEqual(core.snapshot().message, { key }, String(kind));
    clock.tick(10000);
    assert.equal(core.state === state, sticky, `${kind} sticky=${sticky}`);
    send('Stop');
    clock.tick(3000);
  }
});

test('a failed tool looks worried until the view changes', () => {
  const { clock, core, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', { tool: 'Bash', id: 't1', detail: 'npm test' });
  assert.equal(core.snapshot().mood, null);
  send('PostToolUseFailure', { tool: 'Bash', id: 't1' });
  assert.equal(core.state, 'running');
  assert.equal(core.snapshot().mood, 'worried');
  clock.tick(1500);
  assert.equal(core.state, 'thinking');
  assert.equal(core.snapshot().mood, null);
});

test('tool names map to states and bubble messages', () => {
  const { core, send } = setup();
  const cases = [
    ['Write', 'typing', 'typing'],
    ['MultiEdit', 'typing', 'typing'],
    ['NotebookEdit', 'typing', 'typing'],
    ['Read', 'reading', 'reading'],
    ['Grep', 'reading', 'searching'],
    ['Glob', 'reading', 'findingFiles'],
    ['Bash', 'running', 'running'],
    ['PowerShell', 'running', 'running'],
    ['WebSearch', 'working', 'webSearch'],
    ['WebFetch', 'working', 'webFetch'],
    ['Agent', 'working', 'delegating'],
    ['mcp__github__create_issue', 'working', 'mcp'],
    ['SomethingNew', 'working', 'working'],
  ];
  let n = 0;
  for (const [tool, state, key] of cases) {
    send('PreToolUse', { tool, id: `t${(n += 1)}`, detail: 'x' });
    assert.equal(core.state, state, tool);
    assert.equal(core.snapshot().message.key, key, tool);
  }
  send('PreToolUse', { tool: 'mcp__github__create_issue', id: 'mcp' });
  assert.deepEqual(core.snapshot().message.vars, { server: 'github' });
});

test('two sessions: the buddy stays until the last one ends, then waves and quits', () => {
  const { clock, core, quits, send } = setup();
  send('SessionStart', { session: 'A' });
  send('SessionStart', { session: 'B' });
  assert.equal(core.sessionCount, 2);

  send('SessionEnd', { session: 'A', reason: 'prompt_input_exit' });
  assert.equal(core.sessionCount, 1);
  assert.notEqual(core.state, 'goodbye');
  clock.tick(10000);
  assert.deepEqual(quits, []);

  send('SessionEnd', { session: 'B', reason: 'logout' });
  assert.equal(core.state, 'goodbye');
  clock.tick(2999);
  assert.deepEqual(quits, []);
  clock.tick(1);
  assert.deepEqual(quits, ['sessions-ended']);
});

test('a session that ends mid-tool does not leave its tool state behind', () => {
  const { core, send } = setup();
  send('SessionStart', { session: 'A' });
  send('SessionStart', { session: 'B' });
  send('UserPromptSubmit', { session: 'A' });
  send('PreToolUse', { session: 'A', tool: 'Edit', id: 't1' });
  send('SessionEnd', { session: 'A', reason: 'prompt_input_exit' });
  assert.equal(core.state, 'idle');

  // ...but another session's view is left alone.
  send('UserPromptSubmit', { session: 'B' });
  send('PreToolUse', { session: 'B', tool: 'Bash', id: 't2' });
  send('SessionStart', { session: 'C' });
  send('PreToolUse', { session: 'B', tool: 'Bash', id: 't3' });
  send('SessionEnd', { session: 'C', reason: 'other' });
  assert.equal(core.state, 'running');
});

test('any event registers its session, even without SessionStart', () => {
  const { core, send } = setup();
  send('PreToolUse', { session: 'X', tool: 'Read', id: 't1' });
  assert.equal(core.sessionCount, 1);
  assert.deepEqual(core.sessionIds(), ['X']);
});

test('SessionEnd for /clear waits for the follow-up session instead of leaving', () => {
  const { clock, core, quits, send } = setup();
  send('SessionStart', { session: 'old' });
  send('SessionEnd', { session: 'old', reason: 'clear' });
  assert.notEqual(core.state, 'goodbye');
  clock.tick(1000);
  send('SessionStart', { session: 'new', source: 'clear' });
  clock.tick(10000);
  assert.deepEqual(quits, []);
  assert.equal(core.sessionCount, 1);

  // ...but if nothing follows, it does leave.
  send('SessionEnd', { session: 'new', reason: 'resume' });
  clock.tick(4000);
  assert.equal(core.state, 'goodbye');
  clock.tick(3000);
  assert.deepEqual(quits, ['sessions-ended']);
});

test('an event during goodbye cancels quitting', () => {
  const { clock, core, quits, send } = setup();
  send('SessionStart', { session: 'A' });
  send('SessionEnd', { session: 'A', reason: 'other' });
  assert.equal(core.state, 'goodbye');
  clock.tick(1000);
  send('SessionStart', { session: 'B' });
  assert.equal(core.state, 'greeting');
  clock.tick(10000);
  assert.deepEqual(quits, []);
  assert.equal(core.state, 'idle');
});

test('safety net: quits after the idle timeout; 0 disables it', () => {
  const a = setup({ idleTimeoutMs: 30 * 60 * 1000 });
  a.send('SessionStart');
  a.clock.tick(29 * 60 * 1000);
  a.send('UserPromptSubmit'); // activity resets the timer
  a.clock.tick(29 * 60 * 1000);
  assert.deepEqual(a.quits, []);
  a.clock.tick(60 * 1000);
  assert.equal(a.core.state, 'goodbye');
  a.clock.tick(3000);
  assert.deepEqual(a.quits, ['idle-timeout']);

  const b = setup({ idleTimeoutMs: 0 });
  b.send('SessionStart');
  b.clock.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(b.quits, []);
});

test('emits a state event for every view change and nothing after dispose', () => {
  const { clock, core, send } = setup();
  const seen = [];
  core.on('state', (s) => seen.push(s.state));
  send('SessionStart');
  send('UserPromptSubmit');
  send('PreToolUse', { tool: 'Edit', id: 't1' });
  send('Stop');
  assert.deepEqual(seen, ['greeting', 'thinking', 'typing', 'done']);
  core.dispose();
  clock.tick(10000);
  send('UserPromptSubmit');
  assert.deepEqual(seen, ['greeting', 'thinking', 'typing', 'done']);
});

test('sub-agent events go to the crew and never change the main character', () => {
  const { core, send } = setup();
  const crews = [];
  core.on('crew', (list) => crews.push(list));
  send('UserPromptSubmit');
  send('PreToolUse', { tool: 'Agent', id: 'ag1' });
  assert.equal(core.state, 'working');
  send('SubagentStart', { agent: 'abc123def0', agentType: 'Explore' });
  send('PreToolUse', { tool: 'Read', id: 's1', detail: 'main.js', agent: 'abc123def0', agentType: 'Explore' });
  send('PreToolUse', { tool: 'Bash', id: 's2', detail: 'rm -rf build', agent: 'abc123def0', agentType: 'Explore' });
  assert.equal(core.state, 'working', 'main robot unaffected');
  assert.deepEqual(core.crewList(), [{ id: 'abc123def0', type: 'Explore', tool: 'Bash', file: null, status: 'active' }]);
  assert.ok(!JSON.stringify(crews).includes('rm -rf'), 'commands never reach a mini');
  send('Stop');
  assert.equal(core.crewList()[0].status, 'active', 'the main turn ending does not end the agent');
  send('SubagentStop', { agent: 'abc123def0', agentType: 'Explore' });
  assert.equal(core.crewList()[0].status, 'done');
});

test('skill book: out with the Skill tool or a slash command, back in at Stop', () => {
  const { core, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', { tool: 'Skill', id: 'k1', skill: 'pdf' });
  assert.equal(core.snapshot().skill, 'pdf');
  assert.deepEqual(core.snapshot().message, { key: 'skill' });
  send('PostToolUse', { tool: 'Skill', id: 'k1' });
  send('PreToolUse', { tool: 'Edit', id: 'k2', detail: 'a.md' });
  assert.equal(core.snapshot().skill, 'pdf', 'stays while the turn goes on');
  send('Stop');
  assert.equal(core.snapshot().skill, null);

  const seen = [];
  core.on('state', (snap) => seen.push(snap.skill));
  send('UserPromptExpansion', { skill: 'buddy-ping' });
  assert.deepEqual(seen, ['buddy-ping'], 'the view is refreshed with the skill');
  send('SessionEnd', { reason: 'other' });
  assert.equal(core.snapshot().skill, null);
});
