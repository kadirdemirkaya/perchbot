'use strict';

/**
 * Three more moments of the work (app/moments.js), each started by its own action only:
 *   pr      `gh pr create` worked: an envelope is sealed and flies off
 *   plan    ExitPlanMode: a blueprint while the plan waits; planOk (approved): a stamp;
 *           planOff (not taken): it rolls up
 *   plug    an MCP tool: a plug goes into a socket (at most once every PLUG_GAP_MS)
 * The old moments (commit, push, sweat, duck, phew, squeeze, cube) are unchanged:
 * test/moments.test.js, test/duck-popcorn.test.js and test/press.test.js stay as they were.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const send = require('../hooks/send.js');
const { validateEvent, DEMOS } = require('../app/validate');
const { MomentWatch, gitMoments, ghMoments, PLAN_TOOL, PLUG_GAP_MS } = require('../app/moments');
const { BuddyCore } = require('../app/core');
const { taskFor, bubbleForTool } = require('../app/tools');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('ghMoments: only `gh pr create` counts, wherever it is in the line', () => {
  assert.deepEqual(ghMoments('gh pr create --fill'), ['pr']);
  assert.deepEqual(ghMoments('git push -u origin x && gh pr create --title "Fix it"'), ['pr']);
  assert.deepEqual(ghMoments('GH_TOKEN=x gh pr create'), ['pr']);
  assert.deepEqual(ghMoments('gh -R owner/repo pr create --fill'), ['pr']);
  assert.deepEqual(ghMoments('gh --repo owner/repo pr create'), ['pr']);
  for (const no of ['gh pr view 3', 'gh pr list', 'gh issue create', 'gh pr', 'echo gh pr create', 'git commit -m "gh pr create"', 'gh create pr', '', null, 42]) {
    assert.deepEqual(ghMoments(no), [], String(no));
  }
  // git's own moments are not touched by it.
  assert.deepEqual(gitMoments('git push && gh pr create'), ['push']);
});

test('moment watch: a PR only when the command worked, after its push', () => {
  const w = new MomentWatch();
  w.toolStart('s', 't1', 'Bash', 'git push && gh pr create --fill');
  assert.deepEqual(w.toolEnd('s', 't1', true), ['push', 'pr']);
  w.toolStart('s', 't2', 'Bash', 'gh pr create --fill');
  assert.deepEqual(w.toolEnd('s', 't2', false), [], 'it failed: no envelope');
  w.toolStart('s', 't3', 'PowerShell', 'gh pr create');
  assert.deepEqual(w.toolEnd('s', 't3', true), ['pr']);
  w.toolStart('s', 't4', 'Edit', 'gh pr create');
  assert.deepEqual(w.toolEnd('s', 't4', true), [], 'only commands');
});

test('moment watch: the blueprint while a plan waits, then a stamp or rolled up', () => {
  assert.equal(PLAN_TOOL, 'ExitPlanMode');
  const w = new MomentWatch();
  assert.deepEqual(w.toolMoments('s', 'p1', 'ExitPlanMode'), ['plan']);
  assert.deepEqual(w.toolMoments('s', 'p2', 'ExitPlanMode'), [], 'already out: not twice');
  assert.deepEqual(w.toolEnd('s', 'p1', true), [], 'an older id: not this plan');
  assert.deepEqual(w.toolEnd('s', 'p2', true), ['planOk'], 'approved');
  assert.deepEqual(w.planClose('s'), [], 'nothing out any more');
  // Rejected: the tool failed.
  w.toolMoments('s', 'p3', 'ExitPlanMode');
  assert.deepEqual(w.toolEnd('s', 'p3', false), ['planOff']);
  // Not taken: another tool came instead.
  w.toolMoments('s', 'p4', 'ExitPlanMode');
  assert.deepEqual(w.toolMoments('s', 'r1', 'Read'), ['planOff']);
  assert.deepEqual(w.toolMoments('s', 'r2', 'Read'), [], 'once');
  // Not taken: a new prompt, a stop or the end of the session.
  w.toolMoments('s', 'p5', 'ExitPlanMode');
  assert.deepEqual(w.planClose('other'), [], 'another session: its own');
  assert.deepEqual(w.planClose('s'), ['planOff']);
  // No id: nothing to pair the end with, so no blueprint.
  assert.deepEqual(w.toolMoments('s', undefined, 'ExitPlanMode'), []);
  // A plan that fails still counts as a failed tool (the old sweat streak), as before.
  const f = new MomentWatch();
  for (let i = 0; i < 2; i += 1) {
    f.toolStart('s', `e${i}`, 'Edit');
    f.toolEnd('s', `e${i}`, false);
  }
  f.toolMoments('s', 'p', 'ExitPlanMode');
  assert.deepEqual(f.toolEnd('s', 'p', false), ['planOff', 'sweat']);
});

test('moment watch: the plug for an MCP tool, once in PLUG_GAP_MS however many calls', () => {
  const w = new MomentWatch();
  assert.deepEqual(w.toolMoments('s', 'm1', 'mcp__github__list_issues', 1000), ['plug']);
  assert.deepEqual(w.toolMoments('s', 'm2', 'mcp__github__get_issue', 1000 + PLUG_GAP_MS - 1), []);
  assert.deepEqual(w.toolMoments('s', 'm3', 'mcp__slack__post', 1000 + PLUG_GAP_MS), ['plug']);
  for (const tool of ['mcp__', 'mcp____x', 'Read', 'Bash', 'Task', 'mcpfoo', undefined]) {
    assert.deepEqual(w.toolMoments('s', 'x', tool, 10 * PLUG_GAP_MS), [], String(tool));
  }
  // The look while it runs stays the plain one (fun.test.js pins that too).
  assert.equal(taskFor(bubbleForTool('mcp__github__list_issues').key), null);
});

test('core: the moments come with their own events only', () => {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, now: () => clock.now });
  const moments = [];
  core.on('moment', (m) => moments.push(m));
  const ev = (event, extra = {}) => core.handle({ v: 1, event, session: 's1', ts: clock.now, ...extra });
  ev('SessionStart', { source: 'startup' });
  ev('UserPromptSubmit');
  // A plan up for approval, waiting, approved.
  ev('PreToolUse', { tool: 'ExitPlanMode', id: 'p1' });
  ev('Notification', { kind: 'permission_prompt' });
  assert.deepEqual(moments, ['plan']);
  ev('PostToolUse', { tool: 'ExitPlanMode', id: 'p1' });
  assert.deepEqual(moments, ['plan', 'planOk']);
  // A plan that is not taken: the turn ends.
  ev('PreToolUse', { tool: 'ExitPlanMode', id: 'p2' });
  ev('Stop');
  assert.deepEqual(moments.slice(2), ['plan', 'planOff']);
  // ...or a new prompt comes.
  ev('UserPromptSubmit');
  ev('PreToolUse', { tool: 'ExitPlanMode', id: 'p3' });
  ev('UserPromptSubmit');
  assert.deepEqual(moments.slice(4), ['plan', 'planOff']);
  // ...or the session ends.
  ev('PreToolUse', { tool: 'ExitPlanMode', id: 'p4' });
  core.handle({ v: 1, event: 'SessionStart', session: 's2', ts: clock.now, source: 'startup' });
  ev('SessionEnd', { reason: 'other' });
  assert.deepEqual(moments.slice(6), ['plan', 'planOff']);
  // A PR and an MCP tool in another session.
  moments.length = 0;
  const ev2 = (event, extra = {}) => core.handle({ v: 1, event, session: 's2', ts: clock.now, ...extra });
  ev2('UserPromptSubmit');
  ev2('PreToolUse', { tool: 'Bash', id: 'b1', detail: 'gh pr create --fill' });
  ev2('PostToolUse', { tool: 'Bash', id: 'b1' });
  ev2('PreToolUse', { tool: 'mcp__github__list_issues', id: 'm1' });
  ev2('PostToolUse', { tool: 'mcp__github__list_issues', id: 'm1' });
  ev2('PreToolUse', { tool: 'mcp__github__list_issues', id: 'm2' });
  ev2('PostToolUse', { tool: 'mcp__github__list_issues', id: 'm2' });
  assert.deepEqual(moments, ['pr', 'plug']);
  // Everything else as before: a commit and a push still give their own.
  ev2('PreToolUse', { tool: 'Bash', id: 'b2', detail: 'git commit -m x && git push' });
  ev2('PostToolUse', { tool: 'Bash', id: 'b2' });
  assert.deepEqual(moments.slice(2), ['commit', 'push']);
  core.dispose();
});

test('hook: the plan text and MCP input never leave it; gh pr create as a shortened command', () => {
  const secret = 'deploy key sk-live-1234567890 for the customer list';
  const plan = send.buildPayload(
    { hook_event_name: 'PreToolUse', session_id: 'abc', tool_name: 'ExitPlanMode', tool_use_id: 'toolu_1', tool_input: { plan: secret } },
    'PreToolUse',
    1000,
  );
  assert.equal(plan.tool, 'ExitPlanMode');
  assert.ok(!JSON.stringify(plan).includes('sk-live') && !JSON.stringify(plan).includes('customer'));
  assert.deepEqual(validateEvent(plan), plan);
  const mcp = send.buildPayload(
    { hook_event_name: 'PreToolUse', session_id: 'abc', tool_name: 'mcp__github__create_issue', tool_use_id: 'toolu_2', tool_input: { body: secret } },
    'PreToolUse',
    1000,
  );
  assert.equal(mcp.tool, 'mcp__github__create_issue');
  assert.ok(!JSON.stringify(mcp).includes('sk-live'));
  const pr = send.buildPayload(
    { hook_event_name: 'PreToolUse', session_id: 'abc', tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'gh pr create --fill' } },
    'PreToolUse',
    1000,
  );
  assert.deepEqual(ghMoments(pr.detail), ['pr'], `detail: ${pr.detail}`);
});

test('page: the three shows, their art, styles, words and demos', () => {
  const page = read('app', 'renderer', 'renderer.js');
  for (const fn of ['sendEnvelope', 'openBlueprint', 'stampBlueprint', 'closeBlueprint', 'plugIn']) {
    assert.ok(page.includes(`function ${fn}(`), fn);
  }
  for (const kind of ['pr', 'plan', 'planOk', 'planOff', 'plug']) assert.ok(page.includes(`kind === '${kind}'`), kind);
  // Only motion-free pages skip the moving ones; the blueprint shows still.
  assert.match(page, /function sendEnvelope\(\) \{\s*if \(!motionAllowed\(\) \|\| !character\) return;/);
  assert.match(page, /function plugIn\(\) \{\s*if \(!motionAllowed\(\) \|\| !character\) return;/);
  const html = read('app', 'renderer', 'index.html');
  for (const id of ['i-env', 'i-env-flap', 'i-env-seal', 'i-blueprint', 'i-stamp', 'i-socket', 'i-socket-led', 'i-plug']) {
    assert.ok(html.includes(`<symbol id="${id}"`), id);
  }
  const css = read('app', 'renderer', 'overlay.css');
  for (const rule of ['.fx-pr {', '.fx-pr.to-left {', '.fx-pr-flap {', '.fx-pr-seal {', '.fx-plan {', '.fx-plan.closing {', '.fx-plan.stamped .fx-plan-stamp {', '.fx-plug {', '.fx-plug.to-left {', '.fx-plug-led {']) {
    assert.ok(css.includes(rule), rule);
  }
  for (const kf of ['buddy-pr', 'buddy-pr-left', 'buddy-pr-flap', 'buddy-pr-seal', 'buddy-plan-open', 'buddy-plan-close', 'buddy-plan-stamp', 'buddy-plug', 'buddy-plug-head', 'buddy-plug-led']) {
    assert.ok(css.includes(`@keyframes ${kf} {`), kf);
  }
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(read('app', 'locales', `${lang}.json`));
    const quips = Object.values(strings).find((v) => v && typeof v === 'object' && 'commit' in v && 'push' in v);
    assert.ok(quips && quips.pr && quips.planOk, `${lang}: quips`);
  }
  for (const name of ['pr', 'plan', 'plug']) assert.ok(DEMOS.has(name), `demo ${name}`);
});
