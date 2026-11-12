'use strict';

/**
 * Validation for events that reach the overlay, whether over HTTP, from the
 * launch argument, or from a second app instance.
 *
 * Anything that does not match the schema is rejected. Unknown fields are
 * dropped, so the rest of the app only ever sees the whitelisted shape:
 *
 *   {
 *     v: 1,
 *     event:   'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse'
 *            | 'PostToolUse' | 'PostToolUseFailure' | 'Notification' | 'Stop',
 *     session: string,          // session id
 *     ts:      number,          // ms timestamp taken by the hook process
 *     tool?:   string,          // tool name (tool events only)
 *     id?:     string,          // tool_use_id, used to pair Pre/Post events
 *     detail?: string,          // short display text: file name, pattern, trimmed command
 *     kind?:   string,          // notification_type
 *     source?: string,          // SessionStart source
 *     reason?: string,          // SessionEnd reason
 *     agent?: string,           // sub-agent: short hash of agent_id (tool events, SubagentStart/Stop)
 *     agentType?: string,       // sub-agent type, e.g. "Explore"
 *     skill?: string,           // skill / slash-command name (PreToolUse of Skill, UserPromptExpansion)
 *     account?: string,         // Claude config folder name, e.g. "claude-work" (any event)
 *     pid?:    number,          // SessionStart: process id of Claude Code (liveness check)
 *   }
 *   SubagentStart / SubagentStop / UserPromptExpansion are also accepted, and
 *   Demo ({ demo: one of DEMOS }) from the simulator.
 */

const EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptExpansion',
  // Not a hook event: the simulator (scripts/simulate.js) asks for one of the
  // character's own behaviours. hooks/send.js never sends it.
  'Demo',
]);

/** What a Demo event may ask for. */
const DEMOS = new Set([
  'stretch',
  'look',
  'peek',
  'hum',
  'jump',
  'ball',
  'antenna',
  'walk',
  'fly',
  'inspect',
  'home',
  'anger',
  'duel',
  'cat',
  'cat-away',
  'menu',
  // A throw from where it is (no mouse needed), towards the middle of the screen.
  'fling',
]);

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const AGENT_EVENTS = new Set(['SubagentStart', 'SubagentStop']);

/** Largest request body the HTTP server accepts, in bytes. */
const MAX_BODY_BYTES = 4096;
const MAX_DETAIL_CHARS = 80;

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const WORD_RE = /^[a-z_]{1,40}$/;
const AGENT_RE = /^[a-f0-9]{6,16}$/;
const AGENT_TYPE_RE = /^[A-Za-z0-9 _.:/-]{1,40}$/;
const SKILL_RE = /^[A-Za-z0-9_.:/-]{1,24}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,40}$/;

// C0/C1 control characters plus Unicode bidi overrides, which could make a
// bubble render misleading text.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

function cleanText(value, max) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

function pick(value, re) {
  return typeof value === 'string' && re.test(value) ? value : undefined;
}

/**
 * Returns a normalised event object, or null when `raw` is not a valid event.
 * @param {unknown} raw
 */
function validateEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== 1) return null;
  if (!EVENTS.has(raw.event)) return null;
  if (!pick(raw.session, SESSION_RE)) return null;
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts) || raw.ts < 0) return null;

  const evt = { v: 1, event: raw.event, session: raw.session, ts: raw.ts };
  const account = pick(raw.account, ACCOUNT_RE);
  if (account) evt.account = account;

  if (TOOL_EVENTS.has(raw.event)) {
    const tool = pick(raw.tool, TOOL_RE);
    if (!tool) return null;
    evt.tool = tool;
    const id = pick(raw.id, ID_RE);
    if (id) evt.id = id;
    const detail = cleanText(raw.detail, MAX_DETAIL_CHARS);
    if (detail) evt.detail = detail;
  }
  if (raw.event === 'Notification') {
    const kind = pick(raw.kind, WORD_RE);
    if (kind) evt.kind = kind;
  }
  if (raw.event === 'SessionStart') {
    const source = pick(raw.source, WORD_RE);
    if (source) evt.source = source;
    if (Number.isInteger(raw.pid) && raw.pid > 0 && raw.pid <= 0xffffffff) evt.pid = raw.pid;
  }
  if (raw.event === 'SessionEnd') {
    const reason = pick(raw.reason, WORD_RE);
    if (reason) evt.reason = reason;
  }
  if (TOOL_EVENTS.has(raw.event) || AGENT_EVENTS.has(raw.event)) {
    const agent = pick(raw.agent, AGENT_RE);
    if (agent) {
      evt.agent = agent;
      const agentType = pick(raw.agentType, AGENT_TYPE_RE);
      if (agentType) evt.agentType = agentType;
    }
  }
  if (AGENT_EVENTS.has(raw.event) && !evt.agent) return null;
  if (raw.event === 'Demo') {
    if (typeof raw.demo !== 'string' || !DEMOS.has(raw.demo)) return null;
    evt.demo = raw.demo;
  }
  if (raw.event === 'PreToolUse' || raw.event === 'UserPromptExpansion') {
    const skill = pick(raw.skill, SKILL_RE);
    if (skill) evt.skill = skill;
    else if (raw.event === 'UserPromptExpansion') return null;
  }
  return evt;
}

module.exports = { validateEvent, cleanText, EVENTS, DEMOS, MAX_BODY_BYTES, ACCOUNT_RE };
