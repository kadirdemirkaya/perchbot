# Windows test tools (developers only)

Interactive checks that unit tests cannot do: real mouse input, screenshots and CPU
use of the running overlay. Windows PowerShell 5.1, no extra dependencies.

All of them work on an **isolated test overlay**: its own port (7790) and its own
settings folder (`%TEMP%\agent-buddy-test-home`). Your real settings, and the
overlay that your Claude Code sessions use (port 7777), are not touched.

```powershell
.\scripts\windows\start-test-overlay.ps1 -X 520 -Y 880   # start it (free position, screen DIPs)
.\scripts\windows\capture-states.ps1                     # screenshot of every state, no mouse input
.\scripts\windows\capture-states.ps1 -IncludeRest        # ... plus the resting pose (one more minute)
.\scripts\windows\measure-cpu.ps1                        # CPU per state, ~2.5 min, no mouse input
.\scripts\windows\clickthrough-test.ps1                  # click-through regression (see below)
```

Every script takes `-TestHome <dir>` (and `capture-states.ps1` takes `-OutDir <dir>`) if
you want the test overlay's files somewhere else, for example in the git-ignored
`.test-artifacts/` folder of the repo. Start the test overlay with `-X`/`-Y` above the
taskbar to see the hovering pose, or without them for the corner (on the ground).

The test overlay starts with **ambient life, play mode and the cat off**, so the
screenshots and the click-through test are repeatable. Add `-Fun` to turn all three on;
`npm run simulate -- life` (with `$env:AGENT_BUDDY_PORT = '7790'` and `$env:AGENT_BUDDY_HOME`
set to the test home) then plays every behaviour in turn. Developers can also set
`$env:AGENT_BUDDY_DEMO` to `duel`, `trips`, `plays` or `cheers` before starting it.

If PowerShell refuses to run scripts, use
`powershell -NoProfile -ExecutionPolicy Bypass -File <script>`.

## clickthrough-test.ps1

**It moves the mouse and sends real clicks for about 55 seconds. Do not touch the
mouse or keyboard while it runs.** Run it from a normal PowerShell window: inside a
sandboxed tool shell mouse input may be blocked, and the test then stops at its first
safety check without clicking.

It puts a plain target window directly behind the test overlay and checks:
- clicks on empty parts of the overlay window (including where the closed menu sits)
  reach the window below;
- the character takes the mouse while hovered, clicks on it stay there, and it never
  takes focus;
- moving off the character releases the mouse at once (also with a click 0-100 ms later);
- the hover menu opens, its buttons work (the bottom row too), and its spot passes clicks
  again once closed;
- the Play button starts a duel with one click (turning play mode on in the test settings),
  stays during the duel, ends it with a second click on the same spot, and clicks pass
  through again afterwards;
- dragging moves the window and saves the position;
- while the window moves (a walk along the taskbar), clicks on the character reach the
  window below, and the mouse is free again when it arrives;
- the window is a non-activating tool window (not in Alt+Tab).

Safety: before **every** click it checks that the cursor is where the test put it
(otherwise someone is using the mouse) and that the window under the cursor is the
target or the test overlay. If not, it stops without clicking. A preflight checks all
empty points without clicking first.

## Tips

- `<TestHome>\dev.log` has the overlay's `[ui]` trace: pointer zone with page
  coordinates, mouse capture on/off, menu open/closed, resting/awake, drag start/end.
- Windows PowerShell 5.1 strips double quotes from arguments to native programs. Pass
  hook JSON to `hooks/send.js` on stdin or as base64 (see `measure-cpu.ps1`).
- `start-test-overlay.ps1` lets `cmd.exe` redirect Electron's output, so a script that
  captures its output does not wait for the overlay to exit.
- Background-task notifications in a Claude Code session start a new turn, which fires
  `UserPromptSubmit` and can launch the normal overlay. That is expected.
