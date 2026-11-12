#!/usr/bin/env node
'use strict';

/**
 * Plays scripted, fake hook events through hooks/send.js, exactly the way
 * Claude Code would, so you can watch every state without opening Claude Code.
 * The overlay is started automatically by the first SessionStart.
 *
 *   npm run simulate                    tour of every state
 *   npm run simulate -- two-sessions    two overlapping sessions (checks the session counter)
 *   npm run simulate -- playground      keeps the buddy idle so you can try the mouse:
 *                                       hover menu, drag, click, eyes, resting after a minute
 *   npm run simulate -- --fast          shorter pauses
 *   npm run simulate -- --keep          skip the final SessionEnd (overlay stays open)
 */

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SEND = path.join(ROOT, 'hooks', 'send.js');
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const KEEP = args.includes('--keep');
const scenario = args.find((a) => !a.startsWith('-')) || 'tour';

// Same resolution order as hooks/send.js
const { readConfig } = require(SEND);
const PORT = readConfig().port;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, FAST ? ms / 2 : ms));
const randomId = () => Math.random().toString(36).slice(2, 10);

/** Pipe one hook input into send.js, like Claude Code does. */
function hook(input) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SEND, input.hook_event_name], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('close', (code) => resolve({ code, ms: Date.now() - started, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 500 }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function step(label, input, waitMs) {
  if (input) {
    const r = await hook(input);
    const flags = [`exit ${r.code}`, `${r.ms} ms`];
    if (r.stdout) flags.push(`STDOUT NOT EMPTY: ${JSON.stringify(r.stdout)}`);
    console.log(`  ${input.hook_event_name.padEnd(18)} -> ${label.padEnd(30)} (${flags.join(', ')})`);
  } else {
    console.log(`  ${''.padEnd(18)}    ${label}`);
  }
  await sleep(waitMs);
}

function base(session, event, extra = {}) {
  return {
    session_id: session,
    transcript_path: '/tmp/simulated.jsonl',
    cwd: ROOT,
    hook_event_name: event,
    ...extra,
  };
}

function tool(session, event, name, input, id) {
  return base(session, event, { tool_name: name, tool_input: input, tool_use_id: id });
}

async function tour() {
  const s = `sim-${randomId()}`;
  let n = 0;
  const pair = async (label, name, input, holdMs) => {
    const id = `toolu_sim_${(n += 1)}`;
    await step(label, tool(s, 'PreToolUse', name, input, id), holdMs);
    await step('(tool done, holds 1.5 s)', tool(s, 'PostToolUse', name, input, id), 2200);
  };

  console.log(`Session ${s}\n`);
  await step('greeting  "Hello!"', base(s, 'SessionStart', { source: 'startup' }), 3500);
  await step('thinking  "..."', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 3000);
  await pair('reading   main.js', 'Read', { file_path: path.join(ROOT, 'app', 'main.js') }, 3000);
  await pair('reading   search', 'Grep', { pattern: 'TODO', path: ROOT }, 2500);
  await pair('typing    robot.css', 'Edit', {
    file_path: path.join(ROOT, 'characters', 'robot', 'robot.css'),
    old_string: 'secret file content that must never be forwarded',
    new_string: 'more content',
  }, 3500);
  await pair('running   npm test', 'Bash', {
    command: 'npm test -- --reporter=spec && GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 echo ok',
    description: 'Run the test suite',
  }, 3500);
  await pair('working   web search', 'WebSearch', { query: 'electron transparent window' }, 3000);
  await step('waiting   "Waiting for approval"', base(s, 'Notification', {
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  }), 3500);
  await pair('typing    notes.md', 'Write', { file_path: path.join(ROOT, 'notes.md'), content: 'x' }, 2500);
  await step('done      jump + confetti', base(s, 'Stop', { stop_hook_active: false }), 3800);
  await step('idle      (watch it blink)', null, 5000);
  if (KEEP) {
    console.log('\n--keep: overlay left open. It closes after the idle timeout or via the tray menu.');
    return;
  }
  await step('goodbye   wave + fade, then quit', base(s, 'SessionEnd', { reason: 'prompt_input_exit' }), 0);
  const gone = await waitUntilGone(6000);
  console.log(
    gone
      ? '\n  overlay has exited.'
      : '\n  overlay is still running: another session (e.g. a real Claude Code one) is still open.',
  );
}

/** Polls /health until the overlay stops answering. */
async function waitUntilGone(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await health())) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function twoSessions() {
  const a = `sim-a-${randomId()}`;
  const b = `sim-b-${randomId()}`;
  const expect = async (label, check) => {
    const h = await health();
    const ok = check(h);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (health: ${h ? `${h.sessions} sessions, ${h.state}` : 'not running'})`);
    return ok;
  };

  console.log(`Sessions ${a} and ${b}\n`);
  await step('A starts: greeting', base(a, 'SessionStart', { source: 'startup' }), 3000);
  await step('B starts: greeting', base(b, 'SessionStart', { source: 'startup' }), 3000);
  const results = [];
  results.push(await expect('two sessions tracked', (h) => h && h.sessions === 2));
  await step('A thinking', base(a, 'UserPromptSubmit', { prompt: 'x' }), 1500);
  await step('A typing', tool(a, 'PreToolUse', 'Edit', { file_path: 'a.js' }, 'toolu_a1'), 2000);
  await step('A ends (mid-edit)', base(a, 'SessionEnd', { reason: 'prompt_input_exit' }), 4500);
  results.push(await expect('A ended, buddy still here', (h) => h && h.sessions === 1 && h.state === 'idle'));
  await step('B thinking', base(b, 'UserPromptSubmit', { prompt: 'y' }), 1500);
  await step('B done', base(b, 'Stop', {}), 3500);
  await step('B ends: goodbye', base(b, 'SessionEnd', { reason: 'prompt_input_exit' }), 0);
  await waitUntilGone(6000);
  results.push(await expect('B ended, buddy gone', (h) => h === null));
  console.log(results.every(Boolean) ? '\nAll checks passed.' : '\nSome checks FAILED.');
  if (!results.every(Boolean)) process.exitCode = 1;
}

async function playground() {
  const s = `sim-play-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 3000);
  console.log(`
  The buddy is idle now. Things to try:
    - move the cursor near it          its eyes follow (menu: eye icon turns this off)
    - rest the cursor on it            it waves, and the hover menu opens beside it
    - move away                        the menu closes after a moment
    - click it                         a little bounce
    - drag it                          it follows; near a bottom corner it snaps there
    - leave it alone for a minute      it rests (eyes half closed, no animation)
    - click anywhere else              clicks go to the windows below, as usual

  Press Enter to send a few work events, or Ctrl+C to stop (it will close on its own
  after the idle timeout).`);
  const lines = require('node:readline').createInterface({ input: process.stdin });
  for await (const _ of lines) {
    await step('thinking', base(s, 'UserPromptSubmit', { prompt: 'x' }), 2000);
    await step('typing', tool(s, 'PreToolUse', 'Edit', { file_path: 'playground.js' }, `toolu_p_${randomId()}`), 4000);
    await step('done', base(s, 'Stop', {}), 3500);
    console.log('  Press Enter again, or Ctrl+C to stop.');
  }
}

(async () => {
  const running = await health();
  console.log(
    running
      ? `Overlay already running on 127.0.0.1:${PORT}.`
      : `Overlay not running; the first SessionStart will start it (port ${PORT}).`,
  );
  if (scenario === 'two-sessions') await twoSessions();
  else if (scenario === 'tour') await tour();
  else if (scenario === 'playground') await playground();
  else {
    console.error(`Unknown scenario "${scenario}". Use "tour", "two-sessions" or "playground".`);
    process.exitCode = 1;
  }
})();
