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
 *   npm run simulate -- life            every ambient-life behaviour in turn, then three quick
 *                                       taps (it gets angry and moves: the new place is saved),
 *                                       the sword duel and the cat. No mouse needed.
 *   npm run simulate -- lifecycle       Claude Code starting, /clear, /resume, a quick restart,
 *                                       a crash (process killed, no SessionEnd) and a normal
 *                                       exit, with PASS/FAIL checks. Uses stand-in "claude"
 *                                       processes. Run it against the test overlay, or with no
 *                                       Claude Code session open (it waits for the goodbye).
 *   npm run simulate -- chat            a short turn, then the chat panel opens by itself and
 *                                       two questions are answered from what the overlay knows
 *                                       (with the mouse: the chat button in the hover menu).
 *   npm run simulate -- bug             the bug hunt: "npm test" fails, a bug turns up and the
 *                                       buddy fights it while it works (not while it waits for
 *                                       approval); "npm test" passes and it beats the bug. Then
 *                                       a helper's lint fails (the helper jumps), the main
 *                                       session fixes it and the helpers cheer. Last, a failing
 *                                       build whose session ends: that bug escapes.
 *   npm run simulate -- popcorn         a command that runs on and on: after 20 s it sits back
 *                                       with popcorn (the bubble keeps the command), then the
 *                                       command ends and it gets up again
 *   npm run simulate -- duck            stuck: five steps fail in a row (it sweats from the
 *                                       third), out comes the rubber duck; the sixth works:
 *                                       "Thanks, duck!" and the duck hops off
 *   npm run simulate -- press           a compaction: PreCompact (the hook sends the event only),
 *                                       it pumps a little press for a while; then the session
 *                                       comes back compacted: its head is squeezed and a cube of
 *                                       paper pops out
 *   npm run simulate -- plan            a plan up for approval (ExitPlanMode): a blueprint unrolls
 *                                       and waits, approved: a stamp; a second one is not taken
 *                                       (a new prompt comes): it rolls up
 *   npm run simulate -- pr              git push (the rocket), then gh pr create (an envelope)
 *   npm run simulate -- mcp             three MCP calls: the first plugs in, the others not again
 *   npm run simulate -- terminal        terminal commands: a merge conflict, merge, a new branch,
 *                                       stash, stash pop, pull, force push, reset --hard, npm install
 *   npm run simulate -- giant           the giant peek (whatever its switch says): it walks up
 *                                       to the glass from where it stands, bigger with every step
 *                                       (up to ten times its size), knocks, listens, knocks again;
 *                                       with nobody answering it shrugs and walks back to its spot
 *                                       (move the pointer onto it meanwhile: "There you are!" and
 *                                       it runs back)
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
    // Not from a Claude Code process: no pid, so the session lives until its SessionEnd
    // (with --keep, until the idle timeout), as before.
    const child = spawn(process.execPath, [SEND, input.hook_event_name], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PERCHBOT_NO_PID: '1' },
    });
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

/**
 * Ask the overlay for one of the character's own behaviours ("Demo" event,
 * accepted from local processes only; Claude Code's hook never sends it).
 */
function demo(session, name) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ v: 1, event: 'Demo', session, ts: Date.now(), demo: name });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path: '/event',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 1000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

async function act(session, name, label, waitMs) {
  const status = await demo(session, name);
  console.log(`  ${'Demo'.padEnd(18)} -> ${label.padEnd(30)} (${status === 204 ? 'ok' : `HTTP ${status || 'error'}`})`);
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
  await waitUntilGone(10000);
  results.push(await expect('B ended, buddy gone', (h) => h === null));
  console.log(results.every(Boolean) ? '\nAll checks passed.' : '\nSome checks FAILED.');
  if (!results.every(Boolean)) process.exitCode = 1;
}

/**
 * A stand-in for a Claude Code process: it runs hooks/send.js as its own child
 * (as Claude Code does, minus the shell), so the hook finds THIS process as
 * "Claude Code" and reports its pid. Killing it is a crash: no SessionEnd.
 */
const FAKE_CLAUDE = `
const { spawn } = require('node:child_process');
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  // What Claude Code gives its hooks: its own pid, and CLAUDECODE=1.
  const env = { ...process.env, CLAUDE_PID: String(process.pid), CLAUDECODE: '1' };
  delete env.PERCHBOT_NO_PID;
  delete env.AGENT_BUDDY_NO_PID;
  const event = JSON.parse(line).hook_event_name;
  const child = spawn(process.execPath, [${JSON.stringify(SEND)}, event], { stdio: ['pipe', 'ignore', 'ignore'], env });
  child.on('close', () => process.stdout.write('done\\n'));
  child.stdin.end(line);
});
setInterval(() => {}, 1 << 30);
`;

class FakeClaude {
  constructor() {
    this.proc = spawn(process.execPath, ['-e', FAKE_CLAUDE], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.waiting = [];
    this.proc.stdout.on('data', (d) => {
      for (const _ of String(d).split('done').slice(1)) (this.waiting.shift() || (() => {}))();
    });
  }

  get pid() {
    return this.proc.pid;
  }

  /** Run one hook and wait until send.js has finished. */
  hook(input, label) {
    return new Promise((resolve) => {
      const started = Date.now();
      this.waiting.push(() => {
        console.log(`  ${input.hook_event_name.padEnd(18)} -> ${label.padEnd(36)} (${Date.now() - started} ms)`);
        resolve();
      });
      this.proc.stdin.write(JSON.stringify(input) + '\n');
    });
  }

  /** Like closing the terminal window with X: the process is gone, no SessionEnd. */
  kill() {
    this.proc.kill();
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll fn every 200 ms until it returns something truthy; null after timeoutMs. */
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await pause(200);
  }
  return null;
}

/** Every state seen in the next ms ('down' = the overlay did not answer). */
async function statesFor(ms) {
  const seen = new Set();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const h = await health();
    seen.add(h ? h.state : 'down');
    await pause(200);
  }
  return [...seen];
}

async function lifecycle() {
  const results = [];
  const check = (label, ok, detail) => {
    results.push(Boolean(ok));
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
  };
  const id = (name) => `life-${name}-${randomId()}`;
  const calm = (seen) => !seen.includes('goodbye') && !seen.includes('down');

  console.log('1. Claude Code starts: the buddy appears and greets, no prompt needed');
  let claude = new FakeClaude();
  const a = id('a');
  await claude.hook(base(a, 'SessionStart', { source: 'startup' }), 'startup (stand-in claude, pid found by the hook)');
  let h = await waitFor(health, 6000);
  check('it is there after SessionStart', h && h.sessions >= 1 && ['greeting', 'idle'].includes(h.state), h ? `${h.state}, ${h.sessions} session(s)` : 'not running');

  console.log('2. /clear: the session ends and the next one starts at once');
  const b = id('b');
  await claude.hook(base(a, 'SessionEnd', { reason: 'clear' }), 'SessionEnd (clear)');
  await claude.hook(base(b, 'SessionStart', { source: 'clear' }), 'SessionStart (clear)');
  let seen = await statesFor(5000);
  check('it stays, no goodbye', calm(seen), seen.join(', '));

  console.log('3. /resume: another conversation is picked');
  const c = id('c');
  await claude.hook(base(b, 'SessionEnd', { reason: 'resume' }), 'SessionEnd (resume)');
  await pause(800);
  await claude.hook(base(c, 'SessionStart', { source: 'resume' }), 'SessionStart (resume)');
  seen = await statesFor(5000);
  check('it stays, no goodbye', calm(seen), seen.join(', '));

  console.log('4. Quit (/exit) and start Claude Code again within 1.5 s');
  await claude.hook(base(c, 'SessionEnd', { reason: 'prompt_input_exit' }), 'SessionEnd (prompt_input_exit)');
  claude.kill();
  await pause(1500);
  claude = new FakeClaude();
  const d = id('d');
  await claude.hook(base(d, 'SessionStart', { source: 'startup' }), 'startup (a new claude process)');
  seen = await statesFor(5000);
  check('it stays, no goodbye in between', calm(seen), seen.join(', '));

  console.log('5. Crash: the terminal window is closed with X, no SessionEnd');
  claude.kill();
  console.log(`  ${''.padEnd(18)}    stand-in claude killed; liveness check every 5 s, then 2.5 s wait`);
  const t0 = Date.now();
  const left = await waitFor(async () => {
    const x = await health();
    return !x || x.state === 'goodbye' || x.sessions === 0;
  }, 15000);
  check('the session closes by itself, then goodbye', left, `${((Date.now() - t0) / 1000).toFixed(1)} s after the kill`);
  await waitUntilGone(10000);

  console.log('6. Claude Code starts again and exits normally');
  claude = new FakeClaude();
  const e = id('e');
  await claude.hook(base(e, 'SessionStart', { source: 'startup' }), 'startup');
  h = await waitFor(health, 6000);
  check('it comes back at SessionStart', h && h.sessions >= 1, h ? `${h.state}, ${h.sessions} session(s)` : 'not running');
  await claude.hook(base(e, 'SessionEnd', { reason: 'prompt_input_exit' }), 'SessionEnd (prompt_input_exit)');
  claude.kill();
  const t1 = Date.now();
  const gone = await waitUntilGone(10000);
  check('it waves goodbye and quits after the short wait', gone, `${((Date.now() - t1) / 1000).toFixed(1)} s`);

  const passed = results.filter(Boolean).length;
  console.log(passed === results.length ? `All ${passed} checks passed.` : `${results.length - passed} of ${results.length} checks FAILED.`);
  if (passed !== results.length) process.exitCode = 1;
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

async function life() {
  const s = `sim-life-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 3000);
  await step('done, then idle', base(s, 'Stop', {}), 4000);
  console.log('\n  Ambient life, one behaviour at a time:');
  await act(s, 'stretch', 'stretch and yawn', 3500);
  await act(s, 'look', 'look around', 3000);
  await act(s, 'jump', 'a little hop', 2200);
  await act(s, 'ball', 'play with a ball', 5000);
  await act(s, 'antenna', 'play with its antenna', 3500);
  await act(s, 'flip', 'a backflip', 2500);
  await act(s, 'reboot', 'reboot itself', 3800);
  await act(s, 'polish', 'polish its face screen', 4400);
  await act(s, 'sneeze', 'sneeze', 3500);
  await act(s, 'moonwalk', 'moonwalk on the spot', 4200);
  await act(s, 'hum', 'hum a tune', 4000);
  await act(s, 'sit', 'sit down and swing its legs', 5000);
  await act(s, 'fog', 'breathe on the glass, draw a heart in the fog', 6500);
  await act(s, 'yoyo', 'play with a yo-yo', 5500);
  await act(s, 'juggle', 'juggle three balls (the last one on its head)', 6500);
  await act(s, 'read', 'take a book out and read a little', 9500);
  await act(s, 'bubbles', 'blow soap bubbles', 7500);
  await act(s, 'plane', 'throw a paper plane that loops back', 6500);
  await act(s, 'where', 'walk up to the glass and knock: "Where are you?"', 6500);
  await act(s, 'guest', 'a visitor drops by: they chat and practise with swords', 24000);
  await act(s, 'walk', 'walk along the taskbar', 7000);
  await act(s, 'fly', 'a short flight on its thrusters', 5000);
  await act(s, 'inspect', 'fly over to the cursor, have a look', 7000);
  await act(s, 'loop', 'a hop with a loop-the-loop', 6000);
  await act(s, 'cruise', 'a slow, long, wavy flight', 12000);
  await act(s, 'hang', 'up to the top edge, hang from it', 8000);
  await act(s, 'home', 'back home', 5000);
  console.log('\n  Quick taps it loves (no mouse): happy hops and hearts.');
  await act(s, 'glee', 'tap, tap, tap, tap, tap', 3500);
  console.log('\n  Three quick taps it does not want (no mouse): it gets angry and moves; the new place is saved.');
  console.log('  ("Back to the corner" in its menu brings it back.)');
  await act(s, 'anger', 'tap, tap, tap', 7000);
  console.log('\n  Keep at it and it gets angrier: fuming, then its head catches fire and it erupts.');
  await act(s, 'rage', 'tap x3, it leaves fuming, tap x3 where it landed', 12000);
  console.log('\n  Its head on fire twice in five minutes: three burn lines, missiles, then five seconds after the cursor;');
  console.log('  the marks fade 5-10 s after the last blast.');
  await act(s, 'rampage', 'laser eyes, missiles, then beams and missiles after the cursor', 26000);
  console.log('\n  Play: the sword duel (plays itself here; with the mouse, every click is a swing).');
  await act(s, 'duel', 'sword duel', 26000);
  console.log('\n  The cat: walks in, plays with the buddy, then naps aside.');
  await act(s, 'cat', 'call the cat', 16000);
  await act(s, 'cat-away', 'send the cat away', 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

async function bugHunt() {
  const s = `sim-bug-${randomId()}`;
  let n = 0;
  const run = async (label, command, ok, holdMs, afterMs) => {
    const id = `toolu_bug_${(n += 1)}`;
    await step(label, tool(s, 'PreToolUse', 'Bash', { command, description: 'Run a check' }, id), holdMs);
    await step(ok ? '(passed)' : '(FAILED: a bug turns up)', tool(s, ok ? 'PostToolUse' : 'PostToolUseFailure', 'Bash', { command }, id), afterMs);
  };
  const edit = async (label, file, holdMs) => {
    const id = `toolu_bug_${(n += 1)}`;
    const input = { file_path: path.join(ROOT, 'app', file), old_string: 'a', new_string: 'b' };
    await step(label, tool(s, 'PreToolUse', 'Edit', input, id), holdMs);
    await step('(edit done)', tool(s, 'PostToolUse', 'Edit', input, id), 1200);
  };

  console.log(`Session ${s}
`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  await run('running   npm test', 'npm test', false, 2500, 4500);
  await step('thinking  (still fighting)', null, 2500);
  await edit('typing    core.js (fighting)', 'core.js', 4000);
  await step('waiting   (fight pauses)', base(s, 'Notification', {
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  }), 4000);
  await edit('typing    bugs.js (fighting again)', 'bugs.js', 3500);
  await run('running   npm test -- -t bug', 'npm test -- -t bug', true, 2000, 4500);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);

  // A helper's check fails; the main session fixes it.
  const helper = { agent_id: `sim-helper-${randomId()}`, agent_type: 'Explore' };
  const htool = (event, name, input, id) => base(s, event, { tool_name: name, tool_input: input, tool_use_id: id, ...helper });
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1200);
  await step('helper starts', base(s, 'SubagentStart', helper), 3500);
  await step('helper runs   npm run lint', htool('PreToolUse', 'Bash', { command: 'npm run lint' }, 'toolu_h1'), 1500);
  await step('(helper FAILED: a bug, it jumps)', htool('PostToolUseFailure', 'Bash', { command: 'npm run lint' }, 'toolu_h1'), 4000);
  await step('helper is done (bug stays)', base(s, 'SubagentStop', helper), 2000);
  await run('running   npm run lint', 'npm run lint', true, 2000, 4500);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3000);

  // A second session whose build fails and which then just ends: its bug escapes.
  const s2 = `sim-bug2-${randomId()}`;
  const id = 'toolu_bug_build';
  await step('second session', base(s2, 'SessionStart', { source: 'startup' }), 1500);
  await step('running   npm run build', tool(s2, 'PreToolUse', 'Bash', { command: 'npm run build' }, id), 1500);
  await step('(FAILED: another bug)', tool(s2, 'PostToolUseFailure', 'Bash', { command: 'npm run build' }, id), 4000);
  await step('second session ends: it escapes', base(s2, 'SessionEnd', { reason: 'other' }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/** A command that runs on and on (core.js snackMs): popcorn after 20 s, then it ends. */
async function popcornScenario() {
  const s = `sim-popcorn-${randomId()}`;
  const id = 'toolu_pop_1';
  const input = { command: 'npm install', description: 'Install the dependencies' };
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  // Not halved by --fast: the 20 s are the overlay's own.
  await step('running   npm install (20 s, then popcorn)', tool(s, 'PreToolUse', 'Bash', input, id), 0);
  await new Promise((resolve) => setTimeout(resolve, 30000));
  await step('(it ends: up it gets)', tool(s, 'PostToolUse', 'Bash', input, id), 3000);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/** Stuck (app/moments.js DUCK_AFTER): the sweat at 3, the rubber duck at 5, thanks at the fix. */
async function duckScenario() {
  const s = `sim-duck-${randomId()}`;
  let n = 0;
  const edit = async (label, ok, holdMs, afterMs) => {
    const id = `toolu_duck_${(n += 1)}`;
    const input = { file_path: path.join(ROOT, 'app', 'core.js'), old_string: 'a', new_string: 'b' };
    await step(label, tool(s, 'PreToolUse', 'Edit', input, id), holdMs);
    await step(ok ? '(it worked)' : '(failed)', tool(s, ok ? 'PostToolUse' : 'PostToolUseFailure', 'Edit', input, id), afterMs);
  };
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  await edit('typing    core.js (1)', false, 1200, 1500);
  await edit('typing    core.js (2)', false, 1200, 1500);
  await edit('typing    core.js (3: it sweats)', false, 1200, 2500);
  await edit('typing    core.js (4)', false, 1200, 1500);
  await edit('typing    core.js (5: the duck)', false, 1200, 6000);
  await edit('typing    core.js (duck on its head)', true, 3000, 4000);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/** The giant peek (app/giant.js), as a demo: normally the idle story's finale with the "Giant peek" switch on. */
async function giantScenario() {
  const s = `sim-giant-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 3000);
  await step('done, then idle', base(s, 'Stop', {}), 4000);
  await act(s, 'giant', 'the giant peek (pointer on it: found)', 17000);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/** A compaction (PreCompact, then SessionStart with source "compact"): the press, the squeeze, a cube. */
async function pressScenario() {
  const s = `sim-press-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  // Its custom instructions never leave the hook (see the privacy test).
  await step('compacting: the press', base(s, 'PreCompact', { trigger: 'auto', custom_instructions: '(never sent)' }), 8000);
  await step('compacted: squeeze + a cube', base(s, 'SessionStart', { source: 'compact' }), 3500);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/**
 * A plan up for approval (ExitPlanMode): the blueprint unrolls and waits; approved: the stamp.
 * Then a second plan that is not taken (a new prompt comes instead): it just rolls up.
 */
async function planScenario() {
  const s = `sim-plan-${randomId()}`;
  // The plan's text never leaves the hook (the privacy allowlist).
  const input = { plan: '(simulated plan: never sent)' };
  const waiting = { message: 'Claude needs your permission to use ExitPlanMode', notification_type: 'permission_prompt' };
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  await step('plan up   (the blueprint unrolls)', tool(s, 'PreToolUse', 'ExitPlanMode', input, 'toolu_plan_1'), 1200);
  await step('waiting   for approval', base(s, 'Notification', waiting), 4000);
  await step('approved  (the stamp)', tool(s, 'PostToolUse', 'ExitPlanMode', input, 'toolu_plan_1'), 3000);
  await step('typing    notes.md', tool(s, 'PreToolUse', 'Write', { file_path: path.join(ROOT, 'notes.md'), content: 'x' }, 'toolu_plan_w'), 1500);
  await step('back to thinking', tool(s, 'PostToolUse', 'Write', {}, 'toolu_plan_w'), 1000);
  await step('plan up   again', tool(s, 'PreToolUse', 'ExitPlanMode', input, 'toolu_plan_2'), 1200);
  await step('waiting   for approval', base(s, 'Notification', waiting), 3500);
  await step('a new prompt instead (it rolls up)', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 2500);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/** A pull request: git push, then `gh pr create` works: the rocket, then the envelope. */
async function prScenario() {
  const s = `sim-pr-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  const push = { command: 'git push -u origin feature' };
  await step('running   git push', tool(s, 'PreToolUse', 'Bash', push, 'toolu_pr_1'), 1500);
  await step('(pushed: the rocket)', tool(s, 'PostToolUse', 'Bash', push, 'toolu_pr_1'), 3000);
  const pr = { command: 'gh pr create --fill' };
  await step('running   gh pr create', tool(s, 'PreToolUse', 'Bash', pr, 'toolu_pr_2'), 1500);
  await step('(PR open: the envelope)', tool(s, 'PostToolUse', 'Bash', pr, 'toolu_pr_2'), 3500);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/** MCP tools: the first one plugs in; the next ones within PLUG_GAP_MS (30 s) do not again. */
async function mcpScenario() {
  const s = `sim-mcp-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  for (let i = 1; i <= 3; i += 1) {
    const id = `toolu_mcp_${i}`;
    await step(i === 1 ? 'mcp       github (plugs in)' : `mcp       github (${i}: no plug again so soon)`, tool(s, 'PreToolUse', 'mcp__github__list_issues', {}, id), 2800);
    await step('back to thinking', tool(s, 'PostToolUse', 'mcp__github__list_issues', {}, id), 1200);
  }
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

/**
 * Terminal commands, one after the other (each worked, but the first merge): merge conflict,
 * merge, new branch, stash, stash pop, pull, force push (with the old rocket), reset --hard,
 * npm install. A command that is none of these (npm run build) shows nothing new.
 */
async function terminalScenario() {
  const s = `sim-terminal-${randomId()}`;
  let n = 0;
  const run = async (label, command, ok = true, afterMs = 3200) => {
    const id = `toolu_term_${(n += 1)}`;
    const input = { command };
    await step(`running   ${label}`, tool(s, 'PreToolUse', 'Bash', input, id), 1200);
    await step(ok ? '(it worked)' : '(it failed)', tool(s, ok ? 'PostToolUse' : 'PostToolUseFailure', 'Bash', input, id), afterMs);
  };
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1500);
  await run('git merge feature (a conflict)', 'git merge feature', false);
  await run('git merge feature', 'git merge feature');
  await run('git checkout -b fix-login (a new branch)', 'git checkout -b fix-login');
  await run('git stash', 'git stash');
  await run('git stash pop', 'git stash pop');
  await run('git pull', 'git pull');
  await run('git push --force (rocket + siren)', 'git push --force');
  await run('git reset --hard HEAD~1', 'git reset --hard HEAD~1');
  await run('npm install', 'npm install');
  await run('npm run build (nothing new)', 'npm run build', true, 2000);
  await step('done', base(s, 'Stop', { stop_hook_active: false }), 3500);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
}

async function chatScenario() {
  const s = `sim-chat-${randomId()}`;
  console.log(`Session ${s}\n`);
  await step('greeting', base(s, 'SessionStart', { source: 'startup' }), 2500);
  await step('thinking', base(s, 'UserPromptSubmit', { prompt: '(simulated prompt)' }), 1200);
  await step('reading core.js', tool(s, 'PreToolUse', 'Read', { file_path: path.join(ROOT, 'app', 'core.js') }, 'c1'), 900);
  await step('back to thinking', tool(s, 'PostToolUse', 'Read', {}, 'c1'), 600);
  await step('editing chat.js', tool(s, 'PreToolUse', 'Edit', { file_path: path.join(ROOT, 'app', 'chat.js') }, 'c2'), 600);
  console.log('\n  The chat panel opens; it asks "What are you doing?", then "How many tools?".');
  await act(s, 'chat', 'chat panel', 12500);
  await step('back to thinking', tool(s, 'PostToolUse', 'Edit', {}, 'c2'), 600);
  await step('done', base(s, 'Stop', {}), 3000);
  if (!KEEP) await step('session ends (goodbye)', base(s, 'SessionEnd', { reason: 'other' }), 3500);
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
  else if (scenario === 'life') await life();
  else if (scenario === 'lifecycle') await lifecycle();
  else if (scenario === 'chat') await chatScenario();
  else if (scenario === 'bug') await bugHunt();
  else if (scenario === 'popcorn') await popcornScenario();
  else if (scenario === 'duck') await duckScenario();
  else if (scenario === 'press') await pressScenario();
  else if (scenario === 'plan') await planScenario();
  else if (scenario === 'pr') await prScenario();
  else if (scenario === 'mcp') await mcpScenario();
  else if (scenario === 'terminal') await terminalScenario();
  else if (scenario === 'giant') await giantScenario();
  else {
    console.error(`Unknown scenario "${scenario}". Use "tour", "two-sessions", "playground", "life", "lifecycle", "chat", "bug", "popcorn", "duck", "press", "plan", "pr", "mcp", "terminal" or "giant".`);
    process.exitCode = 1;
  }
})();
