'use strict';

/**
 * Hands (opt-in, Windows): the buddy opens a new tab in Chrome (the "new tab"
 * button after the last tab), or closes the last tab (the right-most one),
 * when the user asks for it in the chat panel. Nothing else, and never by
 * itself.
 *
 * A small PowerShell process (started on the first request, stopped after a
 * quiet while) uses Windows UI Automation, the accessibility interface screen
 * readers use: in the front-most Chrome window it finds the "new tab" button
 * or the close button of the last tab, tells where it is (a screen
 * rectangle, physical pixels) and, when asked, presses it the way a screen
 * reader does (InvokePattern): the real mouse is never moved. Button names
 * are only compared with the known "new tab" names inside the helper; no tab
 * title, address or page content is read, kept or passed on. Chrome is found
 * by its process name. A narrow tab that is not selected hides its close
 * button: then the tab is selected first and its close button pressed. The
 * only tab left is never closed (that would close the window). Any window
 * size: the places come from Chrome itself.
 *
 *   const hands = createHands({ log });
 *   await hands.find('newtab')   // { ok: true, x, y, w, h } or { ok: false, why }
 *   await hands.press('close')   // the same, after pressing it
 *   why: 'nochrome' | 'nobutton' | 'last' | 'error' | 'unsupported' | 'busy'
 */

const { spawn } = require('node:child_process');

const TARGETS = new Set(['newtab', 'close']);
const IDLE_MS = 120000;
const TIMEOUT_MS = 8000;

/** "New tab" in the languages it knows (the close button is found by its place: inside the last tab). */
const NEW_TAB_NAMES = Object.freeze(['New Tab', 'New tab', 'Yeni Sekme', 'Yeni sekme']);

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace BuddyHands -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr c);'
[BuddyHands.Dpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$NewNames = @(${NEW_TAB_NAMES.map((n) => `'${n}'`).join(', ')})
$ButtonCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
$TabCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)
$ChromeCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Chrome_WidgetWin_1')

function Get-ChromeWindow {
  $ids = @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if (-not $ids.Count) { return $null }
  foreach ($w in $AE::RootElement.FindAll($Scope::Children, $ChromeCond)) {
    if ($ids -contains $w.Current.ProcessId -and -not $w.Current.IsOffscreen -and -not $w.Current.BoundingRectangle.IsEmpty) { return $w }
  }
  return $null
}

function Find-Target([string]$what) {
  $w = Get-ChromeWindow
  if ($null -eq $w) { return @{ why = 'nochrome' } }
  if ($what -eq 'newtab') {
    foreach ($b in $w.FindAll($Scope::Descendants, $ButtonCond)) {
      if ($NewNames -contains $b.Current.Name) { return @{ el = $b } }
    }
    return @{ why = 'nobutton' }
  }
  $tabs = @($w.FindAll($Scope::Descendants, $TabCond))
  if ($tabs.Count -le 1) { return @{ why = 'last' } }
  # The last tab: the right-most one.
  $last = $tabs | Sort-Object { $_.Current.BoundingRectangle.X } | Select-Object -Last 1
  $b = $last.FindFirst($Scope::Descendants, $ButtonCond)
  if ($null -ne $b -and -not $b.Current.IsOffscreen -and -not $b.Current.BoundingRectangle.IsEmpty) { return @{ el = $b } }
  # Its close button is hidden (a narrow tab that is not selected): select it first.
  return @{ tab = $last }
}

# Where a hidden close button will be: the right end of the tab.
function Tab-CloseRect($tab) {
  $r = $tab.Current.BoundingRectangle
  return @{ X = $r.X + $r.Width - 30; Y = $r.Y + ($r.Height - 26) / 2; Width = 26; Height = 26 }
}

[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line.Split(' ')
  try {
    $t = Find-Target $parts[1]
    if ($null -ne $t.why) { [Console]::Out.WriteLine('{"ok":false,"why":"' + $t.why + '"}'); continue }
    if ($null -ne $t.tab) {
      $r = Tab-CloseRect $t.tab
      if ($parts[0] -eq 'press') {
        $sel = $null
        if ($t.tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) { $sel.Select() }
        Start-Sleep -Milliseconds 150
        $b = $t.tab.FindFirst($Scope::Descendants, $ButtonCond)
        $inv = $null
        if ($null -eq $b -or -not $b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { [Console]::Out.WriteLine('{"ok":false,"why":"nobutton"}'); continue }
        $inv.Invoke()
      }
      [Console]::Out.WriteLine('{"ok":true,"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}')
      continue
    }
    $r = $t.el.Current.BoundingRectangle
    if ($parts[0] -eq 'press') {
      $inv = $null
      if (-not $t.el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { [Console]::Out.WriteLine('{"ok":false,"why":"nobutton"}'); continue }
      $inv.Invoke()
    }
    [Console]::Out.WriteLine('{"ok":true,"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}')
  } catch {
    [Console]::Out.WriteLine('{"ok":false,"why":"error"}')
  }
}
`;

/** The helper's answer line, checked: { ok: true, x, y, w, h } or { ok: false, why }. */
function parseAnswer(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, why: 'error' };
  }
  if (!data || typeof data !== 'object') return { ok: false, why: 'error' };
  if (data.ok === true) {
    const rect = { x: Number(data.x), y: Number(data.y), w: Number(data.w), h: Number(data.h) };
    const valid = Object.values(rect).every(Number.isFinite) && rect.w > 0 && rect.h > 0 && rect.w < 2000 && rect.h < 2000;
    return valid ? { ok: true, ...rect } : { ok: false, why: 'nobutton' };
  }
  const why = ['nochrome', 'nobutton', 'last', 'error'].includes(data.why) ? data.why : 'error';
  return { ok: false, why };
}

function encodedCommand(script = SCRIPT) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function createHands({ log = { devOnly() {}, warn() {} }, platform = process.platform, spawnFn = spawn } = {}) {
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
      log.warn(`hands: could not start (${err.message})`);
      return;
    }
    log.devOnly('hands: helper started');
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
        if (next) next(parseAnswer(line));
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
    for (const resolve of waiting) resolve({ ok: false, why: 'error' });
    waiting = [];
  }

  function ask(op, target) {
    if (!TARGETS.has(target)) return Promise.resolve({ ok: false, why: 'error' });
    if (!supported()) return Promise.resolve({ ok: false, why: 'unsupported' });
    if (!child) start();
    if (!child) return Promise.resolve({ ok: false, why: 'unsupported' });
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
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
        settle({ ok: false, why: 'error' });
      }, TIMEOUT_MS);
      waiting.push(settle);
      try {
        child.stdin.write(`${op} ${target}\n`);
      } catch {
        settle({ ok: false, why: 'error' });
      }
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    if (!child) return;
    log.devOnly('hands: helper stopped');
    try {
      child.stdin.write('quit\n');
      child.stdin.end();
    } catch {
      // gone
    }
    const old = child;
    const killer = setTimeout(() => {
      try {
        old.kill();
      } catch {
        // gone
      }
    }, 1000);
    if (killer.unref) killer.unref();
    finish();
  }

  return {
    find: (target) => ask('find', target),
    press: (target) => ask('press', target),
    stop,
    supported,
    get running() {
      return Boolean(child);
    },
  };
}

module.exports = { createHands, parseAnswer, encodedCommand, SCRIPT, NEW_TAB_NAMES, TARGETS };
