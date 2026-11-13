'use strict';

/**
 * A second safety net for sessions whose SessionEnd never comes: the terminal
 * window was closed with X, a tab was killed, VS Code was quit. Every few
 * seconds it checks that the Claude Code process of each session is alive;
 * when it is gone, the session is closed as if SessionEnd had come.
 *
 * Only sessions whose SessionStart carried a pid (hooks/send.js finds it) are
 * watched; the others keep the idle timeout as their safety net.
 *
 * - Alive or not: process.kill(pid, 0). A few microseconds, nothing is spawned.
 *   "No permission" (EPERM) counts as alive.
 * - PID reuse: when a session is tracked, the process start time is read once.
 *   Later it is compared again: on Linux at every check (one small file read);
 *   elsewhere reading it costs a process spawn (ps on macOS, PowerShell on
 *   Windows), so only for a session that has sent nothing for verifyMs (events
 *   prove a session alive anyway), at most once per verifyMs. If the start time
 *   cannot be read, the pid alone is used.
 * - The timer runs only while at least one session is watched.
 *
 * No network, nothing written to disk, no process information leaves this
 * module except "gone".
 */

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const DEFAULTS = Object.freeze({
  /** How often the processes are checked. */
  intervalMs: 5000,
  /** A silent session's start time is compared again after this long. */
  verifyMs: 5 * 60 * 1000,
});

const realClock = { setTimeout, clearTimeout, setInterval, clearInterval };

/** Windows pids go up to 2^32 - 1, Linux up to 2^22. */
function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

/** Is the process alive? */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * When the process started (an opaque string; only compared with itself), or
 * null when it cannot be read. Never rejects.
 * @param {number} pid
 * @param {string} [platform]
 * @returns {Promise<string|null>}
 */
function processStartTime(pid, platform = process.platform) {
  if (!validPid(pid)) return Promise.resolve(null);
  if (platform === 'linux') {
    return new Promise((resolve) => {
      fs.readFile(`/proc/${pid}/stat`, 'utf8', (err, text) => {
        if (err) return resolve(null);
        // "pid (comm) state ppid ...": field 22, starttime, counted after the ")".
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        resolve(fields[19] || null);
      });
    });
  }
  const run = (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        const text = !err && typeof stdout === 'string' ? stdout.trim() : '';
        resolve(text || null);
      });
    });
  if (platform === 'win32') {
    // Only the creation time of this one process (the pid is a checked integer).
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -Property CreationDate; ` +
      'if ($p) { $p.CreationDate.ToFileTimeUtc() }';
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  }
  return run('ps', ['-o', 'lstart=', '-p', String(pid)]);
}

class LivenessWatch {
  /**
   * @param {object} [options]
   * @param {(pid: number) => boolean} [options.isAlive]
   * @param {(pid: number) => Promise<string|null>|string|null} [options.startTimeOf]
   * @param {boolean} [options.cheapStartTime]  compare the start time at every check
   * @param {(id: string, why: 'exited'|'reused') => void} [options.onGone]
   */
  constructor({
    clock = realClock,
    now = Date.now,
    isAlive = processAlive,
    startTimeOf = processStartTime,
    cheapStartTime = process.platform === 'linux',
    intervalMs = DEFAULTS.intervalMs,
    verifyMs = DEFAULTS.verifyMs,
    onGone = () => {},
  } = {}) {
    Object.assign(this, { clock, now, isAlive, startTimeOf, cheapStartTime, intervalMs, verifyMs, onGone });
    /** @type {Map<string, { pid: number, start: string|null|undefined, lastSeen: number, verifiedAt: number, pending: boolean }>} */
    this.entries = new Map();
    this.timer = null;
  }

  get size() {
    return this.entries.size;
  }

  /** Watch the Claude Code process of a session (again, if it was watched before). */
  track(id, pid) {
    if (!validPid(pid)) return;
    const at = this.now();
    const entry = { pid, start: undefined, lastSeen: at, verifiedAt: at, pending: true };
    this.entries.set(id, entry);
    this.readStart(entry, (start) => {
      entry.start = start;
    });
    this.arm();
  }

  /** The process id watched for a session, or null. */
  pidOf(id) {
    const entry = this.entries.get(id);
    return entry ? entry.pid : null;
  }

  untrack(id) {
    this.entries.delete(id);
    if (this.entries.size === 0) this.disarm();
  }

  /** The session sent an event: it is alive, no start-time check needed for a while. */
  touch(id) {
    const entry = this.entries.get(id);
    if (entry) entry.lastSeen = this.now();
  }

  check() {
    const at = this.now();
    for (const [id, entry] of [...this.entries]) {
      if (!this.isAlive(entry.pid)) {
        this.gone(id, 'exited');
        continue;
      }
      if (entry.pending || typeof entry.start !== 'string') continue;
      const due = this.cheapStartTime || (at - entry.lastSeen >= this.verifyMs && at - entry.verifiedAt >= this.verifyMs);
      if (!due) continue;
      entry.verifiedAt = at;
      this.readStart(entry, (start) => {
        if (this.entries.get(id) === entry && start !== null && start !== entry.start) this.gone(id, 'reused');
      });
    }
  }

  dispose() {
    this.entries.clear();
    this.disarm();
  }

  // ---------------------------------------------------------------- internals

  readStart(entry, done) {
    entry.pending = true;
    let result;
    try {
      result = this.startTimeOf(entry.pid);
    } catch {
      result = null;
    }
    Promise.resolve(result)
      .catch(() => null)
      .then((start) => {
        entry.pending = false;
        done(typeof start === 'string' || typeof start === 'number' ? String(start) : null);
      });
  }

  gone(id, why) {
    this.entries.delete(id);
    if (this.entries.size === 0) this.disarm();
    this.onGone(id, why);
  }

  arm() {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => this.check(), this.intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  disarm() {
    if (!this.timer) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { LivenessWatch, processAlive, processStartTime, validPid, LIVENESS_DEFAULTS: DEFAULTS };
