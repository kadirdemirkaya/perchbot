# Robo: design notes

Robo is **original artwork drawn from scratch for Agent Buddy** and released under the
project's MIT license. It is not based on, traced from or "inspired by" any existing
character, mascot, toy, logo or brand.

## Identity

A small lilac robot with a cream face screen, mint accents and a laptop it carries
everywhere. Friendly and a little earnest: it squints when it is happy, raises one brow
when it is curious and frowns when it waits or something fails.

### Silhouette

- **Head wider at the brow than at the chin** (a soft trapezoid, not a box or a dome).
- **Bell-shaped body** that widens towards the hips.
- **Chunky thruster boots**, so the outline reads as "robot" even at 160 px.

### Signature details

1. **Coiled-spring antenna** with a teardrop "spark" bulb (wobbles after state changes).
2. **Ear dials**: mint knobs with a needle that ticks round while it thinks.
3. **Thruster boots**: mint soles with nozzles. When the robot is placed above the
   ground the nozzles fire small flames and it hovers.
4. Supporting details: a chest status meter (light + three bars), a stitched pocket
   (where it keeps its skill book), an accordion neck, mint cuffs and ball shoulders.

### Palette

| Role | Colour |
|---|---|
| Body | `#8C7BEA` lilac, shade `#7462D6`, highlight `#B3A8F7` |
| Accent | `#4FD6B4` mint |
| Face screen, belly, hands | `#FFF6E8` cream |
| Outline, eyes, brows, mouth | `#2A2650` deep indigo |
| Legs, boots, laptop | `#4A4380`, `#3A3566` |
| Antenna bulb, status light | `#FFD25A` warm yellow |
| Cheeks, worried light | `#FF9DB0` pink |
| Flames | `#FF9A3C`, `#FFD25A`, `#FFF6E8` |

Shading is one flat shade shape per part, clipped to the part (lower right), plus one
highlight stroke (upper left). No gradients, no filters: cheap to render.

### Expressions

| Mood | When | Face |
|---|---|---|
| Neutral | idle, standby | dark oval eyes with a catchlight, small smile |
| Focused | typing, reading, running, working | brows drawn in, eyes towards the laptop |
| Curious | thinking, asking | one brow up, small "o" mouth |
| Worried | waiting for approval, a tool just failed | brows up in the middle, wavy mouth |
| Happy | greeting, done, goodbye, a click | squinting arcs, open grin, brows up |
| Resting | a quiet minute | eyes half closed, brows down, lights dimmed |

### Skill book

A small open book with cream pages and a mint cover. It lives in the stitched pocket and
comes out while a skill is in use; a page turns now and then.

### Fun-mode props

- **Toy sword:** a short wooden blade (light wood with a grain line) with a rounded tip, a
  mint guard and an indigo grip. Deliberately a toy, not a glowing beam: no lightsaber look.
- **Ball:** a small pink ball with a cream stripe, for bouncing.
- **Sparks and hits:** a yellow diamond with a few short dashes, rings and plain strokes.
  No many-rayed starbursts (that shape is close to Anthropic's mark).
- **Annoyed mark** (four little curved veins), **dizzy ring** with three dots going round,
  **music notes**. All small, all `data-nohit`.

## Robo's kids (the sub-agent helpers)

Each sub-agent is drawn as one of Robo's kids (`mini.svg`, `mini.css`), at two thirds of
Robo's size, so the family resemblance is obvious and the two are never confused:

- **Child proportions:** a big round head (still wider at the brow, like its parent), big
  eyes with two catchlights, a small body with a heart-shaped belly light, stubby legs.
- **A short spring antenna with a round bulb** (Robo's bulb is a teardrop).
- **Round ear knobs** instead of dials, little thruster boots, a smaller laptop.
- **Its own colour:** five variants (mint, rose, butter, lavender, pistachio) set by
  `data-tint`, so neighbours never look alike. No blue (Doraemon), no orange or terracotta
  (Anthropic), no saturated "Android" green.

They walk, hop over each other on their thrusters, chat and pass notes, hold their own skill
book, and dangle and kick their legs when the user picks them up.

## Pip, Robo's cat

A small cream cat with **lilac stripes** on its back, tail and forehead, pink inner ears, a
**mint collar with a round yellow tag**. It walks, crouches and pounces at a yellow ball,
then naps curled up like a loaf with little zigzag "z" marks (drawn, not text).

Kept clear of well-known cats: not orange (Garfield; also Anthropic's colour), not a
black-and-white tuxedo (Felix, Sylvester), not white with a bow (Hello Kitty), not blue or
with a bell (Doraemon), not a chubby grey tabby (Pusheen), no grin that floats (Cheshire Cat).

## What it must not look like

The look was chosen to stay clear of well-known robots and brands. When changing it, keep
away from:

- Android's green robot (green body, half-dome head with stub antennas).
- WALL-E (binocular eyes, box body, treads), EVE (white egg body, black visor with glowing
  eyes), Baymax (white rounded body, two dots joined by a line).
- R2-D2 (dome head, barrel body), Bender (grey cylinder head, visor, antenna).
- Cozmo / Vector (forklift, black screen face with glowing rounded-rectangle eyes).
- Doraemon (blue body with a white belly and a pocket): this is why Robo is **not** blue.
- Claude / Anthropic visuals: no terracotta or orange accents, no starburst shapes, no
  brand names. Agent Buddy is unofficial and must not look like an Anthropic product.

## Rig

The SVG keeps the rig documented at the top of `robot.svg` (group names and pivots in
`robot.css`). Animations, hit testing (`data-nohit`) and the app's attributes depend on
it, so restyle shapes freely but keep the groups and their pivots.
