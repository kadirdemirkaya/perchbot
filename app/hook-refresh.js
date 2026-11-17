'use strict';

/**
 * Hooks that keep up with the version ("Keep hooks up to date", on by default).
 *
 * A newer Perchbot can listen to more Claude Code events (0.6.0 added PreCompact,
 * the model looks added PostModelSwitch). The hook script itself is replaced
 * with the package, but a new event also needs an entry in the account's
 * settings.json, which only `perchbot setup` used to write. So a little while
 * after it starts, the overlay looks at the Claude Code accounts once and adds
 * what is missing (the same merge as setup: lib/hooks-config.js addHooks), but
 * only where:
 *   - Perchbot's hooks are there already (setup ran in that account once):
 *     an account without them is never touched;
 *   - every one of them runs this copy's send.js: an account hooked to another
 *     copy (a clone, another install) is left as it is;
 *   - the installed Claude Code's version is known: without it a hook that
 *     needs a recent Claude Code would be dropped instead of added.
 * Each file is backed up next to itself first, then written atomically (lib/cli.js),
 * one log line per file. Other tools' hooks are kept. Nothing leaves the computer.
 * Never with PERCHBOT_HOME set (test overlays): those never touch the real accounts.
 *
 * Pure parts (planRefresh, scriptOf, ...) plus a small runner with injectable
 * file access, so node:test covers it without touching any real file.
 */

const path = require('node:path');
const { exec } = require('node:child_process');
const hooks = require('../lib/hooks-config');
const cli = require('../lib/cli');
const names = require('../lib/names');

const HOOK_REFRESH = Object.freeze({
  /** After the start: out of the way of the first events and the window. */
  delayMs: 8000,
  /** `claude --version` may take this long (it is asked once per start). */
  versionTimeoutMs: 10000,
});

/** The send.js path a hook command runs (`node "<path>" <Event> --perchbot`), or null. */
function scriptOf(command) {
  if (typeof command !== 'string') return null;
  const hit = /^\s*node\s+"([^"]+)"/.exec(command) || /^\s*node\s+(\S+)/.exec(command);
  return hit ? hit[1] : null;
}

/** Two script paths are the same file: slashes alike, case ignored on Windows. */
function samePath(a, b, caseless = process.platform === 'win32') {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p) => {
    const s = path.normalize(p.replace(/\\/g, '/')).replace(/\\/g, '/');
    return caseless ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** The send.js paths of every Perchbot handler in the settings (one per handler). */
function ourScripts(settings) {
  const out = [];
  const all = settings && typeof settings === 'object' && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const groups of Object.values(all)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) if (hooks.isOurHandler(handler)) out.push(scriptOf(handler.command));
    }
  }
  return out;
}

/**
 * What to do with one account's settings.
 * @param {object} o
 * @param {object} o.settings  the parsed settings.json
 * @param {string} o.sendJs  this copy's hooks/send.js
 * @param {string|null} o.claudeVersion  the installed Claude Code's version
 * @param {boolean} [o.caseless]  compare paths without case (Windows)
 * @returns {{ action: 'skip', why: string } | { action: 'refresh', settings: object, missing: string[], replaced: number }}
 */
function planRefresh({ settings, sendJs, claudeVersion, caseless }) {
  if (!claudeVersion) return { action: 'skip', why: 'Claude Code version unknown' };
  if (hooks.checkShape(settings)) return { action: 'skip', why: 'unexpected settings format' };
  const scripts = ourScripts(settings);
  if (scripts.length === 0) return { action: 'skip', why: 'no Perchbot hooks in this account' };
  if (!scripts.every((s) => samePath(s, sendJs, caseless))) return { action: 'skip', why: 'hooked to another copy of Perchbot' };
  if (hooks.isInstalled(settings, sendJs, claudeVersion)) return { action: 'skip', why: 'up to date' };
  const missing = hooks.missingEvents(settings, sendJs, claudeVersion);
  let result;
  try {
    result = hooks.addHooks(settings, sendJs, claudeVersion);
  } catch {
    return { action: 'skip', why: 'unexpected settings format' };
  }
  return { action: 'refresh', settings: result.settings, missing, replaced: result.replaced };
}

/** The account name of a config folder, as the hook names it ("C:/x/.claude-work" -> "claude-work"). */
function accountOf(dir) {
  return path.basename(path.resolve(dir)).replace(/^\.+/, '') || 'claude';
}

/**
 * Why not to look at all, or null. Switched off; a test home (PERCHBOT_HOME:
 * the real accounts are not for a test overlay).
 */
function blocked({ settings, env = process.env }) {
  if (settings && settings.refreshHooks === false) return 'switched off';
  if (names.envValue('HOME', env) !== undefined) return 'test home (PERCHBOT_HOME)';
  return null;
}

/**
 * The installed Claude Code's version, without blocking (`claude --version` in
 * the background). PERCHBOT_CLAUDE_VERSION wins (tests; "none": unknown).
 * @returns {Promise<string|null>}
 */
function claudeVersionLater({ env = process.env, run = exec, timeoutMs = HOOK_REFRESH.versionTimeoutMs } = {}) {
  const override = names.envValue('CLAUDE_VERSION', env);
  if (override !== undefined) return Promise.resolve(override === 'none' ? null : cli.parseClaudeVersion(override));
  return new Promise((resolve) => {
    try {
      // A fixed command through a shell (claude.exe, claude.cmd and the claude script alike).
      run('claude --version', { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, out) => {
        resolve(err ? null : cli.parseClaudeVersion(String(out || '')));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Looks at the accounts once and refreshes what needs it.
 * @param {object} o
 * @param {Array<{ dir: string, file: string }>} o.accounts  lib/cli.js findAccounts()
 * @param {string} o.sendJs
 * @param {string|null} o.claudeVersion
 * @param {string|null} [o.account]  one buddy per account: only this account's folder
 * @param {{ read?: Function, backupPath?: Function, backup?: Function, write?: Function }} [o.io]
 * @returns {Array<{ file: string, action: string, why?: string, missing?: string[], backup?: string|null }>}
 */
function refreshAccounts({ accounts, sendJs, claudeVersion, account = null, io = {}, caseless }) {
  const read = io.read || cli.readSettings;
  const backupPath = io.backupPath || cli.backupPath;
  const backup = io.backup || cli.makeBackup;
  const write = io.write || cli.writeJsonAtomic;
  const out = [];
  for (const { dir, file } of accounts) {
    if (account && accountOf(dir) !== account) continue;
    const current = read(file);
    if (current.error) {
      out.push({ file, action: 'skip', why: current.error });
      continue;
    }
    if (!current.exists) {
      out.push({ file, action: 'skip', why: 'no settings file' });
      continue;
    }
    const plan = planRefresh({ settings: current.data, sendJs, claudeVersion, caseless });
    if (plan.action === 'skip') {
      out.push({ file, action: 'skip', why: plan.why });
      continue;
    }
    try {
      const target = backupPath(file);
      backup(file, target);
      write(file, plan.settings);
      out.push({ file, action: 'refresh', missing: plan.missing, backup: target });
    } catch (err) {
      out.push({ file, action: 'failed', why: err && err.message ? err.message : String(err) });
    }
  }
  return out;
}

module.exports = { HOOK_REFRESH, scriptOf, samePath, ourScripts, planRefresh, accountOf, blocked, claudeVersionLater, refreshAccounts };
