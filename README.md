<div align="center">

# Perchbot

**A little desktop robot that lets you watch Claude Code work in the background, and makes it fun.**

<img src="docs/media/hello.gif" width="300" alt="The robot waves hello">

</div>

Perchbot lives in a corner of your screen and acts out what the agent is doing: it thinks, reads,
types, runs commands, waits for you and cheers when the work is done. Sub-agents show up as little
helpers, a failing test brings a bug to fight, and between tasks it plays on its own.
It runs on your computer and sends nothing anywhere.

<sub>Unofficial; not affiliated with Anthropic.</sub>

## Install

Needs Node.js 20+ and Claude Code.

```sh
npm install -g perchbot
perchbot setup        # adds the hooks to every Claude Code account on this computer
```

Restart open sessions (VS Code: *Developer: Reload Window*) and the robot shows up with your next prompt.
`perchbot demo` plays every state without an agent. From a clone: `npm install`, then `npm run setup`.

## What it does

| When | The robot |
|---|---|
| the agent thinks, reads, searches, edits or runs a command | takes a pose for each step and says what it is on ("Editing auth.js") |
| the agent waits for you | nudges you, then knocks until you answer |
| a turn ends | cheers, with a short summary ("Done! 4 steps in 12 s") |
| sub-agents start | little helpers join in, work beside it, chat and report back |
| a skill is in use | reads its skill book, the skill's name on a tag |
| a test or check fails | a bug turns up and they fight until a check passes ("Bug fixed!") |
| a commit, a push | plants a flag, launches a rocket |
| checks keep failing | sweats, then "Phew!" when it is green again |
| the work gets intense | puts on a headband and codes on a screen of light |
| you tap it | loves it, up to a point: then it fumes, catches fire and goes on a rampage across your screen |
| you start a duel | a sword fight against your cursor, three hearts each |
| it is idle | backflips, moonwalks, blows bubbles, throws paper planes, gets visitors, plays with its cat, naps |
| the cursor rests somewhere | now and then it flies over for a look through its magnifier |
| you open the chat | answers questions about the work; on Windows (opt-in) it opens Chrome, a tab or YouTube for you |

## See it in action

<table>
  <tr>
    <td align="center"><img src="docs/media/work.gif" width="380" alt="The robot reads, searches, edits and runs the tests while the agent works"><br><sub><b>At work:</b> reading, searching, editing, testing</sub></td>
    <td align="center"><img src="docs/media/agents.gif" width="380" alt="Three helper robots join in, chat and report back"><br><sub><b>Sub-agents</b> join in, chat and report back</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/skill.gif" width="380" alt="The robot opens its skill book"><br><sub><b>A skill:</b> out comes the skill book</sub></td>
    <td align="center"><img src="docs/media/bug.gif" width="380" alt="A failing test brings a bug; the robot fights it with a sword"><br><sub><b>Bug hunt:</b> a failing test brings a bug</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/rage.gif" width="380" alt="Tapped too often, the robot fumes and its head catches fire"><br><sub><b>Too many taps:</b> fuming, then fire</sub></td>
    <td align="center"><img src="docs/media/rampage.gif" width="380" alt="Laser eyes and missiles leave marks on the screen, then the beams chase the cursor"><br><sub><b>Rampage:</b> lasers, missiles, then your cursor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/hang.gif" width="380" alt="The robot flies up and hangs upside down from the top of the screen"><br><sub><b>Hanging around</b> at the top of the screen</sub></td>
    <td align="center"><img src="docs/media/duel.gif" width="380" alt="A sword duel between the robot and the cursor"><br><sub><b>Sword duel</b> against your cursor</sub></td>
  </tr>
</table>

<details>
<summary><b>More animations</b></summary>
<br>
<table>
  <tr>
    <td align="center"><img src="docs/media/focus.gif" width="380" alt="Headband on, the robot codes on a screen of light"><br><sub><b>Focus mode</b> when the work gets intense</sub></td>
    <td align="center"><img src="docs/media/moments.gif" width="380" alt="A flag for a commit, a rocket for a push, sweat, then phew"><br><sub><b>Commit, push, sweat, phew</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/chat.gif" width="380" alt="The chat panel with buttons and ready-made questions"><br><sub><b>Chat:</b> ask what it is doing</sub></td>
    <td align="center"><img src="docs/media/fist.gif" width="380" alt="The robot fires its forearm at Chrome's new tab button"><br><sub><b>Rocket fist:</b> a new tab, from afar</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/glee.gif" width="380" alt="Happy hops and hearts"><br><sub><b>A few taps</b> when it is idle: "Hehe!"</sub></td>
    <td align="center"><img src="docs/media/idle.gif" width="380" alt="A backflip, a moonwalk, a sneeze, soap bubbles and a paper plane"><br><sub><b>Idle plays:</b> flips, bubbles, a paper plane</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/visitor.gif" width="380" alt="A small robot visits: a chat and sword practice"><br><sub><b>A visitor</b> drops by for sword practice</sub></td>
    <td align="center"><img src="docs/media/cat.gif" width="380" alt="The robot plays with its cat using a laser pointer, then pets it"><br><sub><b>The cat:</b> laser pointer, then a cuddle</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/follow.gif" width="380" alt="The robot flies to where the cursor rests and looks through a magnifier"><br><sub><b>Curious:</b> a look where your cursor rests</sub></td>
    <td align="center"><img src="docs/media/flight.gif" width="380" alt="A loop-the-loop and a slow wavy flight"><br><sub><b>Flying:</b> a loop-the-loop, a slow cruise</sub></td>
  </tr>
</table>
</details>

## Using it

- **Hover** it for its menu, **drag** it anywhere, **right-click** it to walk, fly, duel or call the cat.
  Everything else is in the tray icon.
- **Quiet mode** hides file names and commands: handy while you share your screen.
- **Ambient life** (tray) lets it and its helpers roam your screens when idle; **Stay here** keeps it on its spot.
- **Several accounts** (`CLAUDE_CONFIG_DIR`)? Tray > Account > *One buddy per account* gives each one its own robot.
- **Sound** (tray, off by default): little robot sounds made in code, no audio files.
- **Hands** (Windows, tray, off by default): Chrome, tab and YouTube buttons in the chat panel. It presses
  them through Windows UI Automation; your mouse is not moved, tab titles and addresses are not read.

## Commands

| | |
|---|---|
| `perchbot setup` | add the hooks (`~/.claude`, `~/.claude-<name>`, `$CLAUDE_CONFIG_DIR`); asks once, backs up each file |
| `perchbot doctor` | fix missing hooks, test each account live (`--account <name>` for one) |
| `perchbot status` | which accounts have the hooks, is the robot running |
| `perchbot start` | start the robot now |
| `perchbot demo` | a tour of every state, no agent needed |
| `perchbot uninstall` | remove the hooks again |

## Privacy

Only the event, the tool name, a file name (not the path) and a shortened command (secrets masked)
leave the hook, and only to `127.0.0.1`. With ambient life on, the robot also looks at the system idle
time, where the cursor is (its position only) and, on Windows, where windows are (frames only, never
titles or contents). Nothing of it is stored or sent anywhere. Settings: `~/.perchbot/settings.json`.

## Development

`npm test` · `npm run dev` · `npm run simulate [-- bug | life | chat]` · `npm pack`.
Make your own character: [characters/README.md](characters/README.md).

MIT, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
