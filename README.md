# Agent Buddy

A tiny robot on your desktop that shows what Claude Code is doing: thinking, reading, typing,
running a command, waiting for you, done. Sub-agents show up as little helpers; a failing test
brings a bug it fights until the fix lands. Runs locally, sends nothing anywhere.
Unofficial; not affiliated with Anthropic.

## Install

Needs Node.js 20+ and Claude Code.

```sh
npm install -g agent-buddy
agent-buddy setup        # adds the hooks to every Claude Code account on this computer
agent-buddy doctor       # checks that each account brings up the buddy
```

From a clone instead: `npm install`, then `npm run setup`.
Open Claude Code sessions pick up the hooks after a restart (VS Code: *Developer: Reload Window*).

## Commands

| | |
|---|---|
| `agent-buddy setup` | add the hooks (`~/.claude`, `~/.claude-<name>`, `$CLAUDE_CONFIG_DIR`); asks once, backs up each file |
| `agent-buddy doctor` | fix missing hooks, test each account live (`--account <name>` for one) |
| `agent-buddy status` | which accounts have the hooks, is the buddy running |
| `agent-buddy start` | start the buddy now |
| `agent-buddy demo` | a tour of every state, no Claude Code needed |
| `agent-buddy uninstall` | remove the hooks again |

## Using it

- **Hover** the buddy for its menu (quiet mode, chat, settings, quit); **drag** it anywhere.
- **Right-click** it: walk, fly, home, sword duel, the cat. More in the **tray icon**.
- **Quiet mode** hides file names and commands: use it while sharing your screen.
- **Several Claude accounts** (`CLAUDE_CONFIG_DIR`)? Tray > Account > **One buddy per account**
  gives each account a buddy of its own, side by side, each with a small name tag.
- **Ambient life** (tray) lets it and its helpers roam your screens when idle; switch it off to keep it still.
  Now and then it flies over to where your cursor came to rest and peers at it through a magnifier.
  **Stay here** (tray or right-click) keeps it on its spot: it still plays there, but no trips, no fleeing.
- Left **idle** for a while it reads a little, the cat comes over (if it is on), a visitor drops by to chat
  and practise with toy swords, and then it yawns and takes a nap.
- **Focus mode:** when the work gets intense (lots of edits in a couple of minutes) it puts on a headband
  and codes on a screen of light projected from its eye instead of the laptop.
- **Tap** it: idle it mostly likes that. Keep tapping and it gets cross, fumes, and its head catches fire.
  Set its head on fire twice within five minutes and it goes on a rampage: laser eyes and missiles
  leave burn marks on your screen (a click-through layer; nothing real is touched) that fade 5 to 10
  seconds after the last blast.
- **Sound** (tray, off by default): little robot sounds made in code, no audio files. With **Work sounds**
  on too it also signals when a turn is done, a tool failed or Claude Code has a question.
- **Hands** (Windows, tray > "Hands: Chrome tabs", off by default): in the chat panel ask it to open a
  new tab or close the last tab in Chrome (or type "open" / "close"). It flies over and presses the
  button through Windows UI Automation; your mouse is not moved, tab titles are not read.

Only the event, the tool name, a file name (not the path) and a shortened command (secrets
masked) leave the hook, and only to `127.0.0.1`. Settings: `~/.agent-buddy/settings.json`.
With ambient life on, the overlay also looks at the system idle time (to say welcome back), where the
cursor is (its position only, to fly over to where it rests) and,
on Windows, at where windows are (frames only, never titles or contents) to sit on title bars.
Nothing of it is stored or sent anywhere.

## Development

`npm test` · `npm run dev` · `npm run simulate [-- bug | life | chat]` · `npm pack`.
Characters: [characters/README.md](characters/README.md).

MIT, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
