param(
  [int]$Port = 7790,
  [string]$TestHome = (Join-Path $env:TEMP 'agent-buddy-test-home'),
  [string]$OutDir = (Join-Path $env:TEMP 'agent-buddy-shots'),
  # Also wait for the resting pose (adds about a minute).
  [switch]$IncludeRest
)
# Puts the ISOLATED test overlay through every state (plus the skill book and two
# sub-agent helpers) and saves one screenshot per step and a labelled contact
# sheet (states.png). No mouse input.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\winput.ps1"
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$send = Join-Path $repo 'hooks\send.js'
$env:AGENT_BUDDY_PORT = "$Port"; $env:AGENT_BUDDY_HOME = $TestHome
# Not a real Claude Code process: no pid, so these sessions live until their SessionEnd.
$env:AGENT_BUDDY_NO_PID = '1'
$overlay = FindOverlay ([int](Get-Content (Join-Path $TestHome 'overlay.pid')))
if ($overlay -eq [IntPtr]::Zero) { 'test overlay window not found; start it with start-test-overlay.ps1'; exit 1 }
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Hook($obj) {
  # Base64: Windows PowerShell 5.1 strips double quotes from native-command arguments.
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5)))
  node -e "require('child_process').spawnSync(process.execPath,[process.argv[1]],{input:Buffer.from(process.argv[2],'base64')})" $send $b64 | Out-Null
}
function Shot([string]$name) {
  $r = New-Object U+RECT; [U]::GetWindowRect($overlay, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $g.Dispose()
  $file = Join-Path $OutDir "$name.png"; $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $file
}

$s = "shots-" + [DateTimeOffset]::Now.ToUnixTimeSeconds(); $n = 0
$ev = { param($name, $extra) $o = @{ session_id = $s; hook_event_name = $name }; if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }; $o }
$tool = { param($event, $name, $id, $toolInput) & $ev $event @{ tool_name = $name; tool_use_id = $id; tool_input = $toolInput } }
$sub = { param($event, $agent, $type, $extra) $o = & $ev $event @{ agent_id = $agent; agent_type = $type }; if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }; $o }
# name ($null = no screenshot), hook input (or several), wait in ms before the screenshot
$steps = @(
  @('greeting', (& $ev 'SessionStart' @{ source = 'startup' }), 450),
  @('idle', (& $ev 'Stop'), 4200),
  @('thinking', (& $ev 'UserPromptSubmit' @{ prompt = 'x' }), 900),
  @('reading', (& $tool 'PreToolUse' 'Read' 't1' @{ file_path = 'C:\proj\src\index.ts' }), 1100),
  @('typing', (& $tool 'PreToolUse' 'Edit' 't2' @{ file_path = '/home/u/proj/robot.css' }), 1300),
  @('running', (& $tool 'PreToolUse' 'Bash' 't3' @{ command = 'npm test -- --reporter=spec' }), 1100),
  @('failed tool', (& $tool 'PostToolUseFailure' 'Bash' 't3' $null), 500),
  @('working', (& $tool 'PreToolUse' 'WebSearch' 't4' @{ query = 'q' }), 1100),
  @('waiting (approval)', (& $ev 'Notification' @{ notification_type = 'permission_prompt' }), 3900),
  @('asking', (& $ev 'Notification' @{ notification_type = 'elicitation_dialog' }), 900),
  @('standby (idle_prompt)', (& $ev 'Notification' @{ notification_type = 'idle_prompt' }), 900),
  @('skill book', (& $tool 'PreToolUse' 'Skill' 't5' @{ skill = 'code-review' }), 900),
  @('helpers arrive', @((& $sub 'SubagentStart' 'agent-1' 'Explore'), (& $sub 'SubagentStart' 'agent-2' 'Plan')), 1300),
  @('helpers at work', @(
      (& $sub 'PreToolUse' 'agent-1' 'Explore' @{ tool_name = 'Read'; tool_use_id = 'a1'; tool_input = @{ file_path = 'C:\p\main.js' } }),
      (& $sub 'PreToolUse' 'agent-2' 'Plan' @{ tool_name = 'Skill'; tool_use_id = 'a2'; tool_input = @{ skill = 'pdf' } })), 3800),
  @('helper reports', (& $sub 'SubagentStop' 'agent-1' 'Explore'), 2600),
  @('done', (& $ev 'Stop'), 380),
  @($null, (& $sub 'SubagentStop' 'agent-2' 'Plan'), 0)
)
$shots = New-Object System.Collections.ArrayList
foreach ($st in $steps) {
  foreach ($h in @($st[1])) { Hook $h }
  Start-Sleep -Milliseconds $st[2]
  if ($st[0]) { [void]$shots.Add(@($st[0], (Shot ($st[0] -replace '[^a-z_-]+', '-')))) }
}
if ($IncludeRest) {
  Start-Sleep -Seconds 64   # done (3 s) -> idle -> resting after a quiet minute
  [void]$shots.Add(@('resting', (Shot 'resting')))
}

# Contact sheet
$imgs = $shots | ForEach-Object { [System.Drawing.Image]::FromFile($_[1]) }
# The window grows while helpers are on screen: cells are as wide as the widest shot.
$w = [int]($imgs | Measure-Object -Property Width -Maximum).Maximum; $h = [int]$imgs[0].Height; $cols = 4; $rows = [math]::Ceiling($imgs.Count / $cols)
$sheet = New-Object System.Drawing.Bitmap ($w * $cols), (($h + 18) * $rows)
$g = [System.Drawing.Graphics]::FromImage($sheet); $g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font 'Segoe UI', 10
for ($i = 0; $i -lt $imgs.Count; $i++) {
  $x = ($i % $cols) * $w; $y = [math]::Floor($i / $cols) * ($h + 18)
  $g.DrawString($shots[$i][0], $font, [System.Drawing.Brushes]::Black, $x + 4, $y); $g.DrawImage($imgs[$i], $x, $y + 18, $imgs[$i].Width, $imgs[$i].Height)
}
$sheetFile = Join-Path $OutDir 'states.png'; $sheet.Save($sheetFile); $g.Dispose(); $sheet.Dispose(); $imgs | ForEach-Object { $_.Dispose() }
"screenshots in $OutDir (contact sheet: $sheetFile)"
