'use strict';

/**
 * Where is the text caret? (Windows only; for "Watch me type", app/typing.js.)
 *
 * A small PowerShell process, started only while "Watch me type" may run and stopped after
 * a quiet while, answers one question: in the window in front, where is the text caret?
 * Two ways, the second only when the first gives nothing:
 *   1. Terminals (Windows Terminal, the classic console): Windows UI Automation, the
 *      accessibility interface screen readers use, for the focused text field's caret.
 *      A field that says it is a password field gives nothing at all.
 *   2. Any other window (VS Code, browsers, editors): the caret object Windows keeps for
 *      the Magnifier (MSAA OBJID_CARET), its rectangle only. Chromium apps answer it from
 *      their input caret without switching on their screen reader support, which UI
 *      Automation would do (VS Code then changes its editor), so that is never asked here.
 *      These apps do not say whether a field is a password field: still a position only.
 * It passes on only the rectangle (screen, physical pixels) and an opaque number that tells
 * two fields (or windows) apart. Never any text: nothing is read from the field, no window
 * titles, no process names, no keys (no keyboard hook). Nothing is written anywhere; the
 * answers stay in this process. No dependency: PowerShell comes with Windows.
 *
 *   const watch = createCaretWatch({ log });
 *   const caret = await watch.where();   // { x, y, w, h, field } or null (or { secret: true })
 *   watch.stop();
 */

const { spawn } = require('node:child_process');

/** Stop the helper after this long without a question (ms). */
const IDLE_MS = 60000;
/** An answer that takes longer than this (ms) gives null (the first one compiles the helper). */
const TIMEOUT_MS = 5000;
/** Window classes asked through UI Automation (way 1): Windows Terminal, the classic console. */
const TERMINALS = Object.freeze(['CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass']);
/**
 * Way 2 (the caret object), a caret spot it does not trust: in the window's top band (DIP;
 * the title bar: Chromium parks its caret at y 0 for a moment when the focus moves, or when
 * the caret's line is scrolled out of view) or outside the window. Measured in VS Code.
 */
const CARET_OBJECT = Object.freeze({ topBand: 32 });

/**
 * The helper. A C# class (compiled once by Add-Type) looks at the window in front only
 * (per-monitor DPI aware), never a hung one.
 * Way 1, terminals: its focused element in the same process, not a password field, a text
 * pattern: the caret is the selection (a terminal's selection is its cursor when nothing
 * is selected), widened to one character for its rectangle.
 * Way 2, when way 1 gives nothing: the caret object of the window with the keyboard focus
 * (OBJID_CARET), its location only; hidden (no width) or untrusted spots give nothing.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, Accessibility -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using Accessibility;
public static class BuddyCaret {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gi);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  static readonly string[] Terminals = { ${TERMINALS.map((t) => `"${t}"`).join(', ')} };
  const uint OBJID_CARET = 0xFFFFFFF8;
  const int TopBand = ${CARET_OBJECT.topBand};
  static Guid IAccessibleId = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  static string Spot(int x, int y, int w, int h, long field) {
    return "{\"x\":" + x + ",\"y\":" + y + ",\"w\":" + w + ",\"h\":" + h + ",\"field\":" + field + "}";
  }
  public static string Where() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    IntPtr front = GetForegroundWindow();
    if (front == IntPtr.Zero || IsHungAppWindow(front)) return "{}";
    StringBuilder kind = new StringBuilder(64);
    GetClassName(front, kind, 64);
    uint pid;
    uint thread = GetWindowThreadProcessId(front, out pid);
    if (Array.IndexOf(Terminals, kind.ToString()) >= 0) {
      string first = FromTerminal(pid);
      if (first != null) return first;
    }
    return FromCaretObject(front, thread);
  }
  static string FromTerminal(uint pid) {
    AutomationElement el = AutomationElement.FocusedElement;
    if (el == null || el.Current.ProcessId != (int)pid) return null;
    if (el.Current.IsPassword) return "{\"secret\":true}";
    object pattern;
    if (!el.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return null;
    TextPatternRange[] selection = ((TextPattern)pattern).GetSelection();
    if (selection == null || selection.Length == 0) return null;
    TextPatternRange caret = selection[0].Clone();
    caret.ExpandToEnclosingUnit(TextUnit.Character);
    Rect[] rects = caret.GetBoundingRectangles();
    if (rects == null || rects.Length == 0 || rects[0].IsEmpty) return null;
    Rect r = rects[0];
    long field = 17;
    foreach (int part in el.GetRuntimeId()) field = (field * 31 + part) & 0x0FFFFFFF;
    return Spot((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height, field);
  }
  static string FromCaretObject(IntPtr front, uint thread) {
    GUITHREADINFO gui = new GUITHREADINFO();
    gui.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(thread, ref gui)) return "{}";
    IntPtr focus = gui.hwndFocus != IntPtr.Zero ? gui.hwndFocus : front;
    object found;
    if (AccessibleObjectFromWindow(focus, OBJID_CARET, ref IAccessibleId, out found) != 0 || found == null) return "{}";
    int x, y, w, h;
    try {
      ((IAccessible)found).accLocation(out x, out y, out w, out h, 0);
    } catch {
      return "{}";
    } finally {
      Marshal.ReleaseComObject(found);
    }
    if (w <= 0 || h < 4) return "{}";
    RECT box;
    if (!GetWindowRect(front, out box)) return "{}";
    uint dpi = GetDpiForWindow(front);
    int band = TopBand * (int)(dpi == 0 ? 96 : dpi) / 96;
    if (x < box.L || x > box.R || y < box.T + band || y + h > box.B) return "{}";
    long field = (23L * 31 + (front.ToInt64() & 0x0FFFFFFF)) & 0x0FFFFFFF;
    return Spot(x, y, w, h, field);
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  try { [Console]::Out.WriteLine([BuddyCaret]::Where()) } catch { [Console]::Out.WriteLine('{}') }
}
`;

/** PowerShell's -EncodedCommand: the script as base64 of UTF-16LE (no quoting trouble). */
function encodedCommand(script = SCRIPT) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const LIMIT = 1e6;
const whole = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/**
 * One answer of the helper: { x, y, w, h, field } (physical pixels), { secret: true } (a
 * password field: nothing more), or null (no caret, not a terminal, anything unexpected).
 */
function parseCaret(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.secret === true) return { secret: true };
  const { x, y, w, h, field } = value;
  if (!whole(x, -LIMIT, LIMIT) || !whole(y, -LIMIT, LIMIT) || !whole(w, 0, 400) || !whole(h, 1, 400) || !whole(field, 0, 0x0fffffff)) return null;
  return { x, y, w, h, field };
}

function createCaretWatch({ log = { devOnly() {}, warn() {} }, platform = process.platform, spawnFn = spawn } = {}) {
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
      log.warn(`caret watch: could not start (${err.message})`);
      return;
    }
    log.devOnly('caret watch: helper started');
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
        if (next) next(parseCaret(line));
      }
      if (buffer.length > 64 * 1024) buffer = '';
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

  /** Where the caret of the window in front is (physical pixels), or null. */
  function where() {
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
      }, TIMEOUT_MS);
      waiting.push(settle);
      try {
        child.stdin.write('where\n');
      } catch {
        settle(null);
      }
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    if (!child) return;
    log.devOnly('caret watch: helper stopped');
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

  return { where, stop, supported, get running() { return Boolean(child); } };
}

module.exports = { createCaretWatch, parseCaret, encodedCommand, SCRIPT, TERMINALS, CARET_OBJECT, IDLE_MS };
