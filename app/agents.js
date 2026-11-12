'use strict';

/**
 * AgentRegistry: the sub-agents ("minis") the overlay shows next to the main
 * character. No Electron dependency; timers are injectable for tests.
 *
 * Lifecycle of one agent (keyed by the short agent hash from the hook):
 *
 *   SubagentStart / first tool event   -> 'active'
 *   tool events (PreToolUse)           -> current tool and file name
 *   PreToolUse of the Skill tool       -> skill name (the mini opens its book until it finishes)
 *   SubagentStop                       -> 'done'   (the mini reports back, then leaves)
 *   no event for idleMs (30 min)       -> 'gone'   (the mini fades quietly)
 *   its session ended                  -> 'gone'
 *   release(id) from the renderer      -> removed (exit scene finished)
 *   releaseMs after done / gone        -> removed anyway (safety net)
 *
 * Rules:
 *  - A repeated SubagentStart for a known agent is ignored.
 *  - A SubagentStop for an agent that was never seen is ignored.
 *  - The main turn's Stop does not end agents: background agents outlive it.
 *  - Only the agent type, the current tool, a FILE name and a skill name are kept. Task
 *    descriptions and prompts never reach the overlay in the first place.
 *
 * Emits 'change' with list() whenever something visible changed.
 */

const { EventEmitter } = require('node:events');

const DEFAULTS = Object.freeze({
  /**
   * A mini without any event for this long fades (SubagentStop never came).
   * Long: a single tool call of a sub-agent can run for many minutes.
   */
  idleMs: 30 * 60 * 1000,
  /** Remove done / gone agents after this long even if the renderer never confirms. */
  releaseMs: 20 * 1000,
  /** Keep at most this many agents in memory (oldest finished ones go first). */
  maxAgents: 32,
});

class AgentRegistry extends EventEmitter {
  constructor({ clock = { setTimeout, clearTimeout }, ...options } = {}) {
    super();
    this.clock = clock;
    this.options = { ...DEFAULTS, ...options };
    /** @type {Map<string, AgentInfo>} insertion order = arrival order */
    this.agents = new Map();
    this.disposed = false;
  }

  /** @returns {Array<{ id: string, type: string, tool: string|null, file: string|null, skill: string|null, status: string }>} */
  list() {
    return [...this.agents.values()].map(({ id, type, tool, file, skill, status }) => ({ id, type, tool, file, skill, status }));
  }

  get activeCount() {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === 'active') n += 1;
    return n;
  }

  start({ agent, agentType, session }) {
    if (this.disposed || !agent || this.agents.has(agent)) return;
    this.add(agent, agentType, session);
    this.changed();
  }

  /** A tool event from inside an agent. Unknown agents are added (the overlay may have started late). */
  activity({ agent, agentType, session, tool = null, file = null, skill = null, started = false }) {
    if (this.disposed || !agent) return;
    let info = this.agents.get(agent);
    let changed = false;
    if (!info) {
      info = this.add(agent, agentType, session);
      changed = true;
    } else if (info.status !== 'active') {
      return; // a late event after the agent finished
    } else {
      this.armIdle(info);
    }
    if (agentType && !info.typeKnown) {
      info.type = agentType;
      info.typeKnown = true;
      changed = true;
    }
    // PreToolUse sets the current tool; the matching PostToolUse only counts as activity.
    if (started && (info.tool !== tool || info.file !== file)) {
      info.tool = tool;
      info.file = file;
      changed = true;
    }
    if (started && tool === 'Skill' && skill && info.skill !== skill) {
      info.skill = skill;
      changed = true;
    }
    if (changed) this.changed();
  }

  stop({ agent }) {
    const info = this.agents.get(agent);
    if (!info || info.status !== 'active') return; // never seen, or already finished
    this.finish(info, 'done');
  }

  /** The renderer finished the exit scene for this agent. */
  release(agent) {
    const info = this.agents.get(agent);
    if (!info || info.status === 'active') return;
    this.remove(info);
    this.changed();
  }

  endSession(session) {
    let any = false;
    for (const info of this.agents.values()) {
      if (info.session === session && info.status === 'active') {
        this.finish(info, 'gone', false);
        any = true;
      }
    }
    if (any) this.changed();
  }

  dispose() {
    this.disposed = true;
    for (const info of this.agents.values()) this.clearTimers(info);
    this.agents.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------- internals

  add(agent, agentType, session) {
    const info = {
      id: agent,
      type: agentType || 'agent',
      typeKnown: Boolean(agentType),
      session: session || null,
      tool: null,
      file: null,
      skill: null,
      status: 'active',
      idleTimer: null,
      releaseTimer: null,
    };
    this.agents.set(agent, info);
    this.armIdle(info);
    this.trim();
    return info;
  }

  finish(info, status, notify = true) {
    this.clearTimers(info);
    info.status = status;
    info.tool = null;
    info.file = null;
    info.skill = null;
    info.releaseTimer = this.clock.setTimeout(() => {
      info.releaseTimer = null;
      if (this.agents.get(info.id) === info) {
        this.remove(info);
        this.changed();
      }
    }, this.options.releaseMs);
    if (notify) this.changed();
  }

  armIdle(info) {
    if (info.idleTimer) this.clock.clearTimeout(info.idleTimer);
    info.idleTimer = this.clock.setTimeout(() => {
      info.idleTimer = null;
      if (info.status === 'active') this.finish(info, 'gone');
    }, this.options.idleMs);
  }

  clearTimers(info) {
    if (info.idleTimer) this.clock.clearTimeout(info.idleTimer);
    if (info.releaseTimer) this.clock.clearTimeout(info.releaseTimer);
    info.idleTimer = null;
    info.releaseTimer = null;
  }

  remove(info) {
    this.clearTimers(info);
    this.agents.delete(info.id);
  }

  /** Never grow without bounds: drop the oldest finished agents, then the oldest active ones. */
  trim() {
    while (this.agents.size > this.options.maxAgents) {
      const victim =
        [...this.agents.values()].find((a) => a.status !== 'active') || this.agents.values().next().value;
      this.remove(victim);
    }
  }

  changed() {
    if (!this.disposed) this.emit('change', this.list());
  }
}

/**
 * @typedef {object} AgentInfo
 * @property {string} id  short agent hash
 * @property {string} type  agent_type, e.g. "Explore"
 * @property {string|null} session
 * @property {string|null} tool  current tool
 * @property {string|null} file  current file name (file tools only)
 * @property {string|null} skill  the skill it opened, until it finishes
 * @property {'active'|'done'|'gone'} status
 */

module.exports = { AgentRegistry, AGENT_DEFAULTS: DEFAULTS };
