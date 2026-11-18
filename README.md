<div align="center">

# Perchbot

[![npm](https://img.shields.io/npm/v/perchbot.svg)](https://www.npmjs.com/package/perchbot)
[![Downloads](https://img.shields.io/npm/dt/perchbot.svg)](https://www.npmjs.com/package/perchbot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kadirdemirkaya/perchbot/blob/main/LICENSE)

**A little desktop robot that lets you watch Claude Code work in the background, and makes it fun.**

<img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/hello.gif" width="300" alt="The robot waves hello">

</div>

Perchbot lives in a corner of your screen and acts out what the agent is doing: it thinks, reads,
types, runs commands, waits for you and cheers when the work is done. Sub-agents show up as little
helpers, a failing test brings a bug to fight, and between tasks it plays on its own.
It runs on your computer and sends nothing anywhere.

<sub>Unofficial; not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.</sub>

## Install

Needs Node.js 20+ and Claude Code.

```sh
npm install -g perchbot
perchbot setup        # adds the hooks to every Claude Code account on this computer
```

The first `perchbot setup` also downloads Electron, the window the robot lives in (about 100 MB, once).
Restart open sessions (VS Code: *Developer: Reload Window*) and the robot shows up with your next prompt.
`perchbot demo` plays every state without an agent. From a clone: `npm install`, then `npm run setup`.

**Updating:** run `npm install -g perchbot` again. On its next start the robot adds any new hooks by
itself (backing up each file first), only in accounts that already use this copy. Tray: *Keep hooks up to date*.

## What it does

| When | The robot |
|---|---|
| the agent thinks, reads, searches, edits or runs a command | takes a pose for each step and says what it is on ("Editing auth.js") |
| the agent waits for you | nudges you, then knocks until you answer |
| a turn ends | cheers, with a short summary ("Done! 4 steps in 12 s"); on Friday afternoons it dances |
| a long turn ends while you look elsewhere | flies over to your cursor: "All done! Over to you.", then back |
| you come back and things happened meanwhile | a big one of it holds up a board: "While you were away (18 min): 2 tasks done, Claude is waiting for you" |
| you have been at it for 50 minutes without a pause (opt-in) | stretches with you, then counts 20 seconds while you look far away |
| sub-agents start | little helpers join in, work beside it, play and report back |
| a skill is in use | reads its skill book, the skill's name on a tag |
| a test or check fails | a bug turns up and they fight until a check passes ("Bug fixed!") |
| a commit, a push | plants a flag, launches a rocket |
| a pull request (`gh pr create`) | seals an envelope and sends it flying |
| a plan waits for your approval | unrolls a blueprint beside it; approved: a stamp on it |
| an MCP tool runs | plugs a cable into a socket, the light blinks green |
| git merge, a new branch, stash, pull, force push, reset, a package install | puzzle pieces click, a sapling grows, a note goes into its pocket, a fish leaps into a bucket, a siren wails, a clock spins backwards, a parcel drops in |
| checks keep failing | sweats, then "Phew!" when it is green again |
| the work gets stuck (five fails in a row) | explains it all to a rubber duck, which sits on its head until something works |
| a command runs on and on | sits back with a bucket of popcorn until it is done |
| the conversation is compacted | pumps a little press; out pops a cube of paper |
| the work gets intense | puts on a headband and codes on a screen of light |
| the session runs Haiku, Sonnet, Opus or Fable | dresses for the model: silver, orchid, lilac and gold, midnight violet |
| you tap it | loves it, up to a point: then it fumes, catches fire and goes on a rampage across your screen |
| you start a duel | a sword fight against your cursor, three hearts each |
| it is idle | backflips, moonwalks, juggles, draws a heart in the fog, blows bubbles, plays with its cat, gets visitors, flies around, perches on windows (Windows), has a morning coffee, knocks on the glass before a nap ("Where are you?"), naps |
| the cursor rests somewhere | now and then it flies over for a look through its magnifier |
| you type (Windows, opt-in) | now and then it flies over, reads along, and a light bulb goes on |
| you open the chat | answers questions about the work; on Windows (opt-in) it opens Chrome, a tab or YouTube for you |

## See it in action

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/work.gif" width="380" alt="The robot reads, searches, edits and runs the tests while the agent works"><br><sub><b>At work:</b> reading, searching, editing, testing</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/agents.gif" width="380" alt="Three helper robots join in, chat and report back"><br><sub><b>Sub-agents</b> join in, chat and report back</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/skill.gif" width="380" alt="The robot opens its skill book"><br><sub><b>A skill:</b> out comes the skill book</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/bug.gif" width="380" alt="A failing test brings a bug; the robot fights it with a sword"><br><sub><b>Bug hunt:</b> a failing test brings a bug</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/rage.gif" width="380" alt="Tapped too often, the robot fumes and its head catches fire"><br><sub><b>Too many taps:</b> fuming, then fire</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/rampage.gif" width="380" alt="Laser eyes and missiles leave marks on the screen, then the beams chase the cursor"><br><sub><b>Rampage:</b> lasers, missiles, then your cursor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/hang.gif" width="380" alt="The robot flies up and hangs upside down from the top of the screen"><br><sub><b>Hanging around</b> at the top of the screen</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/duel.gif" width="380" alt="A sword duel between the robot and the cursor"><br><sub><b>Sword duel</b> against your cursor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/waiting.gif" width="380" alt="The robot waits for approval, whispers psst, then knocks"><br><sub><b>Waiting for you:</b> a psst, then a knock</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/squeeze.gif" width="380" alt="A compaction squeezes its head; on /exit it waves goodbye"><br><sub><b>Compaction</b> squeezes its head, <b>/exit</b> waves goodbye</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/find.gif" width="380" alt="A long task is done while you look elsewhere: it cheers, flies over to your cursor, says All done! Over to you, and flies back"><br><sub><b>Done while you looked away:</b> it flies over to tell you</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/crew-games.gif" width="380" alt="The helpers play tag, build a tower, and one pokes at the resting cursor"><br><sub><b>Helpers at play:</b> tag, a tower, a poke at your cursor</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/typing.gif" width="560" alt="While a prompt is typed in the terminal, the robot flies over, reads along through its magnifier, then a light bulb goes on"><br><sub><b>Watch me type</b> (Windows, opt-in): it reads along, then "Aha! Got it!"</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/slash.gif" width="560" alt="Files on the desktop are deleted one by one: each time the robot flies over and slashes the ghost of the file with its sword, coloured by type (text teal, folder yellow, photo green, Word blue, PDF red)"><br><sub><b>Follow Windows</b> (Windows, opt-in): delete a file and it slashes its ghost, coloured by type</sub></td>
  </tr>
</table>

<details>
<summary><b>More animations</b></summary>
<br>
<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/focus.gif" width="380" alt="Headband on, the robot codes on a screen and keys of light"><br><sub><b>Focus mode</b> when the work gets intense</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/moments.gif" width="380" alt="A flag for a commit, a rocket for a push, sweat, then phew"><br><sub><b>Commit, push, sweat, phew</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/duck.gif" width="380" alt="Five edits fail in a row: the robot takes a rubber duck from its pocket, explains the problem to it and the duck hops onto its head; when an edit works it says Phew! Thanks, duck!"><br><sub><b>Stuck:</b> it asks a rubber duck, then "Thanks, duck!"</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/popcorn.gif" width="380" alt="npm install runs on and on: after 20 seconds the robot sits down with a bucket of popcorn until it is done"><br><sub><b>A long command:</b> popcorn time</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/press.gif" width="380" alt="While the conversation is compacted the robot pumps a little press over a stack of paper; then its head is squeezed and a cube of paper pops out"><br><sub><b>Compaction:</b> a little press, then a cube of paper</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/chat.gif" width="380" alt="The chat panel with buttons and ready-made questions"><br><sub><b>Chat:</b> ask what it is doing</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/fist.gif" width="380" alt="The robot fires its forearm at Chrome's new tab button"><br><sub><b>Rocket fist:</b> a new tab, from afar</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/glee.gif" width="380" alt="Happy hops and hearts"><br><sub><b>A few taps</b> when it is idle: "Hehe!"</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/idle.gif" width="380" alt="A backflip, a moonwalk, a sneeze, soap bubbles and a paper plane"><br><sub><b>Idle plays:</b> flips, bubbles, a paper plane</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/visitor.gif" width="380" alt="A small robot visits: a chat and sword practice"><br><sub><b>A visitor</b> drops by for sword practice</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/cat.gif" width="380" alt="The robot plays with its cat using a laser pointer, then pets it"><br><sub><b>The cat:</b> laser pointer, then a cuddle</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/follow.gif" width="380" alt="The robot flies to where the cursor rests and looks through a magnifier"><br><sub><b>Curious:</b> a look where your cursor rests</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/flight.gif" width="380" alt="A loop-the-loop and a slow wavy flight"><br><sub><b>Flying:</b> a loop-the-loop, a slow cruise</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/curious.gif" width="380" alt="It asks what this is, with answers to click, then welcomes you back"><br><sub><b>Curious:</b> "What's this?", then "Welcome back!"</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/fidgets.gif" width="380" alt="Little plays: a stretch, humming, a ball, the antenna, a reboot, a polish"><br><sub><b>Little plays:</b> stretch, hum, ball, reboot, polish</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/stroll.gif" width="380" alt="It walks along the bottom of the screen, sits down, and the cat comes by"><br><sub><b>Ambient life:</b> a walk, a sit, the cat</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/nap.gif" width="380" alt="A big yawn, then a nap with its light off"><br><sub><b>Nap time</b> after a long idle spell</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/clock.gif" width="380" alt="A morning coffee, a dance when a task is done on a Friday afternoon, and a nap in a nightcap late at night"><br><sub><b>By the clock:</b> a morning coffee, a Friday dance, a nightcap at night</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="https://raw.githubusercontent.com/kadirdemirkaya/perchbot/main/docs/media/perch.gif" width="560" alt="It lands on a window's title bar and rides along when the window moves"><br><sub><b>Perching</b> on a window's title bar, riding along when it moves (Windows)</sub></td>
  </tr>
</table>
</details>

## Using it

- **Hover** it for its menu, **drag** it anywhere (not while it fires its lasers), **right-click** it to
  walk, fly, duel or call the cat. Everything else is in the tray icon.
- **Quiet mode** hides file names and commands: handy while you share your screen.
- **Ambient life** lets it and its helpers roam your screens when idle; **Stay here** keeps it on its spot.
- **Several accounts?** Tray > Account > *One buddy per account* gives each one its own robot.
- **Sound** (off by default): little robot sounds made in code. *Work sounds* adds short ones for the work.
- **Look by model** (on by default): it dresses for your session's model; with several sessions open,
  the highest one wins. Following `/model` mid-session needs Claude Code 2.1.251 or newer.
- **Giant peek** (off by default; needs ambient life): before a nap it walks up to the glass, growing up
  to ten times its size, and knocks. Move the pointer onto it: "There you are!"
- **While you were away** (on by default): back at the computer and things happened, a big robot holds
  up a board: tasks done, commits and pushes, a question waiting, a test still red. Pointer on it: it goes.
- **Stretch breaks** (off by default): after about 50 minutes at the computer without a pause, it
  stretches with you, then counts 20 seconds while you look far away, and goes back to the work.
  Pointer on it: "Okay, later!" (it asks again in 15 minutes).
- **Windows only**, off by default:
  - **Hands**: Chrome, tab and YouTube buttons in the chat. Your mouse is not moved, tab titles are not read.
  - **Watch me type** (needs ambient life): now and then it reads along while you type. It only asks
    where the text cursor is.
  - **Follow Windows**: delete a file and it slashes a ghost of it. It deletes nothing itself, and
    Shift+Delete or command-line deletes are not seen.

## Commands

| | |
|---|---|
| `perchbot setup` | add the hooks (`~/.claude`, `~/.claude-<name>`, `$CLAUDE_CONFIG_DIR`); asks once, backs up each file |
| `perchbot doctor` | fix missing hooks, test each account live (`--account <name>` for one) |
| `perchbot status` | which accounts have the hooks, is the robot running (`--config-dir <dir>` for one) |
| `perchbot start` | start the robot now |
| `perchbot demo` | a tour of every state, no agent needed |
| `perchbot uninstall` | remove the hooks again |

## Privacy

Everything stays on your computer; the robot never goes online.

- **From the hook** (to `127.0.0.1` only): the event, the tool name, a file name (not the path), a
  shortened command (secrets masked) and the model family (`haiku`, `sonnet`, `opus`, `fable`).
  Never your prompts, plans, compact instructions or file contents.
- **Ambient life:** the system idle time, where the cursor is and, on Windows, where windows are
  (frames only, never titles or contents).
- **Watch me type:** where the text cursor is, never the text or your keys.
- **Giant peek, the board, stretch breaks:** where the cursor is, only while the big robot is on screen.
  The board counts only what the hook already sent, in memory; breaks use only the system idle time.
- **Follow Windows:** only the type of each deleted item, never its name or where it was.
- **Keep hooks up to date:** once per start it runs `claude --version` and adds its own missing hooks
  to your Claude Code settings; nothing else in them changes.

Nothing is stored or sent anywhere. Settings: `~/.perchbot/settings.json`. The only download is
Electron, once, by `perchbot setup` (or `start` / `demo` while it is still missing).

## Development

`npm test` · `npm run dev` · `npm run simulate [-- bug | life | chat | duck | popcorn | press | plan | pr | mcp | terminal | giant | board | break | looks]` · `npm pack`.
Make your own character: [characters/README.md](https://github.com/kadirdemirkaya/perchbot/blob/main/characters/README.md).

MIT, see [LICENSE](https://github.com/kadirdemirkaya/perchbot/blob/main/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/kadirdemirkaya/perchbot/blob/main/THIRD_PARTY_NOTICES.md).
