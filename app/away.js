'use strict';

/**
 * "While you were away" (its switch is on by default): back at the computer after a
 * while (app/presence.js), and things happened in the meantime, a giant of it walks up
 * holding a board: how long the user was away, how many turns were done, commits and
 * pushes, and how things stand now (Claude Code waits for the user, a check still fails,
 * it is still at work). Only counts and times, from the hook events the overlay already
 * had: nothing new is collected, nothing is written anywhere, and it all stays in memory.
 *
 * As pure logic: main.js notes what happens (note), asks when the user is back
 * (summary), and boardLines puts it into the user's words.
 */

const AWAY = Object.freeze({
  /** At most this many happenings are kept (the oldest go first)... */
  keep: 500,
  /** ...and none older than this (ms). */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** The board holds at most this many lines below its title. */
  lines: 4,
  /** Each line (and the title) is cut to this many characters (they come from our own strings anyway). */
  maxChars: 60,
});

/** What is counted: a turn done (Stop), a commit, a push (app/moments.js). */
const KINDS = new Set(['done', 'commit', 'push']);
/** Claude Code waits for the user (app/core.js NOTIFICATIONS: the sticky ones). */
const WAITING = new Set(['waiting', 'asking']);
/** Still at work. */
const WORKING = new Set(['thinking', 'typing', 'reading', 'running', 'working']);
/** The board's lines, each with a little sign of its own (renderer/giant.css). */
const LINE_KINDS = Object.freeze(['done', 'git', 'waiting', 'bug', 'working']);

class AwayLog {
  constructor(options = {}) {
    this.o = { ...AWAY, ...options };
    /** [{ kind, at }], oldest first. */
    this.events = [];
  }

  /** Something happened (always noted: when the user went away is known only later). */
  note(kind, at = Date.now()) {
    if (!KINDS.has(kind) || !Number.isFinite(at)) return;
    this.events.push({ kind, at });
    this.prune(at);
  }

  prune(now) {
    const oldest = now - this.o.maxAgeMs;
    while (this.events.length > 0 && (this.events.length > this.o.keep || this.events[0].at < oldest)) this.events.shift();
  }

  /**
   * What happened from `since` (the user's last input) to `now`, and how things stand.
   * null: nothing worth a board (nothing was done, nothing waits, nothing is broken).
   * @param {{ since: number, now?: number, state?: string, bug?: boolean }} p
   * @returns {null | { awayMs: number, done: number, commits: number, pushes: number, waiting: boolean, bug: boolean, working: boolean }}
   */
  summary({ since, now = Date.now(), state = 'idle', bug = false } = {}) {
    if (!Number.isFinite(since) || !Number.isFinite(now) || now <= since) return null;
    this.prune(now);
    const count = (kind) => this.events.filter((e) => e.kind === kind && e.at >= since && e.at <= now).length;
    const s = {
      awayMs: now - since,
      done: count('done'),
      commits: count('commit'),
      pushes: count('push'),
      waiting: WAITING.has(state),
      bug: bug === true,
      working: WORKING.has(state),
    };
    if (!s.done && !s.commits && !s.pushes && !s.waiting && !s.bug) return null;
    return s;
  }
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The board in words: { title, lines: [{ kind, text }], short } (short: the first two lines
 * in one, for the small bubble when no giant fits). null without a summary.
 * @param {ReturnType<AwayLog['summary']>} s
 * @param {(key: string, vars?: object) => string} t  the 'quip' strings in the user's language
 * @param {string} time  how long the user was away, already in words ("18 min")
 */
function boardLines(s, t, time, o = AWAY) {
  if (!s) return null;
  const lines = [];
  if (s.done) lines.push({ kind: 'done', text: t(s.done === 1 ? 'awayDoneOne' : 'awayDone', { count: s.done }) });
  const git = [];
  if (s.commits) git.push(t(s.commits === 1 ? 'awayCommitOne' : 'awayCommits', { count: s.commits }));
  if (s.pushes) git.push(t(s.pushes === 1 ? 'awayPushOne' : 'awayPushes', { count: s.pushes }));
  if (git.length) lines.push({ kind: 'git', text: git.join(' · ') });
  if (s.waiting) lines.push({ kind: 'waiting', text: t('awayWaiting') });
  if (s.bug) lines.push({ kind: 'bug', text: t('awayBug') });
  if (s.working && !s.waiting) lines.push({ kind: 'working', text: t('awayWorking') });
  const shown = lines.slice(0, o.lines).map((l) => ({ kind: l.kind, text: cut(String(l.text), o.maxChars) }));
  return {
    title: cut(String(t('awayTitle', { time })), o.maxChars),
    lines: shown,
    short: shown
      .slice(0, 2)
      .map((l) => l.text)
      .join(' · '),
  };
}

/** How long, in whole minutes (at least one): the board needs no seconds. */
function awayMinutesMs(ms) {
  return Math.max(1, Math.round((Number(ms) || 0) / 60000)) * 60000;
}

module.exports = { AwayLog, AWAY, KINDS, LINE_KINDS, boardLines, awayMinutesMs };
