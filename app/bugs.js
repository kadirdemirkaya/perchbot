'use strict';

/**
 * Bug hunt: a failing check (a test, build, lint or type-check command) opens
 * a "bug"; a later successful run of the same check fixes it. Only what the
 * hook events already say is used: the command core of a PreToolUse (detail)
 * paired by tool id with its PostToolUse / PostToolUseFailure. Pure, with an
 * injectable clock, so node:test drives it.
 *
 * One bug at a time. Phases: 'open' -> 'fixed' (kept for the victory, then
 * gone) or 'escaped' (too old, or its session ended; kept for the exit, then
 * gone). onChange(bug | null) on every change.
 */

const CHECK_RE =
  /\b(test|tests|spec|jest|vitest|mocha|pytest|unittest|rspec|phpunit|tox|lint|eslint|ruff|flake8|pylint|mypy|pyright|tsc|typecheck|check|build|compile|make|cmake|ctest|cargo|gradle|gradlew|mvn|dotnet|xcodebuild)\b/i;
const GO_CHECK_RE = /^go\s+(test|build|vet)\b/i;
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

const BUG_TIMINGS = Object.freeze({
  /** A bug nobody fixed scuttles off after this long. */
  maxMs: 20 * 60 * 1000,
  /** How long 'fixed' / 'escaped' stay before the bug is gone (the page animates them). */
  winMs: 3200,
  escapeMs: 1500,
  /** Tool ids remembered per session (commands whose result has not come yet). */
  maxPending: 32,
});

/** Does this command core look like a check whose failure is a bug? */
function isCheck(core) {
  if (typeof core !== 'string' || !core.trim()) return false;
  const text = core.trim();
  return GO_CHECK_RE.test(text) || CHECK_RE.test(text);
}

/**
 * Which runs count as "the same check": the first word, plus the second when
 * it is a plain word or flag (not a path or file). "npm test" ~ "npm test --
 * -t x", "cargo test -p a" ~ "cargo test", "pytest a.py" ~ "pytest b.py".
 */
function checkKey(core) {
  const words = String(core || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = words[0].toLowerCase();
  const second = words[1] && /^-{0,2}[a-z][\w:-]*$/i.test(words[1]) ? ` ${words[1].toLowerCase()}` : '';
  return first + second;
}

class BugWatch {
  /**
   * @param {object} [o]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [o.clock]
   * @param {() => number} [o.now]  ms
   * @param {Partial<typeof BUG_TIMINGS>} [o.timings]
   * @param {(bug: object | null) => void} [o.onChange]
   */
  constructor({ clock = { setTimeout, clearTimeout }, now = Date.now, timings = {}, onChange = () => {} } = {}) {
    this.clock = clock;
    this.now = now;
    this.t = { ...BUG_TIMINGS, ...timings };
    this.onChange = onChange;
    /** session -> Map(tool id -> check key) */
    this.pending = new Map();
    this.bug = null;
    this.nextId = 1;
    this.timer = null;
  }

  /** The bug right now: { id, phase, session, key, since } or null. */
  current() {
    return this.bug ? { ...this.bug } : null;
  }

  /** A main-session PreToolUse. Remembers commands that look like checks. */
  toolStart(session, id, tool, detail) {
    if (!id || !COMMAND_TOOLS.has(tool) || !isCheck(detail)) return;
    if (!this.pending.has(session)) this.pending.set(session, new Map());
    const map = this.pending.get(session);
    map.set(id, checkKey(detail));
    while (map.size > this.t.maxPending) map.delete(map.keys().next().value);
  }

  /** Its result: ok = PostToolUse, not ok = PostToolUseFailure. */
  toolEnd(session, id, ok) {
    const map = this.pending.get(session);
    if (!id || !map || !map.has(id)) return;
    const key = map.get(id);
    map.delete(id);
    if (!ok && !this.bug) {
      this.set({ id: this.nextId++, phase: 'open', session, key, since: this.now() });
      this.after(this.t.maxMs, () => this.end('escaped'));
    } else if (ok && this.bug && this.bug.phase === 'open' && this.bug.session === session && this.bug.key === key) {
      this.end('fixed');
    }
  }

  /** The session ended (or its process is gone): its bug scuttles off. */
  sessionGone(session) {
    this.pending.delete(session);
    if (this.bug && this.bug.phase === 'open' && this.bug.session === session) this.end('escaped');
  }

  end(phase) {
    if (!this.bug || this.bug.phase !== 'open') return;
    this.set({ ...this.bug, phase });
    this.after(phase === 'fixed' ? this.t.winMs : this.t.escapeMs, () => this.set(null));
  }

  set(bug) {
    this.bug = bug;
    this.onChange(this.current());
  }

  after(ms, fn) {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  dispose() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { BugWatch, isCheck, checkKey, BUG_TIMINGS };
