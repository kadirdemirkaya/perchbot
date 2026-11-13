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
 *   chat       { open, strings } the panel opens / closes; { answer, intent } an answer;
 *              { typing: false } the window lost the keyboard
 *   bug        { id, phase: 'open' | 'fixed' | 'escaped', agent } or null: the bug hunt
 *              (app/bugs.js); agent = the helper that found it, or null
 *
 * To the main process (window.buddy): ready(), capture(bool), drag(phase), menu(id),
 * crewLeft(id), fun(action) (a trip, or the right-click menu), chat(op, intent)
 * (the panel; a typed question is matched to an intent here and never sent).
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
 *   data-hunt (fights a bug at its feet, with data-duel phases; see "bug hunt")
 *   --look-x / --look-y (-1..1)  --type-line (0..7)  --fly-tilt (-1..1)
 *
 * The character SVG is inlined after removing scripts, event handlers and
 * external references. All text goes through textContent, never innerHTML.
 */

(() => {
  const { CaptureController, HoverMenu, RestTimer, lookVector, createTapRhythm, Replay } = window.BuddyInteraction;
  const { TapMeter, AmbientScheduler, pickCheer, Duel, BugFight } = window.BuddyFun;

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
  const skillName = document.getElementById('skill-name');
  const duelHud = document.getElementById('duel-hud');
  const duelPad = document.getElementById('duel-pad');
  const fxTop = document.getElementById('fx-top');
  const chatEl = document.getElementById('chat');
  const chatTitle = document.getElementById('chat-title');
  const chatList = document.getElementById('chat-list');
  const chatClose = document.getElementById('chat-close');
  const chatType = document.getElementById('chat-type');
  const chatInput = document.getElementById('chat-input');
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
  /** The chat panel is open; the user is typing in it; the answer in the bubble (see the chat section). */
  let chatOpen = false;
  let chatTyping = false;
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
   * on. Only for what the user does and the buddy's own play: never for
   * Claude Code's work, and work silences them at once. Nothing while the
   * screen is locked or the buddy rests.
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

  const pet = window.BuddyPetView.createPetView({
    actors,
    sanitizeSvg,
    // The cat plays: the main character joins in (data-pet="play").
    onCue: (name, on) => {
      flag('pet', on && motionAllowed() ? name : null);
      if (name === 'play' && on) {
        sfx('scratch');
        later('purr', 1200, () => sfx('purr'));
      }
    },
    trace,
  });

  /** Bug hunt (app/bugs.js): the bug beside the buddy (the fight: see "bug hunt" below). */
  const bugView = window.BuddyBugView.createBugView({ actors, trace });

  const crew = window.BuddyCrewView.createCrewView({
    actors,
    sanitizeSvg,
    onCue: (name) => onCrewCue(name),
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
    flag('mood', next.mood === 'worried' ? 'worried' : null);
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
    if (!CALM.has(next.state)) {
      pet.interrupt();
      // Work starts: what the taps were doing gives way to it. Not on every
      // event during work: taps at work have their own reactions (lib/fun.js).
      if (CALM.has(previous.state)) {
        cancel('flee');
        cancel('anger');
        flag('annoyed', null);
        meter.reset();
        glee.stop();
        dropQuip();
      }
    }
    // A chat answer gives way to work news at once (never the other way round).
    if (answerText && next.text && (next.state !== previous.state || next.text !== previous.text)) dropAnswer();
    renderBubble();

    // Every event wakes the character; idle starts the rest countdown again.
    rest.setIdle(next.state === 'idle');

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
    const text = answerText || (settings.quiet ? '' : quipText || view.text);
    bubble.classList.toggle('answer', Boolean(answerText));
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
  window.addEventListener('blur', (e) => {
    endTyping(true);
    onPointerLeave(e);
  });

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

  const rest = new RestTimer({
    onChange: (resting) => {
      trace(resting ? 'resting' : 'awake');
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
  function onCrewCue(name) {
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
      // A naughty kid poked it: a little jolt (a "Hey!" too when it is not working).
      boop();
      sfx('bonk', 1.3);
      if (CALM.has(view.state) && !quipText) quip('hey', 900);
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
  const ANNOYED_MS = 1500;
  const INSPECT_MS = 3800;
  let moving = null;
  let crewCount = 0;
  /** The helpers as the main process last sent them ({ id, status, ... }). */
  let crewList = [];
  let away = false;

  const meter = new TapMeter();
  const ambient = new AmbientScheduler({
    onPlay: (name) => {
      if (name) trace(`ambient: ${name}`);
      perfMark(name ? `ambient ${name}` : 'ambient end');
      // Cut short (work came in): ease out of it instead of jumping back.
      const parts = name ? null : snapshotAnimated();
      flag('play', name);
      blendFrom(parts);
      if (name === 'ball') later('ball-sound', BALL_FLOOR_MS, ballBounce);
      // "Achoo!" right when it sneezes (not if the play was cut short before).
      if (name === 'sneeze') later('sneeze', SNEEZE_AT_MS, () => holder.dataset.play === 'sneeze' && quip('sneeze', 1000));
    },
    onTrip: (kind) => {
      trace(`ambient: trip ${kind}`);
      window.buddy.fun(kind);
    },
  });
  const duel = new Duel({ onPhase: onDuelPhase });

  /** robot.css rb-sneeze-head: the "choo" at ~50 % of 2.6 s. */
  const SNEEZE_AT_MS = 1300;
  const BALL_FLOOR_MS = 288;
  const BALL_PERIOD_MS = 600;
  function ballBounce() {
    if (holder.dataset.play !== 'ball') return;
    sfx('bounce', 0.96 + Math.random() * 0.08);
    later('ball-sound', BALL_PERIOD_MS, ballBounce);
  }

  /**
   * Ambient life runs in short bursts, only while nothing else goes on: idle
   * (or standby), awake (not resting), no pointer on the character, no drag,
   * no duel, not already on a trip. Trips only without helpers or the cat.
   */
  function updateFun() {
    const calm =
      ambientOn() && !duel.active && !hunt.active && !moving && !drag && !crew.isPressing() && zone === null && !rest.resting && !chatOpen;
    ambient.update({ enabled: calm && AMBIENT_STATES.has(view.state), trips: crewCount === 0 && !pet.here, away });
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
    const whip = playOn() && weapon === 'whip';
    if (whip && e) {
      effect('crack', e.clientX, e.clientY);
      flag('ouch', true, true);
      later('ouch', OUCH_MS, () => flag('ouch', null));
      armWhip();
    }
    const busy = BUSY.has(view.state);
    let verdict = ambientOn() ? (demo ? demo.meter.tap(demo.busy) : meter.tap(busy)) : 'boop';
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
      if (motionAllowed()) glee.trigger();
      quip('giggle', 900);
      return;
    }
    glee.stop();
    // Already cross: stay cross a little longer, no restart (a restart looks like a stutter).
    if (!holder.dataset.annoyed) flag('annoyed', true, true);
    later('annoyed', ANNOYED_MS, () => flag('annoyed', null));
    if (verdict === 'flee') {
      trace('hit too often: leaving');
      quip('enough', 1800);
      later('flee', 450, () => window.buddy.fun('flee'));
    } else {
      quip(busy ? 'busy' : 'hey', 1100);
    }
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
   */
  function onFlip(phase) {
    if (phase === 'hide') {
      stage.classList.add('flipping');
      requestAnimationFrame(() => requestAnimationFrame(() => window.buddy.flipReady()));
    } else if (phase === 'show') {
      requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.remove('flipping')));
    }
    trace(`layout: flip ${phase}`);
  }

  function tripTick() {
    if (!moving) return;
    window.buddy.tripFrame();
    requestAnimationFrame(tripTick);
  }

  /** A trip around the screen starts (mode) or ends (mode null). */
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
      // walk / fly: trips; toss (thrown, "Always stand"), settle (easing into place after a drop).
      flag('move', MOVE_MODES.has(m.mode) ? m.mode : 'fly');
      flag('face', m.face === 'left' ? 'left' : null);
      crew.setTravel(m.mode, m.face);
      pet.setTravel(m.mode, m.face);
      trace(`trip: ${m.kind} (${m.mode})`);
    } else {
      moving = null;
      away = Boolean(m.away);
      flag('move', null);
      flag('face', null);
      crew.setTravel(null);
      pet.setTravel(null);
      if (m.kind === 'inspect' && m.arrived && motionAllowed()) {
        flag('inspect', m.look === 'left' ? 'left' : 'right');
        later('inspect', INSPECT_MS, () => flag('inspect', null));
      }
      trace(`trip: ${m.kind} ${m.arrived ? 'arrived' : 'stopped'}`);
    }
    updateHunt();
    updateFun();
  }

  // ---------------------------------------------------------------- chat

  /**
   * The chat panel (main.js opens it from the hover menu): ready-made
   * questions; main answers from what the overlay already knows (app/chat.js)
   * and the character says it in the bubble. "Type…" turns into a text field:
   * only then may the window take the keyboard. A typed question is matched to
   * one of the questions right here (lib/chat-match.js) and the field is
   * emptied at once: the text is not kept, logged or sent anywhere.
   *
   * It closes with its x, Esc while typing, or when the pointer has been away
   * for a moment (not while typing).
   */
  const { matchIntent, answerMs } = window.BuddyChatMatch;
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
    if (msg.typing === false) endTyping(false);
  }

  function renderChat(strings) {
    chatTitle.textContent = strings.title || '';
    chatClose.setAttribute('aria-label', strings.close || '');
    chatType.textContent = strings.type || '';
    chatInput.placeholder = strings.placeholder || '';
    const questions = Array.isArray(strings.questions) ? strings.questions : [];
    chatList.replaceChildren(
      ...questions.map((q) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
        button.className = 'chat-q';
        button.textContent = q.label;
        button.addEventListener('click', () => ask(q.id));
        return button;
      }),
    );
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
      endTyping(false);
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

  /** The pointer left the panel (and the character): close after a moment, unless typing. */
  function chatAway(next) {
    if (!chatOpen || chatHold) return;
    if (chatTyping || next === 'chat' || next === 'bubble' || next === 'character' || next === 'mini') {
      cancel('chat-away');
    } else if (!timers.has('chat-away')) {
      later('chat-away', CHAT_AWAY_MS, () => {
        if (!chatTyping) closeChat('pointer away');
      });
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

  chatType.addEventListener('click', () => {
    if (!chatOpen || chatTyping) return;
    chatTyping = true;
    chatEl.classList.add('typing');
    cancel('chat-away');
    chatInput.value = '';
    window.buddy.chat('type');
    chatInput.focus();
    trace('chat: typing');
  });

  // The window got the keyboard (main focused it): straight into the field.
  window.addEventListener('focus', () => {
    if (chatTyping) chatInput.focus();
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeChat('esc');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const intent = matchIntent(chatInput.value);
      chatInput.value = ''; // not kept, not even in the field
      ask(intent || 'unknown');
    }
  });

  /** Typing is over (Esc, closed, or the user clicked another window). */
  function endTyping(tellMain) {
    if (!chatTyping) return;
    chatTyping = false;
    chatInput.value = '';
    chatInput.blur();
    chatEl.classList.remove('typing');
    trace('chat: typing done');
    if (tellMain) window.buddy.chat('untype');
    chatAway(zone);
  }

  // ---------------------------------------------------------------- wiring

  /**
   * Developers only (main sends data.demo in npm run dev with AGENT_BUDDY_DEMO):
   * play a duel, the idle plays or the cheers by themselves, no mouse needed.
   */
  /** The simulator (npm run simulate -- life) asks for one behaviour. */
  function onDemo(name) {
    trace(`demo: ${name}`);
    rest.activity();
    if (name === 'sound' && sound === SILENT_BOARD) {
      trace('sound: switched off (app/features.js)');
    } else if (name === 'sound') {
      soundDemo = true;
      syncSound();
      const list = [
        ['clang', 1],
        ['bonk', 1],
        ['bonk', 1.12],
        ['bonk', 1.24],
        ['grumble', 1],
        ['bounce', 1],
        ['bounce', 0.97],
        ['purr', 1],
        ['scratch', 1],
        ['crack', 1],
      ];
      list.forEach(([item, pitch], i) =>
        later(`demo-sound-${i}`, 400 + i * 700, () => trace(`sound: ${item} ${sfx(item, pitch) ? 'played' : 'skipped'}`)),
      );
      later('demo-sound-end', 400 + list.length * 700 + 1500, () => {
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
      // The unwelcome demo counts as busy, so the third tap always sends it off.
      taps.forEach((ms, i) => later(`${name}-${i}`, ms, () => onClick(null, { meter: fixed, busy: !likes })));
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
  window.buddy.onFlip((phase) => onFlip(phase));
  window.buddy.onChat((msg) => applyChat(msg));
  window.buddy.onBug((bug) => applyBug(bug));
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
