'use strict';

/**
 * BuddyCore: the overlay's brain, with no Electron dependency so it can be
 * unit-tested with fake timers.
 *
 * Responsibilities
 *  - Turn validated hook events into a visual state ("view") for the character.
 *  - Keep tool states on screen briefly after a tool finishes (no flicker).
 *  - Track live sessions; when the last one ends, play goodbye and ask to quit.
 *  - Close a session whose Claude Code process died without SessionEnd
 *    (app/liveness.js), and wait a moment before goodbye in case a new session
 *    follows (restart, /clear, resume).
 *  - Quit on its own after a long period without events (crashed sessions).
 *  - Route sub-agent events to the AgentRegistry (the "minis"); they never
 *    change the main character's state.
 *  - Remember the skill the main session is using until its turn ends.
 *  - Show one Claude account only, if the user picked one (setAccountFilter):
 *    events of other accounts are ignored, apart from noting the account.
 *
 * Emits
 *  - 'state' ({ state, message, mood, skill })  whenever the view changes.
 *      message is null or { key, vars?, mono? }; translation happens elsewhere.
 *      skill is null or the name of the skill in use (the book comes out).
 *  - 'crew'  (agents)              whenever the list of sub-agents changes (see app/agents.js).
 *  - 'account' (name)              the first event of an account in this run.
 *  - 'gone'  (session, why)        a session closed because its process is gone.
 *  - 'quit'  (reason)              when the app should exit.
 *
 * Ordering: hooks run as separate async processes, so events can arrive slightly
 * out of order. Two safeguards handle that:
 *  - Pre/Post tool events are paired by tool_use_id; a PreToolUse whose
 *    PostToolUse was already seen is ignored.
 *  - Events stamped before the session's latest Stop are ignored.
 */

const { EventEmitter } = require('node:events');
const { stateForTool, bubbleForTool, stepForTool, isFileTool, TOOL_STATES } = require('./tools');
const { AgentRegistry } = require('./agents');
const { LivenessWatch } = require('./liveness');
const { BugWatch } = require('./bugs');

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

const DEFAULT_TIMINGS = Object.freeze({
  /** How long a tool state stays after the tool finished. */
  holdMs: 1500,
  /** How long "done" plays before falling back to idle. */
  doneMs: 3000,
  /** How long the greeting plays. */
  greetingMs: 2500,
  /** Goodbye animation length before the app quits. */
  goodbyeMs: 3000,
  /**
   * After the last session ends, wait this long before waving goodbye: a new
   * session often follows at once (Claude Code restarted, /clear, a resume).
   * If one comes, the buddy just stays. 0 = goodbye at once.
   */
  endGraceMs: 2500,
  /** The same after SessionEnd with reason clear / resume: a new session nearly always follows. */
  clearGraceMs: 4000,
  /** How long a calm notification (idle_prompt, unknown types) stays up. */
  idlePromptMs: 10000,
  /** Quit after this long without any event. 0 disables the safety net. */
  idleTimeoutMs: 30 * 60 * 1000,
});

/**
 * notification_type -> how the buddy shows it.
 *  sticky: stays until the next event (the user has to act); otherwise it
 *  times out after idlePromptMs.
 * Only a real permission prompt raises a hand and says "approval".
 */
const NOTIFICATIONS = {
  permission_prompt: { state: 'waiting', key: 'waiting', sticky: true },
  elicitation_dialog: { state: 'asking', key: 'question', sticky: true },
  elicitation_url_dialog: { state: 'asking', key: 'question', sticky: true },
  agent_needs_input: { state: 'asking', key: 'needsInput', sticky: true },
  idle_prompt: { state: 'standby', key: 'waitingForYou', sticky: false },
};
/** Missing or unknown notification types: a calm, generic look. */
const OTHER_NOTIFICATION = { state: 'standby', key: 'notice', sticky: false };
/** Known types that do not concern the user right now. */
const SILENT_NOTIFICATIONS = new Set(['auth_success']);

const RESTART_REASONS = new Set(['clear', 'resume']);
/** Recent steps (files read or written, commands run) shown in a row above the bubble. */
const STEP_LIMIT = 4;
/** States in which a notification is on screen (what it waits for: facts().waiting). */
const NOTICE_STATES = new Set(['waiting', 'asking', 'standby']);
const FINISHED_ID_LIMIT = 256;
/** Ended sessions remembered, so a late event from one does not bring it back. */
const ENDED_ID_LIMIT = 64;

class BuddyCore extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_TIMINGS>} [options.timings]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.clock]
   * @param {object} [options.crew]  AgentRegistry options (idleMs, releaseMs)
   * @param {string} [options.account]  'all' (default) or the account to show
   * @param {object|false} [options.liveness]  LivenessWatch options (app/liveness.js):
   *   watch the Claude Code process of sessions that report a pid. Off when omitted.
   * @param {() => number} [options.now]  current time in ms (for the liveness watch)
   */
  constructor(options = {}) {
    super();
    this.timings = { ...DEFAULT_TIMINGS, ...(options.timings || {}) };
    this.clock = options.clock || { setTimeout, clearTimeout, setInterval, clearInterval };
    /** @type {Map<string, SessionInfo>} */
    this.sessions = new Map();
    /** owner: the session whose event produced the view (null for fallbacks). */
    this.view = { state: 'idle', message: null, owner: null };
    this.timers = { revert: null, quit: null, idle: null, empty: null };
    this.leaving = false;
    this.disposed = false;
    /** The skill the main character holds the book for: { name, session } or null. */
    this.skill = null;
    this.crew = new AgentRegistry({ clock: this.clock, ...(options.crew || {}) });
    /** 'all' or one account name. */
    this.accountFilter = options.account || 'all';
    /** Accounts that sent at least one event in this run. */
    this.seenAccounts = new Set();
    /** Sessions that ended (SessionEnd, or their process is gone), most recent last. */
    this.ended = new Set();
    this.now = options.now || Date.now;
    /** The main sessions' latest steps: [{ kind: 'read' | 'write' | 'run', text }], oldest first. */
    this.steps = [];
    /**
     * The latest turn of a main session, for the chat (facts()):
     * { session, startedAt, tools, last: { tool, detail } | null, endedAt }.
     */
    this.turn = null;
    /** When the last turn ended (Stop), or null. */
    this.lastDoneAt = null;
    /** The latest notification: { kind } (notification_type, may be undefined). */
    this.lastNotice = null;
    /** Second safety net: the Claude Code process of a session died without SessionEnd. */
    this.liveness = options.liveness
      ? new LivenessWatch({
          clock: this.clock,
          now: options.now || Date.now,
          ...options.liveness,
          onGone: (id, why) => this.endSession(id, why),
        })
      : null;
    this.crew.on('change', (agents) => this.emit('crew', agents));
    /** Bug hunt (app/bugs.js): a failing check opens a bug, the same check passing fixes it. */
    this.bugs = new BugWatch({ clock: this.clock, now: this.now, onChange: (bug) => this.emit('bug', bug) });
    this.armIdleTimeout();
  }

  /** Current sub-agents (see AgentRegistry.list()). */
  crewList() {
    return this.crew.list();
  }

  get state() {
    return this.view.state;
  }

  get sessionCount() {
    return this.sessions.size;
  }

  sessionIds() {
    return [...this.sessions.keys()];
  }

  /**
   * The live sessions, for another overlay to take over (one buddy per account
   * switched on or off): id, account and the watched Claude Code pid.
   * @returns {Array<{ session: string, account: string|null, pid: number|null }>}
   */
  handover() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      session: id,
      account: s.account || null,
      pid: this.liveness ? this.liveness.pidOf(id) : null,
    }));
  }

  /**
   * mood: null, or 'worried' after a failed tool (until the view changes).
   * skill: the skill in use by the main session, or null.
   */
  snapshot() {
    return {
      state: this.view.state,
      message: this.view.message,
      mood: this.view.mood || null,
      skill: this.skill ? this.skill.name : null,
      steps: this.steps.slice(),
    };
  }

  /**
   * What the chat (app/chat.js) may answer from: only what the hook events
   * already said, kept in memory. Nothing is collected for it.
   * @param {number} [now]
   */
  facts(now = this.now()) {
    const state = this.view.state;
    const turn = this.turn;
    return {
      now,
      state,
      message: this.view.message,
      turnActive: this.anyTurnActive(),
      turn: turn ? { startedAt: turn.startedAt, tools: turn.tools, last: turn.last, endedAt: turn.endedAt } : null,
      agents: this.crew
        .list()
        .filter((a) => a.status === 'active')
        .map((a) => a.type || null),
      skill: this.skill ? this.skill.name : null,
      waiting: NOTICE_STATES.has(state) && this.lastNotice ? this.lastNotice.kind || 'other' : null,
      lastDoneAt: this.lastDoneAt,
      sessions: this.sessions.size,
    };
  }

  /** Re-emit the current view (e.g. after a language change or renderer reload). */
  refresh() {
    this.emit('state', this.snapshot());
  }

  /**
   * Show only the sessions of `account` ('all' = every account). Sessions and
   * helpers of other accounts are forgotten at once.
   */
  setAccountFilter(account) {
    this.accountFilter = account || 'all';
    if (this.accountFilter === 'all') return;
    let dropped = false;
    for (const [id, session] of this.sessions) {
      if (session.account !== this.accountFilter) {
        this.sessions.delete(id);
        if (this.liveness) this.liveness.untrack(id);
        this.crew.endSession(id);
        this.bugs.sessionGone(id);
        if (this.skill && this.skill.session === id) this.skill = null;
        dropped = true;
      }
    }
    if (dropped && !this.leaving) this.showFallback();
  }

  /** Did this account send anything since the overlay started? */
  hasSeenAccount(account) {
    return this.seenAccounts.has(account);
  }

  /** Something the user should know right now (e.g. after a menu choice): a calm notice. */
  notice(key) {
    if (this.disposed || this.leaving) return;
    this.show('standby', { key }, this.timings.idlePromptMs);
  }

  /** Change the safety-net timeout at runtime (ms, 0 disables it). */
  setIdleTimeout(ms) {
    this.timings.idleTimeoutMs = Math.max(0, Number(ms) || 0);
    this.armIdleTimeout();
  }

  /**
   * Feed one validated event (see app/validate.js) into the machine.
   * @param {object} evt
   */
  handle(evt) {
    if (this.disposed || !evt) return;
    if (evt.account && !this.seenAccounts.has(evt.account)) {
      this.seenAccounts.add(evt.account);
      this.emit('account', evt.account);
    }
    // Another account than the one the user picked: not for us. (Events
    // without an account only show when every account is shown.)
    if (this.accountFilter !== 'all' && evt.account !== this.accountFilter) return;
    // A session that ended only comes back with a new SessionStart (a resume);
    // a late event from it (async hooks can arrive after SessionEnd) is ignored.
    if (this.ended.has(evt.session)) {
      if (evt.event !== 'SessionStart') return;
      this.ended.delete(evt.session);
    }
    if (evt.event === 'SessionEnd') {
      this.onSessionEnd(evt);
      return;
    }

    // Any other event means somebody is still working: cancel a pending goodbye.
    this.cancelLeaving();
    this.clearTimer('empty');
    this.armIdleTimeout();

    const session = this.touch(evt.session, evt.account);
    const owner = evt.session;
    if (this.liveness) {
      if (evt.event === 'SessionStart' && evt.pid) this.liveness.track(evt.session, evt.pid);
      else this.liveness.touch(evt.session);
    }
    const stale = typeof evt.ts === 'number' && evt.ts < session.stopTs;

    // Sub-agents live their own life next to the main character.
    if (evt.agent) {
      this.onAgentEvent(evt, stale);
      return;
    }

    switch (evt.event) {
      case 'SessionStart':
        session.turnActive = false;
        this.show('greeting', { key: 'greeting' }, this.timings.greetingMs, owner);
        break;

      case 'UserPromptSubmit':
        if (stale) return;
        session.turnActive = true;
        session.inflight.clear();
        session.anonymous = 0;
        // A new turn: the row of recent steps starts empty.
        this.turn = { session: owner, startedAt: evt.ts || this.now(), tools: 0, last: null, endedAt: null };
        this.steps = [];
        this.show('thinking', null, 0, owner);
        break;

      case 'UserPromptExpansion':
        // A slash command / skill typed by the user: out comes the book.
        if (stale || !evt.skill) return;
        this.skill = { name: evt.skill, session: owner };
        this.refresh();
        break;

      case 'PreToolUse':
        if (stale) return;
        if (evt.id && session.finished.has(evt.id)) return; // its Post already arrived
        if (evt.tool === 'Skill' && evt.skill) this.skill = { name: evt.skill, session: owner };
        session.turnActive = true;
        if (evt.id) session.inflight.add(evt.id);
        else session.anonymous += 1;
        this.countTool(owner, evt);
        this.addStep(stepForTool(evt.tool, evt.detail));
        this.bugs.toolStart(owner, evt.id, evt.tool, evt.detail);
        this.show(stateForTool(evt.tool), bubbleForTool(evt.tool, evt.detail), 0, owner);
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (evt.id) {
          session.inflight.delete(evt.id);
          rememberFinished(session, evt.id);
        } else {
          session.anonymous = Math.max(0, session.anonymous - 1);
        }
        if (stale) return;
        this.bugs.toolEnd(owner, evt.id, evt.event === 'PostToolUse');
        // A failed tool gets a worried look for the rest of its hold time.
        if (evt.event === 'PostToolUseFailure' && TOOL_STATES.has(this.view.state)) this.setMood('worried');
        if (session.inflight.size > 0 || session.anonymous > 0) return; // parallel tools still running
        if (!TOOL_STATES.has(this.view.state)) return; // e.g. waiting on another approval
        this.scheduleRevert(this.timings.holdMs);
        break;

      case 'Notification': {
        if (stale || SILENT_NOTIFICATIONS.has(evt.kind)) return;
        const shown = NOTIFICATIONS[evt.kind] || OTHER_NOTIFICATION;
        this.lastNotice = { kind: evt.kind };
        this.show(shown.state, { key: shown.key }, shown.sticky ? 0 : this.timings.idlePromptMs, owner);
        break;
      }

      case 'Stop':
        session.turnActive = false;
        session.inflight.clear();
        session.anonymous = 0;
        session.stopTs = Math.max(session.stopTs, evt.ts || 0);
        this.lastDoneAt = evt.ts || this.now();
        if (this.turn && this.turn.session === owner) this.turn.endedAt = this.lastDoneAt;
        // The turn is over: the book goes back into the pocket. Sub-agents carry on.
        if (this.skill && this.skill.session === owner) this.skill = null;
        this.show('done', { key: 'done' }, this.timings.doneMs, owner);
        break;

      default:
        break;
    }
  }

  /**
   * Close a session as if its SessionEnd had come: its Claude Code process is
   * gone ('exited', or its pid now belongs to another process: 'reused').
   * Emits 'gone' (session id, why) when the session was open.
   */
  endSession(id, why = 'exited') {
    if (this.disposed || !this.sessions.has(id)) return;
    this.emit('gone', id, why);
    this.onSessionEnd({ event: 'SessionEnd', session: id, reason: 'gone' });
  }

  onSessionEnd(evt) {
    const known = this.sessions.delete(evt.session);
    if (this.liveness) this.liveness.untrack(evt.session);
    this.ended.delete(evt.session);
    this.ended.add(evt.session);
    if (this.ended.size > ENDED_ID_LIMIT) this.ended.delete(this.ended.values().next().value);
    this.crew.endSession(evt.session);
    this.bugs.sessionGone(evt.session);
    const hadSkill = Boolean(this.skill && this.skill.session === evt.session);
    if (hadSkill) this.skill = null;
    if (this.leaving) return;
    if (this.sessions.size > 0) {
      // Don't leave the buddy "typing" for a session that no longer exists.
      if (this.view.owner === evt.session) this.showFallback();
      else if (hadSkill) this.refresh();
      return;
    }

    // The last one: wait a moment before waving goodbye. /clear and /resume end one
    // session and start another at once, and so does restarting Claude Code; the
    // buddy should not vanish and come straight back. Any event cancels the wait.
    const grace = RESTART_REASONS.has(evt.reason) ? this.timings.clearGraceMs : this.timings.endGraceMs;
    if (!grace) {
      this.leave('sessions-ended');
      return;
    }
    if (known && this.view.owner === evt.session) this.showFallback();
    this.clearTimer('empty');
    this.timers.empty = this.clock.setTimeout(() => {
      this.timers.empty = null;
      if (this.sessions.size === 0) this.leave('sessions-ended');
    }, grace);
  }

  /** Play goodbye, then emit 'quit' unless another event arrives first. */
  leave(reason) {
    if (this.leaving || this.disposed) return;
    this.leaving = true;
    this.clearTimer('revert');
    this.clearTimer('empty');
    this.setView('goodbye', { key: 'goodbye' });
    this.timers.quit = this.clock.setTimeout(() => {
      this.timers.quit = null;
      this.emit('quit', reason);
    }, this.timings.goodbyeMs);
  }

  cancelLeaving() {
    if (!this.leaving) return;
    this.leaving = false;
    this.clearTimer('quit');
    this.showFallback();
  }

  dispose() {
    this.disposed = true;
    for (const name of Object.keys(this.timers)) this.clearTimer(name);
    if (this.liveness) this.liveness.dispose();
    this.crew.dispose();
    this.bugs.dispose();
    this.removeAllListeners();
  }

  /** SubagentStart / SubagentStop / tool events that carry an agent hash. */
  onAgentEvent(evt, stale = false) {
    const who = { agent: evt.agent, agentType: evt.agentType, session: evt.session };
    if (evt.event === 'SubagentStart') this.crew.start(who);
    else if (evt.event === 'SubagentStop') this.crew.stop(who);
    else if (TOOL_EVENTS.has(evt.event)) {
      // The helpers' checks count for the bug hunt too (a SubagentStop leaves the bug alone).
      if (!stale && evt.event === 'PreToolUse') this.bugs.toolStart(evt.session, evt.id, evt.tool, evt.detail, evt.agent);
      else if (!stale) this.bugs.toolEnd(evt.session, evt.id, evt.event === 'PostToolUse');
      this.crew.activity({
        ...who,
        tool: evt.tool,
        // Only a file name, and only for file tools: never commands or search patterns.
        file: isFileTool(evt.tool) ? evt.detail || null : null,
        skill: evt.skill || null,
        started: evt.event === 'PreToolUse',
      });
    }
  }

  // ---------------------------------------------------------------- internals

  /** One more tool in this session's turn (a turn starts here if its prompt was not seen). */
  countTool(owner, evt) {
    if (!this.turn || this.turn.session !== owner || this.turn.endedAt) {
      this.turn = { session: owner, startedAt: evt.ts || this.now(), tools: 0, last: null, endedAt: null };
    }
    this.turn.tools += 1;
    this.turn.last = { tool: evt.tool, detail: evt.detail || null };
  }

  addStep(step) {
    if (!step) return;
    const last = this.steps[this.steps.length - 1];
    if (last && last.kind === step.kind && last.text === step.text) return;
    this.steps = [...this.steps, step].slice(-STEP_LIMIT);
  }

  touch(id, account = null) {
    let session = this.sessions.get(id);
    if (!session) {
      session = { turnActive: false, inflight: new Set(), anonymous: 0, finished: new Set(), stopTs: 0, account };
      this.sessions.set(id, session);
    }
    return session;
  }

  anyTurnActive() {
    for (const session of this.sessions.values()) if (session.turnActive) return true;
    return false;
  }

  show(state, message, revertAfterMs = 0, owner = null) {
    this.clearTimer('revert');
    this.setView(state, message, owner);
    if (revertAfterMs) this.scheduleRevert(revertAfterMs);
  }

  showFallback() {
    this.show(this.anyTurnActive() ? 'thinking' : 'idle', null);
  }

  scheduleRevert(ms) {
    this.clearTimer('revert');
    this.timers.revert = this.clock.setTimeout(() => {
      this.timers.revert = null;
      this.showFallback();
    }, ms);
  }

  setView(state, message, owner = null) {
    this.view = { state, message: message || null, owner, mood: null };
    this.emit('state', this.snapshot());
  }

  setMood(mood) {
    if (this.view.mood === mood) return;
    this.view = { ...this.view, mood };
    this.emit('state', this.snapshot());
  }

  armIdleTimeout() {
    this.clearTimer('idle');
    if (this.timings.idleTimeoutMs > 0 && !this.disposed) {
      this.timers.idle = this.clock.setTimeout(() => {
        this.timers.idle = null;
        this.leave('idle-timeout');
      }, this.timings.idleTimeoutMs);
    }
  }

  clearTimer(name) {
    if (this.timers[name]) {
      this.clock.clearTimeout(this.timers[name]);
      this.timers[name] = null;
    }
  }
}

function rememberFinished(session, id) {
  session.finished.add(id);
  if (session.finished.size > FINISHED_ID_LIMIT) {
    session.finished.delete(session.finished.values().next().value);
  }
}

/**
 * @typedef {object} SessionInfo
 * @property {boolean} turnActive  between UserPromptSubmit and Stop
 * @property {Set<string>} inflight  tool_use_ids that started but did not finish
 * @property {number} anonymous  in-flight tools without an id
 * @property {Set<string>} finished  recently finished tool_use_ids
 * @property {number} stopTs  timestamp of the latest Stop
 * @property {string|null} account  Claude account (config folder name) of the session
 */

module.exports = { BuddyCore, DEFAULT_TIMINGS };
