'use strict';

/**
 * Hands (opt-in, Windows): the buddy works Chrome when the user asks for it in
 * the chat panel: it opens Chrome, closes the front Chrome window (after a
 * Yes), opens a new tab (the "new tab" button after the last tab), closes the
 * last tab (the right-most one), or opens YouTube (a new tab, then it types
 * "youtube.com" into the address bar and presses Enter). Nothing else, and
 * never by itself.
 *
 * A small PowerShell process (started on the first request, stopped after a
 * quiet while) uses Windows UI Automation, the accessibility interface screen
 * readers use: in the front-most Chrome window it finds the button (or the
 * address bar), tells where it is (a screen rectangle, physical pixels) and,
 * when asked, presses it the way a screen reader does (InvokePattern; the
 * window's own Close for the window): the real mouse is never moved.
 *
 * What it reads: positions, and button names only to compare them with the
 * known "new tab" names. No tab title, no address, no page content is read,
 * kept or passed on. Typing writes the one fixed address (SITES) into the
 * address bar (ValuePattern.SetValue, never reading it back) and posts the
 * Enter key to that Chrome window only (never to whichever window is in
 * front). Whether Enter took is seen from the address bar losing the keyboard
 * focus (the page loads). Chrome is found by its process name; opening it
 * starts chrome.exe from its usual install folders, with no address or with
 * the one fixed address. The only tab left is never closed (that would close
 * the window: that is "close Chrome", which asks first).
 *
 *   const hands = createHands({ log });
 *   await hands.find('newtab')   // { ok: true, x, y, w, h } or { ok: false, why }
 *   await hands.press('close')   // the same, after pressing it
 *   await hands.type()           // types SITES.youtube.typed into the bar found last, presses Enter
 *   hands.launch('youtube')      // { ok } : chrome.exe with that address (or none: launch())
 *   why: 'nochrome' | 'nobutton' | 'last' | 'enter' | 'noapp' | 'error' | 'unsupported'
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** What may be asked for: find (where is it), press (and press it), type (into the address bar). */
const TARGETS = Object.freeze({
  find: Object.freeze(['newtab', 'close', 'window', 'bar']),
  press: Object.freeze(['newtab', 'close', 'window']),
  type: Object.freeze(['bar']),
});
const IDLE_MS = 120000;
const TIMEOUT_MS = 8000;

/** "New tab" in the languages it knows (the close button is found by its place: inside the last tab). */
const NEW_TAB_NAMES = Object.freeze(['New Tab', 'New tab', 'Yeni Sekme', 'Yeni sekme']);

/** The sites it opens: what it types into the address bar, and the address Chrome gets when it has no window yet. */
const SITES = Object.freeze({
  youtube: Object.freeze({ typed: 'youtube.com', url: 'https://www.youtube.com/' }),
});

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace BuddyHands -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr c); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
[BuddyHands.Native]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$NewNames = @(${NEW_TAB_NAMES.map((n) => `'${n}'`).join(', ')})
$Typed = '${SITES.youtube.typed}'
$ButtonCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
$TabCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)
$EditCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)
$ChromeCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Chrome_WidgetWin_1')
# The window a new tab was just opened in: the address bar is looked for there.
$script:Recent = $null

function Get-ChromeWindow {
  $ids = @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if (-not $ids.Count) { return $null }
  foreach ($w in $AE::RootElement.FindAll($Scope::Children, $ChromeCond)) {
    if ($ids -contains $w.Current.ProcessId -and -not $w.Current.IsOffscreen -and -not $w.Current.BoundingRectangle.IsEmpty) { return $w }
  }
  return $null
}

function Find-Target([string]$what) {
  $w = $null
  if ($what -eq 'bar' -and $null -ne $script:Recent) {
    try { if (-not $script:Recent.Current.IsOffscreen) { $w = $script:Recent } } catch { $script:Recent = $null }
  }
  if ($null -eq $w) { $w = Get-ChromeWindow }
  if ($null -eq $w) { return @{ why = 'nochrome' } }
  $wr = $w.Current.BoundingRectangle
  if ($what -eq 'newtab') {
    foreach ($b in $w.FindAll($Scope::Descendants, $ButtonCond)) {
      if ($NewNames -contains $b.Current.Name) { return @{ el = $b; win = $w } }
    }
    return @{ why = 'nobutton' }
  }
  if ($what -eq 'window') {
    # The window's close button: the right-most button in the strip along the top edge.
    $strip = @($w.FindAll($Scope::Descendants, $ButtonCond) | Where-Object { $r = $_.Current.BoundingRectangle; -not $r.IsEmpty -and $r.Y -lt $wr.Y + 40 -and $r.Height -lt 80 })
    $b = $strip | Sort-Object { $_.Current.BoundingRectangle.Right } | Select-Object -Last 1
    if ($null -eq $b -or $wr.Right - $b.Current.BoundingRectangle.Right -gt 80) { return @{ why = 'nobutton' } }
    return @{ el = $b; win = $w }
  }
  if ($what -eq 'bar') {
    # The address bar: the widest text field near the top (fields in the page are further down).
    $bars = @($w.FindAll($Scope::Descendants, $EditCond) | Where-Object { $r = $_.Current.BoundingRectangle; -not $r.IsEmpty -and $r.Y -lt $wr.Y + 200 })
    $bar = $bars | Sort-Object { - $_.Current.BoundingRectangle.Width } | Select-Object -First 1
    if ($null -eq $bar) { return @{ why = 'nobutton' } }
    return @{ el = $bar; win = $w }
  }
  $tabs = @($w.FindAll($Scope::Descendants, $TabCond))
  if ($tabs.Count -le 1) { return @{ why = 'last' } }
  # The last tab: the right-most one.
  $last = $tabs | Sort-Object { $_.Current.BoundingRectangle.X } | Select-Object -Last 1
  $b = $last.FindFirst($Scope::Descendants, $ButtonCond)
  if ($null -ne $b -and -not $b.Current.IsOffscreen -and -not $b.Current.BoundingRectangle.IsEmpty) { return @{ el = $b; win = $w } }
  # Its close button is hidden (a narrow tab that is not selected): select it first.
  return @{ tab = $last }
}

# Where a hidden close button will be: the right end of the tab.
function Tab-CloseRect($tab) {
  $r = $tab.Current.BoundingRectangle
  return @{ X = $r.X + $r.Width - 30; Y = $r.Y + ($r.Height - 26) / 2; Width = 26; Height = 26 }
}

function Say-Rect($r) {
  [Console]::Out.WriteLine('{"ok":true,"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}')
}

function Say-No([string]$why) {
  [Console]::Out.WriteLine('{"ok":false,"why":"' + $why + '"}')
}

[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line.Split(' ')
  $op = $parts[0]
  try {
    $t = Find-Target $parts[1]
    if ($null -ne $t.why) { Say-No $t.why; continue }
    if ($null -ne $t.tab) {
      $r = Tab-CloseRect $t.tab
      if ($op -eq 'press') {
        $sel = $null
        if ($t.tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) { $sel.Select() }
        Start-Sleep -Milliseconds 150
        $b = $t.tab.FindFirst($Scope::Descendants, $ButtonCond)
        $inv = $null
        if ($null -eq $b -or -not $b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { Say-No 'nobutton'; continue }
        $inv.Invoke()
      }
      Say-Rect $r
      continue
    }
    $r = $t.el.Current.BoundingRectangle
    if ($op -eq 'press' -and $parts[1] -eq 'window') {
      # The window's own Close, as its x does (Chrome may still ask, e.g. with a download running).
      $wp = $null
      if (-not $t.win.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { Say-No 'nobutton'; continue }
      $wp.Close()
    } elseif ($op -eq 'press') {
      $inv = $null
      if (-not $t.el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { Say-No 'nobutton'; continue }
      $inv.Invoke()
      if ($parts[1] -eq 'newtab') { $script:Recent = $t.win }
    } elseif ($op -eq 'type') {
      # Letter by letter into the address bar (written, never read), then Enter to that window only.
      $vp = $null
      if (-not $t.el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { Say-No 'nobutton'; continue }
      for ($i = 1; $i -le $Typed.Length; $i++) { $vp.SetValue($Typed.Substring(0, $i)); Start-Sleep -Milliseconds 90 }
      Start-Sleep -Milliseconds 250
      $h = [IntPtr]$t.win.Current.NativeWindowHandle
      [BuddyHands.Native]::PostMessage($h, 0x0100, [IntPtr]0x0D, [IntPtr]0x001C0001) | Out-Null
      [BuddyHands.Native]::PostMessage($h, 0x0101, [IntPtr]0x0D, [IntPtr]([long]0xC01C0001)) | Out-Null
      Start-Sleep -Milliseconds 900
      $script:Recent = $null
      # Still in the bar: Enter did not take.
      if ($t.el.Current.HasKeyboardFocus) { Say-No 'enter'; continue }
    }
    Say-Rect $r
  } catch {
    Say-No 'error'
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
    const valid = Object.values(rect).every(Number.isFinite) && rect.w > 0 && rect.h > 0 && rect.w < 8000 && rect.h < 2000;
    return valid ? { ok: true, ...rect } : { ok: false, why: 'nobutton' };
  }
  const why = ['nochrome', 'nobutton', 'last', 'enter', 'error'].includes(data.why) ? data.why : 'error';
  return { ok: false, why };
}

function encodedCommand(script = SCRIPT) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** chrome.exe in its usual install folders (machine-wide, 32-bit, per user), or null. */
function chromePath({ env = process.env, exists = fs.existsSync } = {}) {
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    if (!root) continue;
    const exe = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (exists(exe)) return exe;
  }
  return null;
}

function createHands({
  log = { devOnly() {}, warn() {} },
  platform = process.platform,
  spawnFn = spawn,
  launchFn = spawn,
  findChrome = chromePath,
} = {}) {
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
    if (!TARGETS[op] || !TARGETS[op].includes(target)) return Promise.resolve({ ok: false, why: 'error' });
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

  /** Starts Chrome: a new window, or (site) with that one address. */
  function launch(site = null) {
    if (!supported()) return { ok: false, why: 'unsupported' };
    if (site !== null && !Object.hasOwn(SITES, site)) return { ok: false, why: 'error' };
    const exe = findChrome();
    if (!exe) return { ok: false, why: 'noapp' };
    try {
      const app = launchFn(exe, site ? [SITES[site].url] : [], { detached: true, stdio: 'ignore' });
      if (app && typeof app.on === 'function') app.on('error', () => {});
      if (app && typeof app.unref === 'function') app.unref();
      return { ok: true };
    } catch (err) {
      log.warn(`hands: could not start Chrome (${err.message})`);
      return { ok: false, why: 'error' };
    }
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
    type: () => ask('type', 'bar'),
    launch,
    stop,
    supported,
    get running() {
      return Boolean(child);
    },
  };
}

module.exports = { createHands, parseAnswer, encodedCommand, chromePath, SCRIPT, NEW_TAB_NAMES, SITES, TARGETS };
