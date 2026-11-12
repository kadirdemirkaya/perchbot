# Making a character

A character is a folder with three files. No app code changes are needed.

```
characters/<id>/            # bundled with the repo (send a pull request), or
~/.agent-buddy/characters/<id>/   # your own, private, no repo changes at all
├── character.json
├── <something>.svg
└── <something>.css
```

`<id>` is the folder name: letters, digits, `-` and `_`. If the same id exists in
both places, the bundled one wins. Pick your character from the tray menu
(**Character**), then run `npm run simulate` to see every state.

## License rule

**Only submit artwork you drew yourself, or artwork released under a permissive
license such as CC0 or MIT.** Put the license in `character.json` and, for anything
not drawn by you, add it to `THIRD_PARTY_NOTICES.md` with its source.

Not accepted: characters, logos or mascots owned by someone else (including
"inspired by" redraws of well-known characters), ripped game sprites, or assets
whose license is unclear.

## character.json

```json
{
  "name": "Robo",
  "author": "Your Name",
  "license": "MIT",
  "description": "One sentence about the character.",
  "svg": "robot.svg",
  "css": "robot.css",
  "bubbleAnchor": { "x": 0.44, "y": 0.06 },
  "blink": true,
  "confetti": true,
  "states": {
    "idle": "idle",
    "greeting": "greeting",
    "thinking": "thinking",
    "typing": "typing",
    "reading": "reading",
    "running": "running",
    "working": "working",
    "waiting": "waiting",
    "done": "done",
    "goodbye": "goodbye"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Shown in the tray menu |
| `author`, `license`, `description` | recommended | Shown in the menu / kept for credits |
| `svg`, `css` | yes | Plain file names inside the character folder (max 512 KB each) |
| `bubbleAnchor` | no | Where the speech bubble points, as fractions of the 200×200 character box (`x` from the left, `y` from the top). Default `{ "x": 0.5, "y": 0.1 }` |
| `lookAnchor` | no | Where the eyes are (same units). The cursor direction is measured from here. Default `{ "x": 0.5, "y": 0.35 }` |
| `blink` | no | `true` (default) lets the app set `data-blink` for 150 ms every few seconds |
| `confetti` | no | `true` (default) shows the app's confetti on "done" |
| `states` | no | Maps each app state to the value written into `data-state`. Missing entries use the state name. Lets two states share one animation |

### States

| State | When |
|---|---|
| `idle` | Nothing happening |
| `greeting` | A session started |
| `thinking` | A prompt was submitted, or between tools |
| `typing` | Edit / Write / MultiEdit / NotebookEdit |
| `reading` | Read / Grep / Glob |
| `running` | Bash / PowerShell |
| `working` | Any other tool (web search, sub-agents, MCP tools, ...) |
| `waiting` | Claude Code asks for permission to use a tool (`permission_prompt`) |
| `asking` | Claude Code has a question for the user (elicitation, agent needs input). Falls back to `waiting` |
| `standby` | Calm: waiting for the user's next message (`idle_prompt`) or any other notice. Falls back to `idle` |
| `done` | The turn finished |
| `goodbye` | The last session ended; the app fades the whole overlay out and quits |

## How your SVG and CSS are used

The app inlines your SVG into:

```html
<div class="buddy-character" data-state="typing" data-blink="1">
  <svg>…your SVG…</svg>
</div>
```

and loads your CSS next to it. Style states with attribute selectors:

```css
.buddy-character[data-state='typing'] .my-arm { animation: my-tap 0.3s steps(1) infinite; }
.buddy-character[data-blink] .my-eyes { transform: scaleY(0.1); }
```

The SVG is drawn in a 200 × 200 box at the bottom of the window. The speech bubble,
the hover menu and confetti are drawn by the app; you only animate the character.

### Everything the app sets on the wrapper

Use whatever you like; ignore the rest.

| Attribute / variable | Meaning |
|---|---|
| `data-state` | the current state (see the table above, or your `states` mapping) |
| `data-blink` | present for ~140 ms at random intervals (sometimes twice in a row) |
| `data-hover` | the pointer is over the character or its menu |
| `data-greet` | present for ~1.8 s when the pointer arrives while idle: wave hello |
| `data-boop` | present for ~0.5 s after a click |
| `data-rest` | idle for a minute with nothing happening: show a calm pose, **stop all animation** |
| `data-tap` | while typing: `down` / `up` on every key press of an irregular rhythm |
| `data-sway` | `a` or `b` for ~1.2 s after each state change (secondary motion, e.g. an antenna wobble) |
| `--look-x`, `--look-y` | cursor direction from `lookAnchor`, each from -1 to 1 (0 when the cursor is away) |
| `--type-line` | while typing: 0-7, advances every few key presses |
| `data-mood` | `worried` for the rest of a tool's hold time after the tool failed |
| `data-fly` | `hover` while the character is placed above the ground (hover mode "auto"), `boost` while it is dragged through the air |
| `data-land` | present for ~0.9 s when it comes back to the ground |
| `--fly-tilt` | while flying: -1 to 1, the drag direction (positive = moving right); 0 at rest |

### Hovering

When the user drops the character more than ~24 px above the bottom of the work area,
the app sets `data-fly`. Robo fires flames from its boots, tucks its legs and bobs; a
character that does not style `data-fly` simply stands in the air. Keep flames and other
effects `data-nohit`, still under `data-rest`, and static for reduced motion.

### The mouse

The app treats every **painted** SVG shape as "the character": hovering it opens the
menu, pressing it starts a drag or a click. Transparent space never counts. Mark
shapes that should not count (shadows, effects, props that are hidden in most states)
with a `data-nohit` attribute:

```svg
<ellipse class="my-shadow" data-nohit="" cx="100" cy="190" rx="50" ry="6"/>
```

Hidden props with `opacity: 0` still count as painted, so give them `data-nohit` too.

### Rigging tips

Robo is built as a small rig: one group per moving part (body, head, antenna, upper
arm, forearm, laptop lid), each with its pivot set by `transform-origin` in SVG user
units, and one group per *kind* of motion (click reaction, hops, breathing, gaze, blink)
so they can overlap without fighting over `transform`.

### Rules (enforced or required)

- **No scripts.** `<script>`, `<foreignObject>`, `<image>`, event-handler attributes
  (`onload`, ...) and external `href`s are stripped before the SVG is shown.
- **No inline `style="..."` attributes.** The page's Content Security Policy blocks
  them; use presentation attributes (`fill="#fff"`) or your CSS file.
- **No external resources.** No `url(http...)`, no `@import`, no web fonts. Draw
  text as shapes; the overlay has no network access.
- **Prefix your class names** (Robo uses `rb-`) so they do not collide with the app.

### Keep it light

The overlay should stay around 1% CPU. In practice:

- Keep `idle` very light (Robo breathes at ~2.5 frames per second) and run **nothing**
  under `data-rest`. Blinking comes from `data-blink`.
- Animations that can last a long time (waiting for approval can take minutes) should
  calm down after a few seconds.
- Prefer `transform` and `opacity`. For busy states, `steps()` timing (a few
  changes per second) costs far less than smooth 60 fps motion.
- Scope every animation to the state that needs it.
- Support `@media (prefers-reduced-motion: reduce)`: keep the poses, drop the motion.

`characters/robot/` is a complete, commented example, and `characters/robot/DESIGN.md`
shows how its look was kept original.
