# Agent Buddy

A tiny animated robot on your desktop that shows what Claude Code is doing: thinking,
reading, typing, running a command, waiting for your approval, done. Sub-agents show up as
little helper robots, and a failing test brings a bug that the buddy fights until the fix
lands. Everything runs on your computer; nothing is sent anywhere.

Unofficial; not affiliated with or endorsed by Anthropic.

## Install

Needs [Node.js](https://nodejs.org) 20+ and Claude Code.

```sh
npm install -g agent-buddy          # or a package file: npm install -g ./agent-buddy-0.2.0.tgz
agent-buddy setup                   # hooks into every Claude Code account on this computer
```

`setup` finds every Claude Code account by itself: `~/.claude`, `~/.claude-<name>`
(e.g. `~/.claude-personal`, `~/.claude-work`) and `$CLAUDE_CONFIG_DIR`. It shows what it will
add, asks once, and backs up each settings file first. Other hooks and settings stay as they
are. Done: the buddy appears with the next Claude Code session, in any of those accounts.

From a clone of this repository instead: `npm install`, then `npm run setup`.

## Use

| Command | What it does |
|---|---|
| `agent-buddy status` | which accounts have the hooks, and whether the buddy is running |
| `agent-buddy demo` | a tour of every state, no Claude Code needed |
| `agent-buddy start` | start the buddy now (normally the first Claude Code event does) |
| `agent-buddy setup` | run again after adding a Claude account, or after updating Agent Buddy |
| `agent-buddy uninstall` | remove the hooks again (only Agent Buddy's) |

`--dry-run` shows the changes without writing anything; `--config-dir <dir>` limits `setup`
or `uninstall` to one account.

On the buddy:

- **Hover:** a small menu (quiet mode, eyes, play, cat, chat, corner, settings, quit).
- **Drag** it anywhere; dropped higher up, it hovers on its thrusters.
- **Click:** a tap. Idle it loves it; at work, three quick taps and it moves away.
- **Right-click:** walk, fly, home, sword duel, the whip, the cat.
- **Tray icon:** corner, size, account, character, language (English / Türkçe), quiet mode,
  ambient life, play mode, the cat, settings file, quit.

**Ambient life** (on by default): when idle it plays, walks and flies around the screen, also
over to a second screen, and helpers roam the screen too. Switch it off in the tray to keep
everything still. **Quiet mode** hides the speech bubble (file names, commands): use it while
sharing your screen.

## Privacy

- The hook passes only the event, the tool name, the **file name** (not the path) or a
  **shortened command** with secrets masked, and the account folder's name. Never file
  contents, prompts, full commands or tool output.
- The overlay listens on `127.0.0.1` only. No telemetry, no update checks, no network.
- Settings live in `~/.agent-buddy/settings.json`. The debug log is off by default.

## Troubleshooting

- **No buddy:** run `agent-buddy status`, then restart open Claude Code sessions.
- **After updating or moving Agent Buddy:** run `agent-buddy setup` again (the hooks point at
  the installed copy; `status` tells you when they point at another one).
- **"Electron missing":** reinstall (`npm install -g agent-buddy`), or `npm install` in a clone.
- **Port 7777 taken:** set another `"port"` in `~/.agent-buddy/settings.json`.

## Development

```sh
npm install
npm test                                     # unit tests (node:test)
npm run dev                                  # overlay with console logs
npm run simulate [-- bug | life | chat | two-sessions | lifecycle | playground]
npm pack                                     # the package file (agent-buddy-<version>.tgz)
```

Making a character: [characters/README.md](characters/README.md). Windows checks
(screenshots, CPU, click-through): [scripts/windows/README.md](scripts/windows/README.md).

## License

MIT, see [LICENSE](LICENSE). All artwork is original; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
