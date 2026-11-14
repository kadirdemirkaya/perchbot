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
  'flip',
  'reboot',
  'polish',
  'sneeze',
  'moonwalk',
  // Sits down on the ground, swings its legs.
  'sit',
  'walk',
  'fly',
  'inspect',
  // It asks "What's this?" (with answers to click); the user is back after a while.
  'curious',
  'welcome',
  // The pose it presses a button with (hands); nothing is pressed.
  'press',
  // Hands for real, but only on a test overlay (--dev): open / close Chrome (no "Are you sure?"),
  // open a tab, close the last one, open YouTube.
  'openchrome',
  'closechrome',
  'newtab',
  'closetab',
  'youtube',
  // The rocket fist for sure: it presses the new tab button from where it is.
  'fist',
  // Moments of the work: a flag (commit), a rocket (push), sweat, phew, a squeezed head (compaction),
  // and the nudges while Claude Code waits for the user.
  'commit',
  'push',
  'sweat',
  'phew',
  'squeeze',
  'psst',
  'knock',
  // A slow, long, wavy flight; up to the top edge to hang from it; a hop with a loop-the-loop.
  'cruise',
  'hang',
  'loop',
  // Onto a window's title bar (Windows), to sit there; it rides along when the window moves.
  'perch',
  'home',
  // A trip to another screen (with only one screen: nothing).
  'screen',
  // A helper off to roam the screen in a window of its own (needs a helper at work).
  'roam',
  // Two helpers at work play tag / make a tower; one pokes at the pointer (as if it rested above them).
  'tag',
  'tower',
  'tease',
  'anger',
  // The anger ladder: cross, it leaves fuming, then three more taps set its head on fire.
  'rage',
  // Never stops tapping: the ladder, then three more taps while its head burns: a rampage.
  'pester',
  // Its head on fire twice in five minutes: laser eyes, missiles, marks that fade 5-10 s after the last blast
  // (three burn lines, missiles, then five seconds after the cursor); 'rampage-chase': with the chase for sure.
  'rampage',
  'rampage-chase',
  // Focus mode at once (intense work): a headband, and a screen of light instead of the laptop.
  'focus',
  // As if the cursor rested where it is: it flies over and looks through its magnifier; 'lens': the pose only.
  'follow',
  'lens',
  // "Watch me type": as if the user were typing where the mouse cursor is (it reads along, then the light bulb).
  'typing',
  // "Come and tell me": as if a long turn had just ended (it flies over to the cursor, cheers, and back).
  'find',
  // The idle story: reads a book, blows bubbles, throws a paper plane, pets the cat; a visitor
  // drops by (sit, chat, sword practice); the whole story at once.
  'read',
  'bubbles',
  'plane',
  'pat',
  'guest',
  'story',
  // Five quick taps it loves (happy hops, hearts).
  'glee',
  'duel',
  'cat',
  'cat-away',
  // The cat chases the laser pointer's dot (it must be here).
  'cat-laser',
  'menu',
  // A throw from where it is (no mouse needed), towards the middle of the screen.
  'fling',
  // The chat panel opens, two questions are asked and answered.
  'chat',
  // Every sound once (also with the Sound setting off; nothing while sounds are switched
  // off in app/features.js), and ten seconds of quick taps (taps without sound then).
  'sound',
  'tap-spam',
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
