param(
  [int]$Port = 7790,
  [string]$TestHome = (Join-Path $env:TEMP 'perchbot-test-home')
)
# CPU per state for the ISOLATED test overlay (start-test-overlay.ps1), measured
# on its own process tree only, plus four sub-agent helpers at work and the
# skill book. Takes about 3 minutes (idle has to wait a minute to reach the
# resting state). Keep the cursor away from the test
# overlay, or check <TestHome>\dev.log for [ui] lines during the run.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$send = Join-Path $repo 'hooks\send.js'
$MainPid = [int](Get-Content (Join-Path $TestHome 'overlay.pid'))
$env:PERCHBOT_PORT = "$Port"; $env:PERCHBOT_HOME = $TestHome
# Not a real Claude Code process: no pid, so these sessions live until their SessionEnd.
$env:PERCHBOT_NO_PID = '1'

function Hook($obj) {
  # Base64: Windows PowerShell 5.1 strips double quotes from native-command arguments.
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5)))
  node -e "require('child_process').spawnSync(process.execPath,[process.argv[1]],{input:Buffer.from(process.argv[2],'base64')})" $send $b64 | Out-Null
}
function State { try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1; "$($h.state)/$($h.mouse)" } catch { 'down' } }
function TreePids { @($MainPid) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$MainPid" | ForEach-Object { [int]$_.ProcessId }) }
function CpuMs($ids) { ($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum }
function CpuOf([int]$seconds, [string]$label) {
  $ids = TreePids; $state = State; $t0 = CpuMs $ids; Start-Sleep -Seconds $seconds; $t1 = CpuMs $ids
  $core = 100 * ($t1 - $t0) / ($seconds * 1000); $n = [Environment]::ProcessorCount
  $mb = ($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum / 1MB
  "{0,-18} [{1,-22}] {2,5:N2}% of total CPU  {3,5:N1}% of one core  ({4} cores, {5} processes, {6:N0} MB)" -f $label, $state, ($core / $n), $core, $n, $ids.Count, $mb
}

$s = "cpu-" + [DateTimeOffset]::Now.ToUnixTimeSeconds()
Hook @{ session_id = $s; hook_event_name = 'SessionStart'; source = 'startup' }
Hook @{ session_id = $s; hook_event_name = 'Stop' }
Start-Sleep -Seconds 5
CpuOf 15 'idle (breathing)'
Start-Sleep -Seconds 44     # idle began ~3 s after Stop; the character rests after 60 s
CpuOf 15 'idle (resting)'
Hook @{ session_id = $s; hook_event_name = 'UserPromptSubmit'; prompt = 'x' }
Start-Sleep -Seconds 1
CpuOf 8 'thinking'
Hook @{ session_id = $s; hook_event_name = 'PreToolUse'; tool_name = 'Edit'; tool_use_id = 'c1'; tool_input = @{ file_path = 'C:\p\a.ts' } }
Start-Sleep -Seconds 2
CpuOf 15 'typing'
Hook @{ session_id = $s; hook_event_name = 'Notification'; notification_type = 'permission_prompt' }
Start-Sleep -Seconds 4      # after the three attention hops
CpuOf 12 'waiting'
Hook @{ session_id = $s; hook_event_name = 'PreToolUse'; tool_name = 'Skill'; tool_use_id = 'c2'; tool_input = @{ skill = 'code-review' } }
Start-Sleep -Seconds 2
CpuOf 10 'skill book'
$agents = 1..4 | ForEach-Object { "cpu-agent-$_" }
foreach ($a in $agents) { Hook @{ session_id = $s; hook_event_name = 'SubagentStart'; agent_id = $a; agent_type = 'Explore' } }
$tools = @('Read', 'Edit', 'Grep', 'Bash')
for ($i = 0; $i -lt 4; $i++) {
  Hook @{ session_id = $s; hook_event_name = 'PreToolUse'; agent_id = $agents[$i]; agent_type = 'Explore'; tool_name = $tools[$i]; tool_use_id = "s$i"; tool_input = @{ file_path = 'C:\p\a.ts'; pattern = 'x'; command = 'ls' } }
}
Start-Sleep -Seconds 8      # arrivals and the briefing are over
CpuOf 20 '4 helpers working'
foreach ($a in $agents) { Hook @{ session_id = $s; hook_event_name = 'SubagentStop'; agent_id = $a; agent_type = 'Explore' } }
Start-Sleep -Seconds 1
CpuOf 12 'helpers reporting'
Hook @{ session_id = $s; hook_event_name = 'Stop' }
"(the test overlay is still running; stop it with Stop-Process -Id $MainPid)"
