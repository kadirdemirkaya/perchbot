'use strict';

/**
 * BuddyCore: the overlay's brain, with no Electron dependency so it can be
 * unit-tested with fake timers.
 *
 * Responsibilities
 *  - Turn validated hook events into a visual state ("view") for the character.
 *  - Keep tool states on screen briefly after a tool finishes (no flicker).
 *  - Track live sessions; when the last one ends, play goodbye and ask to quit.
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
 *  - 'quit'  (reason)              when the app should exit.
 *
 * Ordering: hooks run as separate async processes, so events can arrive slightly
 * out of order. Two safeguards handle that:
 *  - Pre/Post tool events are paired by tool_use_id; a PreToolUse whose
 *    PostToolUse was already seen is ignored.
 *  - Events stamped before the session's latest Stop are ignored.
 */

const { EventEmitter } = require('node:events');
const { stateForTool, bubbleForTool, isFileTool, TOOL_STATES } = require('./tools');
const { AgentRegistry } = require('./agents');

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
  /** After SessionEnd with reason clear/resume a new session usually follows. */
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
const FINISHED_ID_LIMIT = 256;

class BuddyCore extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_TIMINGS>} [options.timings]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.clock]
   * @param {object} [options.crew]  AgentRegistry options (idleMs, releaseMs)
   * @param {string} [options.account]  'all' (default) or the account to show
   */
  constructor(options = {}) {
    super();
    this.timings = { ...DEFAULT_TIMINGS, ...(options.timings || {}) };
    this.clock = options.clock || { setTimeout, clearTimeout };
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
    this.crew.on('change', (agents) => this.emit('crew', agents));
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
   * mood: null, or 'worried' after a failed tool (until the view changes).
   * skill: the skill in use by the main session, or null.
   */
  snapshot() {
    return {
      state: this.view.state,
      message: this.view.message,
      mood: this.view.mood || null,
      skill: this.skill ? this.skill.name : null,
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
        this.crew.endSession(id);
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
    const stale = typeof evt.ts === 'number' && evt.ts < session.stopTs;

    // Sub-agents live their own life next to the main character.
    if (evt.agent) {
      this.onAgentEvent(evt);
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
        // A failed tool gets a worried look for the rest of its hold time.
        if (evt.event === 'PostToolUseFailure' && TOOL_STATES.has(this.view.state)) this.setMood('worried');
        if (session.inflight.size > 0 || session.anonymous > 0) return; // parallel tools still running
        if (!TOOL_STATES.has(this.view.state)) return; // e.g. waiting on another approval
        this.scheduleRevert(this.timings.holdMs);
        break;

      case 'Notification': {
        if (stale || SILENT_NOTIFICATIONS.has(evt.kind)) return;
        const shown = NOTIFICATIONS[evt.kind] || OTHER_NOTIFICATION;
        this.show(shown.state, { key: shown.key }, shown.sticky ? 0 : this.timings.idlePromptMs, owner);
        break;
      }

      case 'Stop':
        session.turnActive = false;
        session.inflight.clear();
        session.anonymous = 0;
        session.stopTs = Math.max(session.stopTs, evt.ts || 0);
        // The turn is over: the book goes back into the pocket. Sub-agents carry on.
        if (this.skill && this.skill.session === owner) this.skill = null;
        this.show('done', { key: 'done' }, this.timings.doneMs, owner);
        break;

      default:
        break;
    }
  }

  onSessionEnd(evt) {
    this.sessions.delete(evt.session);
    this.crew.endSession(evt.session);
    const hadSkill = Boolean(this.skill && this.skill.session === evt.session);
    if (hadSkill) this.skill = null;
    if (this.leaving) return;
    if (this.sessions.size > 0) {
      // Don't leave the buddy "typing" for a session that no longer exists.
      if (this.view.owner === evt.session) this.showFallback();
      else if (hadSkill) this.refresh();
      return;
    }

    if (RESTART_REASONS.has(evt.reason)) {
      // /clear and /resume end one session and immediately start another.
      // Wait a moment instead of waving goodbye and coming straight back.
      this.clearTimer('empty');
      this.timers.empty = this.clock.setTimeout(() => {
        this.timers.empty = null;
        if (this.sessions.size === 0) this.leave('sessions-ended');
      }, this.timings.clearGraceMs);
    } else {
      this.leave('sessions-ended');
    }
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
    this.crew.dispose();
    this.removeAllListeners();
  }

  /** SubagentStart / SubagentStop / tool events that carry an agent hash. */
  onAgentEvent(evt) {
    const who = { agent: evt.agent, agentType: evt.agentType, session: evt.session };
    if (evt.event === 'SubagentStart') this.crew.start(who);
    else if (evt.event === 'SubagentStop') this.crew.stop(who);
    else if (TOOL_EVENTS.has(evt.event)) {
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
