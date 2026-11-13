'use strict';

/**
 * The chat's answers, as pure functions.
 *
 * The user picks a ready-made question in the chat panel (buttons only, there
 * is no text field). The answer
 * is built only from what the overlay already knows from the hook events
 * (BuddyCore.facts()): the state, the current tool with its file name or
 * shortened command, the turn's start time and tool count, the active
 * helpers' types, the skill in use, what a notification waits for, when the
 * last turn ended. Nothing is collected for it, nothing is sent anywhere, and
 * nobody else is asked: there is no real conversation with Claude.
 *
 * Every question always has an answer, also when it makes no sense right now
 * ("No helpers at the moment").
 */

const { translate } = require('./i18n');

/** The ready-made questions, in panel order. */
const INTENTS = Object.freeze(['doing', 'duration', 'tools', 'agents', 'skill', 'waiting', 'done']);
const INTENT_SET = new Set(INTENTS);
/**
 * Hands (app/hands.js): commands, not questions, in groups (a row each at the
 * top of the panel, Windows only). With the Hands setting off, a command asks
 * to turn it on first.
 */
const HAND_GROUPS = Object.freeze(
  [
    { id: 'chrome', items: ['openchrome', 'closechrome'] },
    { id: 'tab', items: ['newtab', 'closetab'] },
    { id: 'youtube', items: ['youtube'] },
  ].map((g) => Object.freeze({ id: g.id, items: Object.freeze(g.items) })),
);
const HAND_INTENTS = Object.freeze(HAND_GROUPS.flatMap((g) => g.items));
const HAND_SET = new Set(HAND_INTENTS);
/** Commands that ask "Are you sure?" first (a whole window with its tabs). */
const HAND_CONFIRM = new Set(['closechrome']);

const FILE_WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILE_READ = new Set(['Read', 'NotebookRead']);
const SEARCH = new Set(['Grep', 'Glob', 'LS']);
const COMMAND = new Set(['Bash', 'PowerShell', 'Monitor']);

/** "45 s", "2 min 5 s", "1 h 20 min" (or the Turkish units). */
function formatDuration(ms, t) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return t('seconds', { s: total });
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? t('minutesSeconds', { m: minutes, s: seconds }) : t('minutes', { m: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? t('hoursMinutes', { h: hours, m: rest }) : t('hours', { h: hours });
}

/** "Explore, Plan" (each type once, at most three, then "…"). */
function typeList(types) {
  const unique = [...new Set(types.filter((x) => typeof x === 'string' && x))];
  const shown = unique.slice(0, 3).join(', ');
  return unique.length > 3 ? `${shown}, …` : shown;
}

/** What it is doing now (key + vars), from the state and the current tool. */
function doing(f) {
  const last = f.turn && f.turn.last;
  const tool = last ? last.tool : null;
  const detail = last && last.detail ? last.detail : null;
  switch (f.state) {
    case 'typing':
      return detail && FILE_WRITE.has(tool) ? ['doingTyping', { file: detail }] : ['doingTypingNoFile'];
    case 'reading':
      if (SEARCH.has(tool)) return ['doingSearching'];
      return detail && FILE_READ.has(tool) ? ['doingReading', { file: detail }] : ['doingReadingNoFile'];
    case 'running':
      return detail && COMMAND.has(tool) ? ['doingRunning', { command: detail }] : ['doingRunningNoCommand'];
    case 'working':
      if (tool === 'WebSearch') return ['doingWebSearch'];
      if (tool === 'WebFetch') return ['doingWebFetch'];
      if (tool === 'Task' || tool === 'Agent') return ['doingDelegating'];
      if (tool === 'Skill' && f.skill) return ['doingSkill', { skill: f.skill }];
      if (tool && tool.startsWith('mcp__') && tool.split('__')[1]) return ['doingMcp', { server: tool.split('__')[1] }];
      return ['doingWorking'];
    case 'thinking':
      return ['doingThinking'];
    case 'waiting':
      return ['doingWaiting'];
    case 'asking':
      return ['doingAsking'];
    case 'done':
      return ['doingDone'];
    case 'greeting':
      return ['doingGreeting'];
    case 'goodbye':
      return ['doingGoodbye'];
    default:
      if (f.agents.length === 1) return ['doingIdleHelper'];
      if (f.agents.length > 1) return ['doingIdleHelpers', { count: f.agents.length }];
      return ['doingIdle'];
  }
}

const WAITING_KEYS = {
  permission_prompt: 'waitingPermission',
  elicitation_dialog: 'waitingQuestion',
  elicitation_url_dialog: 'waitingQuestion',
  agent_needs_input: 'waitingInput',
  idle_prompt: 'waitingPrompt',
};

/**
 * The answer to one question, as a translation key and its variables.
 * @param {string} intent  one of INTENTS, or anything else for "I don't know"
 * @param {ReturnType<import('./core').BuddyCore['facts']>} f
 * @param {(key: string, vars?: object) => string} t  the chat strings (durations are filled in with it)
 * @returns {[string, object?]}
 */
function answerKey(intent, f, t) {
  const turn = f.turn;
  switch (intent) {
    case 'doing':
      return doing(f);
    case 'duration':
      if (f.turnActive && turn) return ['durationActive', { time: formatDuration(f.now - turn.startedAt, t) }];
      if (turn && turn.endedAt) {
        return ['durationLast', { time: formatDuration(turn.endedAt - turn.startedAt, t), ago: formatDuration(f.now - turn.endedAt, t) }];
      }
      return ['durationNone'];
    case 'tools':
      if (!turn) return ['toolsNone'];
      if (f.turnActive) return turn.tools === 0 ? ['toolsActiveZero'] : [turn.tools === 1 ? 'toolsActiveOne' : 'toolsActive', { count: turn.tools }];
      return [turn.tools === 1 ? 'toolsLastOne' : 'toolsLast', { count: turn.tools }];
    case 'agents':
      if (!f.agents.length) return ['agentsNone'];
      if (!typeList(f.agents)) return [f.agents.length === 1 ? 'agentsOneBare' : 'agentsManyBare', { count: f.agents.length }];
      return [f.agents.length === 1 ? 'agentsOne' : 'agentsMany', { count: f.agents.length, types: typeList(f.agents) }];
    case 'skill':
      return f.skill ? ['skillOn', { skill: f.skill }] : ['skillNone'];
    case 'waiting':
      if (f.waiting) return [WAITING_KEYS[f.waiting] || 'waitingNotice'];
      return f.turnActive ? ['waitingNothingBusy'] : ['waitingNothingIdle'];
    case 'done':
      if (f.turnActive) return ['doneNotYet'];
      if (f.agents.length) return [f.agents.length === 1 ? 'doneHelperBusy' : 'doneHelpersBusy', { count: f.agents.length }];
      if (f.lastDoneAt) return ['doneYes', { ago: formatDuration(f.now - f.lastDoneAt, t) }];
      return ['doneNothing'];
    default:
      return ['unknown'];
  }
}

/**
 * The answer text in `lang`.
 * @param {string} intent
 * @param {object} facts  BuddyCore.facts()
 * @param {string} lang
 */
function answer(intent, facts, lang) {
  const t = (key, vars) => translate(lang, 'chat', key, vars);
  const [key, vars] = answerKey(intent, facts, t);
  return t(key, vars);
}

/** What the page may ask (renderer -> main): open / close the panel, a question or a command. */
const CHAT_OPS = new Set(['open', 'close', 'ask']);

/**
 * A request from the page, checked: { op } or { op: 'ask', intent }, else null.
 * A question carries only its intent; never any text.
 */
function parseChatRequest(msg) {
  if (!msg || typeof msg !== 'object' || !CHAT_OPS.has(msg.op)) return null;
  if (msg.op !== 'ask') return { op: msg.op };
  if (msg.intent === 'unknown' || INTENT_SET.has(msg.intent) || HAND_SET.has(msg.intent)) return { op: 'ask', intent: msg.intent };
  return null;
}

/**
 * The panel's labels in `lang`: the questions in order and, where hands work
 * (`commands`: Windows), the command rows above them: a group name and its
 * short buttons, each with its full name (tooltip).
 */
function panelStrings(lang, { commands = false } = {}) {
  const t = (key) => translate(lang, 'chat', key);
  return {
    commands: commands
      ? HAND_GROUPS.map((g) => ({ label: t(`g_${g.id}`), items: g.items.map((id) => ({ id, label: t(`c_${id}`), title: t(`q_${id}`) })) }))
      : [],
    questions: INTENTS.map((id) => ({ id, label: t(`q_${id}`) })),
    title: t('title'),
    close: t('close'),
  };
}

module.exports = { INTENTS, INTENT_SET, HAND_GROUPS, HAND_INTENTS, HAND_SET, HAND_CONFIRM, CHAT_OPS, answer, answerKey, formatDuration, typeList, panelStrings, parseChatRequest };
