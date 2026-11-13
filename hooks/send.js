#!/usr/bin/env node
'use strict';

/**
 * Agent Buddy hook script. Claude Code runs it for each configured hook event
 * and passes the event as JSON on stdin.
 *
 * Contract: it must never get in Claude Code's way.
 *  - Never writes to stdout (stdout of some hooks is added to Claude's context).
 *  - Always exits with code 0, even on errors.
 *  - Finishes fast: one local HTTP request with a 300 ms timeout. On SessionStart
 *    (registered async, so Claude Code does not wait) finding Claude Code's
 *    process id adds up to 1.5 s (about 0.4 s on Windows, a few ms elsewhere).
 *  - Forwards only a small whitelisted summary of the event (see buildPayload):
 *    no file contents, no prompts, no full commands, no tool output.
 *
 * On SessionStart it also looks for the process id of Claude Code among its
 * ancestors (see findClaudePid; only names and parent ids are read, and only
 * the number is sent), so the overlay can tell when a session dies without
 * SessionEnd (terminal closed with X, VS Code quit).
 *
 * If the overlay is not running and the event is SessionStart or
 * UserPromptSubmit, it starts the overlay detached and hands it the event as a
 * launch argument, then exits without waiting. It does not do that for a
 * Claude account the user filtered out (settings.json "account").
 *
 * Usage: node hooks/send.js [EventName] [--agent-buddy]
 *   EventName is a fallback; hook_event_name from stdin wins.
 *   --agent-buddy only tags the command so setup/uninstall can recognise it.
 *
 * Environment (all optional):
 *   AGENT_BUDDY_HOME       settings folder (default ~/.agent-buddy)
 *   AGENT_BUDDY_PORT       overlay port (default: settings.json "port", else 7777)
 *   AGENT_BUDDY_DEBUG=1    append one line per event to <home>/logs/hook.log
 *   AGENT_BUDDY_NO_LAUNCH=1  never start the overlay (used by tests)
 *   AGENT_BUDDY_NO_PID=1   do not look for Claude Code's process id (tests, simulator)
 *
 * Zero dependencies: Node.js built-ins only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');

const START_TS = Date.now();
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_PORT = 7777;
const POST_TIMEOUT_MS = 300;
const STDIN_TIMEOUT_MS = 1000;
const STDIN_LIMIT_BYTES = 16 * 1024 * 1024;
const HARD_EXIT_MS = 2500;
const COMMAND_MAX = 40;
const PATTERN_MAX = 30;
const FILE_MAX = 36;
const MAX_LOG_BYTES = 256 * 1024;

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
]);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const AGENT_EVENTS = new Set(['SubagentStart', 'SubagentStop']);
const LAUNCH_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const AGENT_TYPE_MAX = 40;
const SKILL_MAX = 24;
const ACCOUNT_MAX = 40;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,40}$/;
/** Shells and launchers between Claude Code and this script (Git Bash runs bash.exe twice). */
const SHELL_NAMES = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'env', 'winpty']);
/** Claude Code's own process: the native binary, or Node / Bun running the CLI. */
const CLAUDE_NAMES = new Set(['claude', 'node', 'bun']);
const PID_DEPTH = 6;
const PID_TIMEOUT_MS = 1500;

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Read', 'NotebookEdit', 'NotebookRead']);
const PATTERN_TOOLS = new Set(['Grep', 'Glob']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

/**
 * ALLOWLIST: the only fields that may leave this process, each a string or a
 * number. Everything else is dropped at the end of buildPayload, including
 * any field a future Claude Code version adds to the hook input.
 */
const PAYLOAD_FIELDS = Object.freeze({
  v: 'payload format version',
  event: 'hook event name',
  session: 'session_id',
  ts: 'timestamp (ms) taken when the hook started',
  tool: 'tool_name',
  id: 'tool_use_id, pairs PreToolUse with PostToolUse',
  detail: 'file name, shortened command (secrets masked), search pattern or web host',
  kind: 'notification_type',
  source: 'SessionStart source (startup / resume / clear / compact)',
  reason: 'SessionEnd reason',
  agent: 'short hash of agent_id (sub-agents)',
  agentType: 'agent_type, e.g. "Explore" (sub-agents)',
  skill: 'skill name',
  account: 'Claude config folder name, e.g. "claude-personal" (never a full path)',
  pid: 'SessionStart only: process id of Claude Code, a number (nothing else about the process)',
});

/** Copy only allowlisted string / number fields. */
function allowlisted(payload) {
  const out = {};
  for (const key of Object.keys(PAYLOAD_FIELDS)) {
    const value = payload[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

const ID_RE = /^[A-Za-z0-9._:-]+$/;
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const WORD_RE = /^[a-z_]{1,40}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Secrets that commonly appear inside shell commands. Matches are replaced
// with *** before the command is shortened, so a secret is never half-shown.
const SECRET_PATTERNS = [
  // Authorization schemes: "Bearer abc", "Basic abc", "token abc"
  [/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, '$1 ***'],
  // --password=x, --api-key x, -token x ...
  [
    /(--?[\w-]*(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|apikey|auth|credential|private[-_]?key)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2***',
  ],
  // GITHUB_TOKEN=x, $env:API_KEY = "x" ...
  [
    /\b([A-Za-z0-9_]*(?:pass(?:word|wd)?|pwd|secret|token|api_?key|auth|credential|private_?key)[A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2***',
  ],
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1***@'],
  // curl -u user:password
  [/(\s-u\s+)("[^"]*"|'[^']*'|\S+)/g, '$1***'],
  // Long opaque tokens: 24+ characters mixing letters and digits
  [/(?<![A-Za-z0-9_\-+=])(?=[A-Za-z0-9_\-+=]*\d)(?=[A-Za-z0-9_\-+=]*[A-Za-z])[A-Za-z0-9_\-+=]{24,}/g, '***'],
];

// ---------------------------------------------------------------- payload

function cleanString(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ') : '';
}

function shorten(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '\u2026' : text;
}

function maskSecrets(text) {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** "C:\\a\\b\\very-long-name.test.ts" -> "very-long-name.test.ts" (shortened, extension kept). */
function fileLabel(filePath) {
  if (typeof filePath !== 'string' || !filePath) return undefined;
  const name = cleanString(filePath).split(/[\\/]/).filter(Boolean).pop();
  if (!name) return undefined;
  if (name.length <= FILE_MAX) return name;
  const tail = name.slice(-10);
  return name.slice(0, FILE_MAX - tail.length - 1) + '\u2026' + tail;
}

// Leading parts of a command line that only prepare the real command: changing
// directory, setting variables. They are left out, so "cd C:\long\path && npm test"
// becomes "npm test" (and the path never leaves the hook).
const SETUP_PARTS = [
  /^(cd|chdir|pushd|popd|set-location|sl)(\s|$)/i,
  /^\$env:[\w]+\s*=/i,
  /^\$[\w]+\s*=/,
  /^(export|set|setx)\s+\w+=/i,
  /^\w+=("[^"]*"|'[^']*'|\S*)$/,
];
// A token that is an absolute or home path: shown as its last part only.
const PATH_TOKEN = /^(["']?)((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:home|Users|root|mnt|tmp|var|etc|opt|srv|c|d)\/)[^"']*)\1$/;

function lastPart(text) {
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

/**
 * The command itself, without the set-up in front of it: "cd x && FOO=1 npm test"
 * -> "npm test", "& 'C:\tools\dotnet.exe' test" -> "dotnet test". Paths become
 * their last part. Only ever removes text.
 */
function commandCore(line) {
  const parts = line.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  let i = 0;
  while (i < parts.length - 1 && SETUP_PARTS.some((re) => re.test(parts[i]))) i += 1;
  const allSetup = SETUP_PARTS.some((re) => re.test(parts[i] || ''));
  let rest = line;
  if (i > 0) {
    // Cut the original line after the separator that ends the last set-up part.
    let at = 0;
    for (let k = 0; k < i; k += 1) {
      at = line.indexOf(parts[k], at) + parts[k].length;
      const sep = /^\s*(?:&&|\|\||;)\s*/.exec(line.slice(at));
      if (sep) at += sep[0].length;
    }
    rest = line.slice(at);
  }
  rest = rest.replace(/^&\s+/, '').replace(/^(\w+=("[^"]*"|'[^']*'|\S+)\s+)+/, '');
  // Words, quoted parts kept together ("C:\Program Files\x.exe" is one).
  const tokens = rest.match(/"[^"]*"?|'[^']*'?|\S+/g) || [];
  const out = tokens.map((token, index) => {
    const path = PATH_TOKEN.exec(token);
    let word = path ? lastPart(path[2]) : token;
    if (index === 0) {
      word = word.replace(/^["']|["']$/g, '');
      if (word.includes('/') || word.includes('\\')) word = lastPart(word);
      word = word.replace(/\.(exe|cmd|bat|com)$/i, '');
    }
    return word;
  });
  // Only set-up ("cd somewhere"): say so, without the path.
  if (allSetup && i === parts.length - 1) return out[0];
  return out.join(' ').trim();
}

/** The command itself (see commandCore), first line, secrets masked, at most COMMAND_MAX characters. */
function summarizeCommand(command) {
  if (typeof command !== 'string') return undefined;
  const lines = command.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  let line = commandCore(maskSecrets(cleanString(lines[0]).replace(/\s+/g, ' ').trim()));
  if (!line) return undefined;
  if (lines.length > 1) line += ' \u2026';
  return shorten(line, COMMAND_MAX);
}

function summarizePattern(pattern) {
  if (typeof pattern !== 'string') return undefined;
  const text = maskSecrets(cleanString(pattern).replace(/\s+/g, ' ').trim());
  return text ? shorten(text, PATTERN_MAX) : undefined;
}

function hostOf(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return shorten(parsed.hostname.replace(/^www\./, ''), 40);
  } catch {
    return undefined;
  }
}

function toolDetail(tool, input) {
  if (!input || typeof input !== 'object') return undefined;
  if (FILE_TOOLS.has(tool)) return fileLabel(input.file_path || input.notebook_path);
  if (PATTERN_TOOLS.has(tool)) return summarizePattern(input.pattern);
  if (COMMAND_TOOLS.has(tool)) return summarizeCommand(input.command);
  if (tool === 'WebFetch') return hostOf(input.url);
  return undefined;
}

function safeId(value, max) {
  return typeof value === 'string' && value.length <= max && ID_RE.test(value) ? value : undefined;
}

/** agent_id -> 10 hex characters. Pairs an agent's events without passing on the id itself. */
function agentHash(agentId) {
  if (typeof agentId !== 'string' || !agentId || agentId.length > 256) return undefined;
  return crypto.createHash('sha256').update(`agent-buddy:${agentId}`).digest('hex').slice(0, 10);
}

/** agent_type such as "Explore" or "plugin:reviewer": safe characters only, at most 40. */
function agentTypeLabel(value) {
  if (typeof value !== 'string') return undefined;
  const text = cleanString(value).replace(/[^A-Za-z0-9 _.:/-]/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, AGENT_TYPE_MAX).trim() : undefined;
}

/** A skill or slash-command name: no leading "/", safe characters only, at most 24. */
function skillLabel(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/^\/+/, '').replace(/[^A-Za-z0-9_.:/-]/g, '');
  return text ? text.slice(0, SKILL_MAX) : undefined;
}

/**
 * Which Claude account (config folder) this hook runs for: the folder NAME of
 * CLAUDE_CONFIG_DIR without leading dots ("C:/Users/x/.claude-work" ->
 * "claude-work"), or "claude" for the default ~/.claude. Never a path.
 */
function accountName(env = process.env) {
  const dir = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (!dir) return 'claude';
  const base = path.basename(path.resolve(dir)).replace(/^\.+/, '');
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, ACCOUNT_MAX);
  return clean || 'claude';
}

/**
 * Reduce a hook input to the few fields the overlay needs.
 * Returns null for events the overlay does not handle.
 * @param {unknown} input  parsed stdin JSON (may be null)
 * @param {string} [fallbackEvent]  event name from argv
 * @param {number} [now]
 * @param {{ account?: string, pid?: number }} [extra]  the account name (see accountName),
 *   Claude Code's process id (see findClaudePid; used on SessionStart only)
 */
function buildPayload(input, fallbackEvent, now = Date.now(), extra = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const event = typeof src.hook_event_name === 'string' ? src.hook_event_name : fallbackEvent;
  if (!EVENTS.has(event)) return null;

  const payload = { v: 1, event, session: safeId(src.session_id, 128) || 'unknown', ts: now };
  if (typeof extra.account === 'string' && ACCOUNT_RE.test(extra.account)) payload.account = extra.account;

  if (TOOL_EVENTS.has(event)) {
    payload.tool = typeof src.tool_name === 'string' && TOOL_RE.test(src.tool_name) ? src.tool_name : 'unknown';
    const id = safeId(src.tool_use_id, 64);
    if (id) payload.id = id;
    if (event === 'PreToolUse') {
      const detail = toolDetail(payload.tool, src.tool_input);
      if (detail) payload.detail = detail;
    }
  }
  if (event === 'Notification' && typeof src.notification_type === 'string' && WORD_RE.test(src.notification_type)) {
    payload.kind = src.notification_type;
  }
  if (event === 'SessionStart' && typeof src.source === 'string' && WORD_RE.test(src.source)) {
    payload.source = src.source;
  }
  if (event === 'SessionStart' && validPid(extra.pid)) payload.pid = extra.pid;
  if (event === 'SessionEnd' && typeof src.reason === 'string' && WORD_RE.test(src.reason)) {
    payload.reason = src.reason;
  }
  // Sub-agents: their tool events and Start / Stop carry agent_id (the main session's do not).
  if (TOOL_EVENTS.has(event) || AGENT_EVENTS.has(event)) {
    const agent = agentHash(src.agent_id);
    if (agent) {
      payload.agent = agent;
      const type = agentTypeLabel(src.agent_type);
      if (type) payload.agentType = type;
    }
  }
  if (AGENT_EVENTS.has(event) && !payload.agent) return null;
  // Skills: only the name. Through the Skill tool, or typed as a slash command.
  if (event === 'PreToolUse' && payload.tool === 'Skill' && src.tool_input && typeof src.tool_input === 'object') {
    const skill = skillLabel(src.tool_input.skill);
    if (skill) payload.skill = skill;
  }
  if (event === 'UserPromptExpansion') {
    if (src.expansion_type !== 'slash_command') return null;
    const skill = skillLabel(src.command_name);
    if (!skill) return null;
    payload.skill = skill;
  }
  return allowlisted(payload);
}

// ---------------------------------------------------------------- Claude Code's process id

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

/** "C:\\x\\Claude.EXE" -> "claude" */
function processName(name) {
  return typeof name === 'string' ? path.basename(name.trim()).toLowerCase().replace(/\.exe$/, '') : '';
}

/**
 * Walk up from the hook's parent through shells: the first process that is
 * not a shell is Claude Code if it is called "claude" (the native binary),
 * or "node" / "bun" (the CLI installed with npm) when the hook knows it runs
 * under Claude Code (CLAUDECODE=1). Anything else (a terminal, an IDE, a
 * script that runs the hook, a gap in the chain): null, no pid is sent.
 * @param {number} start  the hook's parent pid
 * @param {Map<number, { ppid: number, name: string }>} chain  ancestors by pid
 * @param {{ runtime?: boolean }} [allow]  runtime: accept node / bun
 * @returns {number|null}
 */
function claudePidFrom(start, chain, allow = {}) {
  let pid = start;
  for (let depth = 0; depth < PID_DEPTH; depth += 1) {
    const info = chain.get(pid);
    if (!info) return null;
    const name = processName(info.name);
    if (!SHELL_NAMES.has(name)) {
      const ok = name === 'claude' || (allow.runtime === true && CLAUDE_NAMES.has(name));
      return ok && validPid(pid) ? pid : null;
    }
    pid = info.ppid;
  }
  return null;
}

/**
 * Claude Code puts its own process id into its children's environment
 * (CLAUDE_PID; seen in Claude Code 2.1, not documented for hooks). Use it when
 * it really is one of the hook's ancestors; otherwise walk up (claudePidFrom).
 * If the ancestors cannot be read at all, a live CLAUDE_PID is used as it is.
 * @param {number} start
 * @param {Map<number, { ppid: number, name: string }>} chain
 * @param {object} env
 * @param {(pid: number) => boolean} isAlive
 */
function chooseClaudePid(start, chain, env, isAlive) {
  const fromEnv = /^\d{1,10}$/.test(String(env.CLAUDE_PID || '')) ? Number(env.CLAUDE_PID) : null;
  if (validPid(fromEnv) && chain.has(fromEnv)) return fromEnv;
  if (validPid(fromEnv) && chain.size === 0 && isAlive(fromEnv)) return fromEnv;
  return claudePidFrom(start, chain, { runtime: env.CLAUDECODE === '1' });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/** "pid|ppid|name" lines -> Map. */
function parseChain(text) {
  const chain = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const [pid, ppid, ...name] = line.trim().split('|');
    const p = Number(pid);
    if (validPid(p)) chain.set(p, { ppid: Number(ppid) || 0, name: name.join('|') });
  }
  return chain;
}

/**
 * The hook's ancestors, at most PID_DEPTH of them: process id, parent id and
 * executable name, nothing else (no command lines, no paths). Never rejects.
 * @returns {Promise<Map<number, { ppid: number, name: string }>>}
 */
function readAncestors(start, platform = process.platform) {
  return new Promise((resolve) => {
    if (!validPid(start)) return resolve(new Map());
    if (platform === 'win32') {
      // One PowerShell call walks the chain (Name and ParentProcessId only).
      const script =
        `$p = ${start}; for ($i = 0; $i -lt ${PID_DEPTH} -and $p -gt 0; $i++) { ` +
        '$c = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -Property ProcessId,ParentProcessId,Name; ' +
        'if (-not $c) { break }; "$($c.ProcessId)|$($c.ParentProcessId)|$($c.Name)"; $p = $c.ParentProcessId }';
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: PID_TIMEOUT_MS },
        (err, stdout) => resolve(err ? new Map() : parseChain(stdout)),
      );
      return;
    }
    const chain = new Map();
    try {
      let pid = start;
      for (let depth = 0; depth < PID_DEPTH && validPid(pid); depth += 1) {
        let ppid;
        let name;
        if (platform === 'linux') {
          // "pid (comm) state ppid ..."
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
          ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        } else {
          const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 300, encoding: 'utf8' });
          const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(out);
          if (!m) break;
          ppid = Number(m[1]);
          name = m[2];
        }
        chain.set(pid, { ppid, name: processName(name) });
        pid = ppid;
      }
    } catch {
      // a gap in the chain: what was read so far
    }
    resolve(chain);
  });
}

/** Claude Code's process id, or null if it cannot be found reliably. Never rejects. */
async function findClaudePid(start = process.ppid, platform = process.platform, env = process.env) {
  try {
    return chooseClaudePid(start, await readAncestors(start, platform), env, processAlive);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- config

function readConfig(env = process.env) {
  const home = env.AGENT_BUDDY_HOME ? path.resolve(env.AGENT_BUDDY_HOME) : path.join(os.homedir(), '.agent-buddy');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')) || {};
  } catch {
    // no settings file: defaults
  }
  const validPort = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
  const envPort = Number(env.AGENT_BUDDY_PORT);
  return {
    home,
    port: validPort(envPort) ? envPort : validPort(settings.port) ? settings.port : DEFAULT_PORT,
    debug: env.AGENT_BUDDY_DEBUG === '1' || settings.debug === true,
    noLaunch: env.AGENT_BUDDY_NO_LAUNCH === '1',
    noPid: env.AGENT_BUDDY_NO_PID === '1',
    /** "all", or the one account the overlay shows (tray menu "Account"). */
    account: typeof settings.account === 'string' && ACCOUNT_RE.test(settings.account) ? settings.account : 'all',
  };
}

/** Sessions the user closed the overlay for via the tray ("Quit now"). */
function isMuted(home, session, now = Date.now()) {
  try {
    const muted = JSON.parse(fs.readFileSync(path.join(home, 'muted.json'), 'utf8'));
    return muted.until > now && Array.isArray(muted.sessions) && muted.sessions.includes(session);
  } catch {
    return false;
  }
}

function shouldLaunch(payload, config) {
  if (config.noLaunch || !LAUNCH_EVENTS.has(payload.event)) return false;
  // The overlay only shows one account: do not start it for another one.
  if (config.account && config.account !== 'all' && payload.account !== config.account) return false;
  if (payload.event === 'SessionStart') return true; // a fresh start always brings the buddy back
  return !isMuted(config.home, payload.session);
}

// ---------------------------------------------------------------- I/O

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      if (size < STDIN_LIMIT_BYTES) chunks.push(chunk);
      size += chunk.length;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Resolves to 'delivered' | 'refused' | 'timeout' | 'error' | 'http-<status>'. Never rejects. */
function post(payload, port, timeoutMs = POST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/event',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        done(res.statusCode === 204 ? 'delivered' : `http-${res.statusCode}`);
      },
    );
    const timer = setTimeout(() => {
      done('timeout');
      req.destroy();
    }, timeoutMs);
    req.on('error', (err) => done(err && err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
    req.end(body);
  });
}

/**
 * The Electron binary: from Agent Buddy's own node_modules (a clone, or a
 * global npm install), else wherever Node would find the package from here
 * (an install where npm put Electron one level up). null when it is missing.
 */
function electronBinary(root = ROOT) {
  const places = [path.join(root, 'node_modules', 'electron')];
  try {
    places.push(path.dirname(require.resolve('electron/package.json', { paths: [root] })));
  } catch {
    // not resolvable from here
  }
  for (const pkg of places) {
    try {
      const binary = path.join(pkg, 'dist', fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim());
      if (fs.existsSync(binary)) return binary;
    } catch {
      // not installed here (or its download never finished)
    }
  }
  return null;
}

/** Start the overlay detached and hand it the event; do not wait for it. */
function launchOverlay(payload) {
  const binary = electronBinary();
  if (!binary) return 'electron-missing';
  const env = { ...process.env };
  // Set inside VS Code's extension host; it would make Electron behave as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const arg = '--initial-event=' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const child = spawn(binary, [ROOT, arg], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return 'launched';
}

// ---------------------------------------------------------------- schema probe

/**
 * Developer aid for checking which fields Claude Code actually sends. OFF by
 * default; it runs only while <home>/schema-log.on exists. It appends one JSON
 * line per hook to <home>/logs/schema.log containing:
 *  - field NAMES (top level, tool_input, tool_response), never their values;
 *  - the event and tool name (identifiers, needed to read the log);
 *  - session_id / agent_id as 8-character salted hashes, so events can be
 *    correlated without recording the ids. The salt is the content of the
 *    flag file; deleting that file makes the hashes meaningless.
 *  - for UserPromptExpansion only: the expansion_type VALUE (an identifier such
 *    as "slash_command", lowercase letters and "_" only), so a test can tell
 *    whether the overlay would show it. Never the command, its arguments or
 *    the prompt.
 */
function schemaRecord(input, salt, env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : null;
  const transcript = typeof input.transcript_path === 'string' ? path.resolve(input.transcript_path) : null;
  const keysOf = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : undefined;
  const kind = (value) => (value === undefined ? undefined : Array.isArray(value) ? 'array' : typeof value);
  const hash = (value) =>
    typeof value === 'string' && value
      ? crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 8)
      : undefined;
  const safeName = (value) => (typeof value === 'string' && TOOL_RE.test(value) ? value : undefined);
  return {
    event: safeName(input.hook_event_name),
    tool: safeName(input.tool_name),
    keys: keysOf(input),
    tool_input: keysOf(input.tool_input),
    tool_response: keysOf(input.tool_response),
    tool_response_type: kind(input.tool_response),
    session: hash(input.session_id),
    agent: hash(input.agent_id),
    expansion_type:
      input.hook_event_name === 'UserPromptExpansion' &&
      typeof input.expansion_type === 'string' &&
      WORD_RE.test(input.expansion_type)
        ? input.expansion_type
        : undefined,
    // Booleans only: is CLAUDE_CONFIG_DIR visible to the hook, and does the
    // transcript live under it? (No paths are recorded.)
    env_config_dir: Boolean(configDir),
    transcript_in_config_dir:
      configDir && transcript ? transcript.toLowerCase().startsWith(configDir.toLowerCase() + path.sep) : undefined,
  };
}

function schemaProbe(home, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  let salt;
  try {
    salt = fs.readFileSync(path.join(home, 'schema-log.on'), 'utf8').trim();
  } catch {
    return; // probe is off
  }
  try {
    const dir = path.join(home, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), ...schemaRecord(input, salt) });
    fs.appendFileSync(path.join(dir, 'schema.log'), line + '\n', 'utf8');
  } catch {
    // never fail because of the probe
  }
}

function debugLog(config, line) {
  if (!config || !config.debug) return;
  try {
    const dir = path.join(config.home, 'logs');
    const file = path.join(dir, 'hook.log');
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // never fail because of logging
  }
}

// ---------------------------------------------------------------- main

async function main() {
  let config = null;
  let payload = null;
  let result = 'skipped';
  try {
    const argEvent = process.argv.slice(2).find((a) => !a.startsWith('-'));
    // Some shells (e.g. Windows PowerShell 5.1 pipes) prepend a byte-order mark.
    const raw = (await readStdin()).replace(/^﻿/, '');
    let input = null;
    try {
      input = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      input = null;
    }
    config = readConfig();
    schemaProbe(config.home, input);
    const event = input && typeof input.hook_event_name === 'string' ? input.hook_event_name : argEvent;
    const pid = event === 'SessionStart' && !config.noPid ? await findClaudePid() : null;
    payload = buildPayload(input, argEvent, START_TS, { account: accountName(), pid });
    if (payload) {
      result = await post(payload, config.port);
      if (result === 'refused' && shouldLaunch(payload, config)) result = launchOverlay(payload);
    }
  } catch {
    result = 'error';
  }
  // Only event metadata is logged: no file names, commands or prompt text.
  if (payload) {
    debugLog(
      config,
      `event=${payload.event} session=${payload.session.slice(0, 8)} tool=${payload.tool || '-'} ` +
        `result=${result} ${Date.now() - START_TS}ms`,
    );
  }
  process.exit(0);
}

if (require.main === module) {
  // Guard rails: nothing may reach stdout, nothing may change the exit code.
  process.stdout.write = () => true;
  console.log = () => {};
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
  main();
}

module.exports = {
  PAYLOAD_FIELDS,
  accountName,
  claudePidFrom,
  chooseClaudePid,
  parseChain,
  findClaudePid,
  allowlisted,
  buildPayload,
  summarizeCommand,
  commandCore,
  summarizePattern,
  maskSecrets,
  fileLabel,
  agentHash,
  agentTypeLabel,
  skillLabel,
  hostOf,
  readConfig,
  isMuted,
  shouldLaunch,
  post,
  schemaRecord,
  electronBinary,
};
