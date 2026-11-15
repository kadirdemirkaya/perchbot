param(
  [int]$Port = 7790,
  [string]$TestHome = (Join-Path $env:TEMP 'perchbot-test-home')
)
# Click-through regression test for the ISOLATED test overlay
# (start it first with start-test-overlay.ps1).
#
# THIS MOVES THE MOUSE AND SENDS REAL CLICKS for about 30 seconds. Do not touch
# the mouse or keyboard while it runs.
#
# If the cursor does not arrive where the test puts it (someone moves the mouse,
# or synthetic input is blocked on this machine), the safety check below stops
# the test before any click.
#
# The last part starts a walk (ambient life) and clicks on the walking
# character: those clicks must reach the window below.
#
# A plain "target" window is placed directly behind the overlay (TopMost, then
# the overlay is put back above it). Every click that passes through the
# overlay lands on the target and is counted.
#
# Safety, checked before EVERY click:
#   - the cursor must be where the test put it (otherwise someone is using the
#     mouse: the test stops), and
#   - the window that would receive the click must be the target or the test
#     overlay (otherwise the test stops). Clicks never reach other applications.
# A preflight checks all empty points WITHOUT clicking before anything else.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\winput.ps1"
function Health { try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1 } catch { $null } }

$pidFile = Join-Path $TestHome 'overlay.pid'
if (-not (Test-Path $pidFile) -or -not (Health)) { 'test overlay is not running; start it with start-test-overlay.ps1. Nothing done.'; exit 1 }
$MainPid = [int](Get-Content $pidFile)
$overlay = FindOverlay $MainPid
if ($overlay -eq [IntPtr]::Zero) { 'test overlay window not found. Nothing done.'; exit 1 }

$r = New-Object U+RECT; [U]::GetWindowRect($overlay, [ref]$r) | Out-Null
$W = $r.R - $r.L; $H = $r.B - $r.T
# Device pixels per CSS px: the window's DPI (the test overlay is "medium", zoom 1).
# The window's own height is not exact enough: Windows rounds the bounds.
$dpi = 0; try { $dpi = [U]::GetDpiForWindow($overlay) } catch { $dpi = 0 }
$k = if ($dpi -gt 0) { $dpi / 96.0 } else { $H / 270.0 }
$sideRight = ($r.L + $W / 2) -lt ([U]::GetSystemMetrics(0) / 2)
# With the menu on the left the window is wider than the page (it keeps room for the
# widest helper column, placement.windowFrame): the page is its right-hand 284 CSS px.
$pageLeft = if ($sideRight) { 0 } else { [math]::Max(0, $W / $k - 284) }
$slotLeft = if ($sideRight) { 0 } else { $pageLeft + 64 }
$menuLeft = if ($sideRight) { 220 } else { $pageLeft }
function Css($x, $y) { @([int]($r.L + $x * $k), [int]($r.T + $y * $k)) }
# The hover menu: two columns of 30 px buttons from y = 70, rows 36 px apart, row by
# row, the first column on the outer side. Items: quiet, eyes, play, cat, [corner],
# settings, quit.
function MenuSpot($index) {
  $outer = if ($sideRight) { 49 } else { 15 }; $inner = if ($sideRight) { 15 } else { 49 }
  $x = if ($index % 2 -eq 0) { $outer } else { $inner }
  Css ($menuLeft + $x) (85 + 36 * [math]::Floor($index / 2))
}
# Points in page CSS px. The character SVG sits at slot + (10, 66), 1 SVG unit = 1 CSS px.
$P = @{
  hiddenMenu = MenuSpot 0                    # where the closed menu's first button would be
  hiddenPlay = MenuSpot 2                    # ... and its Play button
  topCorner  = Css ($slotLeft + 12) 12       # empty top corner
  body       = Css ($slotLeft + 98) 195      # robot belly
  gapNearArm = Css ($slotLeft + 45) 194      # empty, just left of the far arm
  menuFirst  = MenuSpot 0                    # first menu button (quiet)
  menuPlay   = MenuSpot 2                    # Play (sword duel)
}
# The room left of the page (only when there is some): part of the window, never of the page.
if ($pageLeft -ge 60) { $P.beside = Css ($pageLeft - 40) 150 }
$farX = if ($sideRight) { $r.R + 100 } else { $r.L - 100 }
$P.far = @([int]$farX, [int]($r.T + $H / 2))
"overlay ($($r.L),$($r.T)) ${W}x${H}, $([math]::Round($k,3)) px per CSS px (dpi $dpi), menu on the $(if ($sideRight) {'right'} else {'left'}), page from CSS x $([math]::Round($pageLeft))"
$empty = @('topCorner', 'hiddenMenu', 'hiddenPlay') + $(if ($P.beside) { @('beside') } else { @() })

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'; $form.ShowInTaskbar = $false; $form.TopMost = $true
$form.Bounds = New-Object System.Drawing.Rectangle ([math]::Min($r.L, $P.far[0]) - 40), ($r.T - 40), ($W + 220), ($H + 80)
$form.BackColor = [System.Drawing.Color]::FromArgb(240, 236, 228)
$script:clicks = 0
$form.Add_MouseDown({ $script:clicks++ })
$form.Show(); Pump 300
[U]::SetWindowPos($overlay, [U]::TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null   # NOSIZE|NOMOVE|NOACTIVATE
Pump 300
$target = $form.Handle

$results = New-Object System.Collections.ArrayList
function Check($name, $ok, $detail) { [void]$results.Add([pscustomobject]@{ test = $name; result = $(if ($ok) { 'PASS' } else { 'FAIL' }); detail = $detail }) }
function Abort($why) {
  [U]::Move([int]([U]::GetSystemMetrics(0) / 2), 200); $form.Close()
  $results | Format-Table -AutoSize | Out-String -Width 220
  "STOPPED: $why. No further clicks were sent."; exit 2
}
function Go($pt, $ms = 250) {
  [U]::Move($pt[0], $pt[1]); Pump $ms
  $c = New-Object U+POINT; [U]::GetCursorPos([ref]$c) | Out-Null
  if ([math]::Abs($c.X - $pt[0]) -gt 2 -or [math]::Abs($c.Y - $pt[1]) -gt 2) { Abort 'the cursor is not where the test put it (someone is using the mouse)' }
}
function SafeClick($pt) {
  $root = RootAt $pt[0] $pt[1]
  if ($root -ne $target -and $root -ne $overlay) { Abort "a click at ($($pt[0]),$($pt[1])) would reach another application" }
  [U]::Down($pt[0], $pt[1]); Pump 40; [U]::Up($pt[0], $pt[1]); Pump 120
}

# Preflight (no clicks): every empty point must lead to the target window.
foreach ($name in @('far', 'gapNearArm') + $empty) {
  Go $P[$name] 200
  if ((RootAt $P[$name][0] $P[$name][1]) -ne $target) { Abort "preflight: '$name' does not lead to the target window" }
}
'preflight ok'

foreach ($name in $empty) {
  Go $P.far 150; Go $P[$name]
  $before = $script:clicks; SafeClick $P[$name]
  Check "click on empty area ($name) reaches the window below" ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"
}

Go $P.body 350
Check 'hovering the character: overlay takes the mouse' ((RootAt $P.body[0] $P.body[1]) -eq $overlay) "health.mouse=$((Health).mouse)"
$before = $script:clicks; SafeClick $P.body
Check 'click on the character stays on the overlay' ($script:clicks -eq $before) "target +$($script:clicks - $before)"
Check 'click on the character does not take focus' ([U]::GetForegroundWindow() -ne $overlay) ''

Go $P.gapNearArm 120
$before = $script:clicks; SafeClick $P.gapNearArm
Check 'character -> empty spot next to it: click passes through' ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"

Go $P.body 550; Go $P.menuFirst 300
Check 'open menu button takes the mouse' ((RootAt $P.menuFirst[0] $P.menuFirst[1]) -eq $overlay) "health.mouse=$((Health).mouse)"
$settingsFile = Join-Path $TestHome 'settings.json'
$q0 = (Get-Content $settingsFile -Raw | ConvertFrom-Json).quiet
SafeClick $P.menuFirst; Pump 300
$q1 = (Get-Content $settingsFile -Raw | ConvertFrom-Json).quiet
Check 'menu button click works (quiet toggled in the TEST settings)' ($q1 -ne $q0) "quiet $q0 -> $q1"
if ($q1 -ne $q0) { SafeClick $P.menuFirst; Pump 300 }
Go $P.far 900; Go $P.menuFirst 150
$before = $script:clicks; SafeClick $P.menuFirst
Check 'closed menu spot passes clicks through' ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"

# The Play button: one click starts a duel (it turns play mode on by itself), a second
# click on the same spot ends it, and then clicks pass through again. The duel is the
# page's own, so its start and end are read from the [ui] trace in dev.log.
$devLog = Join-Path $TestHome 'dev.log'
function LogSince($from) {
  $fs = [IO.File]::Open($devLog, 'Open', 'Read', 'ReadWrite')
  try { [void]$fs.Seek($from, 'Begin'); (New-Object IO.StreamReader $fs).ReadToEnd() } finally { $fs.Dispose() }
}
$items = if ((Get-Content $settingsFile -Raw | ConvertFrom-Json).position) { 7 } else { 6 }
$P.menuLast = MenuSpot ($items - 1)
Go $P.far 150; Go $P.body 550; Go $P.menuPlay 300
Check 'open menu: the Play button takes the mouse' ((RootAt $P.menuPlay[0] $P.menuPlay[1]) -eq $overlay) "health.mouse=$((Health).mouse)"
Go $P.menuLast 200
Check "open menu: the last button ($items items) is inside the window and takes the mouse" ((RootAt $P.menuLast[0] $P.menuLast[1]) -eq $overlay) ''
Go $P.menuPlay 200
$mark = (Get-Item $devLog).Length
SafeClick $P.menuPlay; Pump 700
$started = (LogSince $mark) -match '\[ui\] duel: start'
$playMode = (Get-Content $settingsFile -Raw | ConvertFrom-Json).playMode
Check 'Play starts a duel (play mode turned on in the TEST settings)' ($started -and $playMode) "duel start=$started, playMode=$playMode"
Go $P.menuPlay 150
Check 'in the duel the Play button stays and takes the mouse' ((RootAt $P.menuPlay[0] $P.menuPlay[1]) -eq $overlay) ''
$mark = (Get-Item $devLog).Length
SafeClick $P.menuPlay; Pump 500
$ended = (LogSince $mark) -match '\[ui\] duel: stopped from the menu'
Check 'a second click on Play ends the duel' $ended ''
Go $P.far 300; Go $P.topCorner 200
$before = $script:clicks; SafeClick $P.topCorner
Check 'after the duel, clicks pass through again' ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"

# Off the character and a click right after. A click in the very instant the cursor jumps off
# the shape (0 ms) is synthetic input only (a hand never clicks within 0 ms of leaving) and lands
# either way (the overlay lets go of the mouse within a frame): reported, not checked.
$info = New-Object System.Collections.ArrayList
function Landed($before) { if ($script:clicks -eq $before + 1) { 'passed through' } else { 'stayed on the overlay' } }
foreach ($delay in 0, 16, 50, 100) {
  Go $P.far 150; Go $P.body 300
  [U]::Move($P.gapNearArm[0], $P.gapNearArm[1]); if ($delay -gt 0) { Pump $delay }
  $before = $script:clicks; SafeClick $P.gapNearArm
  if ($delay -eq 0) { [void]$info.Add("leave the shape, click in the same instant (0 ms): $(Landed $before)"); continue }
  Check "leave the shape, click after $delay ms: passes through" ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"
}
if ($P.beside) {
  foreach ($delay in 0, 16, 50) {
    Go $P.far 150; Go $P.body 300
    [U]::Move($P.beside[0], $P.beside[1]); if ($delay -gt 0) { Pump $delay }
    $before = $script:clicks; SafeClick $P.beside
    if ($delay -eq 0) { [void]$info.Add("character -> beside the page, click in the same instant (0 ms): $(Landed $before)"); continue }
    Check "character -> beside the page, click after $delay ms: passes through" ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"
  }
}

# Dragged along the ground towards the middle of the screen, far enough for the drop to stay put: a
# drop is pulled inside the work area and snapped to a corner within 48 DIP (app/placement.js
# dropPlacement), so a drag outwards from a corner eases right back into it. Slow steps and a still
# moment before letting go make it a plain drop, not a throw (app/fling.js).
function DragBy($from, $byX, $why) {
  Go $from 300
  if ((RootAt $from[0] $from[1]) -ne $overlay) { Abort "${why}: the overlay is not under the cursor" }
  [U]::Down($from[0], $from[1]); Pump 60
  for ($i = 1; $i -le 30; $i++) { [U]::Move($from[0] + [int]($byX * $i / 30), $from[1]); Pump 25 }
  Pump 200
  [U]::Up($from[0] + $byX, $from[1]); Pump 600
  $r = New-Object U+RECT; [U]::GetWindowRect($overlay, [ref]$r) | Out-Null
  $r
}
$wasCorner = $null -eq (Get-Content $settingsFile -Raw | ConvertFrom-Json).position
$dx = if ($sideRight) { 150 } else { -150 }
$r0 = New-Object U+RECT; [U]::GetWindowRect($overlay, [ref]$r0) | Out-Null
$r1 = DragBy $P.body $dx 'drag'
# A drag starts once the pointer has moved more than 4 CSS px (renderer.js DRAG_THRESHOLD) and the
# window does not jump to catch up, so it follows the cursor up to ~12 px behind.
Check "drag moves the window with the cursor ($dx px along the ground)" ([math]::Abs(($r1.L - $r0.L) - $dx) -le 15 -and [math]::Abs($r1.T - $r0.T) -le 6) "moved ($($r1.L - $r0.L), $($r1.T - $r0.T))"
Check 'dropped position is saved' ($null -ne (Get-Content $settingsFile -Raw | ConvertFrom-Json).position) ''
# And back to where it came from: near its corner it settles into the corner again (no saved
# position), so the walk below starts from there, on the ground, as always.
$r1 = DragBy @(($P.body[0] + ($r1.L - $r0.L)), $P.body[1]) ($r0.L - $r1.L) 'drag back'
$pos = (Get-Content $settingsFile -Raw | ConvertFrom-Json).position
$backName = if ($wasCorner) { 'dragged back near its corner: it settles into the corner' } else { 'dragged back: it is where it started' }
Check $backName ([math]::Abs($r1.L - $r0.L) -le 6 -and [math]::Abs($r1.T - $r0.T) -le 6 -and (($null -eq $pos) -eq $wasCorner)) "off by ($($r1.L - $r0.L), $($r1.T - $r0.T)), position $(if ($pos) { 'saved' } else { 'none (corner)' })"

# A moving window (ambient life: a walk along the taskbar) never takes the mouse:
# clicks on the walking character reach the window below, and the mouse is free
# again when it arrives. The simulator's Demo event starts the walk.
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
# The target window now covers the whole width, down to the taskbar (a walk in the
# air first flies down to the ground).
$form.Bounds = New-Object System.Drawing.Rectangle $wa.X, ($r1.T - 40), $wa.Width, ($wa.Bottom - ($r1.T - 40))
Pump 300
[U]::SetWindowPos($overlay, [U]::TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
Pump 200
$demo = '{"v":1,"event":"Demo","session":"clickthrough","ts":' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + ',"demo":"walk"}'
try { Invoke-RestMethod "http://127.0.0.1:$Port/event" -Method Post -ContentType 'application/json' -Body $demo -TimeoutSec 1 | Out-Null } catch { }
Pump 500
$walking = (Health).trip -eq 'stroll'
Check 'a walk starts (Demo event)' $walking "health.trip=$((Health).trip)"
if ($walking) {
  for ($i = 0; $i -lt 3; $i++) {
    $rm = New-Object U+RECT; [U]::GetWindowRect($overlay, [ref]$rm) | Out-Null
    # The robot's belly, wherever the window is right now (the slot is on the outer side).
    $slotCss = if ($sideRight) { 0 } else { ($rm.R - $rm.L) / $k - 220 }
    $pt = @([int]($rm.L + ($slotCss + 98) * $k), [int]($rm.T + 195 * $k))
    Go $pt 120
    $before = $script:clicks; SafeClick $pt
    Check "click on the walking character passes through ($($i + 1))" ($script:clicks -eq $before + 1) "target +$($script:clicks - $before)"
    Pump 250
  }
  for ($i = 0; $i -lt 40 -and (Health).trip -eq 'stroll'; $i++) { Pump 200 }
  Pump 300
  Check 'after the walk the mouse is free' ((Health).mouse -eq 'passthrough') "health.mouse=$((Health).mouse)"
}

$ex = [U]::GetWindowLong($overlay, -20)
Check 'tool window (not in Alt+Tab), never activates' ((($ex -band 0x80) -ne 0) -and (($ex -band 0x8000000) -ne 0)) ('exstyle 0x{0:X8}' -f $ex)

[U]::Move([int]([U]::GetSystemMetrics(0) / 2), 200); Pump 200
$form.Close()
$results | Format-Table -AutoSize | Out-String -Width 220
foreach ($line in $info) { "info (synthetic input only): $line" }
"passed $(@($results | Where-Object result -eq 'PASS').Count) of $($results.Count)"
