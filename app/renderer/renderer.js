'use strict';

/**
 * Renderer: shows the character, the speech bubble, the hover menu and effects.
 *
 * From the main process:
 *   init       { character, settings, view, layout, menu, flight, crew, paused }
 *   view       { state, cssState, text, mono, mood, skill }   every state change
 *   settings   { quiet, eyeTracking, ambientLife, playMode, sound, soundVolume, strings }
 *   layout     { side, slotLeft, width, height } where the menu column goes
 *   menu-items [{ id, icon, label }]
 *   paused     true while the screen is locked / the system sleeps
 *   released   the main process let go of the mouse (cursor left the window)
 *   flight     { airborne, boost, tilt } hovering above the ground
 *   crew       [{ id, type, tool, file, skill, status }] sub-agents (crew-view.js draws them)
 *   move       { mode: 'walk' | 'fly' | null, face, kind, arrived, look } a trip around the screen
 *   fun        { action: 'duel' } from the right-click menu
 *   chat       { open, strings } the panel opens / closes; { answer, intent } an answer
 *   bug        { id, phase: 'open' | 'fixed' | 'escaped', agent } or null: the bug hunt
 *              (app/bugs.js); agent = the helper that found it, or null
 *
 * To the main process (window.buddy): ready(), capture(bool), drag(phase), menu(id),
 * crewLeft(id), fun(action) (a trip, or the right-click menu), chat(op, intent)
 * (the panel: buttons only, a question or a command goes as its intent).
 *
 * Attributes this page sets on the character wrapper (the character's CSS
 * may use any of them; see characters/README.md):
 *   data-state  data-blink  data-hover  data-greet  data-boop  data-rest
 *   data-mood ("worried")  data-tap ("down" | "up")  data-sway ("a" | "b")
 *   data-fly ("hover" | "boost")  data-land
 *   data-skill ("open" | "stow")  data-brief / data-receive ("left" | "right": where the mini stands)
 *   fun mode: data-play  data-cheer  data-annoyed  data-glee (tapped and liked it)
 *   data-move ("walk" | "fly")  data-face ("left")
 *   data-inspect ("left" | "right")  data-duel (phase, see lib/fun.js)
 *   data-rampage ("charge" | "laser" | "missile" | "smug" | "heal"; see "the rampage")
 *   data-holo (focus mode: intense work, see "focus mode")
 *   data-lens (a look through the magnifier where the cursor rested, see "following the cursor")
 *   data-seated ("down" | "up": sitting with a visitor, see "the idle story")
 *   data-hunt (fights a bug at its feet, with data-duel phases; see "bug hunt")
 *   --look-x / --look-y (-1..1)  --type-line (0..7)  --fly-tilt (-1..1)
 *
 * The character SVG is inlined after removing scripts, event handlers and
 * external references. All text goes through textContent, never innerHTML.
 */

(() => {
  const { CaptureController, HoverMenu, RestTimer, lookVector, createTapRhythm, Replay } = window.BuddyInteraction;
  const { TapMeter, Temper, TEMPER_MAX, Fury, FocusMeter, FOCUS, IdleStory, AmbientScheduler, pickCheer, pickThinkPose, THINK_MS, Duel, BugFight } = window.BuddyFun;

  const root = document.documentElement;
  const stage = document.getElementById('stage');
  const holder = document.getElementById('character');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const trail = document.getElementById('trail');
  const fx = document.getElementById('fx');
  const menuEl = document.getElementById('menu');
  const tooltip = document.getElementById('tooltip');
  const actors = document.getElementById('actors');
  const skillTag = document.getElementById('skill-tag');
  const accountTag = document.getElementById('account-tag');
  const skillName = document.getElementById('skill-name');
  const duelHud = document.getElementById('duel-hud');
  const duelPad = document.getElementById('duel-pad');
  const fxTop = document.getElementById('fx-top');
  const chatEl = document.getElementById('chat');
  const chatTitle = document.getElementById('chat-title');
  const chatList = document.getElementById('chat-list');
  const chatClose = document.getElementById('chat-close');
  const chatCmds = document.getElementById('chat-cmds');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const CONFETTI_COLORS = ['#FFC857', '#FF8FA3', '#7EE0D2', '#8AB6FF', '#B49CFF', '#9BE564'];
  const SLOT_WIDTH = 220;
  const SLOT_HEIGHT = 270;
  const CHAR_LEFT = 10;
  const CHAR_SIZE = 200;
  const CHAR_BOTTOM = 4;
  const DRAG_THRESHOLD = 4;
  const GREET_MS = 1800;
  const BOOP_MS = 460;
  const GLEE_MS = 640;
  const SWAY_MS = 1200;
  const CODE_LINES = 8;
  const TAPS_PER_LINE = 3;
  const BUSY = new Set(['typing', 'reading', 'running', 'working', 'thinking', 'waiting', 'asking']);
  const STOW_MS = 800;
  const BRIEF_MS = 1700;
  const RECEIVE_MS = 1600;

  let character = null;
  let settings = { quiet: false, eyeTracking: true, ambientLife: true, playMode: false };
  let view = { state: 'idle', cssState: 'idle', text: '', mono: false };
  let layout = { side: 'left', slotLeft: 64 };
  let paused = false;
  let loadToken = 0;
  let dev = false;
  /** The chat panel is open; the answer in the bubble (see the chat section). */
  let chatOpen = false;
  let answerText = null;
  let chatHold = false;

  /** Interaction trace, only with `npm run dev` (main forwards it to the console). */
  function trace(message) {
    if (dev) console.log(`[ui] ${message}`);
  }

  /**
   * Developers (npm run dev with AGENT_BUDDY_PERF=1): frame times around every
   * transition, long tasks and long animation frames, as "[perf]" lines in the
   * dev log (lib/perf.js). Not created otherwise.
   */
  let perfTrace = null;
  function perfMark(label) {
    if (perfTrace) perfTrace.mark(label);
  }

  function startPerf() {
    if (perfTrace || !window.BuddyPerf) return;
    perfTrace = new window.BuddyPerf.PerfTrace({
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(cb),
      log: (line) => console.log(`[perf] ${line}`),
    });
    for (const type of ['longtask', 'long-animation-frame']) {
      try {
        new PerformanceObserver((list) => list.getEntries().forEach((e) => perfTrace.longEntry(e))).observe({ type });
      } catch {
        // not supported by this Chromium
      }
    }
    console.log('[perf] trace on');
  }

  // ---------------------------------------------------------------- small helpers

  const timers = new Map();
  /** Named, restartable timeout. */
  function later(name, ms, fn) {
    clearTimeout(timers.get(name));
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        fn();
      }, ms),
    );
  }
  function cancel(name) {
    clearTimeout(timers.get(name));
    timers.delete(name);
  }

  /** Set or clear a data-* attribute, restarting CSS animations if asked. */
  function flag(name, value, restart = false) {
    if (value === null || value === false || value === undefined) {
      delete holder.dataset[name];
      return;
    }
    if (restart) {
      delete holder.dataset[name];
      void holder.offsetWidth; // force a style flush so the animation restarts
    }
    holder.dataset[name] = value === true ? '1' : String(value);
  }

  const motionAllowed = () => !reducedMotion.matches && !paused;

  // ---------------------------------------------------------------- sounds

  /**
   * Little sounds made in code (lib/sound.js), off unless the Sound setting is
   * on. For what the user does and the buddy's own play; work silences them
   * at once. For Claude Code's work only a few short signals (workSfx: done,
   * a failure, a question for the user, focus mode), and only with "Work
   * sounds" on too. Nothing while the screen is locked or the buddy rests.
   *
   * Switched off for now (app/features.js): index.html does not load
   * lib/sound.js, and this silent board stands in (no AudioContext at all).
   */
  const SILENT_BOARD = Object.freeze({
    play: () => false,
    tapPitch: () => 1,
    stopAll() {},
    setEnabled() {},
    setVolume() {},
  });
  const sound = window.BuddySound
    ? new window.BuddySound.SoundBoard({ createContext: () => new AudioContext({ latencyHint: 'interactive' }) })
    : SILENT_BOARD;
  /** The simulator's sound demos play even with the setting off. */
  let soundDemo = false;

  function syncSound() {
    sound.setVolume(settings.soundVolume);
    sound.setEnabled(settings.sound === true || soundDemo);
  }

  function sfx(name, pitch = 1) {
    if (paused || rest.resting || BUSY.has(view.state)) return false;
    return sound.play(name, { pitch });
  }

  /** A work signal (done, a failure, a question, focus mode): with Sound and Work sounds on. */
  function workSfx(name, pitch = 1) {
    if (paused || settings.workSounds === false) return false;
    const played = sound.play(name, { pitch });
    if (played) trace(`sound: ${name} (work)`);
    return played;
  }

  /** Done, a question for the user, a tool that failed, a session that starts. */
  function workSignals(previous, next) {
    if (next.state !== previous.state) {
      if (next.state === 'done') workSfx('done');
      else if (NUDGE_STATES.has(next.state)) workSfx('alert');
      else if (next.state === 'greeting') workSfx('chirp', 1.1);
    }
    if (next.mood === 'worried' && previous.mood !== 'worried' && !NUDGE_STATES.has(next.state)) workSfx('error');
  }

  /**
   * The sounds that go with a play or the cat's routine (BuddySound.CUES).
   * With the sound off this sets no timers at all; each one checks `still()`
   * when it fires, so a play cut short goes quiet. A little random wobble in
   * pitch, so a repeated sound is never quite the same.
   */
  function playCues(key, cues, still) {
    if (sound === SILENT_BOARD) return;
    window.BuddySound.scheduleCues(cues, {
      on: settings.sound === true || soundDemo,
      key: `cue-${key}`,
      later,
      still,
      play: (name, pitch) => trace(`sound: ${name} (${key}) ${sfx(name, pitch * (0.97 + Math.random() * 0.06)) ? 'played' : 'skipped'}`),
    });
  }
  const CUES = window.BuddySound ? window.BuddySound.CUES : { play: {}, cat: {}, rampage: {} };

  // ---------------------------------------------------------------- character loading

  function sanitizeSvg(markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      throw new Error('character SVG could not be parsed');
    }
    svg.querySelectorAll('script, foreignObject, iframe, object, embed, image').forEach((n) => n.remove());
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on') || name === 'style') el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) el.removeAttribute(attr.name);
      }
    }
    return document.importNode(svg, true);
  }

  async function loadCharacter(next) {
    const token = ++loadToken;
    character = next;
    if (!next) {
      holder.replaceChildren();
      return;
    }
    const oldLink = document.getElementById('character-css');
    const link = document.createElement('link');
    link.id = 'character-css';
    link.rel = 'stylesheet';
    link.href = next.cssUrl;

    const response = await fetch(next.svgUrl);
    const svg = sanitizeSvg(await response.text());
    if (token !== loadToken) return;

    if (oldLink) oldLink.replaceWith(link);
    else document.head.appendChild(link);
    holder.replaceChildren(svg);
    scheduleBlink();
    try {
      await crew.setCharacter(next.mini || null);
    } catch (err) {
      console.error(`Agent Buddy: mini artwork: ${err.message}`);
      await crew.setCharacter(null);
    }
    try {
      await pet.setPet(next.pet || null);
    } catch (err) {
      console.error(`Agent Buddy: pet artwork: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- crew view (sub-agents)

  /** The cat's phase (lib/pet.js), null while there is no cat: its sounds check it. */
  let catPhase = null;
  const pet = window.BuddyPetView.createPetView({
    actors,
    sanitizeSvg,
    // The cat plays: the main character joins in (data-pet="play"); it came
    // to be petted (data-pet="cuddle", the idle story); or it chases the laser
    // pointer's dot (data-pet="laser").
    onCue: (name, on) => {
      flag('pet', on && motionAllowed() ? name : null);
      if (name === 'cuddle') onCuddle(on);
      if (name === 'laser') onPetLaser(on);
    },
    // Its sounds: hello on the way in, the ball while it plays, a purr as it dozes off.
    onPhase: (phase) => {
      catPhase = phase;
      if (phase) playCues(`cat-${phase}`, CUES.cat[phase], () => catPhase === phase);
      // Called for the story's petting: it comes over as soon as it has walked in
      // (a moment later: not from inside the cat's own phase change).
      if (phase === 'play' && patPending) {
        patPending = false;
        later('pat-come', PAT_COME_MS, () => {
          // Work came in meanwhile: it stays where it is.
          const ok = ambientOn() && AMBIENT_STATES.has(view.state) && motionAllowed() && pet.cuddle();
          if (!ok && story.playing === 'pat') story.done();
        });
      }
      if (phase === null) patPending = false;
      // It naps a lot: now and then the laser pointer wakes it up to play.
      if (phase === 'nap') later('cat-laser', CAT_LASER_MIN_MS + Math.random() * (CAT_LASER_MAX_MS - CAT_LASER_MIN_MS), tryCatLaser);
      else cancel('cat-laser');
    },
    trace,
  });

  /** Bug hunt (app/bugs.js): the bug beside the buddy (the fight: see "bug hunt" below). */
  const bugView = window.BuddyBugView.createBugView({ actors, trace });

  const crew = window.BuddyCrewView.createCrewView({
    actors,
    sanitizeSvg,
    onCue: (name, data) => onCrewCue(name, data),
    onRelease: (id) => window.buddy.crewLeft(id),
    trace,
  });

  // ---------------------------------------------------------------- view

  function applyView(next) {
    const previous = view;
    view = next;
    // A new state: what the old one was animating eases into the new pose (see blendFrom).
    const parts = holder.dataset.state !== (next.cssState || next.state) ? snapshotAnimated() : null;
    holder.dataset.state = next.cssState || next.state;
    flag('mood', next.mood === 'worried' || next.mood === 'sweat' ? next.mood : null);
    // What it works on: a book, a search, the web (robot.css data-task).
    flag('task', next.task === 'book' || next.task === 'search' || next.task === 'web' ? next.task : null);
    stage.classList.toggle('leaving', next.state === 'goodbye');
    applySkill(next.skill || null);
    // Claude Code needs the character: anything but idle / standby ends a duel at
    // once (the arena goes, the sword is put away by the character's own eased
    // transitions), and work (anything but a calm state) ends ambient life, anger
    // and the cat's play. A line of its own gives way to the work text.
    if (!AMBIENT_STATES.has(next.state) && duel.active) {
      duel.stop();
      dropQuip();
    }
    if (BUSY.has(next.state)) sound.stopAll();
    workSignals(previous, next);
    if (!CALM.has(next.state)) {
      pet.interrupt();
      // Work starts: what the taps were doing gives way to it. Not on every
      // event during work: taps at work have their own reactions (lib/fun.js).
      if (CALM.has(previous.state)) {
        cancel('flee');
        cancel('anger');
        cancel('annoyed');
        cancel('erupt');
        flag('annoyed', null);
        flag('erupt', null);
        meter.reset();
        temper.reset();
        glee.stop();
        dropQuip();
        if (raging) leaveRampage();
      }
    }
    // A chat answer gives way to work news at once (never the other way round).
    if (answerText && next.text && (next.state !== previous.state || next.text !== previous.text)) dropAnswer();
    // Work comes in: the question can wait.
    if (curious && !curious.always && !CALM.has(next.state)) dropCurious();
    renderBubble();

    noteFocus(previous, next);

    // Every event wakes the character; idle starts the rest countdown again.
    rest.setIdle(next.state === 'idle');
    updateThinking();
    if (next.state !== previous.state) updateNudges();

    if (next.state !== previous.state) {
      perfMark(`${previous.state}→${next.state}`);
      swayAntenna();
      if (next.state === 'done') {
        burstConfetti();
        // Fun mode: not always the same celebration.
        flag('cheer', ambientOn() ? pickCheer() : 'jump');
      }
      if (BUSY.has(next.state)) flag('greet', null);
    }
    updateHunt();
    updateTyping();
    updateFun();
    blendFrom(parts);
  }

  // ---------------------------------------------------------------- easing out interrupted animations

  /**
   * A state change removes the old state's CSS animations at once, so whatever
   * they were doing (a hop in mid-air, a forearm waving at a low frame rate, a
   * play cut short by work) would jump straight to the new pose. Before the
   * change, note the transform of every part with a running CSS animation;
   * after it, play a short additive animation that starts exactly there and
   * fades into whatever the new state does (its transition or its own
   * animation). Works for any character; nothing with reduced motion.
   */
  const BLEND_MS = 220;
  const IDENTITY = 'matrix(1, 0, 0, 1, 0, 0)';

  function snapshotAnimated() {
    if (!motionAllowed() || typeof holder.getAnimations !== 'function') return null;
    const parts = new Map();
    for (const anim of holder.getAnimations({ subtree: true })) {
      const el = anim.effect && anim.effect.target;
      // CSS animations only (not transitions, not our own blends).
      if (!el || parts.has(el) || !anim.animationName || anim.playState !== 'running') continue;
      parts.set(el, getComputedStyle(el).transform);
    }
    return parts;
  }

  function blendFrom(parts) {
    if (!parts || !parts.size) return;
    let blended = 0;
    for (const [el, from] of parts) {
      if (!el.isConnected) continue;
      const now = getComputedStyle(el).transform;
      if (now === from) continue;
      let offset;
      try {
        // The part is drawn as now x offset: start at the old pose, end at the new one.
        offset = new DOMMatrix(now === 'none' ? IDENTITY : now).inverse().multiply(new DOMMatrix(from === 'none' ? IDENTITY : from));
      } catch {
        continue;
      }
      const still = Math.abs(offset.a - 1) + Math.abs(offset.b) + Math.abs(offset.c) + Math.abs(offset.d - 1) < 0.004 && Math.abs(offset.e) + Math.abs(offset.f) < 0.3;
      if (still) continue;
      el.animate(
        [
          { transform: offset.toString(), composite: 'add' },
          { transform: IDENTITY, composite: 'add' },
        ],
        { duration: BLEND_MS, easing: 'ease-out' },
      );
      blended += 1;
    }
    if (blended) trace(`blend: ${blended} part(s) eased out`);
  }

  /** A short line of its own (hit, duel) that shows for a moment instead of the state's text. */
  let quipText = null;
  function quip(key, ms = 1300) {
    const text = settings.strings && settings.strings.quips && settings.strings.quips[key];
    if (!text) return;
    quipText = text;
    renderBubble();
    later('quip', ms, () => {
      quipText = null;
      renderBubble();
    });
  }

  function dropQuip() {
    cancel('quip');
    quipText = null;
  }

  function renderBubble() {
    // A chat answer shows even in quiet mode: the user asked for it.
    // A question it asks about a command (hands) shows even in quiet mode: the user just asked.
    const text = answerText || (curious && curious.always ? curious.text : settings.quiet ? '' : curious ? curious.text : quipText || view.text);
    bubble.classList.toggle('answer', Boolean(answerText));
    renderChoices();
    if (!text) {
      bubble.classList.remove('show');
      renderTrail();
      return;
    }
    bubbleText.textContent = text;
    bubble.classList.toggle('mono', Boolean(view.mono) && !quipText && !answerText);
    positionBubble();
    bubble.classList.add('show');
    renderTrail();
  }

  // ---------------------------------------------------------------- recent steps

  /**
   * A row of small chips above the bubble: the last files read or written and
   * the last commands run in this turn (core.steps), while it works and when it
   * is done. The step the bubble shows right now is not repeated.
   */
  const TRAIL_STATES = new Set(['typing', 'reading', 'running', 'working', 'thinking', 'waiting', 'asking', 'done']);
  const TRAIL_MAX = 2;
  const STEP_ICONS = { read: 'i-step-read', write: 'i-step-write', run: 'i-step-run' };
  let trailKey = '';

  function trailSteps() {
    if (settings.quiet || quipText || answerText || !TRAIL_STATES.has(view.state)) return [];
    const steps = (Array.isArray(view.steps) ? view.steps : []).filter((s) => s && STEP_ICONS[s.kind] && typeof s.text === 'string');
    const newest = steps[steps.length - 1];
    const shownNow = newest && view.text && view.text.includes(newest.text) ? 1 : 0;
    return steps.slice(0, steps.length - shownNow).slice(-TRAIL_MAX);
  }

  function renderTrail() {
    const list = trailSteps();
    const key = list.map((s) => `${s.kind}:${s.text}`).join('\n');
    if (key !== trailKey) {
      trailKey = key;
      trace(`trail: ${list.length} step(s)`);
      trail.replaceChildren(
        ...list.map((step, index) => {
          const chip = document.createElement('div');
          chip.className = `trail-chip ${step.kind}${index < list.length - 1 ? ' older' : ''}`;
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('aria-hidden', 'true');
          const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          use.setAttribute('href', `#${STEP_ICONS[step.kind]}`);
          svg.appendChild(use);
          const label = document.createElement('span');
          label.textContent = step.text;
          chip.append(svg, label);
          return chip;
        }),
      );
    }
    trail.classList.toggle('show', list.length > 0);
    if (!list.length) return;
    // Above the bubble (or where it would be), above the skill tag.
    const head = headPoint();
    const lift = skillTag.classList.contains('show') ? skillTag.offsetHeight + 4 : 0;
    let bottom = SLOT_HEIGHT - head.top + 10 + lift;
    if (bubble.classList.contains('show')) bottom += bubble.offsetHeight + 4;
    trail.style.bottom = `${Math.round(bottom)}px`;
  }

  /** The point above the character's head (bubbleAnchor), in slot coordinates. */
  function headPoint() {
    const anchor = (character && character.bubbleAnchor) || { x: 0.5, y: 0.1 };
    return { x: CHAR_LEFT + anchor.x * CHAR_SIZE, top: SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + anchor.y * CHAR_SIZE };
  }

  /** Centre the bubble over the character's anchor point, clamped to the slot. Above the skill tag, if any. */
  function positionBubble() {
    const head = headPoint();
    const width = bubble.offsetWidth;
    const left = Math.max(6, Math.min(SLOT_WIDTH - width - 6, head.x - width / 2));
    const lift = skillTag.classList.contains('show') ? skillTag.offsetHeight + 4 : 0;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.bottom = `${Math.round(SLOT_HEIGHT - head.top + 10 + lift)}px`;
    bubble.style.setProperty('--tail-x', `${Math.round(Math.max(14, Math.min(width - 14, head.x - left)))}px`);
  }

  // ---------------------------------------------------------------- skill book

  /**
   * A skill is in use: the book comes out of the pocket (data-skill="open")
   * and a tag with the skill name sits above the head. When it is put away,
   * data-skill="stow" plays for a moment so the character can tuck it in.
   */
  let skill = null;
  function applySkill(name) {
    if (name === skill) return;
    skill = name;
    if (name) {
      cancel('stow');
      flag('skill', 'open');
      skillName.textContent = name;
      skillTag.classList.add('show');
      const head = headPoint();
      const width = skillTag.offsetWidth;
      skillTag.style.left = `${Math.round(Math.max(4, Math.min(SLOT_WIDTH - width - 4, head.x - width / 2)))}px`;
      skillTag.style.bottom = `${Math.round(SLOT_HEIGHT - head.top + 6)}px`;
      trace(`skill: open (${name.length} chars)`);
    } else {
      skillTag.classList.remove('show');
      flag('skill', 'stow');
      later('stow', STOW_MS, () => flag('skill', null));
      trace('skill: stow');
    }
  }

  function applyLayout(next) {
    if (!next) return;
    perfMark(`layout ${next.width}x${next.height}`);
    layout = next;
    stage.classList.toggle('side-left', next.side === 'left');
    stage.classList.toggle('side-right', next.side !== 'left');
    crew.setLayout(next);
    pet.setLayout(next);
    bugView.setLayout(next);
  }

  // ---------------------------------------------------------------- mouse: hit testing and capture

  const capture = new CaptureController((wanted) => {
    trace(`capture ${wanted ? 'on' : 'off'}`);
    window.buddy.capture(wanted);
  });

  const hover = new HoverMenu({
    onChange: (open) => {
      trace(`menu ${open ? 'open' : 'closed'}`);
      perfMark(open ? 'menu open' : 'menu close');
      menuEl.classList.toggle('open', open);
      crew.setMenuOpen(open);
      if (!open) hideTooltip();
    },
  });

  /**
   * 'character' | 'menu' | 'mini' | 'duel' | 'chat' | 'bubble' | null for the
   * element under the pointer. All of them take the mouse (a mini can be picked
   * up and moved); everything else lets clicks through to the window below.
   */
  function zoneOf(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.closest('.duel-pad')) return 'duel';
    // The open chat panel, and a chat answer in the bubble (a click puts it away).
    if (el.closest('.chat.open .chat-card')) return 'chat';
    if (el.closest('.bubble.answer.show')) return 'bubble';
    if (el.closest('.bubble.ask.show .bubble-choice')) return 'bubble';
    // An open menu's buttons; in a duel only the Play button (it ends the duel).
    if (el.closest('.menu.open .menu-button, .menu.duel .menu-button[data-id="play"]')) return 'menu';
    if (holder.contains(el) && el !== holder && el.closest('svg') && el.tagName.toLowerCase() !== 'svg') {
      return 'character';
    }
    if (actors.contains(el) && el.closest('.buddy-mini svg') && el.tagName.toLowerCase() !== 'svg') return 'mini';
    return null;
  }

  const MOUSE_ZONES = new Set(['character', 'menu', 'mini', 'duel', 'chat', 'bubble']);
  const takesMouse = (z) => MOUSE_ZONES.has(z);

  let lastPointer = null;
  /** Where the cursor was last seen in this window (not reset while it rests): aim for duels. */
  let pointerAt = null;
  let zone = null;
  let lookFrame = 0;
  let lastActivity = 0;

  function onPointerMove(clientX, clientY) {
    lastPointer = { x: clientX, y: clientY };
    pointerAt = lastPointer;
    // Synchronous on purpose: releasing the mouse must not wait for a frame.
    const holding = crew.isPressing();
    const el = drag || holding || moving ? null : document.elementFromPoint(clientX, clientY);
    // On a trip the window moves under the cursor: never take the mouse then.
    const next = drag ? 'character' : holding ? 'mini' : moving ? null : zoneOf(el);
    capture.pointer(takesMouse(next));
    setZone(next);
    if (next === 'mini' && !crew.isHolding()) {
      if (el) showMiniTooltip(el);
    } else if (miniTip) hideTooltip();
    if (next && Date.now() - lastActivity > 1000) {
      lastActivity = Date.now();
      rest.activity();
    }
    if (!lookFrame) lookFrame = requestAnimationFrame(updateLook);
    faceCursor();
    later('look-reset', 1500, resetLook);
  }

  function setZone(next) {
    const enteredCharacter = next === 'character' && zone !== 'character';
    if (next !== zone) {
      const at = lastPointer ? ` at ${Math.round(lastPointer.x)},${Math.round(lastPointer.y)}` : '';
      trace(`pointer zone: ${next || 'none'}${at} (capturing=${capture.capturing})`);
    }
    zone = next;
    // The chat panel takes the menu's place: no hover menu while it is open.
    hover.set(drag || duel.active || chatOpen ? null : next);
    chatAway(next);
    flag('hover', next === 'character' || next === 'menu' ? true : null);
    if (enteredCharacter && !drag && !duel.active) greet();
    updateFun();
  }

  function onPointerLeave(e) {
    trace(`pointer left the page (${e && e.type})`);
    if (drag) return;
    capture.leave();
    setZone(null);
    resetLook();
  }

  document.addEventListener('mousemove', (e) => onPointerMove(e.clientX, e.clientY), { passive: true });
  document.addEventListener('mouseleave', onPointerLeave);
  window.addEventListener('blur', (e) => onPointerLeave(e));

  window.buddy.onReleased(() => {
    capture.released();
    if (drag) endDrag(false);
    if (crew.isPressing()) crew.endDrag();
    setZone(null);
    resetLook();
  });

  // ---------------------------------------------------------------- hover reactions, click, drag

  /** Wave hello when the pointer arrives, unless the character is busy. */
  function greet() {
    rest.activity();
    if (BUSY.has(view.state) || view.state === 'goodbye' || !motionAllowed()) return;
    flag('greet', true, true);
    later('greet', GREET_MS, () => flag('greet', null));
  }

  /**
   * A boop and a happy hop: quick taps queue one more round instead of
   * restarting the animation mid-way (that looked like a stutter).
   */
  const booping = new Replay({ ms: BOOP_MS, onStart: () => flag('boop', true, true), onEnd: () => flag('boop', null) });
  const glee = new Replay({
    ms: GLEE_MS,
    onStart: () => {
      flag('glee', true, true);
      floatHearts();
    },
    onEnd: () => flag('glee', null),
  });

  function boop() {
    rest.activity();
    if (!motionAllowed()) return;
    booping.trigger();
  }

  let drag = null;

  holder.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || zoneOf(e.target) !== 'character') return;
    drag = { x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId, frame: 0 };
    holder.setPointerCapture(e.pointerId);
    capture.startDrag();
  });

  holder.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // No dragging in the middle of a duel: every press is a swing.
    if (!drag.moved && !duel.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_THRESHOLD) {
      drag.moved = true;
      stage.classList.add('dragging');
      hover.closeNow();
      hideTooltip();
      flag('greet', null);
      // Picked off the top edge: it lets go.
      flag('hang', null);
      window.buddy.drag('start');
    }
    if (drag.moved && !drag.frame) {
      drag.frame = requestAnimationFrame(() => {
        if (drag) drag.frame = 0;
        window.buddy.drag('move');
      });
    }
  });

  function endDrag(completed, e) {
    const wasDrag = drag && drag.moved;
    if (drag && drag.frame) cancelAnimationFrame(drag.frame);
    if (drag && holder.hasPointerCapture(drag.pointerId)) holder.releasePointerCapture(drag.pointerId);
    drag = null;
    stage.classList.remove('dragging');
    if (wasDrag) window.buddy.drag(completed ? 'end' : 'cancel');
    else if (completed) onClick(e);
    const under = e ? zoneOf(document.elementFromPoint(e.clientX, e.clientY)) : null;
    capture.endDrag(takesMouse(under));
    setZone(under);
  }

  holder.addEventListener('pointerup', (e) => drag && endDrag(true, e));
  holder.addEventListener('pointercancel', (e) => drag && endDrag(false, e));

  // Minis: press and drag to move one; a click without moving is a boop.
  let miniPointer = null;
  actors.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || zoneOf(e.target) !== 'mini' || !crew.startDrag(e.target, e.clientX, e.clientY)) return;
    rest.activity();
    hideTooltip();
    miniPointer = { id: e.pointerId, el: e.target.closest('.buddy-mini') };
    miniPointer.el.setPointerCapture(e.pointerId);
    capture.startDrag();
  });

  actors.addEventListener('pointermove', (e) => {
    if (miniPointer && e.pointerId === miniPointer.id) crew.dragMove(e.clientX, e.clientY);
  });

  function endMiniDrag(e) {
    if (!miniPointer || e.pointerId !== miniPointer.id) return;
    if (miniPointer.el.hasPointerCapture(e.pointerId)) miniPointer.el.releasePointerCapture(e.pointerId);
    miniPointer = null;
    const clicked = crew.endDrag();
    if (clicked && e.type === 'pointerup') onMiniClick(clicked, e.clientX, e.clientY);
    const under = zoneOf(document.elementFromPoint(e.clientX, e.clientY));
    capture.endDrag(takesMouse(under));
    setZone(under);
  }

  actors.addEventListener('pointerup', endMiniDrag);
  actors.addEventListener('pointercancel', endMiniDrag);

  // ---------------------------------------------------------------- hover menu

  /** The items on screen now (main sends them; labels are localised there). */
  let menuList = [];

  function renderMenu(items) {
    menuList = items || [];
    const buttons = menuList.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-button';
      button.dataset.id = item.id;
      button.style.setProperty('--i', String(index));
      button.setAttribute('aria-label', item.label);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#i-${item.icon}`);
      svg.appendChild(use);
      button.appendChild(svg);
      button.addEventListener('mouseenter', () => showTooltip(button, labelOf(item)));
      button.addEventListener('mouseleave', hideTooltip);
      button.addEventListener('click', () => {
        rest.activity();
        // The same button ends the duel it started (the page owns the duel).
        if (item.id === 'play' && duel.active) {
          trace('duel: stopped from the menu');
          duel.stop();
          return;
        }
        window.buddy.menu(item.id);
      });
      return button;
    });
    menuEl.replaceChildren(...buttons);
    syncMenuDuel();
  }

  const labelOf = (item) => (item.id === 'play' && duel.active && item.activeLabel ? item.activeLabel : item.label);

  /**
   * In a duel the menu keeps only the Play button, in its place and lit up
   * (overlay.css), so the same spot that started the duel ends it.
   */
  function syncMenuDuel() {
    const inDuel = duel.active;
    menuEl.classList.toggle('duel', inDuel);
    const item = menuList.find((i) => i.id === 'play');
    const button = menuEl.querySelector('.menu-button[data-id="play"]');
    if (!item || !button) return;
    button.setAttribute('aria-label', labelOf(item));
    button.setAttribute('aria-pressed', String(inDuel));
    if (inDuel && button.matches(':hover')) showTooltip(button, labelOf(item));
    else if (!inDuel && !hover.open) hideTooltip();
  }

  /** Tooltip next to the button, on the character's side, inside the window. */
  function showTooltip(button, text) {
    tooltip.textContent = text;
    tooltip.classList.add('show');
    const top = menuEl.offsetTop + button.offsetTop + button.offsetHeight / 2 - tooltip.offsetHeight / 2;
    const menuLeft = menuEl.offsetLeft;
    const left =
      layout.side === 'left' ? menuLeft + menuEl.offsetWidth + 2 : menuLeft - tooltip.offsetWidth - 2;
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.left = `${Math.round(Math.max(2, left))}px`;
  }

  function hideTooltip() {
    tooltip.classList.remove('show');
    miniTip = null;
  }

  /** Above a mini's head: "Explore · Read · main.js". */
  let miniTip = null;
  function showMiniTooltip(el) {
    const hit = crew.labelAt(el);
    if (!hit || !hit.text) {
      hideTooltip();
      return;
    }
    if (miniTip === hit.el && tooltip.textContent === hit.text) return;
    miniTip = hit.el;
    tooltip.textContent = hit.text;
    tooltip.classList.add('show');
    const rect = hit.el.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const maxLeft = document.documentElement.clientWidth - width - 2;
    const left = Math.max(2, Math.min(maxLeft, rect.left + rect.width * 0.44 - width / 2));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(2, rect.top - tooltip.offsetHeight + 4))}px`;
  }

  // ---------------------------------------------------------------- eyes

  /** At most once per frame; tiny changes and a resting character cost nothing. */
  const look = { x: 0, y: 0 };
  function updateLook() {
    lookFrame = 0;
    if (rest.resting || paused) return;
    if (!lastPointer || !settings.eyeTracking || reducedMotion.matches || view.state === 'goodbye') {
      resetLook();
      return;
    }
    const rect = holder.getBoundingClientRect();
    const eyes = (character && character.lookAnchor) || { x: 0.5, y: 0.35 };
    const v = lookVector(lastPointer.x - (rect.left + eyes.x * rect.width), lastPointer.y - (rect.top + eyes.y * rect.height));
    setLook(v.x, v.y);
  }

  function setLook(x, y) {
    if (Math.abs(x - look.x) < 0.05 && Math.abs(y - look.y) < 0.05) return;
    look.x = x;
    look.y = y;
    holder.style.setProperty('--look-x', x.toFixed(2));
    holder.style.setProperty('--look-y', y.toFixed(2));
  }

  function resetLook() {
    lastPointer = null;
    look.x = look.y = 1; // force the write below
    setLook(0, 0);
  }

  // ---------------------------------------------------------------- blinking

  function scheduleBlink() {
    cancel('blink');
    if (!character || !character.blink) return;
    later('blink', 2500 + Math.random() * 4500, () => {
      if (!paused && !rest.resting && view.state !== 'goodbye') {
        blinkOnce();
        if (Math.random() < 0.2) later('blink2', 260, blinkOnce); // now and then, a double blink
      }
      scheduleBlink();
    });
  }

  function blinkOnce() {
    flag('blink', true);
    later('blink-end', 140, () => flag('blink', null));
  }

  // ---------------------------------------------------------------- typing rhythm

  const nextTap = createTapRhythm();
  let typingActive = false;
  let taps = 0;
  let line = 0;

  function updateTyping() {
    // Not while it fights a bug: the typing arm would win over the sword arm in the CSS.
    const want = view.state === 'typing' && motionAllowed() && !hunt.active;
    if (want === typingActive) return;
    typingActive = want;
    if (want) {
      // Let the arm reach the keyboard before tapping starts.
      later('tap', 420, tap);
    } else {
      cancel('tap');
      cancel('tap-up');
      flag('tap', null);
    }
  }

  function tap() {
    if (!typingActive) return;
    const step = nextTap();
    if (!step.pause) {
      flag('tap', 'down');
      later('tap-up', 45, () => typingActive && flag('tap', 'up'));
      taps += 1;
      if (taps % TAPS_PER_LINE === 0) advanceLine();
    }
    later('tap', step.delay, tap);
  }

  /**
   * Code scrolls one line per few key presses. The screen content repeats
   * every CODE_LINES lines, so wrapping from the last line to 0 is seamless.
   */
  function advanceLine() {
    line = (line + 1) % CODE_LINES;
    holder.style.setProperty('--type-line', String(line));
  }

  // ---------------------------------------------------------------- rest, sway, confetti

  /**
   * Resting: after a quiet minute it rests (nothing moves, almost no CPU). With
   * ambient life on it is livelier: it stays up for three minutes, and while it
   * rests it gets up by itself every two to four minutes for a while (a walk,
   * a flight, a play), then rests again.
   */
  const REST_MS = 60000;
  const REST_LIVELY_MS = 180000;
  const NAP_MIN_MS = 120000;
  const NAP_MAX_MS = 240000;

  function syncRest() {
    // At the end of the idle story it is sleepy: a nap soon.
    rest.setDelay(sleepy && ambientOn() ? SLEEPY_MS : ambientOn() ? REST_LIVELY_MS : REST_MS);
  }

  const rest = new RestTimer({
    delay: REST_MS,
    onChange: (resting) => {
      trace(resting ? 'resting' : 'awake');
      // Asleep: the next time it gets tired as usual.
      if (resting) sleepy = false;
      if (resting && ambientOn()) {
        later('nap', NAP_MIN_MS + Math.random() * (NAP_MAX_MS - NAP_MIN_MS), () => {
          if (!rest.resting || !ambientOn()) return;
          trace('rested enough: up again');
          rest.activity();
        });
      } else {
        cancel('nap');
      }
      perfMark(resting ? 'rest' : 'wake');
      flag('rest', resting ? true : null);
      crew.setRest(resting || paused);
      pet.setRest(resting || paused);
      bugView.setRest(resting || paused);
      if (!resting) swayAntenna();
      updateHunt();
      updateFun();
    },
  });

  let swayToggle = false;
  function swayAntenna() {
    if (!motionAllowed()) return;
    swayToggle = !swayToggle;
    flag('sway', swayToggle ? 'a' : 'b');
    later('sway', SWAY_MS, () => flag('sway', null));
  }

  /** Confetti from the character's head, or from a point of the page (at = client coordinates). */
  function burstConfetti(count = 18, at = null) {
    if (!motionAllowed() || !character || character.confetti === false) return;
    const anchor = character.bubbleAnchor || { x: 0.5, y: 0.1 };
    let originX = CHAR_LEFT + anchor.x * CHAR_SIZE;
    let originY = SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + (anchor.y + 0.15) * CHAR_SIZE;
    if (at) {
      const box = fx.getBoundingClientRect();
      originX = at.x - box.left;
      originY = at.y - box.top;
    }
    const pieces = [];
    for (let i = 0; i < count; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'confetti';
      piece.style.left = `${originX + (Math.random() - 0.5) * 30}px`;
      piece.style.top = `${originY}px`;
      piece.style.setProperty('--c', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 170}px`);
      piece.style.setProperty('--up', `${-40 - Math.random() * 45}px`);
      piece.style.setProperty('--down', `${70 + Math.random() * 60}px`);
      piece.style.setProperty('--r', `${(Math.random() - 0.5) * 720}deg`);
      piece.style.setProperty('--d', `${Math.random() * 0.15}s`);
      pieces.push(piece);
    }
    fx.replaceChildren(...pieces);
    later('confetti', 1900, () => fx.replaceChildren());
  }

  /**
   * One buddy per account: the account it is for, beside its feet ("claude-work"
   * shows as "work"). Not in quiet mode: an account name can say more than it should
   * while the screen is shared. As text, never as markup.
   */
  function renderAccountTag() {
    const name = typeof settings.account === 'string' ? settings.account : '';
    const show = Boolean(name) && !settings.quiet;
    accountTag.textContent = show ? name.replace(/^claude-(?=.)/, '') : '';
    accountTag.classList.toggle('show', show);
  }

  // ---------------------------------------------------------------- focus mode

  /**
   * Intense work (lib/fun.js FocusMeter: many steps in the last two minutes,
   * edits count double): it means business. data-holo puts on a headband,
   * and in the laptop states a screen of light from its eyes takes the
   * laptop's place. A calm spell of FOCUS.calmMs ends it.
   */
  const FOCUS_STATES = new Set(['typing', 'reading', 'running', 'working']);
  const focus = new FocusMeter();

  function noteFocus(previous, next) {
    if (CALM.has(next.state) || next.state === 'done') {
      if (focus.focused) later('focus-calm', FOCUS.calmMs, endFocus);
      return;
    }
    cancel('focus-calm');
    // A new step: another tool, or the same tool on something else.
    if (!FOCUS_STATES.has(next.state) || (next.state === previous.state && next.text === previous.text)) return;
    const was = focus.focused;
    focus.step(next.state);
    if (focus.focused === was) return;
    trace(`focus: ${focus.focused ? 'on' : 'off'}`);
    if (focus.focused) {
      quip('focusOn', 1400);
      workSfx('holo');
    }
    flag('holo', focus.focused);
  }

  function endFocus() {
    if (!focus.focused) return;
    trace('focus: off (calm)');
    focus.reset();
    flag('holo', null);
  }

  // ---------------------------------------------------------------- thinking poses

  /**
   * While it thinks, the pose changes every few seconds (lib/fun.js
   * pickThinkPose): hand on chin, an idea (a light bulb), or pacing up and down
   * with its hands behind its back (it turns round every PACE_TURN_MS).
   */
  const PACE_TURN_MS = 2400;
  let thinkPose = null;

  function updateThinking() {
    if (view.state !== 'thinking' || !motionAllowed()) {
      stopThinking();
      return;
    }
    if (!thinkPose) nextThinkPose();
  }

  function nextThinkPose() {
    thinkPose = pickThinkPose(thinkPose, { airborne: flight.airborne, hunting: hunt.active || Boolean(moving) });
    trace(`thinking: ${thinkPose}`);
    flag('think', thinkPose === 'chin' ? null : thinkPose);
    turnWhilePacing();
    later('think', THINK_MS, nextThinkPose);
  }

  function turnWhilePacing() {
    cancel('pace');
    if (thinkPose !== 'pace' || moving || hunt.active) {
      if (!moving && !hunt.active && holder.dataset.face) flag('face', null);
      return;
    }
    flag('face', holder.dataset.face === 'left' ? null : 'left');
    later('pace', PACE_TURN_MS, turnWhilePacing);
  }

  function stopThinking() {
    if (thinkPose === null) return;
    const paced = thinkPose === 'pace';
    thinkPose = null;
    cancel('think');
    cancel('pace');
    flag('think', null);
    if (paced && !moving && !hunt.active) flag('face', null);
  }

  // ---------------------------------------------------------------- "What's this?"

  /**
   * Next to the cursor it now and then asks what that is, with three little
   * answers to click (no answer: it lets it go after CURIOUS_MS). Nothing is
   * sent anywhere: the answer only picks its reaction.
   */
  const CURIOUS_CHANCE = 0.35;
  const CURIOUS_MS = 9000;
  const CHOICES = [
    { id: 'code', label: 'choiceCode', reply: 'curiousCode' },
    { id: 'game', label: 'choiceGame', reply: 'curiousGame' },
    { id: 'none', label: 'choiceNone', reply: 'curiousNone' },
  ];
  const choicesEl = document.getElementById('bubble-choices');
  let curious = null;
  let choicesKey = '';

  function quipString(key) {
    return (settings.strings && settings.strings.quips && settings.strings.quips[key]) || '';
  }

  /**
   * The bubble with answers to click: { text, choices: [{ id, label }], pick(id),
   * always } (always: a question about a command, shown in quiet mode too and
   * kept when work comes in).
   */
  function askWhatsThis() {
    if (curious || settings.quiet || !ambientOn() || !CALM.has(view.state) || chatOpen || answerText) return;
    const text = quipString('whatsThis');
    if (!text) return;
    trace('curious: what is this?');
    dropQuip();
    curious = { text, choices: CHOICES.map((c) => ({ id: c.id, label: quipString(c.label) })), pick: pickWhatsThis };
    renderBubble();
    if (motionAllowed()) {
      flag('talk', true, true);
      later('talk', 900, () => flag('talk', null));
    }
    later('curious-end', CURIOUS_MS, () => dropCurious(true));
  }

  function renderChoices() {
    bubble.classList.toggle('ask', Boolean(curious));
    const choices = curious ? curious.choices : [];
    const key = choices.map((c) => `${c.id}:${c.label}`).join('|');
    if (key === choicesKey) return;
    choicesKey = key;
    choicesEl.replaceChildren(
      ...choices.map((c) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bubble-choice';
        button.dataset.choice = c.id;
        button.textContent = c.label;
        return button;
      }),
    );
  }

  function dropCurious(render = false) {
    if (!curious) return;
    curious = null;
    cancel('curious-end');
    if (render) renderBubble();
    else renderChoices();
    const under = pointerAt ? zoneOf(document.elementFromPoint(pointerAt.x, pointerAt.y)) : null;
    capture.pointer(takesMouse(under));
    setZone(under);
  }

  choicesEl.addEventListener('click', (e) => {
    const button = e.target instanceof Element ? e.target.closest('.bubble-choice') : null;
    if (!button || !curious) return;
    const { pick } = curious;
    const id = button.dataset.choice;
    rest.activity();
    dropCurious(true);
    if (pick) pick(id);
  });

  /** "What's this?" answered: its reaction. */
  function pickWhatsThis(id) {
    const choice = CHOICES.find((c) => c.id === id);
    if (!choice) return;
    trace(`curious: ${choice.id}`);
    if (choice.id === 'game' && motionAllowed()) glee.trigger();
    if (choice.id === 'none') {
      const { level } = temper.flare('annoyed');
      flag('annoyed', level, !holder.dataset.annoyed);
      coolDown();
    }
    if (choice.id === 'code' && motionAllowed()) {
      flag('talk', true, true);
      later('talk', 1200, () => flag('talk', null));
    }
    quip(choice.reply, 1800);
  }

  /**
   * A Yes / No about a hands command in the bubble: hands are off ("Turn them
   * on and do it?": Yes turns them on in main and does it), or "Close Chrome?"
   * (a whole window: Yes does it). Nothing happens otherwise.
   */
  const HANDS_ASK_MS = 12000;
  function askHands(ask, kind) {
    // Main sends only its own commands (app/chat.js HAND_INTENTS); the bridge checks them again.
    if (!ask || typeof ask.text !== 'string' || typeof ask.intent !== 'string' || !/^[a-z]{2,12}$/.test(ask.intent)) return;
    dropAnswer();
    dropQuip();
    if (curious) dropCurious();
    trace(`hands: ask ${kind === 'go' ? 'to be sure' : 'to turn on'} (${ask.intent})`);
    curious = {
      text: ask.text,
      always: true,
      choices: [
        { id: 'yes', label: String(ask.yes || 'Yes') },
        { id: 'no', label: String(ask.no || 'No') },
      ],
      pick: (id) => {
        if (kind === 'go') {
          trace(`hands: ${id === 'yes' ? 'go ahead' : 'never mind'} (${ask.intent})`);
          if (id === 'yes') window.buddy.handsGo(ask.intent);
          return;
        }
        trace(`hands: ${id === 'yes' ? 'turned on' : 'left off'}`);
        if (id === 'yes') window.buddy.handsOn(ask.intent);
      },
    };
    renderBubble();
    later('curious-end', HANDS_ASK_MS, () => dropCurious(true));
  }

  // ---------------------------------------------------------------- the user away and back (app/presence.js)

  /** Back at the computer after a while: it wakes up and says hello again. */
  function onPresence(change) {
    if (!change || change.kind !== 'back') return;
    if (!ambientOn() || !CALM.has(view.state)) return;
    rest.activity();
    updateFun();
    if (motionAllowed()) glee.trigger();
    quip(change.awayMs > 3600000 ? 'welcomeBackLong' : 'welcomeBack', 2200);
    trace('presence: welcome back');
  }

  // ---------------------------------------------------------------- moments (app/moments.js)

  /** A commit (a flag), a push (a rocket), a failure streak over (phew), a compaction (squeeze). */
  const MOMENT_MS = { phew: 1700, squeeze: 1900 };
  function onMoment(kind) {
    trace(`moment: ${kind}`);
    if (kind === 'commit') {
      plantFlag();
      if (motionAllowed()) glee.trigger();
      quip('commit', 1600);
    } else if (kind === 'push') {
      launchRocket();
      quip('push', 1800);
    } else if (kind === 'phew' || kind === 'squeeze') {
      if (motionAllowed()) {
        flag('moment', kind, true);
        later('moment', MOMENT_MS[kind], () => flag('moment', null));
      }
      quip(kind, 1500);
    }
  }

  /** The center of the character's feet and the top of its head, in page px. */
  function figurePoint(x, y) {
    return { x: CHAR_LEFT + x * CHAR_SIZE, y: SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + y * CHAR_SIZE };
  }

  /** A commit: a little flag pops up beside it and waves. */
  const FLAG_MS = 2600;
  function plantFlag() {
    if (!motionAllowed() || !character) return;
    const at = figurePoint(0.17, 0.93);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'fx-flag');
    svg.setAttribute('viewBox', '0 0 24 32');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-flag');
    svg.appendChild(use);
    svg.style.left = `${Math.round(at.x)}px`;
    svg.style.top = `${Math.round(at.y)}px`;
    fx.appendChild(svg);
    setTimeout(() => svg.remove(), FLAG_MS + 200);
  }

  /** A push: a little rocket takes off beside it, with a puff of smoke. */
  const ROCKET_MS = 1900;
  function launchRocket() {
    if (!motionAllowed() || !character) return;
    const at = figurePoint(0.8, 0.86);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'fx-rocket');
    svg.setAttribute('viewBox', '0 0 24 36');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-rocket');
    svg.appendChild(use);
    svg.style.left = `${Math.round(at.x)}px`;
    svg.style.top = `${Math.round(at.y)}px`;
    fx.appendChild(svg);
    for (let i = 0; i < 4; i += 1) {
      const puff = document.createElement('i');
      puff.className = 'fx-puff';
      puff.style.left = `${Math.round(at.x + (i - 1.5) * 7)}px`;
      puff.style.top = `${Math.round(at.y + 14)}px`;
      puff.style.setProperty('--d', `${(0.05 + i * 0.07).toFixed(2)}s`);
      fx.appendChild(puff);
      setTimeout(() => puff.remove(), 1400);
    }
    setTimeout(() => svg.remove(), ROCKET_MS + 200);
  }

  // ---------------------------------------------------------------- waiting for the user

  /**
   * Claude Code waits for the user (a permission, a question): after a while a
   * "Psst!" with a hop, later "Knock knock!" on the glass, again every minute.
   */
  const NUDGE_STATES = new Set(['waiting', 'asking']);
  const NUDGE = Object.freeze({ firstMs: 30000, knockMs: 90000, againMs: 60000, showMs: 2400 });
  function updateNudges() {
    cancel('nudge-1');
    cancel('nudge-2');
    cancel('nudge-end');
    flag('nudge', null);
    if (!NUDGE_STATES.has(view.state)) return;
    later('nudge-1', NUDGE.firstMs, () => nudge('psst'));
    later('nudge-2', NUDGE.knockMs, knockAgain);
  }

  function knockAgain() {
    nudge('knock');
    later('nudge-2', NUDGE.againMs, knockAgain);
  }

  function nudge(kind) {
    if (!NUDGE_STATES.has(view.state)) return;
    trace(`nudge: ${kind}`);
    if (motionAllowed()) {
      flag('nudge', kind, true);
      later('nudge-end', NUDGE.showMs, () => flag('nudge', null));
      if (kind === 'knock') knockRings();
    }
    quip(kind === 'knock' ? 'knock' : 'nudge', NUDGE.showMs);
  }

  /** Little rings where its knuckles hit the glass. */
  function knockRings() {
    const at = figurePoint(0.66, 0.5);
    for (let i = 0; i < 3; i += 1) {
      const ring = document.createElement('i');
      ring.className = 'fx-knock';
      ring.style.left = `${Math.round(at.x)}px`;
      ring.style.top = `${Math.round(at.y)}px`;
      ring.style.setProperty('--d', `${(0.25 + i * 0.32).toFixed(2)}s`);
      fx.appendChild(ring);
      setTimeout(() => ring.remove(), 2000);
    }
  }

  /** Tapped and it liked it: two little hearts float up from its head. */
  const HEART_MS = 1100;
  function floatHearts() {
    if (!motionAllowed() || !character) return;
    const anchor = character.bubbleAnchor || { x: 0.5, y: 0.1 };
    const originX = CHAR_LEFT + anchor.x * CHAR_SIZE;
    const originY = SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + (anchor.y + 0.04) * CHAR_SIZE;
    for (let i = 0; i < 2; i += 1) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'fx-heart');
      svg.setAttribute('viewBox', '0 0 24 24');
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', '#i-heart');
      svg.appendChild(use);
      const side = i === 0 ? -1 : 1;
      svg.style.left = `${Math.round(originX + side * (20 + Math.random() * 14))}px`;
      svg.style.top = `${Math.round(originY + Math.random() * 10)}px`;
      svg.style.setProperty('--dx', `${Math.round(side * (6 + Math.random() * 10))}px`);
      svg.style.setProperty('--d', `${i * 0.12}s`);
      fx.appendChild(svg);
      setTimeout(() => svg.remove(), HEART_MS + 200);
    }
    while (fx.querySelectorAll('.fx-heart').length > 6) fx.querySelector('.fx-heart').remove();
  }

  // ---------------------------------------------------------------- hovering

  /**
   * The main process decides whether the character is in the air (placed
   * above the ground, hover mode "auto"). This page only turns that into
   * attributes: data-fly ("hover" | "boost" while dragged), --fly-tilt, and
   * data-land for a short touchdown when it comes back to the ground.
   */
  const LAND_MS = 900;
  let flight = { airborne: false, boost: false, tilt: 0 };

  function applyFlight(next) {
    if (!next) return;
    const wasAirborne = flight.airborne;
    flight = { airborne: next.airborne === true, boost: next.boost === true, tilt: Number(next.tilt) || 0 };
    if (flight.airborne !== wasAirborne) trace(`flight: ${flight.airborne ? 'hover' : 'ground'}`);
    flag('fly', flight.airborne ? (flight.boost ? 'boost' : 'hover') : null);
    crew.setHover(flight.airborne);
    holder.style.setProperty('--fly-tilt', Math.max(-1, Math.min(1, flight.tilt)).toFixed(2));
    if (flight.airborne) {
      cancel('land');
      flag('land', null);
    } else if (wasAirborne && motionAllowed()) {
      flag('land', true, true);
      later('land', LAND_MS, () => flag('land', null));
    }
  }

  // ---------------------------------------------------------------- pause (screen locked)

  function setPaused(value) {
    paused = Boolean(value);
    if (paused) root.dataset.paused = '1';
    else delete root.dataset.paused;
    crew.setRest(paused || rest.resting);
    pet.setRest(paused || rest.resting);
    bugView.setRest(paused || rest.resting);
    if (paused) {
      if (duel.active) duel.stop();
      hover.closeNow();
      closeChat('paused');
      sound.stopAll();
      setZone(null);
      capture.released();
      rest.stop();
    } else {
      // Unlocking the screen does not wake it: only an event or the pointer does.
      rest.resume();
      scheduleBlink();
    }
    updateHunt();
    updateTyping();
    updateFun();
  }

  // ---------------------------------------------------------------- crew (sub-agents)

  /**
   * Cues from the crew for the main character: it explains the task to a new
   * mini ("brief") and takes the note of one that reports back ("receive").
   */
  function onCrewCue(name, data = {}) {
    // Roaming is bookkeeping with main: never skipped (a recall must always reach it).
    if (name === 'outing' || name === 'recall') {
      onRoamCue(name, data);
      return;
    }
    if (!motionAllowed()) return;
    const towards = layout.side === 'right' ? 'right' : 'left';
    // A mini came over for a word: the main character talks back like in a briefing.
    if (name === 'brief' || name === 'talk') {
      flag('brief', towards, true);
      later('brief', BRIEF_MS, () => flag('brief', null));
    } else if (name === 'receive') {
      flag('receive', towards, true);
      later('receive', RECEIVE_MS, () => flag('receive', null));
    } else if (name === 'poke') {
      // A naughty kid poked it: a little jolt (a "Hey!" too when it is not working,
      // and with ambient life it gets a little cross: the kids heat it up too).
      boop();
      sfx('bonk', 1.3);
      if (CALM.has(view.state) && !quipText) quip('hey', 900);
      if (CALM.has(view.state) && ambientOn() && !duel.active) {
        const { level } = temper.flare('annoyed');
        flag('annoyed', level, !holder.dataset.annoyed);
        coolDown();
      }
    }
  }

  /**
   * A helper flew out of the window to roam the screen ('outing': main gives it
   * a little window of its own, app/outings.js), or it is called back ('recall').
   */
  function onRoamCue(name, data) {
    if (!data || typeof data.id !== 'string') return;
    if (name === 'outing') {
      trace(`crew: ${data.id.slice(0, 4)} out roaming`);
      window.buddy.outing({ id: data.id, tint: data.tint, off: data.off, x: data.x, y: data.y });
    } else {
      window.buddy.outingEnd(data.id);
    }
  }

  // ---------------------------------------------------------------- ambient life, play mode

  /** Ambient life: off with the setting, reduced motion or a locked screen. */
  const ambientOn = () => settings.ambientLife !== false && motionAllowed();
  /** Play mode: the duel and the whip. */
  const playOn = () => Boolean(settings.playMode) && motionAllowed();
  /** States that are not work: ambient life may run, nothing gets interrupted. */
  const CALM = new Set(['idle', 'standby', 'greeting']);
  const AMBIENT_STATES = new Set(['idle', 'standby']);
  /** A duel may start in these (it goes on into idle / standby). */
  const DUEL_STATES = new Set(['idle', 'standby', 'greeting', 'done']);
  const INSPECT_MS = 3800;
  let moving = null;
  let crewCount = 0;
  /** The helpers as the main process last sent them ({ id, status, ... }). */
  let crewList = [];

  const meter = new TapMeter();
  /** Anger that builds up over unwelcome taps and outlasts a flight (lib/fun.js). */
  const temper = new Temper();
  /** Its head on fire twice in five minutes: a rampage (see "the rampage"). */
  const fury = new Fury();
  /** The rampage's phase while it lasts ('charge', 'laser', 'missile', 'chase', 'smug', 'heal'; 'away': work came in). */
  let raging = null;
  const ambient = new AmbientScheduler({
    onPlay: (name) => {
      if (name) trace(`ambient: ${name}`);
      perfMark(name ? `ambient ${name}` : 'ambient end');
      if (!name && storyPlay) {
        storyPlay = null;
        story.done();
      }
      // Cut short (work came in): ease out of it instead of jumping back.
      const parts = name ? null : snapshotAnimated();
      flag('play', name);
      blendFrom(parts);
      if (name) playCues(`play-${name}`, CUES.play[name], () => holder.dataset.play === name);
      // "Achoo!" right when it sneezes (not if the play was cut short before).
      if (name === 'sneeze') later('sneeze', SNEEZE_AT_MS, () => holder.dataset.play === 'sneeze' && quip('sneeze', 1000));
      // "Gotcha!" when the paper plane is back in its hand.
      if (name === 'plane') later('plane-catch', PLANE_CATCH_MS, () => holder.dataset.play === 'plane' && quip('gotYou', 1200));
    },
    onTrip: (kind) => {
      trace(`ambient: trip ${kind}`);
      window.buddy.fun(kind);
    },
  });
  const duel = new Duel({ onPhase: onDuelPhase });

  /** robot.css rb-sneeze-head: the "choo" at ~50 % of 2.6 s. */
  const SNEEZE_AT_MS = 1300;
  /** The paper plane is back in its hand (robot.css rb-plane-fly: 86 % of 5.6 s). */
  const PLANE_CATCH_MS = 4850;

  /**
   * Ambient life runs in short bursts, only while nothing else goes on: idle
   * (or standby), awake (not resting), no pointer on the character, no drag,
   * no duel, not already on a trip. Trips only without helpers or the cat.
   */
  function updateFun() {
    syncRest();
    // Helpers may roam the screen: ambient life on (with motion), awake, not paused.
    crew.setRoam(ambientOn() && !rest.resting);
    const calm =
      ambientOn() && !duel.active && !hunt.active && !moving && !drag && !crew.isPressing() && zone === null && !rest.resting && !chatOpen && !raging && !guest && !cuddling && !guestPending && !lasering;
    // The idle story runs while it is idle with ambient life on; anything else ends it.
    if (ambientOn() && AMBIENT_STATES.has(view.state)) story.start();
    else if (story.running || story.finished) story.stop();
    if (guest && (!ambientOn() || !AMBIENT_STATES.has(view.state) || moving || drag || crewCount > 0 || raging || duel.active || hunt.active || paused)) {
      endGuest('interrupted');
    }
    ambient.update({
      // (Not while its forearm is off: the rocket fist, hands.)
      enabled: calm && !fisting && AMBIENT_STATES.has(view.state),
      // "Stay here": plays on the spot only.
      trips: crewCount === 0 && !pet.here && !settings.stayPut,
      // Sitting needs the ground; hanging from the top edge, the next thing is a trip away.
      grounded: !flight.airborne,
      hanging: Boolean(holder.dataset.hang),
    });
  }

  /**
   * A click on the character: with the whip a lash (crack + wince), otherwise
   * a tap, and how it takes a streak of taps is up to its mood (TapMeter in
   * lib/fun.js): idle it mostly loves it (a happy hop, hearts, a giggle), at
   * work it mostly does not (cross, "Working, later!", and at the third tap
   * it leaves for a random spot somewhere else on the screen).
   */
  function onClick(e, demo = null) {
    rest.activity();
    // On a rampage it has no time for taps.
    if (raging) return;
    const whip = playOn() && weapon === 'whip';
    if (whip && e) {
      effect('crack', e.clientX, e.clientY);
      flag('ouch', true, true);
      later('ouch', OUCH_MS, () => flag('ouch', null));
      armWhip();
    }
    const busy = BUSY.has(view.state);
    const tapper = demo ? demo.meter : meter;
    let verdict = ambientOn() ? tapper.tap(demo ? demo.busy : busy, temper.hot) : 'boop';
    // Nobody enjoys the whip.
    if (whip && verdict === 'happy') verdict = 'boop';
    trace(`tap: ${verdict}${busy ? ' (busy)' : ''}`);
    // A bonk that climbs with quick taps (a crack with the whip); "hmph" when it leaves.
    const pitch = sound.tapPitch();
    if (whip && e) sfx('crack');
    else if (verdict === 'flee') sfx('grumble');
    else sfx('bonk', pitch);
    if (verdict === 'boop') {
      if (whip) quip('ouch', 900);
      else boop();
      return;
    }
    booping.stop();
    if (verdict === 'happy') {
      cancel('annoyed');
      flag('annoyed', null);
      temper.reset();
      if (motionAllowed()) glee.trigger();
      quip('giggle', 900);
      return;
    }
    glee.stop();
    // Every unwelcome tap heats it up (Temper): cross, fuming, blazing. data-annoyed
    // carries the level; already cross, a hotter level only changes the look (no
    // restart, a restart looks like a stutter). It cools down by itself.
    const before = temper.level;
    const { level, erupt } = temper.flare(verdict);
    flag('annoyed', level, !holder.dataset.annoyed);
    coolDown();
    // Its head catches fire for the second time in five minutes (or it is kept
    // burning with more taps, lib/fun.js Fury.stoke): no flight this time.
    if (level >= TEMPER_MAX && before < TEMPER_MAX && fury.blaze() && goRampage()) return;
    if (level >= TEMPER_MAX && before >= TEMPER_MAX && fury.stoke() && goRampage()) return;
    if (verdict === 'flee') {
      trace(erupt ? 'hit too often while blazing: erupting' : 'hit too often: leaving');
      if (erupt) {
        flag('erupt', true, true);
        later('erupt', ERUPT_MS, () => flag('erupt', null));
        burstEmbers();
      }
      quip(erupt ? 'erupt' : 'enough', 1800);
      // ("Stay here": it stays where it is, cross.)
      if (!settings.stayPut) later('flee', erupt ? ERUPT_MS : 450, () => window.buddy.fun('flee'));
    } else {
      trace(`temper: ${level}`);
      quip(tapper.fedUp ? 'fedUp' : TEMPER_QUIPS[level] || (busy ? 'busy' : 'hey'), 1100);
    }
  }

  /** What it says when a tap makes it this angry (level 1: "Hey!" / "Working, later!"). */
  const TEMPER_QUIPS = { 2: 'fuming', 3: 'blazing' };
  /** It erupts (leaves while blazing): the burst of flames before it flies off. */
  const ERUPT_MS = 700;

  /** The anger mark follows the temper as it cools, one level at a time. */
  function coolDown() {
    const level = temper.level;
    if (level <= 0) {
      cancel('annoyed');
      flag('annoyed', null);
      return;
    }
    flag('annoyed', level);
    later('annoyed', temper.coolsInMs(), coolDown);
  }

  /** It erupts: sparks fly up from its burning head. */
  const EMBER_MS = 1000;
  function burstEmbers() {
    if (!motionAllowed() || !character) return;
    const anchor = character.bubbleAnchor || { x: 0.5, y: 0.1 };
    const originX = CHAR_LEFT + anchor.x * CHAR_SIZE;
    const originY = SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + (anchor.y + 0.08) * CHAR_SIZE;
    for (let i = 0; i < 8; i += 1) {
      const ember = document.createElement('i');
      ember.className = 'fx-ember';
      ember.style.left = `${Math.round(originX + (Math.random() - 0.5) * 36)}px`;
      ember.style.top = `${Math.round(originY + Math.random() * 8)}px`;
      ember.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 70)}px`);
      ember.style.setProperty('--up', `${Math.round(-40 - Math.random() * 40)}px`);
      ember.style.setProperty('--d', `${(Math.random() * 0.2).toFixed(2)}s`);
      fx.appendChild(ember);
      setTimeout(() => ember.remove(), EMBER_MS + 300);
    }
    while (fx.querySelectorAll('.fx-ember').length > 16) fx.querySelector('.fx-ember').remove();
  }

  // ---------------------------------------------------------------- the rampage (app/rampage.js)

  /**
   * Its head caught fire twice within five minutes (Fury): instead of flying
   * off it stays, its eyes glow, beams from its eyes burn a line into the
   * screen and missiles fly out of a hatch in its chest. The main process
   * draws that in a click-through window over the screen and sends the
   * phases; then for five seconds it goes after the cursor ('chase': beams and
   * missiles at it); the marks fade 5-10 s after the last blast and it calms down, a little
   * sheepish. Taps wait until it is over.
   */
  const RAMPAGE_GUARD_MS = 30000;

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** Starts it, if it can be shown now. True when it started. */
  function goRampage() {
    if (raging || !motionAllowed() || !character || moving || drag || duel.active || hunt.active || chatOpen) return false;
    // The character marks its eyes (data-eye) and where the missiles come out (data-launch).
    const eyes = [...holder.querySelectorAll('[data-eye]')].slice(0, 2).map(centerOf);
    const hatch = holder.querySelector('[data-launch]');
    if (!eyes.length || !hatch) return false;
    trace('rampage: its head caught fire twice in five minutes');
    cancel('rampage-sheepish');
    raging = 'charge';
    // The flames stay on for the whole show.
    cancel('annoyed');
    cancel('flee');
    flag('annoyed', TEMPER_MAX);
    flag('rampage', 'charge', true);
    playCues('rampage-charge', CUES.rampage.charge, () => raging === 'charge');
    dropCurious(true);
    quip('rampage', 2600);
    window.buddy.rampage({ eyes, hatch: centerOf(hatch), face: holder.dataset.face === 'left' ? 'left' : 'right' });
    // The main process never answered (refused, or gone): back to normal.
    later('rampage-guard', RAMPAGE_GUARD_MS, () => endRampage());
    updateFun();
    return true;
  }

  function onRampage(msg) {
    const phase = msg && typeof msg.phase === 'string' ? msg.phase : null;
    if (!raging) return;
    if (phase === null) {
      endRampage();
      return;
    }
    if (raging === 'away') return;
    trace(`rampage: ${phase}`);
    raging = phase;
    flag('rampage', phase);
    if (CUES.rampage[phase]) playCues(`rampage-${phase}`, CUES.rampage[phase], () => raging === phase);
    // All fired: it has blown off steam, the flames go out (and stop costing frames).
    if (phase === 'smug') flag('annoyed', null);
    if (phase === 'heal') {
      // The marks fade: it calms down, a little sheepish.
      flag('annoyed', null);
      temper.reset();
      quip('rampageFix', 2400);
    }
  }

  /** Work came in: the poses give way at once; the marks fade on their own. */
  function leaveRampage() {
    raging = 'away';
    flag('rampage', null);
  }

  /** It stays sheepish a moment longer than the marks take to fade. */
  const SHEEPISH_MS = 1800;

  function endRampage() {
    if (!raging) return;
    trace('rampage: over');
    const sheepish = raging === 'heal';
    raging = null;
    cancel('rampage-guard');
    if (sheepish && motionAllowed()) later('rampage-sheepish', SHEEPISH_MS, () => !raging && flag('rampage', null));
    else flag('rampage', null);
    temper.reset();
    fury.reset();
    coolDown();
    updateFun();
  }

  /** The same for a helper: a hop or a happy hop, cross, then it stomps off to another spot. */
  const miniMeters = new Map();
  function onMiniClick(id, x, y) {
    rest.activity();
    const whip = playOn() && weapon === 'whip';
    if (whip) {
      effect('crack', x, y);
      crew.react(id, 'ouch');
      armWhip();
    }
    if (whip) sfx('crack');
    else sfx('bonk', sound.tapPitch() * 1.45);
    if (!ambientOn()) {
      crew.react(id, 'boop');
      return;
    }
    if (!miniMeters.has(id)) miniMeters.set(id, new TapMeter());
    if (miniMeters.size > 16) miniMeters.delete(miniMeters.keys().next().value);
    const verdict = miniMeters.get(id).tap(BUSY.has(view.state));
    if (verdict === 'boop' || (whip && verdict === 'happy')) {
      if (!whip) crew.react(id, 'boop');
    } else if (verdict === 'happy') {
      crew.react(id, 'glee');
    } else if (verdict === 'annoyed') {
      crew.react(id, 'annoyed');
    } else {
      crew.react(id, 'shoo');
      sfx('grumble', 1.4);
    }
  }

  // ---------------------------------------------------------------- weapons and hits

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** What it says during a duel ('win' = the robot won). */
  const DUEL_QUIPS = {
    draw: 'enGarde',
    hit: 'gotYou',
    stun: 'parried',
    hurt: 'hurt',
    block: 'blocked',
    win: 'robotWins',
    lose: 'youWin',
  };
  const OUCH_MS = 450;
  /** The whip goes back after this long without a lash. */
  const WHIP_IDLE_MS = 45000;
  let weapon = 'hand';

  function setWeapon(next) {
    weapon = next === 'whip' ? 'whip' : 'hand';
    if (weapon === 'whip') root.dataset.weapon = 'whip';
    else delete root.dataset.weapon;
    trace(`weapon: ${weapon}`);
    if (weapon === 'whip') armWhip();
    else cancel('whip');
  }

  function armWhip() {
    later('whip', WHIP_IDLE_MS, () => {
      setWeapon('hand');
      window.buddy.fun('whip-off');
    });
  }

  /** Little drawings at a point of the page, each gone after half a second. */
  const FX = {
    // a lash of the whip, cracking at the tip
    crack: [
      ['path', { d: 'M4 40C16 36 20 22 32 14', stroke: '#FFFFFF', 'stroke-width': 5 }],
      ['path', { d: 'M4 40C16 36 20 22 32 14', stroke: '#7462D6', 'stroke-width': 2.6 }],
      ['path', { d: 'M35 10l6-5M37 14h7M35 18l5 5', stroke: '#2A2650', 'stroke-width': 2.4 }],
    ],
    // swords clash
    spark: [
      ['path', { d: 'M24 13l7 11-7 11-7-11z', fill: '#FFD25A', stroke: '#2A2650', 'stroke-width': 2 }],
      ['path', { d: 'M24 4v4M24 40v4M8 18l4 2M40 18l-4 2M10 33l4-2M38 33l-4-2', stroke: '#2A2650', 'stroke-width': 2.4 }],
    ],
    // the robot's sword got you
    slash: [
      ['path', { d: 'M6 40Q24 28 42 8', stroke: '#2A2650', 'stroke-width': 8 }],
      ['path', { d: 'M6 40Q24 28 42 8', stroke: '#FFFFFF', 'stroke-width': 4.5 }],
    ],
    // you got the robot
    impact: [
      ['circle', { cx: 24, cy: 24, r: 14, stroke: '#FF7D9B', 'stroke-width': 3.5 }],
      ['circle', { cx: 24, cy: 24, r: 5, fill: '#FFD25A', stroke: '#2A2650', 'stroke-width': 2 }],
    ],
    // a swing that hit nothing
    swoosh: [['path', { d: 'M8 34Q22 12 42 18', stroke: '#FFFFFF', 'stroke-width': 3, opacity: 0.8 }]],
  };

  function effect(kind, x, y) {
    if (!motionAllowed() || !FX[kind]) return;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `fx-hit ${kind}`);
    svg.setAttribute('viewBox', '0 0 48 48');
    for (const [tag, attrs] of FX[kind]) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value));
      svg.appendChild(shape);
    }
    svg.style.left = `${Math.round(x)}px`;
    svg.style.top = `${Math.round(y)}px`;
    fxTop.appendChild(svg);
    setTimeout(() => svg.remove(), 600);
    while (fxTop.childElementCount > 12) fxTop.firstElementChild.remove();
  }

  function shake() {
    if (!motionAllowed()) return;
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
    later('shake', 400, () => stage.classList.remove('shake'));
  }

  // ---------------------------------------------------------------- the duel arena

  // Every click in the window is a swing of your sword: near the robot it counts.
  duelPad.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !duel.active) return;
    e.preventDefault();
    swing(e.clientX, e.clientY);
  });

  duelPad.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (duel.active) duel.stop();
  });

  function swing(x, y) {
    rest.activity();
    const r = holder.getBoundingClientRect();
    const near = x > r.left - 24 && x < r.right + 24 && y > r.top && y < r.bottom + 8;
    const result = near ? duel.click() : 'miss';
    if (result === 'hit') effect('impact', x, y);
    else if (result === 'parry' || result === 'blocked') effect('spark', x, y);
    else effect('swoosh', x, y);
    if (result === 'parry' || result === 'blocked') sfx('clang');
    else if (result === 'hit') sfx('clang', 0.82);
    trace(`duel swing: ${result}`);
  }

  // Right-click on the character: the fun menu (duel, walk, fly, home). In a duel: give up.
  holder.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (zoneOf(e.target) !== 'character') return;
    if (duel.active) duel.stop();
    else window.buddy.fun('context');
  });

  function startDuel() {
    if (!motionAllowed() || duel.active) return;
    // Not in the middle of work: the next event would end it at once.
    if (!DUEL_STATES.has(view.state)) {
      quip('busy', 1400);
      return;
    }
    hover.closeNow();
    closeChat('duel');
    flag('play', null);
    flag('greet', null);
    flag('cheer', null);
    trace('duel: start');
    root.dataset.duel = '1';
    duel.start();
    syncMenuDuel();
    updateFun();
  }

  function onDuelPhase(phase, info) {
    trace(`duel: ${phase}`);
    rest.activity();
    if (phase === 'end') {
      const parts = snapshotAnimated();
      flag('duel', null);
      flag('face', null);
      blendFrom(parts);
      delete root.dataset.duel;
      duelHud.classList.remove('show');
      syncMenuDuel();
      // The arena is gone: let clicks through again right away, not only after the next move.
      const under = pointerAt ? zoneOf(document.elementFromPoint(pointerAt.x, pointerAt.y)) : null;
      capture.pointer(takesMouse(under));
      setZone(under);
      updateFun();
      return;
    }
    flag('duel', phase, phase === 'hurt' || phase === 'block');
    renderHud(info);
    const line = DUEL_QUIPS[phase];
    if (line) quip(line, phase === 'win' || phase === 'lose' ? 2400 : 900);
    // Its slash landed: a cut across your cursor, and the scene shakes.
    if (phase === 'hit') {
      sfx('clang', 1.12);
      const r = holder.getBoundingClientRect();
      const at = pointerAt || { x: r.left + r.width * 0.85, y: r.top + r.height * 0.5 };
      effect('slash', at.x, at.y);
      shake();
    }
  }

  /** "Robo ♥♥♥   You ♥♥♥" above the character. */
  function renderHud(info) {
    const side = (cls, label, left) => {
      const el = document.createElement('div');
      el.className = `duel-side ${cls}`;
      const name = document.createElement('span');
      name.textContent = label;
      el.appendChild(name);
      for (let i = 0; i < info.hearts; i += 1) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        if (i < left) svg.setAttribute('class', 'full');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#i-heart');
        svg.appendChild(use);
        el.appendChild(svg);
      }
      return el;
    };
    const you = (settings.strings && settings.strings.you) || 'You';
    duelHud.replaceChildren(side('robot', (character && character.name) || 'Robo', info.robot), side('player', you, info.player));
    duelHud.classList.add('show');
  }

  /** In a duel the character turns to face the cursor. */
  function faceCursor() {
    if (!duel.active || !pointerAt) return;
    const rect = holder.getBoundingClientRect();
    flag('face', pointerAt.x < rect.left + rect.width * 0.49 ? 'left' : null);
  }

  // ---------------------------------------------------------------- bug hunt

  /**
   * Bug hunt (app/bugs.js): a failing check brings a little bug beside the
   * buddy (bug-view.js). While Claude Code works on it, the robot fights it
   * with the duel's sword poses, set here as data-duel plus data-hunt (no
   * Duel, no hearts, no arena; the bug sits where the sword comes down):
   * guard -> windup -> strike (it lunges; a hit sparks and the bug flinches, or
   * the bug hops out of the way) -> recover ... (BugFight in lib/fun.js).
   * When the same check passes, one last strike squashes it and the robot
   * cheers: "Bug fixed!" and a little confetti. It fights only in the work
   * states (the bubble and the chips still say what it does), or while idle
   * when helpers are still at work (background agents): never in waiting /
   * asking (the prompt matters more), never resting, on a trip, in a duel or
   * without motion. Otherwise the bug just sits there, and a fix squashes it
   * at once. A helper's failing check brings a bug too: that helper jumps,
   * and at the win every helper on screen cheers.
   */
  const HUNT_STATES = new Set(['typing', 'reading', 'running', 'working', 'thinking']);
  /** "Bug fixed!" would cover something more important here. */
  const NO_BUG_QUIP = new Set(['waiting', 'asking', 'goodbye']);
  const BUG_QUIP_MS = 1800;
  /** The spark shows when the slash arrives (robot.css: the lunge takes 0.12 s). */
  const STRIKE_LANDS_MS = 110;
  let bugNow = null;
  const hunt = new BugFight({ onPhase: onHuntPhase, onStrike: onHuntStrike });

  /** Helpers still at work (the main session may be idle while background agents run). */
  const helpersAtWork = () => crewList.some((a) => a && a.status === 'active');
  const huntAllowed = () =>
    motionAllowed() &&
    !rest.resting &&
    !moving &&
    !duel.active &&
    (HUNT_STATES.has(view.state) || (AMBIENT_STATES.has(view.state) && helpersAtWork()));

  /** From the main process (and init). */
  function applyBug(next) {
    const fresh = Boolean(next && typeof next === 'object' && (!bugNow || bugNow.id !== next.id));
    bugNow = next && typeof next === 'object' ? next : null;
    bugView.setBug(bugNow);
    // The helper whose check failed jumps (if it is on screen).
    if (fresh && bugNow.phase === 'open' && typeof bugNow.agent === 'string' && motionAllowed()) crew.react(bugNow.agent, 'boop');
    if (bugNow && bugNow.phase === 'fixed') bugFixed();
    else updateHunt();
  }

  /** Start or stop the fight as the state, rest, trips and motion change. */
  function updateHunt() {
    const want = Boolean(bugNow && bugNow.phase === 'open' && bugView.here) && huntAllowed();
    if (want && !hunt.active) {
      trace('bug hunt: fight');
      hunt.start();
      return;
    }
    if (want || !hunt.active) return;
    // The finishing blow plays out, unless the prompt needs the character or it is off on a trip.
    if (hunt.finishing && bugNow && motionAllowed() && !moving && !NO_BUG_QUIP.has(view.state)) return;
    hunt.stop();
  }

  /** The fix landed: the finishing blow, or (no fight possible) squashed at once. */
  function bugFixed() {
    if (!bugView.here) return;
    if (hunt.active || huntAllowed()) {
      trace('bug hunt: finishing blow');
      hunt.finish();
      return;
    }
    bugView.squash();
    if (!NO_BUG_QUIP.has(view.state)) quip('bugFixed', BUG_QUIP_MS);
  }

  function onHuntPhase(phase) {
    trace(`bug hunt: ${phase}`);
    if (phase === 'end') {
      cancel('hunt-strike');
      const parts = snapshotAnimated();
      flag('duel', null);
      flag('hunt', null);
      flag('face', null);
      blendFrom(parts);
      bugView.setFight(false);
      // Stopped before the finishing blow landed: the bug still goes.
      if (bugNow && bugNow.phase === 'fixed' && bugView.here) bugView.squash();
      updateTyping();
      return;
    }
    if (!holder.dataset.duel) {
      // The first pose: turn towards the bug, put the typing arm away.
      flag('face', layout.side === 'right' ? null : 'left');
      flag('hunt', true);
      bugView.setFight(true);
      updateTyping();
    }
    flag('duel', phase);
    if (phase === 'win') {
      if (!NO_BUG_QUIP.has(view.state)) quip('bugFixed', BUG_QUIP_MS);
      burstConfetti(10, bugView.point());
      // The helpers cheer along.
      for (const a of crewList) if (a && typeof a.id === 'string') crew.react(a.id, 'glee');
    }
  }

  function onHuntStrike(final, hit) {
    // A miss: the bug sees it coming and hops away; the blade only cuts the air.
    if (!hit) bugView.dodge();
    later('hunt-strike', STRIKE_LANDS_MS, () => {
      const at = bugView.point();
      if (!hit) {
        if (at) effect('swoosh', at.x, at.y - 10);
        return;
      }
      if (at) effect('spark', at.x, at.y);
      if (final) bugView.squash();
      else bugView.flinch();
    });
  }

  const MOVE_MODES = new Set(['walk', 'fly', 'toss', 'settle']);

  /**
   * The menu column switches sides: main moves the window under the page, which
   * can only redraw a moment later. Hidden for that moment ('hide': answer
   * once the hidden frame is on screen; 'show': back once the new layout is drawn).
   * 'warp': off to another screen. It fades out (with a little zip upwards),
   * then main moves the window over there and sends 'show': it fades in.
   */
  const WARP_FADE_MS = 240;
  function onFlip(phase) {
    if (phase === 'hide') {
      stage.classList.add('flipping');
      requestAnimationFrame(() => requestAnimationFrame(() => window.buddy.flipReady()));
    } else if (phase === 'warp') {
      cancel('warp-in');
      stage.classList.remove('warp-in');
      stage.classList.add('warping');
      later('warp', motionAllowed() ? WARP_FADE_MS : 0, () => requestAnimationFrame(() => window.buddy.flipReady()));
    } else if (phase === 'show') {
      const warped = stage.classList.contains('warping');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          stage.classList.remove('flipping', 'warping');
          if (warped && motionAllowed()) {
            stage.classList.add('warp-in');
            later('warp-in', WARP_FADE_MS + 60, () => stage.classList.remove('warp-in'));
          }
        }),
      );
    }
    trace(`layout: flip ${phase}`);
  }

  function tripTick() {
    if (!moving) return;
    window.buddy.tripFrame();
    requestAnimationFrame(tripTick);
  }

  /** A trip around the screen starts (mode) or ends (mode null). */
  /**
   * A loop-the-loop on this flight (app/roam.js): the figure turns once while
   * the window flies the circle, from loop.at ms into the trip for loop.ms.
   */
  function startLoop(loop) {
    cancel('loop');
    flag('loop', null);
    if (!loop || !motionAllowed()) return;
    const at = Math.max(0, Math.round(Number(loop.at) || 0));
    const ms = Math.max(200, Math.round(Number(loop.ms) || 0));
    holder.style.setProperty('--loop-delay', `${at}ms`);
    holder.style.setProperty('--loop-ms', `${ms}ms`);
    flag('loop', true, true);
    later('loop', at + ms + 100, () => flag('loop', null));
  }

  function applyMove(m) {
    if (!m) return;
    perfMark(`trip ${m.kind} ${m.mode ? 'start' : 'end'}`);
    if (m.mode) {
      // The window moves in step with the frames drawn here (see main.js stepTrip).
      if (!moving) requestAnimationFrame(tripTick);
      moving = m.mode;
      updateHunt(); // off on a trip: the fight stops before the trip turns it round
      // (No rest.activity(): a trip of its own must not keep it from resting.)
      capture.pointer(false);
      // Off on a trip: the panel goes (a throw keeps it; the window keeps its size then).
      if (m.kind !== 'fling') closeChat('trip');
      setZone(null);
      hover.closeNow();
      flag('play', null);
      flag('inspect', null);
      flag('lens', null);
      cancel('lens');
      flag('hang', null);
      startLoop(m.loop);
      // walk / fly: trips; toss (thrown, "Always stand"), settle (easing into place after a drop).
      flag('move', MOVE_MODES.has(m.mode) ? m.mode : 'fly');
      flag('face', m.face === 'left' ? 'left' : null);
      crew.setTravel(m.mode, m.face);
      pet.setTravel(m.mode, m.face);
      trace(`trip: ${m.kind} (${m.mode})`);
    } else {
      moving = null;
      flag('move', null);
      flag('face', null);
      cancel('loop');
      flag('loop', null);
      // Up at the top edge: it hangs there until its next trip (or work, or a drag).
      flag('hang', m.kind === 'hang' && m.arrived && motionAllowed() ? true : null);
      // On a window's title bar: it sits down there for a moment. Fell off one: "Whoa!".
      if (m.kind === 'perch' && m.arrived && ambientOn() && CALM.has(view.state)) later('perch-sit', 350, () => ambient.run('sit'));
      if (m.kind === 'fall') quip('whoa', 1200);
      crew.setTravel(null);
      pet.setTravel(null);
      if (m.kind === 'inspect' && m.arrived && motionAllowed() && m.lens) {
        peerThroughLens(m.look === 'left' ? 'left' : 'right');
      } else if (m.kind === 'inspect' && m.arrived && motionAllowed()) {
        flag('inspect', m.look === 'left' ? 'left' : 'right');
        later('inspect', INSPECT_MS, () => flag('inspect', null));
        // Now and then it asks what that is.
        if (Math.random() < CURIOUS_CHANCE) later('curious', 900, askWhatsThis);
      }
      trace(`trip: ${m.kind} ${m.arrived ? 'arrived' : 'stopped'}`);
    }
    updateHunt();
    updateFun();
  }

  // ---------------------------------------------------------------- the idle story (lib/fun.js IdleStory)

  /**
   * A long idle spell, before it naps (ambient life on, once per idle spell):
   * three of these, picked at random each time (lib/fun.js STORY), then sleep:
   *   read     it takes the book out and reads a few pages (the 'read' play)
   *   cat      the cat comes over and plays with it (only with the Cat switch on)
   *   pat      it pets the cat: the cat comes close (called first if it is not
   *            here; only with the Cat switch on), purrs, then naps again
   *   bubbles  it blows soap bubbles (the 'bubbles' play)
   *   plane    it throws a paper plane that loops back to its hand (the 'plane' play)
   *   guest    a visitor drops by, a little robot like its helpers: they sit and
   *            chat, then practise with toy swords, bow, and it flies off (the
   *            cat the story brought goes first, to make room)
   *   sleep    a big yawn, and it naps soon after
   * Work, a drag, a trip, helpers arriving: the visitor leaves at once.
   */
  const STORY_CAT_MS = 11000;
  /** The petting beat ends with the cuddle; this is a backstop (the cat never came). */
  const STORY_PAT_MS = 20000;
  /** Called in for the petting: it looks round a moment before it comes over. */
  const PAT_COME_MS = 500;
  /** The story's own plays (each one ends the beat when it is over). */
  const STORY_PLAY_BEATS = new Set(['read', 'bubbles', 'plane']);
  const SLEEPY_MS = 9000;
  const GUEST_LEAVE_MS = 900;
  const story = new IdleStory({ onBeat: storyBeat });
  /** The story's play that is on now (its end is the beat's end). */
  let storyPlay = null;
  /** The cat was called for the story's petting: it comes close once it is in. */
  let patPending = false;
  /** The cat is being petted (data-pet="cuddle"). */
  let cuddling = false;
  /** The story called the visitor: it is on its way (main makes room first). */
  let guestPending = false;
  /** The cat chases the laser pointer's dot (data-pet="laser"). */
  let lasering = false;
  /** A backstop: the visitor never came. */
  const GUEST_PENDING_MS = 6000;
  /** The story brought the cat: it may send it away again to make room. */
  let storyCat = false;
  /** At the end of the story: it naps soon (see syncRest). */
  let sleepy = false;
  /** The visitor while it is here: { el, timers }. */
  let guest = null;

  /** Free for a beat: idle, awake, nothing else going on, not held or hovered. */
  function storyFree() {
    return (
      ambientOn() &&
      AMBIENT_STATES.has(view.state) &&
      !rest.resting &&
      !moving &&
      !drag &&
      !duel.active &&
      !hunt.active &&
      !chatOpen &&
      !raging &&
      !guest &&
      zone === null &&
      !crew.isPressing()
    );
  }

  function storyBeat(name) {
    if (!ambientOn() || !AMBIENT_STATES.has(view.state)) return 'skip';
    if (!storyFree()) return 'later';
    trace(`story: ${name}`);
    if (STORY_PLAY_BEATS.has(name)) {
      storyPlay = name;
      ambient.run(name);
      return 'busy';
    }
    if (name === 'pat') return startPat() ? 'busy' : 'skip';
    if (name === 'cat') {
      if (!settings.cat || !character || !character.pet || pet.here) return 'skip';
      storyCat = true;
      window.buddy.fun('cat');
      later('story-cat', STORY_CAT_MS, () => story.done());
      return 'busy';
    }
    if (name === 'guest') {
      if (crewCount > 0 || !character || !character.mini) return 'skip';
      // The user's own cat stays; then there is no room for a visitor.
      if (pet.here && !storyCat) return 'skip';
      // Nothing of its own (a stroll...) until the visitor is here: it would send it away again.
      guestPending = true;
      ambient.stop();
      later('guest-pending', GUEST_PENDING_MS, () => {
        guestPending = false;
        updateFun();
      });
      if (pet.here) {
        storyCat = false;
        window.buddy.fun('cat-away');
        later('story-guest', 2600, () => window.buddy.fun('guest'));
      } else {
        window.buddy.fun('guest');
      }
      updateFun();
      return 'busy';
    }
    if (name === 'sleep') getSleepy();
    return 'skip';
  }

  /**
   * It pets the cat: the cat comes close (from its nap, or called in first:
   * then it comes over as soon as it has walked in). True when it started.
   */
  function startPat() {
    if (!settings.cat || !character || !character.pet || crewCount > 0 || !motionAllowed()) return false;
    ambient.stop();
    if (pet.here) {
      if (!pet.cuddle()) return false;
    } else {
      storyCat = true;
      patPending = true;
      window.buddy.fun('cat');
    }
    later('story-pat', STORY_PAT_MS, () => {
      patPending = false;
      if (story.playing === 'pat') story.done();
    });
    return true;
  }

  /** The cat arrived to be petted (on) or goes back to its nap (off). */
  function onCuddle(on) {
    cuddling = Boolean(on);
    if (on) {
      trace('cat: petted');
      // It turns to the cat (on the helpers' side, like the visitor).
      if (!hunt.active && !duel.active && !moving) flag('face', layout.side !== 'right' ? 'left' : null);
      quip('petCat', 1800);
      floatHearts();
      later('pat-hearts', 2600, floatHearts);
    } else {
      cancel('pat-hearts');
      if (!hunt.active && !duel.active && !moving) flag('face', null);
      if (story.playing === 'pat') {
        cancel('story-pat');
        story.done();
      }
    }
    updateFun();
  }

  /**
   * The cat naps a lot: while it naps and the buddy is idle, awake and free,
   * every 45-90 s the laser pointer comes out and the cat chases the dot
   * (lib/pet.js laser(); it also comes out after the ball now and then).
   */
  const CAT_LASER_MIN_MS = 45000;
  const CAT_LASER_MAX_MS = 90000;
  const CAT_LASER_RETRY_MS = 20000;

  function tryCatLaser() {
    if (catPhase !== 'nap') return;
    const free =
      ambientOn() &&
      AMBIENT_STATES.has(view.state) &&
      motionAllowed() &&
      !rest.resting &&
      !moving &&
      !drag &&
      !duel.active &&
      !hunt.active &&
      !chatOpen &&
      !raging &&
      !guest &&
      !guestPending &&
      !cuddling &&
      zone === null;
    if (free && pet.laser()) trace('cat: the laser pointer');
    else later('cat-laser', CAT_LASER_RETRY_MS, tryCatLaser);
  }

  /** The cat is at the dot (on) or goes back to its nap (off): it turns to the cat, like for petting. */
  function onPetLaser(on) {
    lasering = Boolean(on);
    if (!hunt.active && !duel.active && !moving) flag('face', on ? (layout.side !== 'right' ? 'left' : null) : null);
    if (on) ambient.stop();
    updateFun();
  }

  /** The end of the story: a big yawn, "nap time", and it rests soon. */
  function getSleepy() {
    if (!ambientOn() || rest.resting) return;
    sleepy = true;
    quip('sleepy', 2000);
    sfx('yawn');
    ambient.run('stretch');
    syncRest();
    rest.activity();
  }

  /** The main process made room ({ on: true }) or refused / took it back. */
  function onGuest(msg) {
    guestPending = false;
    cancel('guest-pending');
    if (msg && msg.on) startGuest();
    else if (!guest && story.playing === 'guest') story.done();
  }

  /**
   * The visit, step by step (ms from its arrival): it drops in on its
   * thrusters and waves, they sit and chat, get up for sword practice (three
   * exchanges, a clang each), bow, and it waves and flies off.
   */
  function startGuest() {
    const spot = layout.guest;
    const el = guest ? null : crew.makeGuest();
    if (!el || !spot || !motionAllowed() || !ambientOn() || !AMBIENT_STATES.has(view.state) || moving || drag || raging) {
      if (el) el.remove();
      if (!guest) window.buddy.fun('guest-away');
      if (!guest && story.playing === 'guest') story.done();
      return;
    }
    ambient.stop();
    const g = { el, timers: [] };
    guest = g;
    const onLeft = layout.side !== 'right';
    const tints = (character && character.mini && character.mini.tints) || 1;
    el.dataset.tint = String(Math.floor(Math.random() * tints));
    el.style.setProperty('--off', `${spot.off}px`);
    // The artwork faces right: on the right-hand side it turns to face the buddy.
    if (!onLeft) el.dataset.flip = '1';
    const set = (name, value) => {
      if (value === null) delete el.dataset[name];
      else el.dataset[name] = value;
    };
    const at = (ms, fn) => g.timers.push(setTimeout(() => guest === g && fn(), ms));
    const face = () => !hunt.active && flag('face', onLeft ? 'left' : null);
    trace('guest: drops by');
    set('phase', 'arrive');
    set('fly', '1');
    sfx('whoosh', 1.3);
    updateFun();

    // Hello.
    at(700, () => {
      set('fly', null);
      set('phase', 'play');
      set('play', 'wave');
      face();
      flag('greet', true, true);
      quip('guestHi', 1600);
      sfx('chirp', 1.45);
    });
    // They sit down and chat: turns to talk, a laugh at the end.
    at(2700, () => {
      set('play', null);
      set('phase', 'sit');
      flag('greet', null);
      flag('seated', 'down', true);
    });
    for (let i = 0; i < 5; i += 1) {
      const t = 3300 + i * 1300;
      const theirs = i % 2 === 0;
      at(t, () => {
        set('talk', theirs ? '1' : null);
        flag('talk', theirs ? null : true);
        sfx('chirp', theirs ? 1.45 : 1);
      });
    }
    at(9800, () => {
      set('talk', null);
      flag('talk', null);
      set('laugh', '1');
      floatHearts();
      sfx('chirp', 1.8);
    });
    // Up for sword practice.
    at(11000, () => {
      set('laugh', null);
      flag('seated', 'up');
      set('phase', 'look');
      quip('guestSpar', 1500);
    });
    at(11500, () => flag('seated', null));
    at(12300, () => {
      set('phase', 'spar');
      set('spar', 'guard');
      flag('duel', 'guard');
    });
    // Three exchanges: the buddy strikes and it blocks, then the other way round.
    for (let i = 0; i < 3; i += 1) {
      const t = 13300 + i * 1700;
      const buddyStrikes = i % 2 === 0;
      at(t, () => (buddyStrikes ? flag('duel', 'windup') : set('spar', 'windup')));
      at(t + 450, () => {
        if (buddyStrikes) {
          flag('duel', 'strike');
          set('spar', 'block');
        } else {
          set('spar', 'strike');
          flag('duel', 'block');
        }
        clash(el, onLeft);
      });
      at(t + 1050, () => {
        flag('duel', 'guard');
        set('spar', 'guard');
      });
    }
    // A bow, a happy hop, goodbye.
    at(18700, () => {
      flag('duel', null);
      set('spar', null);
      set('phase', 'play');
      set('play', 'jump');
      if (motionAllowed()) glee.trigger();
      quip('guestBow', 1600);
      sfx('sparkle');
    });
    at(20600, () => set('play', 'wave'));
    at(22200, () => endGuest('bye'));
  }

  /** The toy swords meet between them: a spark and a clang. */
  function clash(el, onLeft) {
    const g = el.getBoundingClientRect();
    const h = holder.getBoundingClientRect();
    const x = onLeft ? (g.left + g.width * 0.8 + h.left + h.width * 0.12) / 2 : (g.left + g.width * 0.2 + h.right - h.width * 0.12) / 2;
    effect('spark', x, h.top + h.height * 0.5);
    sfx('clang');
  }

  /** The visit is over (goodbye, or something else needs the buddy): it flies off. */
  function endGuest(why) {
    const g = guest;
    if (!g) return;
    guest = null;
    for (const t of g.timers) clearTimeout(t);
    trace(`guest: leaves (${why})`);
    if (!duel.active && !hunt.active) flag('duel', null);
    if (!duel.active && !hunt.active && !moving) flag('face', null);
    flag('seated', null);
    flag('talk', null);
    for (const name of ['spar', 'talk', 'laugh', 'play']) delete g.el.dataset[name];
    g.el.dataset.phase = 'leave';
    g.el.dataset.fly = '1';
    sfx('whoosh', 1.2);
    setTimeout(() => {
      g.el.remove();
      window.buddy.fun('guest-away');
    }, GUEST_LEAVE_MS);
    if (story.playing === 'guest') story.done();
    updateFun();
  }

  // ---------------------------------------------------------------- following the cursor (app/follow.js)

  /**
   * The cursor moved somewhere and rested there for ten seconds (main.js
   * samples its position, nothing else): the user is probably looking at that
   * spot. Idle, awake and free to move, it flies over and peers at it through
   * a big magnifier, held up to its eye on the side of the spot (data-lens;
   * the figure turns to put that side towards it). Once per spot (main.js
   * offers the spot again while it is busy, until it has been), at most every
   * 15 s. Never with "Stay here".
   */
  const FOLLOW_GAP_MS = 15000;
  const LENS_MS = 5200;
  let lastFollow = -Infinity;

  function onFollow(msg) {
    if (!msg || !msg.dwell) return;
    const demo = Boolean(msg.demo);
    if (settings.stayPut || !ambientOn() || raging || moving || drag || duel.active || hunt.active || chatOpen || rest.resting || guest) return;
    // As for its own trips: idle, nobody else around, the pointer not on it.
    if (!AMBIENT_STATES.has(view.state) || crewCount > 0 || pet.here || zone !== null) return;
    if (!demo && Date.now() - lastFollow < FOLLOW_GAP_MS) return;
    lastFollow = Date.now();
    trace('follow: off to look at where the cursor rests');
    window.buddy.fun('peek');
  }

  /** The magnifier pose, its far side towards the spot (the artwork holds it up to the far eye). */
  function peerThroughLens(look) {
    flag('face', look === 'right' ? 'left' : null);
    flag('inspect', 'left');
    flag('lens', true, true);
    quip('lensHmm', 1600);
    sfx('chirp', 1.15);
    later('lens', LENS_MS, () => {
      flag('lens', null);
      flag('inspect', null);
      if (!moving && !hunt.active) flag('face', null);
    });
    // Now and then it asks what that is, after a good look.
    if (Math.random() < CURIOUS_CHANCE) later('curious', 2200, askWhatsThis);
  }

  // ---------------------------------------------------------------- chat

  /**
   * The chat panel (main.js opens it from the hover menu): on Windows the
   * hands commands in rows at the top (app/hands.js), then ready-made
   * questions; main answers from what the overlay already knows (app/chat.js)
   * and the character says it in the bubble. Buttons only: the window never
   * takes the keyboard.
   *
   * It closes with its x, or when the pointer has been away for a moment.
   */
  const { answerMs } = window.BuddyChatMatch;
  const CHAT_AWAY_MS = 2500;
  const NUDGE_MS = 1400;
  const TALK_MAX_MS = 1800;
  function applyChat(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.answer === 'string') {
      showAnswer(msg.answer, msg.intent);
      return;
    }
    if (msg.strings) renderChat(msg.strings);
    // The simulator opens it with no pointer around: it does not close by itself then.
    if (msg.open === true) chatHold = msg.hold === true;
    if (typeof msg.open === 'boolean') setChatOpen(msg.open);
  }

  function chatButton(id, label, extra = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = `chat-q${extra}`;
    button.textContent = label;
    button.addEventListener('click', () => ask(id));
    return button;
  }

  function renderChat(strings) {
    chatTitle.textContent = strings.title || '';
    chatClose.setAttribute('aria-label', strings.close || '');
    // "Chrome  [Open] [Close]": a group's name, then its short buttons (full name as tooltip).
    const groups = Array.isArray(strings.commands) ? strings.commands : [];
    chatCmds.replaceChildren(
      ...groups.map((g) => {
        const row = document.createElement('div');
        row.className = 'chat-cmd-row';
        const name = document.createElement('span');
        name.className = 'chat-cmd-name';
        name.textContent = g.label;
        const items = Array.isArray(g.items) ? g.items : [];
        row.append(
          name,
          ...items.map((c) => {
            const button = chatButton(c.id, c.label, ' chat-cmd');
            button.title = c.title || '';
            button.setAttribute('aria-label', c.title || c.label);
            return button;
          }),
        );
        return row;
      }),
    );
    chatCmds.hidden = groups.length === 0;
    const questions = Array.isArray(strings.questions) ? strings.questions : [];
    chatList.replaceChildren(...questions.map((q) => chatButton(q.id, q.label)));
  }

  function setChatOpen(open) {
    if (open === chatOpen) return;
    chatOpen = open;
    chatEl.classList.toggle('open', open);
    chatEl.setAttribute('aria-hidden', String(!open));
    crew.setMenuOpen(open || hover.open);
    cancel('chat-away');
    if (open) {
      hover.closeNow();
      hideTooltip();
    } else {
      chatEl.classList.remove('nudge');
    }
    trace(`chat ${open ? 'open' : 'closed'}`);
    perfMark(open ? 'chat open' : 'chat close');
    // What is under the pointer now (a closed panel lets clicks through at once).
    const under = pointerAt && !drag ? zoneOf(document.elementFromPoint(pointerAt.x, pointerAt.y)) : null;
    capture.pointer(takesMouse(under));
    setZone(under);
    updateFun();
  }

  /** Close from the page: hide at once, then tell main (the window narrows). */
  function closeChat(why) {
    if (!chatOpen) return;
    trace(`chat: close (${why})`);
    setChatOpen(false);
    window.buddy.chat('close');
  }

  /** The pointer left the panel (and the character): close after a moment. */
  function chatAway(next) {
    if (!chatOpen || chatHold) return;
    if (next === 'chat' || next === 'bubble' || next === 'character' || next === 'mini') {
      cancel('chat-away');
    } else if (!timers.has('chat-away')) {
      later('chat-away', CHAT_AWAY_MS, () => closeChat('pointer away'));
    }
  }

  function ask(intent) {
    if (!chatOpen) return;
    rest.activity();
    trace(`chat: ask ${intent}`);
    window.buddy.chat('ask', intent);
  }

  function showAnswer(text, intent) {
    if (!chatOpen || !text) return;
    answerText = text;
    renderBubble();
    const ms = answerMs(text);
    later('answer', ms, () => {
      answerText = null;
      renderBubble();
    });
    if (motionAllowed()) {
      flag('talk', true, true);
      later('talk', Math.min(TALK_MAX_MS, ms), () => flag('talk', null));
    }
    // "I don't know that, but you can ask me these": point at the questions.
    if (intent === 'unknown') {
      chatEl.classList.add('nudge');
      later('chat-nudge', NUDGE_MS, () => chatEl.classList.remove('nudge'));
    }
    trace(`chat: answer (${intent})`);
  }

  /** Hands: how long the press pose lasts (robot.css data-press), and the typing at the address bar. */
  const PRESS_MS = 1200;
  const TYPE_MS = 2600;

  /**
   * The rocket fist (app/fist.js): 'aim' turns it and its near arm towards the
   * button (--fist-rot), 'out' the forearm is off (the effect window flies
   * it), 'dock' it is back with a clunk, null the pose ends.
   */
  let fisting = false;
  function applyFist(msg) {
    const phase = ['aim', 'out', 'dock'].includes(msg.fist) ? msg.fist : null;
    if (phase === 'aim') {
      const rot = Number.isFinite(msg.rot) ? Math.max(-180, Math.min(180, msg.rot)) : -130;
      holder.style.setProperty('--fist-rot', `${rot}deg`);
      flag('face', msg.face === 'left' ? 'left' : null);
      sfx('charge', 1.3);
    }
    if (phase === 'out') sfx('launch', 1.2);
    fisting = phase !== null;
    flag('fist', phase, phase === 'dock');
    if (!phase) {
      holder.style.removeProperty('--fist-rot');
      if (!moving) flag('face', null);
    }
    trace(`hands: fist ${phase || 'over'}`);
    updateFun();
  }

  /** A line about a command (hands): shown like a chat answer, also with the panel closed. */
  function sayAnswer(text) {
    dropQuip();
    answerText = text;
    renderBubble();
    later('answer', answerMs(text), () => {
      answerText = null;
      renderBubble();
    });
  }

  function dropAnswer() {
    cancel('answer');
    cancel('talk');
    flag('talk', null);
    answerText = null;
  }

  // A click on the answer puts it away.
  bubble.addEventListener('click', () => {
    if (!answerText) return;
    dropAnswer();
    renderBubble();
    const under = pointerAt ? zoneOf(document.elementFromPoint(pointerAt.x, pointerAt.y)) : null;
    capture.pointer(takesMouse(under));
    setZone(under);
  });

  chatClose.addEventListener('click', () => closeChat('x'));

  // ---------------------------------------------------------------- wiring

  /**
   * Developers only (main sends data.demo in npm run dev with AGENT_BUDDY_DEMO):
   * play a duel, the idle plays or the cheers by themselves, no mouse needed.
   */
  /** The simulator (npm run simulate -- life) asks for one behaviour. */
  function onDemo(name) {
    trace(`demo: ${name}`);
    rest.activity();
    if (name === 'roam') {
      // A helper off to roam the screen right now (normally one of the crew's naughty moments).
      if (!crew.demoRoam()) trace('demo: no helper at work to send out');
    } else if (name === 'sound' && sound === SILENT_BOARD) {
      trace('sound: switched off (app/features.js)');
    } else if (name === 'sound') {
      soundDemo = true;
      syncSound();
      // Every sound once, in turn (a tap streak climbs in the tap-spam demo).
      const list = window.BuddySound.NAMES;
      list.forEach((item, i) =>
        later(`demo-sound-${i}`, 400 + i * 900, () => trace(`sound: ${item} ${sfx(item) ? 'played' : 'skipped'}`)),
      );
      later('demo-sound-end', 400 + list.length * 900 + 1500, () => {
        soundDemo = false;
        syncSound();
      });
    } else if (name === 'tap-spam') {
      // Ten seconds of quick taps (no mouse): for CPU measurements.
      soundDemo = true;
      syncSound();
      let played = 0;
      let taps = 0;
      const tick = () => {
        boop();
        taps += 1;
        if (sfx('bonk', sound.tapPitch())) played += 1;
        if (taps < 90) later('tap-spam', 110, tick);
        else {
          trace(`sound: tap-spam done, ${taps} taps, ${played} sounds`);
          soundDemo = false;
          syncSound();
        }
      };
      tick();
    } else if (name === 'anger' || name === 'glee') {
      // Quick taps without a mouse, in a mood fixed for the demo: three unwelcome
      // ones (cross, then it leaves) or five it loves (happy hops, hearts).
      const likes = name === 'glee';
      const fixed = new TapMeter({ random: () => (likes ? 0.01 : 0.99), likes: { calm: likes ? 1 : 0, busy: likes ? 1 : 0 } });
      const taps = likes ? [0, 250, 500, 750, 1000] : [0, 300, 600];
      // It starts calm, so the demo always looks the same.
      temper.reset();
      // ...and it never counts as a second blaze (no rampage in the middle of a demo).
      fury.reset();
      // The unwelcome demo counts as busy, so the third tap always sends it off.
      taps.forEach((ms, i) => later(`${name}-${i}`, ms, () => onClick(null, { meter: fixed, busy: !likes })));
    } else if (name === 'rage') {
      // The whole anger ladder: three taps (cross, then it leaves fuming), and
      // three more where it landed while it still fumes: its head catches fire,
      // and it erupts and leaves again.
      const fixed = new TapMeter({ random: () => 0.99, likes: { calm: 0, busy: 0 } });
      temper.reset();
      fury.reset();
      [0, 300, 600, 3600, 3900, 4200].forEach((ms, i) => later(`rage-${i}`, ms, () => onClick(null, { meter: fixed, busy: true })));
    } else if (name === 'pester') {
      // Never stops tapping: the anger ladder, then three more taps while its head
      // still burns (Fury.stoke): a rampage, without a second fire.
      const fixed = new TapMeter({ random: () => 0.99, likes: { calm: 0, busy: 0 } });
      temper.reset();
      fury.reset();
      [0, 300, 600, 3600, 3900, 4200, 8400, 8700, 9000].forEach((ms, i) => later(`pester-${i}`, ms, () => onClick(null, { meter: fixed, busy: true })));
    } else if (name === 'guest') {
      // A visitor right now (normally the idle story's third beat).
      if (crewCount > 0 || guest) trace('guest: not now');
      else window.buddy.fun('guest');
    } else if (name === 'cat-laser') {
      // The laser pointer for the cat now (it must be here: Cat switch, or the 'cat' demo first).
      if (!pet.laser()) trace('cat: not now');
    } else if (name === 'pat') {
      // It pets the cat (normally an idle story beat; the Cat switch must be on).
      if (!startPat()) trace('cat: not now');
    } else if (name === 'story') {
      // The whole idle story, every wait a tenth as long.
      story.stop();
      story.start({ fast: true });
    } else if (name === 'lens') {
      // The magnifier pose on the spot (normally where the cursor rested, app/follow.js).
      peerThroughLens(Math.random() < 0.5 ? 'left' : 'right');
    } else if (name === 'focus') {
      // Focus mode at once (as after a burst of edits); it ends with the next calm spell.
      for (let i = 0; i < FOCUS.on; i += 1) focus.step('typing');
      trace('focus: on (demo)');
      quip('focusOn', 1400);
      flag('holo', true);
    } else if (name === 'rampage') {
      // Its head on fire for the second time (no taps needed): the show (beams, missiles,
      // then after the cursor; main.js and app/rampage.js plan it).
      temper.reset();
      for (let i = 0; i < TEMPER_MAX; i += 1) temper.flare('annoyed');
      flag('annoyed', TEMPER_MAX, true);
      if (!goRampage()) trace('rampage: not now');
    } else if (name === 'press') {
      // The press poses only (nothing is pressed): at a button, on its own chest, typing.
      flag('press', true, true);
      later('press', PRESS_MS, () => flag('press', 'chest', true));
      later('press-type', PRESS_MS * 2 + 300, () => flag('press', 'type', true));
      later('press-end', PRESS_MS * 2 + 300 + TYPE_MS, () => flag('press', null));
      // ...and the rocket fist's arm (no forearm flies here).
      later('press-fist', PRESS_MS * 2 + 600 + TYPE_MS, () => applyFist({ fist: 'aim', rot: -125 }));
      later('press-fist-out', PRESS_MS * 2 + 1100 + TYPE_MS, () => applyFist({ fist: 'out' }));
      later('press-fist-dock', PRESS_MS * 2 + 2100 + TYPE_MS, () => applyFist({ fist: 'dock' }));
      later('press-fist-end', PRESS_MS * 2 + 2500 + TYPE_MS, () => applyFist({ fist: null }));
    } else if (name === 'curious') {
      askWhatsThis();
    } else if (name === 'welcome') {
      onPresence({ kind: 'back', awayMs: 600000 });
    } else if (name === 'commit' || name === 'push' || name === 'phew' || name === 'squeeze') {
      onMoment(name);
    } else if (name === 'sweat') {
      flag('mood', 'sweat');
      later('demo-sweat', 4000, () => flag('mood', view.mood === 'worried' || view.mood === 'sweat' ? view.mood : null));
    } else if (name === 'knock' || name === 'psst') {
      // (Normally only while Claude Code waits for the user.)
      if (motionAllowed()) {
        flag('nudge', name, true);
        later('nudge-end', NUDGE.showMs, () => flag('nudge', null));
        if (name === 'knock') knockRings();
      }
      quip(name === 'knock' ? 'knock' : 'nudge', NUDGE.showMs);
    } else if (name === 'loop') {
      // A hop with a loop-the-loop (main plans it; ambient life must be on).
      window.buddy.fun('loop');
    } else if (name === 'duel') {
      runDemo('duel');
    } else if (name === 'menu') {
      // The hover menu, open for a moment, without a mouse.
      hover.setOpen(true);
      later('demo-menu', 2500, () => hover.closeNow());
    } else if (motionAllowed()) {
      ambient.run(name);
    }
  }

  function runDemo(name) {
    if (name === 'duel') {
      // Round 1: no answer (the robot hits). Then parry + hit until it loses.
      let rounds = 0;
      const original = duel.onPhase;
      duel.onPhase = (phase, info) => {
        original(phase, info);
        if (phase === 'windup' && rounds++ > 0) later('demo', 250, demoSwing);
        if (phase === 'stun') later('demo', 400, demoSwing);
        if (phase === 'guard' && rounds === 2) later('demo', 300, demoSwing); // a blocked one
      };
      // A swing at the robot's chest, as a click there would do.
      const demoSwing = () => {
        const r = holder.getBoundingClientRect();
        swing(r.left + r.width * 0.62, r.top + r.height * 0.55);
      };
      later('demo-start', 1200, startDuel);
    } else if (name === 'menu') {
      // The hover menu, open, with the Play button's tooltip.
      later('demo-menu', 900, () => {
        hover.setOpen(true);
        const play = menuEl.querySelector('.menu-button[data-id="play"]');
        if (play) later('demo-tip', 300, () => showTooltip(play, play.getAttribute('aria-label')));
      });
    } else if (name === 'plays' || name === 'cheers') {
      const list = name === 'plays' ? ['stretch', 'look', 'peek', 'hum', 'jump', 'ball', 'antenna'] : ['jump', 'spin', 'dance', 'fist'];
      list.forEach((item, i) =>
        later(`demo-${i}`, 1500 + i * 3600, () => {
          trace(`demo: ${item}`);
          if (name === 'plays') flag('play', item, true);
          else {
            holder.dataset.state = 'done';
            flag('cheer', item, true);
          }
          later(`demo-off-${i}`, 3200, () => flag(name === 'plays' ? 'play' : 'cheer', null));
        }),
      );
    }
  }

  window.buddy.onInit(async (data) => {
    dev = data.dev === true;
    if (data.perf === true) startPerf();
    if (data.demo) later('demo-run', 500, () => runDemo(data.demo));
    settings = { ...settings, ...(data.settings || {}) };
    crew.setStrings(settings.strings);
    syncSound();
    renderAccountTag();
    applyLayout(data.layout);
    renderMenu(data.menu);
    setPaused(data.paused);
    applyFlight(data.flight);
    try {
      await loadCharacter(data.character);
    } catch (err) {
      console.error(`Agent Buddy: ${err.message}`);
    }
    applyView(data.view || view);
    crewList = Array.isArray(data.crew) ? data.crew : [];
    crew.setAgents(data.crew);
    pet.setOn(data.pet);
    applyBug(data.bug || null);
  });

  window.buddy.onView((next) => applyView(next));
  window.buddy.onLayout((next) => applyLayout(next));
  window.buddy.onMenuItems((items) => renderMenu(items));
  window.buddy.onPaused((value) => setPaused(value));
  window.buddy.onFlight((next) => applyFlight(next));
  window.buddy.onCrew((list) => {
    // Sub-agents at work keep the main character awake.
    rest.activity();
    const count = Array.isArray(list) ? list.length : 0;
    if (count !== crewCount) perfMark(`crew ${crewCount}→${count}`);
    crewCount = count;
    crewList = Array.isArray(list) ? list : [];
    crew.setAgents(list);
    updateHunt();
    updateFun();
  });
  window.buddy.onMove((m) => applyMove(m));
  window.buddy.onMoment((kind) => onMoment(kind));
  window.buddy.onPresence((change) => onPresence(change));
  // Hands (app/hands.js): the press pose at the button (or on its own chest: "Open Chrome";
  // typing at the address bar: YouTube), what it says about it, and the Yes / No questions.
  window.buddy.onHands((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.press && motionAllowed()) {
      const how = msg.press === 'chest' || msg.press === 'type' ? msg.press : true;
      flag('press', how, true);
      later('press', how === 'type' ? TYPE_MS : PRESS_MS, () => flag('press', null));
    }
    if (typeof msg.say === 'string' && msg.say) sayAnswer(msg.say);
    if (msg.ask) askHands(msg.ask, 'on');
    if (msg.confirm) askHands(msg.confirm, 'go');
    if ('fist' in msg) applyFist(msg);
  });
  window.buddy.onFlip((phase) => onFlip(phase));
  window.buddy.onChat((msg) => applyChat(msg));
  window.buddy.onBug((bug) => applyBug(bug));
  window.buddy.onRampage((msg) => onRampage(msg));
  window.buddy.onFollow((msg) => onFollow(msg));
  window.buddy.onGuest((msg) => onGuest(msg));
  window.buddy.onOutingBack((id) => {
    if (typeof id !== 'string') return;
    trace(`crew: ${id.slice(0, 4)} back from roaming`);
    crew.comeBack(id);
  });
  window.buddy.onFun((msg) => {
    if (msg && msg.action === 'duel') startDuel();
    if (msg && msg.action === 'whip') setWeapon(msg.on ? 'whip' : 'hand');
    if (msg && msg.action === 'demo' && typeof msg.name === 'string') onDemo(msg.name);
  });
  window.buddy.onPet((msg) => {
    pet.setOn(Boolean(msg && msg.on));
    updateFun();
  });
  window.buddy.onSettings((next) => {
    settings = { ...settings, ...next };
    renderAccountTag();
    crew.setStrings(settings.strings);
    syncSound();
    if (!settings.eyeTracking) resetLook();
    renderBubble();
    updateFun();
  });

  reducedMotion.addEventListener('change', () => {
    resetLook();
    updateHunt();
    updateTyping();
  });

  window.buddy.ready();
})();
