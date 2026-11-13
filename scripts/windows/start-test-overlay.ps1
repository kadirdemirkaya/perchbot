param(
  [int]$Port = 7790,
  [string]$TestHome = (Join-Path $env:TEMP 'agent-buddy-test-home'),
  [int]$X = 0,
  [int]$Y = 0,
  # Ambient life, play mode and the cat are OFF here by default: a trip in the
  # middle of a test would move the window. -Fun turns all three on.
  [switch]$Fun,
  # Hands (open / close Chrome tabs when asked): off unless -Hands.
  [switch]$Hands,
  # Stay here (no trips of its own, no fleeing, no following the cursor): off unless -StayPut.
  [switch]$StayPut
)
# Starts an ISOLATED overlay for interactive tests: its own port and its own
# settings folder, so the hooks of a live Claude Code session (which talk to
# the normal overlay on 7777) cannot interfere, and your real settings are
# never touched.
#
#   .\scripts\windows\start-test-overlay.ps1                 # bottom-right corner
#   .\scripts\windows\start-test-overlay.ps1 -X 520 -Y 880   # free position (screen DIPs)
#   .\scripts\windows\start-test-overlay.ps1 -Fun            # ambient life, play mode and the cat on
#
# Writes <TestHome>\overlay.pid and logs to <TestHome>\dev.log (with [ui] traces).
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$electron = Join-Path $repo ('node_modules\electron\dist\' + (Get-Content (Join-Path $repo 'node_modules\electron\path.txt')).Trim())
if (-not (Test-Path $electron)) { throw "Electron binary not found. Run: npm install (or node node_modules/electron/install.js)" }

# Port taken (e.g. an older test overlay still running): stop here, before
# Electron starts and shows its "port in use" error box.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) { throw "port $Port is already in use (pid $($busy.OwningProcess)); stop that process first, e.g. an older test overlay" }

New-Item -ItemType Directory -Force $TestHome | Out-Null
$settings = @{ quiet = $false; ambientLife = [bool]$Fun; playMode = [bool]$Fun; cat = [bool]$Fun; hands = [bool]$Hands; stayPut = [bool]$StayPut }
if ($X -or $Y) { $settings.position = @{ x = $X; y = $Y } }
$settings | ConvertTo-Json -Compress | Out-File -Encoding ascii (Join-Path $TestHome 'settings.json')

$env:AGENT_BUDDY_PORT = "$Port"
$env:AGENT_BUDDY_HOME = $TestHome
# Start-Process -RedirectStandardOutput would let Electron inherit the caller's
# pipes, so a caller that captures this script's output would hang until the
# overlay exits. cmd.exe does the redirection instead (started via
# ShellExecute, which passes no handles on).
$out = Join-Path $TestHome 'dev.log'; $err = Join-Path $TestHome 'dev-err.log'
$shell = Start-Process -FilePath $env:ComSpec -WindowStyle Hidden -PassThru `
  -ArgumentList "/d /c `"`"$electron`" `"$repo`" --dev > `"$out`" 2> `"$err`"`""
$proc = $null
for ($i = 0; $i -lt 50 -and -not $proc; $i++) {
  $proc = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($shell.Id) AND Name='electron.exe'" | Select-Object -First 1
  if (-not $proc) { Start-Sleep -Milliseconds 100 }
}
if (-not $proc) { throw "Electron did not start (see $err)" }
$proc = [pscustomobject]@{ Id = [int]$proc.ProcessId }
$proc.Id | Out-File -Encoding ascii (Join-Path $TestHome 'overlay.pid')

$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1 | Out-Null; $up = $true } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $up) { throw "test overlay did not answer on 127.0.0.1:$Port (see $TestHome\dev-err.log)" }
"test overlay running: pid $($proc.Id), port $Port, home $TestHome"
"send it events with:  `$env:AGENT_BUDDY_PORT='$Port'; `$env:AGENT_BUDDY_HOME='$TestHome'; npm run simulate"
"stop it with:         Stop-Process -Id $($proc.Id)   (or end the simulated session)"
