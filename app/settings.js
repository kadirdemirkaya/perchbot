'use strict';

/**
 * User settings, stored as JSON in ~/.agent-buddy/settings.json.
 * (Override the folder with the AGENT_BUDDY_HOME environment variable.)
 *
 * hooks/send.js reads `port` and `debug` from the same file, so keep the
 * location in sync with buddyHome() there.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORNERS = ['bottom-right', 'bottom-left'];
const SIZES = ['small', 'medium', 'large'];
const LANGUAGES = ['en', 'tr'];
/** auto: hover with sole thrusters when placed above the ground; stand: never. */
const HOVER_MODES = ['auto', 'stand'];
/** Claude account (config folder) names, as hooks/send.js sends them. */
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_KNOWN_ACCOUNTS = 8;

const DEFAULTS = Object.freeze({
  corner: 'bottom-right',
  size: 'medium',
  character: 'robot',
  quiet: false,
  language: 'en',
  port: 7777,
  idleTimeoutMinutes: 30,
  debug: false,
  /** Eyes follow the cursor while it is over the overlay window. */
  eyeTracking: true,
  /** null = corner mode; {x, y} = where the character was dragged to (screen DIPs). */
  position: null,
  hoverMode: 'auto',
  /** "all", or the one Claude account (config folder name) whose sessions are shown. */
  account: 'all',
  /** Accounts seen so far, offered in the tray menu (at most 8, most recent first). */
  knownAccounts: [],
  /** Idle plays, varied cheers, trips around the screen, running off when clicked too often. */
  funMode: true,
});

const COORD_LIMIT = 1e6;

function normalizePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < COORD_LIMIT;
  return ok(x) && ok(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

function buddyHome() {
  const override = process.env.AGENT_BUDDY_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.agent-buddy');
}

function settingsPath(home = buddyHome()) {
  return path.join(home, 'settings.json');
}

/** Coerce arbitrary input into a valid settings object, field by field. */
function normalizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  if (CORNERS.includes(raw.corner)) s.corner = raw.corner;
  if (SIZES.includes(raw.size)) s.size = raw.size;
  if (typeof raw.character === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(raw.character)) {
    s.character = raw.character;
  }
  if (typeof raw.quiet === 'boolean') s.quiet = raw.quiet;
  if (LANGUAGES.includes(raw.language)) s.language = raw.language;
  if (Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535) s.port = raw.port;
  if (typeof raw.idleTimeoutMinutes === 'number' && raw.idleTimeoutMinutes >= 0 && raw.idleTimeoutMinutes <= 24 * 60) {
    s.idleTimeoutMinutes = raw.idleTimeoutMinutes;
  }
  if (typeof raw.debug === 'boolean') s.debug = raw.debug;
  if (typeof raw.eyeTracking === 'boolean') s.eyeTracking = raw.eyeTracking;
  if (typeof raw.funMode === 'boolean') s.funMode = raw.funMode;
  s.position = normalizePosition(raw.position);
  if (HOVER_MODES.includes(raw.hoverMode)) s.hoverMode = raw.hoverMode;
  if (typeof raw.account === 'string' && (raw.account === 'all' || ACCOUNT_RE.test(raw.account))) s.account = raw.account;
  if (Array.isArray(raw.knownAccounts)) {
    s.knownAccounts = [...new Set(raw.knownAccounts.filter((a) => typeof a === 'string' && ACCOUNT_RE.test(a) && a !== 'all'))].slice(
      0,
      MAX_KNOWN_ACCOUNTS,
    );
  }
  return s;
}

/** knownAccounts with `name` first (deduplicated, capped). */
function rememberAccount(known, name) {
  if (typeof name !== 'string' || !ACCOUNT_RE.test(name) || name === 'all') return known;
  if (known[0] === name) return known;
  return [name, ...known.filter((a) => a !== name)].slice(0, MAX_KNOWN_ACCOUNTS);
}

/**
 * @returns {{ settings: typeof DEFAULTS, error: string | null }}
 *   error is set when the file exists but could not be parsed.
 */
function loadSettings(file = settingsPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { settings: { ...DEFAULTS }, error: null }; // no file yet
  }
  try {
    return { settings: normalizeSettings(JSON.parse(text)), error: null };
  } catch (err) {
    return { settings: { ...DEFAULTS }, error: `Could not parse ${file}: ${err.message}` };
  }
}

/** Write atomically: temp file + rename, so a crash never leaves half a file. */
function saveSettings(settings, file = settingsPath()) {
  const clean = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}

/** Port actually used: AGENT_BUDDY_PORT wins over the settings file. */
function effectivePort(settings) {
  const fromEnv = Number(process.env.AGENT_BUDDY_PORT);
  if (Number.isInteger(fromEnv) && fromEnv >= 1024 && fromEnv <= 65535) return fromEnv;
  return settings.port;
}

module.exports = {
  DEFAULTS,
  CORNERS,
  SIZES,
  LANGUAGES,
  HOVER_MODES,
  MAX_KNOWN_ACCOUNTS,
  rememberAccount,
  buddyHome,
  settingsPath,
  normalizeSettings,
  loadSettings,
  saveSettings,
  effectivePort,
};
