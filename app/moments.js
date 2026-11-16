'use strict';

/**
 * Moments in Claude Code's work worth a little show, as pure logic. Only from
 * what the hook already sends (the event, the tool, its shortened command);
 * nothing new is collected.
 *
 *   commit   a `git commit` ran and worked: a flag goes up
 *   push     a `git push` ran and worked: a rocket takes off
 *   sweat    SWEAT_AFTER tools failed in a row: it sweats until one works
 *   duck     DUCK_AFTER tools failed in a row (still sweating): stuck, so out
 *            comes a rubber duck to explain it to; the duck stays on its head
 *            until a tool works or the turn ends (core.js snapshot().duck)
 *   phew     the first tool that works after that
 *   squeeze  the conversation was compacted (SessionStart, source "compact")
 *   cube     ...and the press had been running (PreCompact came first): a
 *            cube of paper pops out of it (installs from before 0.6.0 have
 *            no PreCompact hook: just the squeeze, as before)
 *   pr       a `gh pr create` ran and worked: an envelope is sealed and flies off
 *   plan     Claude Code puts its plan up for approval (ExitPlanMode starts):
 *            a blueprint unrolls beside it and stays while the plan waits
 *   planOk   ...the plan was approved (ExitPlanMode worked): a stamp on it
 *   planOff  ...or not (it failed, another tool came, the turn or session
 *            ended): the blueprint rolls up again
 *   plug     an MCP tool starts (mcp__<server>__<tool>): a plug goes into a
 *            socket beside it (at most once every PLUG_GAP_MS)
 *
 * Also: the greeting by the time of day (greetingKey) and the "done" summary
 * of a longer turn (doneSummary).
 */

/** Tools whose detail is a shortened command. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
/** Failed tools in a row before it sweats. */
const SWEAT_AFTER = 3;
/** Failed tools in a row before the rubber duck comes out (a layer after the sweat). */
const DUCK_AFTER = 5;
/** Tool ids remembered between start and end (per watch). */
const PENDING_LIMIT = 64;
/** git options that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
/** gh options that take a value as the next word (before the command). */
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname']);
/** The tool that puts a plan up for approval. */
const PLAN_TOOL = 'ExitPlanMode';
/** MCP tools: one plug show, then none for this long (ms), however many calls follow. */
const PLUG_GAP_MS = 30000;

/**
 * The git commands in a (shortened) command line that count: 'commit' and
 * 'push', in the order they run. "git add -A && git commit -m x" -> ['commit'];
 * "git -C repo push" -> ['push']; "git log" -> [].
 */
function gitMoments(command) {
  if (typeof command !== 'string' || !command) return [];
  const out = [];
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/);
    // The command itself must be git (after any VAR=value): not "echo git commit".
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
    if (words[at] !== 'git') continue;
    for (let i = at + 1; i < words.length; i += 1) {
      const word = words[i];
      if (GIT_VALUE_OPTIONS.has(word)) {
        i += 1;
        continue;
      }
      if (word.startsWith('-')) continue;
      if (word === 'commit' || word === 'push') out.push(word);
      break;
    }
  }
  return out;
}

/**
 * The gh commands in a (shortened) command line that count: 'pr' for
 * `gh pr create`. "git push && gh pr create --fill" -> ['pr'];
 * "gh pr view 3" -> []; "echo gh pr create" -> [].
 */
function ghMoments(command) {
  if (typeof command !== 'string' || !command) return [];
  const out = [];
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/);
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
    if (words[at] !== 'gh') continue;
    const rest = [];
    for (let i = at + 1; i < words.length && rest.length < 2; i += 1) {
      if (GH_VALUE_OPTIONS.has(words[i])) {
        i += 1;
        continue;
      }
      if (!words[i].startsWith('-')) rest.push(words[i]);
    }
    if (rest[0] === 'pr' && rest[1] === 'create') out.push('pr');
  }
  return out;
}

class MomentWatch {
  constructor() {
    /** session|id -> ['commit' | 'push' | 'pr'] waiting for the tool to end. */
    this.pending = new Map();
    this.failures = 0;
    /** Sessions whose PreCompact came: the press runs until their compaction is over. */
    this.pressing = new Set();
    /** session -> the id of its ExitPlanMode waiting for approval (the blueprint is out). */
    this.plans = new Map();
    /** When the last plug show was (ms). */
    this.lastPlug = -Infinity;
  }

  get sweating() {
    return this.failures >= SWEAT_AFTER;
  }

  /** Stuck: the rubber duck is out (on its head) until a tool works or the streak is reset. */
  get ducking() {
    return this.failures >= DUCK_AFTER;
  }

  /** A tool starts: remember the git moments its command would make. */
  toolStart(session, id, tool, detail) {
    if (!id || !COMMAND_TOOLS.has(tool)) return;
    const kinds = [...gitMoments(detail), ...ghMoments(detail)];
    if (!kinds.length) return;
    this.pending.set(`${session}|${id}`, kinds);
    while (this.pending.size > PENDING_LIMIT) this.pending.delete(this.pending.keys().next().value);
  }

  /**
   * A tool ended (ok: it worked). Returns the moments it makes, in order.
   * @returns {string[]}
   */
  toolEnd(session, id, ok) {
    const out = [];
    const key = `${session}|${id}`;
    const kinds = id ? this.pending.get(key) : null;
    if (kinds) this.pending.delete(key);
    // The plan that waited for approval: approved (it worked) or not.
    const plan = Boolean(id) && this.plans.get(session) === id;
    if (plan) this.plans.delete(session);
    if (!ok) {
      if (plan) out.push('planOff');
      this.failures += 1;
      if (this.failures === SWEAT_AFTER) out.push('sweat');
      if (this.failures === DUCK_AFTER) out.push('duck');
      return out;
    }
    if (this.sweating) out.push('phew');
    this.failures = 0;
    if (kinds) out.push(...kinds);
    if (plan) out.push('planOk');
    return out;
  }

  /**
   * A tool starts (any tool of the main session): the shows that start with it.
   * ExitPlanMode: the blueprint ('plan'); any other tool while a plan waits: it
   * was not taken ('planOff'); an MCP tool: the plug ('plug', now and then).
   * @returns {string[]}
   */
  toolMoments(session, id, tool, now = Date.now()) {
    const out = [];
    if (typeof tool !== 'string') return out;
    if (tool === PLAN_TOOL) {
      if (!id) return out;
      if (!this.plans.has(session)) out.push('plan');
      this.plans.set(session, id);
      while (this.plans.size > PENDING_LIMIT) this.plans.delete(this.plans.keys().next().value);
      return out;
    }
    if (this.plans.has(session)) {
      this.plans.delete(session);
      out.push('planOff');
    }
    if (tool.startsWith('mcp__') && tool.split('__')[1] && now - this.lastPlug >= PLUG_GAP_MS) {
      this.lastPlug = now;
      out.push('plug');
    }
    return out;
  }

  /** A new prompt, a stop, a session that ends: a plan still out is rolled up. */
  planClose(session) {
    if (!this.plans.delete(session)) return [];
    return ['planOff'];
  }

  /** A new prompt, a stop, a session that ends: a fresh start for the streak. */
  calm() {
    this.failures = 0;
  }

  /** PreCompact: the press starts (core.js shows it). */
  preCompact(session) {
    this.pressing.add(session);
    while (this.pressing.size > PENDING_LIMIT) this.pressing.delete(this.pressing.values().next().value);
  }

  /** SessionStart: after a compaction it squeezes its head; a press that ran gives a cube. */
  sessionStart(source, session) {
    const pressed = this.pressing.delete(session);
    if (source !== 'compact') return [];
    return pressed ? ['squeeze', 'cube'] : ['squeeze'];
  }
}

/** The greeting's bubble key by the local hour: morning, evening, late at night, or plain. */
function greetingKey(hour) {
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) return 'greeting';
  if (h >= 5 && h < 11) return 'greetingMorning';
  if (h >= 18 && h < 23) return 'greetingEvening';
  if (h >= 23 || h < 5) return 'greetingNight';
  return 'greeting';
}

/** A turn worth a summary: this many tools, or this long (ms). */
const SUMMARY = Object.freeze({ tools: 3, ms: 60000 });

/**
 * The "done" bubble for a turn: { key: 'done' } for a short one, otherwise
 * { key: 'doneSummary', vars: { count, ms } } (main.js formats the time).
 * @param {{ tools: number, startedAt: number } | null} turn
 */
function doneMessage(turn, endedAt) {
  if (!turn || !Number.isFinite(turn.startedAt) || !Number.isFinite(endedAt)) return { key: 'done' };
  const ms = Math.max(0, endedAt - turn.startedAt);
  const tools = Number(turn.tools) || 0;
  if (tools < SUMMARY.tools && ms < SUMMARY.ms) return { key: 'done' };
  return { key: 'doneSummary', vars: { count: String(tools), ms } };
}

module.exports = { MomentWatch, gitMoments, ghMoments, greetingKey, doneMessage, SWEAT_AFTER, DUCK_AFTER, SUMMARY, COMMAND_TOOLS, PLAN_TOOL, PLUG_GAP_MS };
