'use strict';

/**
 * One buddy per Claude account (settings "perAccount"), as pure functions.
 *
 * Off (the default): one overlay for every account, on settings.port (7777).
 * On: every account gets an overlay of its own, started by its hooks with
 * --account=<name>. Each has its own port, its own single-instance lock
 * (Chromium data in ~/.perchbot/electron-<name>), its own place on the
 * screen (settings.positions[<name>]) and only shows its own sessions. The
 * rest of settings.json is shared.
 *
 * The port: each instance writes ~/.perchbot/instances/<name>.json
 * ({ port, pid }) once it listens, and removes it when it quits. Until then
 * (and if that file is gone) the hook tries the account's preferred port
 * (preferredPort). An instance that gets an event of another account answers
 * 421, and the hook starts the right one, which then takes the next free port.
 *
 * hooks/send.js has its own copy of preferredPort and the file name (the hook
 * loads no app code); a test checks that both agree.
 */

const path = require('node:path');

/** Claude account (config folder) names, as hooks/send.js sends them. */
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,40}$/;
/** Preferred ports: settings.port + 1 .. settings.port + PORT_SPAN. */
const PORT_SPAN = 200;
/** An instance tries this many ports from its preferred one before it gives up. */
const PORT_TRIES = 20;
/** Two buddies side by side in a corner: this much room between their slots (DIP at medium size). */
const SIDE_GAP = 24;

/** The account this instance is for (--account=<name>), or null for the shared overlay. */
function accountArg(argv) {
  const prefix = '--account=';
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (!arg) return null;
  const name = arg.slice(prefix.length);
  return ACCOUNT_RE.test(name) && name !== 'all' ? name : null;
}

/** FNV-1a over the name's characters: a small stable number for it. */
function hashName(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The port an account's overlay tries first (and the hook, before the instance file exists). */
function preferredPort(base, account) {
  const start = Number.isInteger(base) && base >= 1024 && base <= 65535 - PORT_SPAN - PORT_TRIES ? base : 7777;
  return start + 1 + (hashName(String(account)) % PORT_SPAN);
}

/** Ports to try, in order. */
function candidatePorts(base, account, tries = PORT_TRIES) {
  const first = preferredPort(base, account);
  return Array.from({ length: tries }, (_, i) => first + i);
}

function instanceFile(home, account) {
  return path.join(home, 'instances', `${account}.json`);
}

/** The instance file's content: { port, pid }, or null when it is not usable. */
function parseInstance(text) {
  try {
    const data = JSON.parse(text);
    const ok = data && Number.isInteger(data.port) && data.port >= 1024 && data.port <= 65535;
    return ok ? { port: data.port, pid: Number.isInteger(data.pid) ? data.pid : null } : null;
  } catch {
    return null;
  }
}

/**
 * Which place in the corner this account's buddy takes when it has none of its
 * own: 0 for the first of the accounts in alphabetical order, 1 for the next...
 * (The same on every start, as long as the set of accounts stays the same.)
 */
function slotIndex(account, known = []) {
  const names = [...new Set([...(known || []).filter((a) => ACCOUNT_RE.test(a)), account])].sort();
  return Math.max(0, names.indexOf(account));
}

/**
 * The corner anchor moved inwards for buddy number `index` (0 stays put), so
 * buddies of different accounts stand side by side instead of on top of each
 * other. Never further than the middle of the work area.
 */
function shiftAnchor(anchor, corner, index, slotWidth, workArea) {
  if (!index) return { ...anchor };
  const step = (slotWidth + SIDE_GAP) * index;
  const middle = workArea.x + workArea.width / 2;
  const x = corner === 'bottom-left' ? Math.min(anchor.x + step, middle) : Math.max(anchor.x - step, middle);
  return { x: Math.round(x), y: anchor.y };
}

/**
 * The mode was switched: the live sessions of this overlay go over to the
 * overlay(s) of the new mode, so the buddies show up at once (not only with
 * the next prompt). One launch per session, each with a "resume" SessionStart
 * as its first event (with the watched pid, so liveness goes on); a second
 * launch for the same overlay hands its event to the running one.
 *   perAccount true: to the account's own overlay (account: its name; a
 *   session without an account cannot go anywhere and is left out)
 *   perAccount false: to the one shared overlay (account: null)
 * @param {Array<{ session: string, account: string|null, pid: number|null }>} sessions
 * @returns {Array<{ account: string|null, event: object }>}
 */
function handoverLaunches(sessions, perAccount, now = Date.now()) {
  const out = [];
  for (const s of sessions || []) {
    if (!s || typeof s.session !== 'string') continue;
    const account = typeof s.account === 'string' && ACCOUNT_RE.test(s.account) && s.account !== 'all' ? s.account : null;
    if (perAccount && !account) continue;
    const event = { v: 1, event: 'SessionStart', session: s.session, ts: now, source: 'resume' };
    if (account) event.account = account;
    if (Number.isInteger(s.pid) && s.pid > 0) event.pid = s.pid;
    out.push({ account: perAccount ? account : null, event });
  }
  return out;
}

module.exports = {
  ACCOUNT_RE,
  handoverLaunches,
  PORT_SPAN,
  PORT_TRIES,
  SIDE_GAP,
  accountArg,
  hashName,
  preferredPort,
  candidatePorts,
  instanceFile,
  parseInstance,
  slotIndex,
  shiftAnchor,
};
