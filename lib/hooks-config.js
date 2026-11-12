'use strict';

/**
 * Pure functions that add / remove Agent Buddy's hooks in a Claude Code
 * settings object. They never touch the disk and never mutate their input.
 *
 * Claude Code format (https://code.claude.com/docs/en/hooks):
 *   { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 *
 * Our handlers are recognised by the `--agent-buddy` tag at the end of the
 * command, so we only ever remove what we added, even if the repo moved.
 */

const MARKER = '--agent-buddy';

/**
 * Hooks we register. All run with "async": true (Claude Code does not wait
 * for them) except SessionEnd: Claude Code may exit right after it, and a
 * background hook could be killed before it reaches the overlay. SessionEnd
 * hooks share a 1.5 s budget; send.js needs a few tens of milliseconds.
 */
const HOOK_SPECS = Object.freeze([
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  // A user typing /some-skill bypasses PreToolUse; this event covers that path.
  { event: 'UserPromptExpansion' },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PostToolUseFailure', matcher: '*' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SessionEnd', sync: true },
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The shell command for one event. Claude Code runs hook commands with sh,
 * Git Bash, or PowerShell (Windows without Git Bash). A double-quoted path with
 * forward slashes works the same in all three.
 */
function hookCommand(sendJsPath, event) {
  const scriptPath = sendJsPath.replace(/\\/g, '/');
  if (/["`$]/.test(scriptPath)) {
    throw new Error(
      `The project path contains a character that cannot be quoted safely for every shell (", \`, $):\n  ${scriptPath}\n` +
        'Move the agent-buddy folder to a path without those characters and run setup again.',
    );
  }
  return `node "${scriptPath}" ${event} ${MARKER}`;
}

function isOurHandler(handler) {
  return (
    isPlainObject(handler) &&
    typeof handler.command === 'string' &&
    /send\.js/.test(handler.command) &&
    new RegExp(`(^|\\s)${MARKER}(\\s|$)`).test(handler.command)
  );
}

/** The matcher groups we add, one per event. */
function buildGroups(sendJsPath) {
  return HOOK_SPECS.map((spec) => {
    const handler = { type: 'command', command: hookCommand(sendJsPath, spec.event) };
    if (!spec.sync) handler.async = true;
    const group = spec.matcher ? { matcher: spec.matcher, hooks: [handler] } : { hooks: [handler] };
    return { event: spec.event, group };
  });
}

/**
 * Checks that the parts of the settings we would touch have the documented
 * shape. Returns an error message, or null when it is safe to edit.
 */
function checkShape(settings) {
  if (!isPlainObject(settings)) return 'the file does not contain a JSON object';
  if (settings.hooks === undefined) return null;
  if (!isPlainObject(settings.hooks)) return '"hooks" is not an object';
  for (const { event } of HOOK_SPECS) {
    const groups = settings.hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) return `"hooks.${event}" is not an array`;
  }
  return null;
}

/** Number of Agent Buddy handlers currently in the settings. */
function countOurHandlers(settings) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return 0;
  let count = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (isPlainObject(group) && Array.isArray(group.hooks)) count += group.hooks.filter(isOurHandler).length;
    }
  }
  return count;
}

/** Handlers that are not ours, for the "kept as they are" summary. */
function countOtherHandlers(settings) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return 0;
  let count = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (isPlainObject(group) && Array.isArray(group.hooks)) count += group.hooks.filter((h) => !isOurHandler(h)).length;
    }
  }
  return count;
}

/** True when exactly our current hooks are present (nothing missing, nothing stale). */
function isInstalled(settings, sendJsPath) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return false;
  const expected = buildGroups(sendJsPath);
  if (countOurHandlers(settings) !== expected.length) return false;
  return expected.every(({ event, group }) => {
    const groups = settings.hooks[event];
    return Array.isArray(groups) && groups.some((g) => JSON.stringify(g) === JSON.stringify(group));
  });
}

/**
 * Remove every Agent Buddy handler. Groups and events that become empty
 * because of us are removed too; everything else is left untouched.
 * @returns {{ settings: object, removed: number }}
 */
function removeHooks(settings) {
  const out = structuredClone(settings);
  let removed = 0;
  if (!isPlainObject(out) || !isPlainObject(out.hooks)) return { settings: out, removed };

  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const kept = group.hooks.filter((h) => !isOurHandler(h));
      removed += group.hooks.length - kept.length;
      if (kept.length === group.hooks.length) keptGroups.push(group);
      else if (kept.length > 0) keptGroups.push({ ...group, hooks: kept });
    }
    if (keptGroups.length > 0 || groups.length === 0) out.hooks[event] = keptGroups;
    else delete out.hooks[event];
  }
  if (removed > 0 && Object.keys(out.hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

/**
 * Add (or refresh) our hooks. Existing handlers, including other tools' hooks
 * on the same events, are preserved.
 * @returns {{ settings: object, added: Array<{event: string, group: object}>, replaced: number }}
 */
function addHooks(settings, sendJsPath) {
  const shapeError = checkShape(settings);
  if (shapeError) throw new Error(`Unexpected settings format: ${shapeError}`);
  const groups = buildGroups(sendJsPath);
  const { settings: out, removed } = removeHooks(settings);
  if (!isPlainObject(out.hooks)) out.hooks = {};
  for (const { event, group } of groups) {
    if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
    out.hooks[event].push(structuredClone(group));
  }
  return { settings: out, added: groups, replaced: removed };
}

module.exports = {
  MARKER,
  HOOK_SPECS,
  hookCommand,
  isOurHandler,
  buildGroups,
  checkShape,
  countOurHandlers,
  countOtherHandlers,
  isInstalled,
  removeHooks,
  addHooks,
};
