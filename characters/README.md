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
| `mini` | no | `{ "svg", "css", "tints" }`: a small helper drawn once per sub-agent (see [Sub-agent helpers](#sub-agent-helpers)). Without it the app shows a "N helpers" badge instead |
| `pet` | no | `{ "svg", "css" }`: a pet the user can call from the menu (see [A pet](#a-pet)). Without it the cat menu items stay disabled |

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
| `data-boop` | present for ~0.5 s after a click (quick clicks: back to back, never restarted half-way) |
| `data-rest` | idle for a minute with nothing happening: show a calm pose, **stop all animation** |
| `data-tap` | while typing: `down` / `up` on every key press of an irregular rhythm |
| `data-sway` | `a` or `b` for ~1.2 s after each state change (secondary motion, e.g. an antenna wobble) |
| `--look-x`, `--look-y` | cursor direction from `lookAnchor`, each from -1 to 1 (0 when the cursor is away) |
| `--type-line` | while typing: 0-7, advances every few key presses |
| `data-mood` | `worried` for the rest of a tool's hold time after the tool failed; `sweat` while at work after three failed tools in a row, until one works (app/moments.js) |
| `data-moment` | `phew` (~1.7 s: a tool worked after a failure streak) or `squeeze` (~1.9 s: the conversation was compacted). The app adds a flag for a `git commit` and a rocket for a `git push` itself |
| `data-nudge` | Claude Code waits for the user (`waiting` / `asking`): `psst` after ~30 s (a hop), `knock` after ~90 s and then every minute (a knock on the glass; the app adds the rings), ~2.4 s each |
| `data-fly` | `hover` while the character is placed above the ground (hover mode "auto"), `boost` while it is dragged through the air |
| `data-land` | present for ~0.9 s when it comes back to the ground |
| `--fly-tilt` | while flying: -1 to 1, the drag direction (positive = moving right); 0 at rest |
| `data-skill` | `open` while a skill is in use (show a book, a scroll, ...), `stow` for ~0.8 s when it is put away. The app draws the tag with the skill name itself |
| `data-brief`, `data-receive` | present for ~1.7 s when a helper is briefed / reports back. The value (`left` / `right`) is the side the helper stands on |
| `data-press` | ~1.2 s: it presses a button with the near hand (hands: Chrome's new tab or close button). The app puts that hand ~46 px right of and ~115 px above the anchor (main.js `HAND_OFFSET`, medium size); raise the hand there |
| `data-task` | at work, what it works on (from the tool, app/tools.js `taskFor`): `book` (reading a file, `data-state="reading"`), `search` (Grep / Glob, `reading`), `web` (WebSearch / WebFetch, `working`). Absent: the plain look of the state |
| `data-think` | while thinking the app changes the pose every ~7 s: absent (the plain thinking look), `bulb` (an idea) or `pace` (pacing up and down; the app flips `data-face` every ~2.4 s) |
| `data-talk` | up to ~1.8 s while it answers a question from the chat panel (talk, nod); also while it chats with a visitor |
| `data-seated` | `down` while it sits with a visitor (the idle story), `up` for ~0.5 s as it gets up again |
| `data-play` | ambient life, while idle: `stretch`, `look`, `peek`, `hum`, `jump`, `ball`, `antenna`, `flip`, `reboot`, `polish`, `sneeze`, `moonwalk` or `sit` (only on the ground) for 1.5-4.2 s, and the idle story's own plays (only the story starts them): `read` (9 s: takes a book out and reads), `bubbles` (7 s: blows soap bubbles through a wand), `plane` (6 s: throws a paper plane that loops back to its hand) (each name's time is in `PLAYS` in `app/renderer/lib/fun.js`; end your animation within it; the optional sounds that go with them are timed to the robot's keyframes, see `CUES` in `app/renderer/lib/sound.js`) |
| `data-pet` | `play` while the pet plays next to the character (it joins in); `cuddle` while the pet stands close to be petted (the idle story; the app also turns the character towards it with `data-face`); `laser` while the pet chases a laser pointer's dot (the character points it; turned towards the pet like for `cuddle`) |
| `data-cheer` | with `data-state="done"`: `jump` (the classic), `spin`, `dance` or `fist` |
| `data-glee` | ~0.65 s: tapped and it liked it (a happy hop; quick taps: back to back). The app adds the hearts |
| `data-annoyed`, `data-ouch` | tapped and it did not want it / hit with the whip (~0.5 s). The value of `data-annoyed` is how angry it is: `1` cross (~1.5 s), `2` fuming, `3` blazing; more unwelcome taps heat it up, and it cools one level at a time (`TEMPER_HOLD` in `app/renderer/lib/fun.js`). A plain `[data-annoyed]` rule covers every level |
| `data-erupt` | ~0.7 s: tapped while blazing, it erupts and flies off (the app adds the sparks) |
| `data-lens` | ~5 s on arrival next to where the cursor rested (app/follow.js), with `data-inspect` set too: a look through a big magnifier. The app turns the figure (`data-face`) so that its far side faces the spot |
| `data-holo` | focus mode: the work is intense (steps in the last two minutes, edits count double; `FocusMeter` in `app/renderer/lib/fun.js`). Set for the whole spell (also while it thinks between tools); a calm spell of 25 s clears it. Robo puts on a headband and, in the laptop states, codes on a projected screen instead of the laptop |
| `data-rampage` | its head caught fire twice within five minutes: `charge` (~1 s), `laser` (~1.6 s), `missile`, `chase` (5 s: beams and missiles after the cursor), `smug`, `heal` (then ~1.8 s more). The app draws the beams, missiles and marks over the screen; it starts the beams at the elements marked `data-eye` (one or two) and the missiles at the one marked `data-launch`. A character without them never goes on a rampage (it flies off as before) |
| `data-move` | on a trip around the screen: `walk` or `fly` (the app also sets `data-fly` while flying). Also `fly` while it glides after being thrown, `toss` for the same with hover mode "Always stand", and `settle` for the short ease into place after a drop |
| `data-hang` | it hangs from the top edge of the screen (a trip took it there) until its next trip, a drag or work. The app puts the anchor `HANG_REACH` (app/roam.js, 190 px at medium size) below the edge: Robo turns upside down and hooks its boots over it. Hide thrusters and shadow |
| `data-loop` | a loop-the-loop on a flight: turn the figure once, `animation-delay: var(--loop-delay)` and `animation-duration: var(--loop-ms)` (the app sets both), while the window flies the circle |
| `data-face` | `left` while walking or fighting towards the left (also towards a bug): the app mirrors your SVG, you do nothing |
| `data-inspect` | `left` / `right` for ~4 s after it flew next to the cursor: have a look that way |
| `data-duel` | the duel: `draw`, `guard`, `windup` (the telegraph, make it obvious), `strike`, `hit` (it got the user), `recover`, `stun` (parried), `block`, `hurt` (the user got it), `win`, `lose` |
| `data-hunt` | the bug hunt: present while it fights a bug at its feet, together with `data-duel` (`guard`, `windup`, `strike`, `recover`, then `win` when the fix lands). This happens in the work states (`thinking`, `typing`, `reading`, `running`, `working`), so let the duel poses win over them. The bug sits ~16 px beyond the edge of the 220 px slot, where Robo's sword comes down when it lunges 30 px on `strike`; with a shorter reach, lunge further. The app draws the bug, the sparks and the confetti |

### Sub-agent helpers

Add `"mini": { "svg": "mini.svg", "css": "mini.css", "tints": 5 }` to `character.json`
to give every sub-agent a small helper. The app draws the mini SVG at 132 px (two thirds
of the main box), walks it around, mirrors it to face the other way and positions it; your
CSS only animates its body. The feet should stand on y = 182 of the 200 × 200 box, centred
at x ≈ 88, like Robo's.

The app wraps each copy in `<div class="buddy-mini">` and sets:

| Attribute | Meaning |
|---|---|
| `data-phase` | `arrive` (drops in), `brief`, `walk`, `work` (laptop open), `chat`, `look` (looks around), `play` (a little show, see `data-play`), `prank` (pokes the main character), `held` (picked up by the user), `land`, `huff` (hit too often, about to stomp off), `done`, `report`, `leave`, `outing` (takes off out of the window to roam the screen: like a flying `leave`), `away` (out roaming: hide it). While it roams, the app draws the same mini SVG and CSS in a little window of its own (152 px, the 132 px box 10 px in) with `data-phase` `walk` / `look` / `play` / `prank` (a poke at the cursor), `data-fly`, `data-travel="walk"`, `data-flip` and `data-tint` |
| `data-play` | during `play`, ~2 s: `spin`, `jump`, `wave` or `dance` |
| `data-phase` (a visitor) | the idle story's visitor is a mini too (class `buddy-guest`, never takes the mouse): `arrive`, `play`, `sit` (sits and chats, with `data-talk` and `data-laugh`), `look`, `spar` with `data-spar` (`guard`, `windup`, `strike`, `block`: a toy sword, `rbm-sword`), `leave` |
| `data-tint` | `0` … `tints - 1`: which colour variant to wear; neighbours always differ |
| `data-fly` | thrusters on (dropping in, flying off, hopping over others, or the whole buddy hovers) |
| `data-hop` | while walking: hopping over the helpers in the way |
| `data-talk` | in a chat, while this one is talking |
| `data-give` | present for ~0.7 s while it hands over a note |
| `data-skill` | `open` while its agent uses a skill |
| `data-boop` | ~0.5 s after a click |
| `data-glee` | ~0.9 s: tapped and it liked it |
| `data-ouch`, `data-annoyed` | hit with the whip / tapped and it did not want it |
| `data-travel` | `walk` or `fly`: the whole buddy is on a trip and the helpers come along (the app mirrors them to face the way); `toss` or `settle` while it is thrown or eases into place after a drop |
| `data-rest` | the main character is resting (or the screen is locked): stop every animation |

Use classes to recolour shapes per tint (Robo's kids use `--rbm-body` and friends, see
`mini.css`). Mark props, shadows and flames `data-nohit`, as for the main character.

### A pet

Add `"pet": { "svg": "cat.svg", "css": "cat.css" }` to give the character a pet (Robo has a
cat). The app draws it at 96 px, feet on y = 182 of the 200 × 200 box, centred at x = 100,
facing right; it walks it in, mirrors it and places it. It never takes the mouse. The app
sets on its wrapper `<div class="buddy-pet">`:

| Attribute | Meaning |
|---|---|
| `data-phase` | `enter` (walks in), `play`, `aside` (walks to its nap spot), `nap`, `cuddle` (walks up close to the character and is petted there, ~6 s; `data-walk` while it walks up), `laser` (chases the dot to its play spot, then pounces at it there, ~6.5 s; draw the dot yourself), `leave` |
| `data-walk` | present while it walks |
| `data-travel` | `walk` / `fly`: the whole buddy is on a trip and the pet comes along |
| `data-rest` | the main character rests or the screen is locked: no animation |

Napping can last long: keep it to a few frames per second and nothing under `data-rest`.

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
- Long-running loops (idle, waiting, typing) can use `steps()`; short moments (a walk, a
  play, a cheer, the duel) look better smooth and only last a few seconds.
- Animations that can last a long time (waiting for approval can take minutes) should
  calm down after a few seconds.
- Prefer `transform` and `opacity`. For busy states, `steps()` timing (a few
  changes per second) costs far less than smooth 60 fps motion.
- Scope every animation to the state that needs it.
- Support `@media (prefers-reduced-motion: reduce)`: keep the poses, drop the motion.

`characters/robot/` is a complete, commented example, and `characters/robot/DESIGN.md`
shows how its look was kept original.
