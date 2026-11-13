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
- **Tap** it: idle it mostly likes that. Keep tapping and it gets cross, fumes, and its head catches fire.

Only the event, the tool name, a file name (not the path) and a shortened command (secrets
masked) leave the hook, and only to `127.0.0.1`. Settings: `~/.agent-buddy/settings.json`.
With ambient life on, the overlay also looks at the system idle time (to say welcome back) and,
on Windows, at where windows are (frames only, never titles or contents) to sit on title bars.
Nothing of it is stored or sent anywhere.

## Development

`npm test` · `npm run dev` · `npm run simulate [-- bug | life | chat]` · `npm pack`.
Characters: [characters/README.md](characters/README.md).

MIT, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
