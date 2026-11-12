# Agent Buddy

> **Agent Buddy is an independent, unofficial companion app for Claude Code. It is not affiliated with or endorsed by Anthropic.**

A tiny animated robot that sits in the corner of your screen and reacts to what
your Claude Code session is doing. It types while files are edited, puts on
glasses to read, shows a prompt while commands run, raises a hand when your
approval is needed and jumps when the work is done.

<p align="center">
  <!-- TODO: add docs/demo.gif, a short screen recording of `npm run simulate` -->
  <em>Demo GIF coming soon.</em>
</p>

- Works with Claude Code in the terminal and in the VS Code extension (both fire the same hooks).
- Stays out of your way: clicks pass through everywhere except the character's own pixels,
  it never takes keyboard focus and it is not in Alt+Tab.
- Hover it for a small menu, drag it anywhere (it snaps to the bottom corners), click it for a
  bounce. Its eyes follow the cursor while the cursor is near.
- Lifelike but light: breathing, random blinks, an irregular typing rhythm, squash-and-stretch
  jumps. After a quiet minute it rests and nothing animates at all.
- Sub-agents show up as little helper robots, each in its own colour: they get a briefing,
  work on their own laptops, chat with each other now and then, and report back when done.
- When a skill is in use, the skill book comes out of the pocket, with its name on a tag.
- Ambient life (on by default): when idle it stretches, looks around, hops, bounces a ball,
  plays with its antenna, walks along the taskbar or takes a short flight, and it gets cross
  and moves elsewhere when you poke it three times. Play mode adds a sword duel and a whip;
  a cat can be called to play with it and then nap.
- Handles several sessions at once and disappears when the last one ends.
- Everything stays on your machine. See [Privacy](#privacy).
- Characters are plug-ins: a folder with an SVG, a CSS file and a JSON manifest.
- English and Turkish UI.

## How it works

```
Claude Code ──(hooks)──► hooks/send.js ──HTTP POST──► Agent Buddy overlay (Electron)
(terminal or VS Code)    Node.js, no deps,           127.0.0.1:7777 only
                         exits in ~50 ms             state machine → animated SVG
```

1. **Claude Code hooks** run `hooks/send.js` for each event (session start/end, prompt,
   before/after each tool, notifications, stop) and pass the event as JSON on stdin.
2. **send.js** keeps a handful of fields (event, tool name, *file name*, a shortened
   command), posts them to `http://127.0.0.1:7777/event` with a 300 ms timeout and exits.
   It never prints anything and always exits with code 0. The hooks are registered as
   `async`, so Claude Code does not wait for them at all (except `SessionEnd`, which
   needs a few milliseconds).
3. If the overlay is not running, a `SessionStart` or `UserPromptSubmit` event starts it
   in the background and hands it that first event.
4. **The overlay** is a transparent, frameless, click-through Electron window. It counts
   open sessions; when the last one ends it waves goodbye and quits. If no event arrives
   for 30 minutes (for example after a crashed session) it quits on its own.

| State | Trigger | Animation | Bubble |
|---|---|---|---|
| idle | nothing happening | standing, laptop closed, blinks now and then | – |
| greeting | `SessionStart` | waves | "Hello!" |
| thinking | `UserPromptSubmit`, between tools | hand on chin, "..." | – |
| typing | Edit, Write, MultiEdit, NotebookEdit | laptop open, code scrolling | "Editing *file*" |
| reading | Read, Grep, Glob | glasses on, highlight moves down the page | "Reading *file*" |
| running | Bash, PowerShell | `>_` on the screen | first ~40 characters of the command |
| working | any other tool | three dots on the screen | e.g. "Searching the web" |
| waiting | `Notification`: permission prompt | raises a hand, little hops, worried face | "Waiting for approval" |
| asking | `Notification`: a question for you | hand half up, question badge | "Question for you" |
| standby | `Notification`: idle reminder, other notices | calm, light pulses slowly, no hops (10 s) | "Waiting for you" |
| done | `Stop` | jumps, confetti | "Done!" |
| goodbye | last session ended | waves and fades out | "See you!" |

Tool states stay on screen for 1.5 s after the tool finishes so the character does not
flicker between quick tool calls. A tool that fails gets a worried face for that time.

Drop the buddy higher than ~24 px above the taskbar (the bottom of the screen's work area)
and it hovers on small boot thrusters; drag it back down and it lands. Turn this off with
**Hover mode → Always stand** in the tray menu.

### Sub-agents and skills

Each sub-agent (`SubagentStart` … `SubagentStop`) gets a little helper robot next to the
buddy, on the side facing the middle of the screen. The window grows towards that side, so
the buddy itself never moves.

- **Arrival:** the helper drops in on its thrusters, gets a short briefing from the buddy and
  walks to its spot (it hops over the others if they are in the way).
- **Work:** laptop open. The tooltip on a helper shows its type, current tool and file name,
  nothing else. Now and then a helper gets up: it chats with a neighbour (they pass a note),
  walks over for a word with the buddy, or strolls around and looks about.
- **Done:** a happy face, then it walks to the buddy, salutes, hands over its note and flies
  off. A helper whose session ends, or that has sent no event for 30 minutes, just fades.
- Up to four helpers are shown when there is room; the rest wait behind a "+N" badge. The
  main session's `Stop` does not end them: background agents keep working.

### Ambient life, play mode and the cat

Three switches, in the tray menu and in the right-click menu:

| Switch | Default | What it adds |
|---|---|---|
| **Ambient life** | on | Idle behaviours, varied cheers, getting cross when poked |
| **Play mode** | off | *Play: sword duel* (also a sword button in the hover menu) and the whip |
| **Cat** | off | *Call the cat* / *Send the cat away* (also a cat button in the hover menu) |

**Ambient life.** While the buddy is idle (or on standby) and awake, every 20 to 90 seconds
it does one short thing, never the same twice in a row: stretch and yawn, look around, a
little hop, bounce a ball, play with its antenna, hum a tune, peek at its laptop, walk along
the taskbar, take a short flight on its boot thrusters, fly over to your cursor for a look
through its glasses (keeping its distance), or go back home. It stops at once when Claude
Code needs it (a tool, a permission prompt, the end of a turn), when you hover or drag it,
while it rests after a quiet minute, while the screen is locked, and with reduced motion.
Trips only happen while no helpers and no cat are around. Where a trip took it is not
saved; it returns home sooner or later. "done" is celebrated with a jump, a pirouette, a
little dance or fist pumps.

**Poke it three times.** Click it twice in a row and it frowns; a third time and it says so
and walks or flies off to a random spot elsewhere on the screen. That spot is saved as its new
place (*Back to the corner* in its menu undoes it). Handy when it sits right where you want to
click. Helpers do the same inside their row.

**Play mode.** *Play: sword duel*: the buddy puts its laptop down and draws a toy wooden
sword, and the whole overlay window becomes the arena: your cursor is a sword and every click
is a swing. It guards, raises its sword (its light blinks: get ready) and slashes at you.
Click while it raises the sword to parry (sparks fly where the blades meet, it is stunned),
then click again to hit it; click while it guards and it blocks and strikes back at once.
Three hearts each. Right-click to give up. *Take the whip*: the cursor turns into a whip over
the buddy and its helpers; every click is a lash (a crack, a wince), the third in a row sends
it off.

**The cat.** *Call the cat*: a cream cat with lilac stripes walks in, plays ball with the buddy
for a while, then walks aside, curls up and naps until you send it away. If Claude Code needs
the buddy while they play, the cat goes to nap at once.

Any event from Claude Code ends the duel, a play or a poke reaction immediately: work comes
first, and work notifications are never delayed.

When a skill is used (the `Skill` tool, or a slash command you type), the buddy takes the
skill book out of its pocket and a tag with the skill name appears above its head; at the
end of the turn the book goes back. Helpers do the same for the skills they use.

### Using the mouse

The overlay window ignores the mouse, so clicks reach the windows below, except while the
pointer is over a painted part of the character, a helper, or the open menu. A safety check in the
main process releases the mouse whenever the cursor is outside the window.

| Do this | It does this |
|---|---|
| Move the cursor near it | Its eyes follow (turn off: menu, eye icon) |
| Rest the cursor on it | It waves, and a small menu opens beside it |
| Move away | The menu closes after a moment |
| Click it | A little bounce |
| Drag it | It follows the cursor; near a bottom corner it snaps there. Any monitor works; if that monitor is unplugged it returns to the primary display's corner |
| Rest the cursor on a helper | A tooltip: its type, tool and file name |
| Drag a helper | Pick it up and drop it elsewhere next to the buddy; it lands there and keeps that spot |
| Click a helper | A little hop (twice: it gets annoyed; three times: it stomps off to another spot) |
| Click it twice / three times quickly | It frowns / it moves to a random spot on the screen and stays there (ambient life) |
| Right-click it | Play (duel), whip, walk, fly, come back home, call the cat, and the three switches |
| Leave it alone for a minute while idle | It rests: eyes half closed, no animation. Any event or hover wakes it |

The hover menu: show/hide speech bubble, eyes on/off, back to the corner (after a drag),
more settings (the full tray menu), quit.

## Requirements

- **Node.js 20 or newer**, available as `node` on your `PATH` (Claude Code runs the hook with it).
- **Claude Code** with hook support. Developed against Claude Code 2.1.x.
- **Windows 10/11** is the main target. macOS and Linux are expected to work but are less tested.

## Install

```sh
git clone https://github.com/<your-account>/agent-buddy.git
cd agent-buddy
npm install
npm run setup
```

Then start Claude Code (`claude`, or open the VS Code extension). The buddy appears
in the bottom-right corner. To see it without Claude Code, run `npm run simulate`.

### What `npm run setup` changes

`npm run setup` **modifies your Claude Code settings file**. Before writing anything it:

1. prints the file it will change and why it chose it,
2. lists every hook it will add (the exact command for each event),
3. prints the path of the backup it will create,
4. asks you to confirm (skip with `--yes`).

It then copies the current file to
`settings.json.agent-buddy-YYYYMMDD-HHMMSS.bak` **in the same folder** and writes the
merged result. Hooks you already have, including other tools' hooks on the same events,
are kept. Running setup again does not create duplicates. If the file is not valid
JSON, setup stops and changes nothing.

Which file is used:

| Command | File |
|---|---|
| `npm run setup` | `$CLAUDE_CONFIG_DIR/settings.json` if that variable is set, otherwise `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`) |
| `npm run setup -- --config-dir <dir>` | `<dir>/settings.json` |
| `npm run setup -- --project [dir]` | `<dir>/.claude/settings.json` (shared with your team if committed) |
| `npm run setup -- --local [dir]` | `<dir>/.claude/settings.local.json` (personal, usually git-ignored) |
| add `--dry-run` | show the changes, write nothing |

`[dir]` defaults to the folder you ran `npm` from. Each hook looks like this:

```json
{ "type": "command", "command": "node \"C:/path/to/agent-buddy/hooks/send.js\" PreToolUse --agent-buddy", "async": true }
```

The `--agent-buddy` tag is how `uninstall-hooks` recognises its own entries.

Claude Code notices settings changes on its own; restart open sessions if the buddy
does not react. In interactive sessions, hooks only run after you accept the
workspace trust dialog for the folder.

## Uninstall

```sh
npm run uninstall-hooks            # same options as setup: --config-dir, --project, --local, --dry-run
```

It removes **only** the hooks Agent Buddy added (other hooks stay) and writes a backup
first, named like the one above. To remove everything, also delete:

- the `~/.agent-buddy` folder (settings, optional logs, Electron cache), and
- the cloned `agent-buddy` folder.

To undo a setup or uninstall by hand, copy the `.bak` file back over `settings.json`.

## Settings

Most settings are in the tray menu (the robot-head icon in the notification area; on
Windows it may be under the `^` overflow arrow):

| Menu item | Effect |
|---|---|
| Position | Bottom right / bottom left of the primary display |
| Size | Small / medium / large |
| Hover mode | Auto (hover when placed above the ground) / Always stand |
| Account | All accounts, or only one Claude account (see [Several Claude accounts](#several-claude-accounts)) |
| Ambient life / Play mode / Cat | See [Ambient life, play mode and the cat](#ambient-life-play-mode-and-the-cat) |
| Character | Any character found in `characters/` or `~/.agent-buddy/characters/` |
| Language | English / Türkçe |
| Quiet mode | Hides the speech bubble (handy while screen sharing) |
| Eyes follow the cursor | On by default |
| Back to the corner | Shown after you dragged the character somewhere else |
| Open settings folder | Opens `~/.agent-buddy` |
| Quit now | Closes the overlay. It will not come back for the sessions that are open now; a new session brings it back |

Everything is stored in `~/.agent-buddy/settings.json`
(Windows: `%USERPROFILE%\.agent-buddy\settings.json`):

```json
{
  "corner": "bottom-right",
  "size": "medium",
  "character": "robot",
  "quiet": false,
  "language": "en",
  "port": 7777,
  "idleTimeoutMinutes": 30,
  "debug": false,
  "eyeTracking": true,
  "position": null,
  "hoverMode": "auto",
  "account": "all",
  "knownAccounts": [],
  "ambientLife": true,
  "playMode": false,
  "cat": false
}
```

| Key | Values | Notes |
|---|---|---|
| `corner` | `bottom-right`, `bottom-left` | |
| `size` | `small`, `medium`, `large` | |
| `character` | folder name | |
| `quiet` | `true` / `false` | |
| `language` | `en`, `tr` | |
| `port` | 1024–65535 | Read by both the hook and the overlay. Restart the overlay after changing it |
| `idleTimeoutMinutes` | 0–1440 | Quit after this long without events. `0` turns the safety net off |
| `debug` | `true` / `false` | Writes `~/.agent-buddy/logs/hook.log` and `overlay.log`. Off by default |
| `eyeTracking` | `true` / `false` | Eyes follow the cursor while it is over the overlay window |
| `position` | `null` or `{ "x", "y" }` | `null` = the chosen corner. Set by dragging: the bottom-centre of the character in screen coordinates |
| `hoverMode` | `auto`, `stand` | `auto`: hovers when placed above the ground |
| `account` | `all` or an account name | Show only the sessions of this Claude account |
| `knownAccounts` | list of names | Accounts seen so far (at most 8), offered in the tray menu. Filled in automatically |
| `ambientLife` | `true` / `false` | Idle behaviours, cheers, getting cross when poked (was `funMode` before 0.3) |
| `playMode` | `true` / `false` | The sword duel and the whip |
| `cat` | `true` / `false` | The cat can be called from the menus |

Environment variables (optional): `AGENT_BUDDY_HOME` (another settings folder),
`AGENT_BUDDY_PORT`, `AGENT_BUDDY_DEBUG=1`.

### Several Claude accounts

If you run Claude Code with more than one config folder (`claude --config-dir …` or
`CLAUDE_CONFIG_DIR`, e.g. a personal and a work account) and installed the hooks in each,
one overlay shows them all. The hook tells the overlay which account an event comes from by
the **name of the config folder** without leading dots (`~/.claude-work` → `claude-work`,
the default `~/.claude` → `claude`); the path itself is never sent.

**Account** in the tray menu lists every account seen so far. Pick one and the buddy only
shows that account's sessions and helpers; the others are ignored, and a session of another
account no longer starts the overlay. If the chosen account has not sent anything since the
overlay started, the buddy says so ("No events from this account yet").

## Adding a character

Create a folder with `character.json`, an SVG and a CSS file, either in `characters/`
(and send a pull request) or in `~/.agent-buddy/characters/` (just for you). The app
sets `data-state="typing"` (and so on) on the element around your SVG; your CSS animates
the parts. No app code changes are needed.

**Only submit artwork you drew yourself, or artwork under a permissive license such as
CC0 or MIT.** No copyrighted characters, mascots or logos, no ripped sprites, nothing
with an unclear license.

The full format, the list of states and performance tips are in
[characters/README.md](characters/README.md). `characters/robot/` is a commented example.

## Privacy

- **No data collection.** No analytics, no telemetry, no crash reporting, no update checks.
- **Nothing leaves your computer.** The only network socket is the overlay's server,
  bound to `127.0.0.1` (loopback). The overlay's page cannot make http(s) or websocket
  requests: they are blocked, and the page is served from a private `buddy://` scheme.
- **What the hook passes to the overlay** is fixed by an allowlist in `hooks/send.js`. Only
  these fields can leave the hook process; anything else, including fields a future Claude
  Code version might add, is dropped (a unit test checks this):

  | Field | Content |
  |---|---|
  | `event`, `ts`, `v` | hook event name, time, payload format version |
  | `session` | session id |
  | `tool`, `id` | tool name, tool-use id (pairs "started" with "finished") |
  | `detail` | the **file name** (not the path, not the contents), or the **first ~40 characters of a command** with obvious secrets (tokens, passwords, `KEY=value`, `user:password@`) replaced by `***`, or a search pattern (max. 30 characters), or a web host name |
  | `kind`, `source`, `reason` | notification type, why a session started / ended |
  | `agent`, `agentType` | for sub-agents: a short hash of the agent id, and its type (e.g. `Explore`) |
  | `skill` | the name of a skill being used |
  | `account` | the name of the Claude config folder (e.g. `claude-personal`), never a full path |
- **Never passed on or stored:** file contents, prompts, full commands, tool output,
  environment variables, transcripts.
- **Stored on disk:** only your settings. The debug log is **off by default**; when you
  turn it on it records event names, tool names, results and timings, never file names,
  commands or prompts.
- **Schema probe (developer aid), off by default.** To check which fields a new Claude Code
  version sends, create an empty file `~/.agent-buddy/schema-log.on` (its content is used as
  a random salt). While it exists, the hook appends one line per event to
  `~/.agent-buddy/logs/schema.log` with **field names only, never values**: the event and
  tool name, the names of the input fields, and the session / agent id as 8-character
  salted hashes so events can be matched up. The one value it records is the expansion type
  of a typed slash command (e.g. `slash_command`), never the command or its arguments.
  Delete both files to turn it off; without the salt the hashes mean nothing.
- **On screen:** the bubble shows file names and shortened commands. Use Quiet mode while
  screen sharing.
- **At install time** `npm install` downloads Electron from the npm registry and Electron's
  official GitHub releases. That is the only network access, and it is done by npm.

## Security

- The simulator can ask for one of the buddy's own behaviours (a "Demo" event: a stretch, a
  walk, the duel, the cat...). Only a local program can send it (same rules as below); the
  hook never does, and it carries nothing but the name of the behaviour.
- The server accepts only `POST /event` and `GET /health` on `127.0.0.1`. It rejects
  browser requests (any `Origin` or `Sec-Fetch-*` header), unexpected `Host` headers
  (DNS rebinding), non-JSON bodies, bodies over 4 KB and anything that fails schema
  validation. A web page cannot drive the character.
- The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration` and a strict
  Content Security Policy. Character SVGs are sanitised before use, and bubble text is
  always inserted as text, never as HTML.
- The hook never blocks Claude Code: async registration, short timeouts, exit code 0,
  nothing on stdout.

Found a problem? Please open an issue (or a private security advisory on GitHub for
anything sensitive).

## Troubleshooting

**The buddy does not appear.**
1. Run `npm run simulate`. If nothing shows up there either, the Electron binary may be
   missing: run `node node_modules/electron/install.js`. Some npm setups skip that
   download during `npm install`.
2. Make sure the hooks are in the settings file Claude Code actually reads. If you use
   `CLAUDE_CONFIG_DIR`, run setup from a shell where it is set. Inside Claude Code,
   `/hooks` lists the active hooks.
3. Accept the workspace trust dialog; hooks do not run before that.
4. `node` must be on the `PATH` of the shell Claude Code uses (Git Bash, or PowerShell
   when Git Bash is not installed).
5. Set `"debug": true` and look at `~/.agent-buddy/logs/hook.log`. `result=delivered`
   means the overlay received the event; `result=refused` means it was not running.

**"Port 7777 is already in use".** Another program owns that port. Agent Buddy does not
silently switch ports. Pick another `port` in `~/.agent-buddy/settings.json` (the hook
reads the same value). To see which program uses it on Windows:
`netstat -ano | findstr :7777`.

**Windows Defender Firewall / security prompts.** The server listens on `127.0.0.1`
only, so Windows normally does not ask. If a firewall prompt appears anyway, you can
deny it: loopback traffic keeps working. `electron.exe` under `node_modules` is the
official Electron binary downloaded by npm.

**The buddy stays after I closed Claude Code.** If the terminal was killed, Claude Code
may not have run its `SessionEnd` hook. The buddy quits on its own after 30 minutes
without events, or right away with **Quit now** in the tray menu.

**It shows up over a full-screen video or game.** It is an always-on-top window. Use
**Quit now**, or drag it somewhere else.

**A click did not reach the window under the buddy.** Only the character's painted pixels
and its open menu take the mouse. If something seems to block clicks, move the cursor away
and back; the overlay releases the mouse as soon as the cursor is outside its window. Please
open an issue with your OS version and display scaling if it happens again.

**I dragged it somewhere and want it back.** Hover it and choose **Back to the corner**, or
use the same item in the tray menu.

## Development

```sh
npm run dev                         # overlay with console logs
npm run simulate                    # tour of every state through the real hook script
npm run simulate -- two-sessions    # checks the session counter (PASS/FAIL)
npm run simulate -- playground      # idle buddy to try hover, menu, drag, click, resting
npm run simulate -- --fast --keep   # shorter pauses, leave the overlay open
npm run simulate -- life             # every ambient-life behaviour, 3 pokes, the duel, the cat
AGENT_BUDDY_DEMO=duel npm run dev   # developers: duel | trips | plays | cheers by itself
npm test                            # unit tests (node:test, no extra dependencies)
npm run make-icons                  # regenerate the tray icons
```

On Windows, `scripts/windows/` has interactive checks on an isolated test overlay:
screenshots of every state, CPU per state, and a click-through regression test with real
mouse input. See [scripts/windows/README.md](scripts/windows/README.md).

```
agent-buddy/
├── app/                 Electron main process, renderer and the pure logic it uses
│   ├── main.js          window, tray, single instance, private buddy:// scheme
│   ├── core.js          state machine, session counter, idle safety net
│   ├── agents.js        sub-agent registry (the helpers)
│   ├── roam.js          trips around the screen (ambient life, being poked)
│   ├── placement.js     corners, dragging, snapping, monitor fallback
│   ├── menu-items.js    the hover menu (add features here)
│   ├── server.js        127.0.0.1 HTTP endpoint
│   ├── validate.js      event schema
│   ├── renderer/        overlay page (HTML, CSS, JS); lib/ holds its pure, tested logic
│   │                    (interaction.js: mouse, menu, rest; crew.js: the helpers' choreography;
│   │                    fun.js: ambient life, pokes, cheers, the duel; pet.js: the cat)
│   └── locales/         en.json, tr.json
├── characters/robot/    the default character (SVG + CSS + manifest)
├── hooks/send.js        the hook script (Node built-ins only)
├── lib/                 settings.json merge logic shared by setup/uninstall
├── scripts/             simulate.js, make-icons.js
├── test/                node:test suites
├── setup.js, uninstall.js
└── README.md, LICENSE, THIRD_PARTY_NOTICES.md
```

## Contributing

Issues and pull requests are welcome. Please keep these properties intact:

- **Zero runtime dependencies besides Electron.** `hooks/send.js`, `setup.js` and
  `uninstall.js` use Node built-ins only.
- **The hook must never get in Claude Code's way:** silent, fast, exit code 0.
- **No network access, telemetry or update checks.**
- **Tests pass** (`npm test`), and new behaviour comes with a test.
- Code, comments and docs are in English.
- **Assets:** only your own work or permissively licensed (CC0, MIT, ...), listed in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Translations:** copy `app/locales/en.json` to `app/locales/<code>.json`, translate
  the values (keep the `{placeholders}`), then register the code in `app/i18n.js` and
  `app/settings.js`. A test checks that every key and placeholder is present.

## Disclaimer

This software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)).
`npm run setup` modifies your Claude Code settings file. It shows the changes first and
writes a timestamped backup next to the file before changing it, and
`npm run uninstall-hooks` removes the entries again. Review what it prints before you
confirm.

## License

[MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

"Claude" and "Claude Code" are Anthropic's product names. They are used here only to
describe compatibility.
