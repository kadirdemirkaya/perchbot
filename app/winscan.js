'use strict';

/**
 * Where are the windows? (Windows only; for perching on title bars, app/perch.js.)
 *
 * A small PowerShell process, started only when asked and stopped after a
 * quiet while, lists the visible top-level windows that have a title bar, the
 * top-most first: for each one only its frame (screen rectangle in physical
 * pixels) and an opaque handle number to tell them apart. No titles, no
 * process names, nothing inside a window, nothing written anywhere; the
 * answers stay in this process. No dependency: PowerShell comes with Windows.
 *
 *   const scanner = createScanner({ log });
 *   const windows = await scanner.scan();   // [{ id, x, y, w, h, max }] or null
 *   scanner.stop();
 */

const { spawn } = require('node:child_process');
const { parseScan } = require('./perch');

/** Stop the helper after this long without a request (ms). */
const IDLE_MS = 120000;
/** A scan that takes longer than this (ms) gives null (the first one compiles the helper). */
const SCAN_TIMEOUT_MS = 6000;

/**
 * The helper. A C# class (compiled once by Add-Type) walks the windows:
 * visible, not minimised, with a caption, not a tool window, not owned by
 * another window, not cloaked (hidden store apps); the frame is DWM's
 * extended frame bounds in physical pixels (per-monitor DPI aware).
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BuddyWindows {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  public static string Scan() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    StringBuilder sb = new StringBuilder("[");
    bool first = true;
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int style = GetWindowLong(h, -16);
      int ex = GetWindowLong(h, -20);
      if ((style & 0x00C00000) != 0x00C00000) return true;
      if ((ex & 0x00000080) != 0) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r;
      if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return true;
      if (r.R - r.L < 40 || r.B - r.T < 40) return true;
      if (!first) sb.Append(",");
      first = false;
      sb.Append("{\"id\":").Append(h.ToInt64()).Append(",\"x\":").Append(r.L).Append(",\"y\":").Append(r.T)
        .Append(",\"w\":").Append(r.R - r.L).Append(",\"h\":").Append(r.B - r.T)
        .Append(",\"max\":").Append(IsZoomed(h) ? "true" : "false").Append("}");
      return true;
    }, IntPtr.Zero);
    return sb.Append("]").ToString();
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  try { [Console]::Out.WriteLine([BuddyWindows]::Scan()) } catch { [Console]::Out.WriteLine('[]') }
}
`;

/** PowerShell's -EncodedCommand: the script as base64 of UTF-16LE (no quoting trouble). */
function encodedCommand(script = SCRIPT) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function createScanner({ log = { devOnly() {}, warn() {} }, platform = process.platform, spawnFn = spawn } = {}) {
  let child = null;
  let buffer = '';
  let waiting = [];
  let idleTimer = null;
  let broken = false;

  const supported = () => platform === 'win32' && !broken;

  function start() {
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand()], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      broken = true;
      log.warn(`window scan: could not start (${err.message})`);
      return;
    }
    log.devOnly('window scan: helper started');
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line || line === 'ready') continue;
        const next = waiting.shift();
        if (next) next(parseScan(line));
      }
      if (buffer.length > 256 * 1024) buffer = '';
    });
    child.on('error', () => {
      broken = true;
      finish();
    });
    child.on('exit', () => finish());
    if (child.stdin) child.stdin.on('error', () => {});
  }

  function finish() {
    child = null;
    for (const resolve of waiting) resolve(null);
    waiting = [];
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  /** The windows now (physical pixels), or null (not Windows, no helper, too slow). */
  function scan() {
    if (!supported()) return Promise.resolve(null);
    if (!child) start();
    if (!child) return Promise.resolve(null);
    armIdle();
    return new Promise((resolve) => {
      let done = false;
      const settle = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        waiting = waiting.filter((w) => w !== settle);
        settle(null);
      }, SCAN_TIMEOUT_MS);
      waiting.push(settle);
      try {
        child.stdin.write('scan\n');
      } catch {
        settle(null);
      }
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    if (!child) return;
    log.devOnly('window scan: helper stopped');
    try {
      child.stdin.write('quit\n');
      child.stdin.end();
    } catch {
      // already gone
    }
    const old = child;
    setTimeout(() => {
      try {
        old.kill();
      } catch {
        // gone
      }
    }, 1000).unref?.();
    finish();
  }

  return { scan, stop, supported, get running() { return Boolean(child); } };
}

module.exports = { createScanner, encodedCommand, SCRIPT, IDLE_MS };
