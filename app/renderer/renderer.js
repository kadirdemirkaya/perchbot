'use strict';

/**
 * Renderer: shows the character, the speech bubble, the hover menu and effects.
 *
 * From the main process:
 *   init       { character, settings, view, layout, menu, flight, crew, paused }
 *   view       { state, cssState, text, mono, mood, skill }   every state change
 *   settings   { quiet, eyeTracking, strings }
 *   layout     { side, slotLeft, width, height } where the menu column goes
 *   menu-items [{ id, icon, label }]
 *   paused     true while the screen is locked / the system sleeps
 *   released   the main process let go of the mouse (cursor left the window)
 *   flight     { airborne, boost, tilt } hovering above the ground
 *   crew       [{ id, type, tool, file, skill, status }] sub-agents (crew-view.js draws them)
 *   move       { mode: 'walk' | 'fly' | null, face, kind, arrived, look } a trip around the screen
 *   fun        { action: 'duel' } from the right-click menu
 *
 * To the main process (window.buddy): ready(), capture(bool), drag(phase), menu(id),
 * crewLeft(id), fun(action) (a trip, or the right-click menu).
 *
 * Attributes this page sets on the character wrapper (the character's CSS
 * may use any of them; see characters/README.md):
 *   data-state  data-blink  data-hover  data-greet  data-boop  data-rest
 *   data-mood ("worried")  data-tap ("down" | "up")  data-sway ("a" | "b")
 *   data-fly ("hover" | "boost")  data-land
 *   data-skill ("open" | "stow")  data-brief / data-receive ("left" | "right": where the mini stands)
 *   fun mode: data-play  data-cheer  data-annoyed  data-move ("walk" | "fly")  data-face ("left")
 *   data-inspect ("left" | "right")  data-duel (phase, see lib/fun.js)
 *   --look-x / --look-y (-1..1)  --type-line (0..7)  --fly-tilt (-1..1)
 *
 * The character SVG is inlined after removing scripts, event handlers and
 * external references. All text goes through textContent, never innerHTML.
 */

(() => {
  const { CaptureController, HoverMenu, RestTimer, lookVector, createTapRhythm } = window.BuddyInteraction;
  const { ClickMeter, AmbientScheduler, pickCheer, Duel } = window.BuddyFun;

  const root = document.documentElement;
  const stage = document.getElementById('stage');
  const holder = document.getElementById('character');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const fx = document.getElementById('fx');
  const menuEl = document.getElementById('menu');
  const tooltip = document.getElementById('tooltip');
  const actors = document.getElementById('actors');
  const skillTag = document.getElementById('skill-tag');
  const skillName = document.getElementById('skill-name');
  const duelHud = document.getElementById('duel-hud');
  const duelPad = document.getElementById('duel-pad');
  const fxTop = document.getElementById('fx-top');
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

  /** Interaction trace, only with `npm run dev` (main forwards it to the console). */
  function trace(message) {
    if (dev) console.log(`[ui] ${message}`);
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
    onCue: (name, on) => flag('pet', on && motionAllowed() ? name : null),
    trace,
  });

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
    if (!CALM.has(next.state)) {
      cancel('flee');
      cancel('anger');
      flag('annoyed', null);
      meter.reset();
      pet.interrupt();
      dropQuip();
    }
    renderBubble();

    // Every event wakes the character; idle starts the rest countdown again.
    rest.setIdle(next.state === 'idle');

    if (next.state !== previous.state) {
      swayAntenna();
      if (next.state === 'done') {
        burstConfetti();
        // Fun mode: not always the same celebration.
        flag('cheer', ambientOn() ? pickCheer() : 'jump');
      }
      if (BUSY.has(next.state)) flag('greet', null);
    }
    updateTyping();
    updateFun();
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
    const text = settings.quiet ? '' : quipText || view.text;
    if (!text) {
      bubble.classList.remove('show');
      return;
    }
    bubbleText.textContent = text;
    bubble.classList.toggle('mono', Boolean(view.mono) && !quipText);
    positionBubble();
    bubble.classList.add('show');
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
    layout = next;
    stage.classList.toggle('side-left', next.side === 'left');
    stage.classList.toggle('side-right', next.side !== 'left');
    crew.setLayout(next);
    pet.setLayout(next);
  }

  // ---------------------------------------------------------------- mouse: hit testing and capture

  const capture = new CaptureController((wanted) => {
    trace(`capture ${wanted ? 'on' : 'off'}`);
    window.buddy.capture(wanted);
  });

  const hover = new HoverMenu({
    onChange: (open) => {
      trace(`menu ${open ? 'open' : 'closed'}`);
      menuEl.classList.toggle('open', open);
      crew.setMenuOpen(open);
      if (!open) hideTooltip();
    },
  });

  /**
   * 'character' | 'menu' | 'mini' | null for the element under the pointer.
   * All three take the mouse (a mini can be picked up and moved); everything
   * else lets clicks through to the window below.
   */
  function zoneOf(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.closest('.duel-pad')) return 'duel';
    // An open menu's buttons; in a duel only the Play button (it ends the duel).
    if (el.closest('.menu.open .menu-button, .menu.duel .menu-button[data-id="play"]')) return 'menu';
    if (holder.contains(el) && el !== holder && el.closest('svg') && el.tagName.toLowerCase() !== 'svg') {
      return 'character';
    }
    if (actors.contains(el) && el.closest('.buddy-mini svg') && el.tagName.toLowerCase() !== 'svg') return 'mini';
    return null;
  }

  const takesMouse = (z) => z === 'character' || z === 'menu' || z === 'mini' || z === 'duel';

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
    hover.set(drag || duel.active ? null : next);
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
  window.addEventListener('blur', onPointerLeave);

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

  function boop() {
    rest.activity();
    if (!motionAllowed()) return;
    flag('boop', true, true);
    later('boop', BOOP_MS, () => flag('boop', null));
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
    const want = view.state === 'typing' && motionAllowed();
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
      flag('rest', resting ? true : null);
      crew.setRest(resting || paused);
      pet.setRest(resting || paused);
      if (!resting) swayAntenna();
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

  function burstConfetti() {
    if (!motionAllowed() || !character || character.confetti === false) return;
    const anchor = character.bubbleAnchor || { x: 0.5, y: 0.1 };
    const originX = CHAR_LEFT + anchor.x * CHAR_SIZE;
    const originY = SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + (anchor.y + 0.15) * CHAR_SIZE;
    const pieces = [];
    for (let i = 0; i < 18; i += 1) {
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
    if (paused) {
      if (duel.active) duel.stop();
      hover.closeNow();
      setZone(null);
      capture.released();
      rest.stop();
    } else {
      rest.activity();
      scheduleBlink();
    }
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
  let away = false;

  const meter = new ClickMeter();
  const ambient = new AmbientScheduler({
    onPlay: (name) => {
      if (name) trace(`ambient: ${name}`);
      flag('play', name);
    },
    onTrip: (kind) => {
      trace(`ambient: trip ${kind}`);
      window.buddy.fun(kind);
    },
  });
  const duel = new Duel({ onPhase: onDuelPhase });

  /**
   * Ambient life runs in short bursts, only while nothing else goes on: idle
   * (or standby), awake (not resting), no pointer on the character, no drag,
   * no duel, not already on a trip. Trips only without helpers or the cat.
   */
  function updateFun() {
    const calm = ambientOn() && !duel.active && !moving && !drag && !crew.isPressing() && zone === null && !rest.resting;
    ambient.update({ enabled: calm && AMBIENT_STATES.has(view.state), trips: crewCount === 0 && !pet.here, away });
  }

  /**
   * A click on the character: with the whip a lash (crack + wince), otherwise
   * a boop. Hit twice in a row it gets annoyed; a third time and it leaves for
   * a random spot somewhere else on the screen.
   */
  function onClick(e) {
    rest.activity();
    const whip = playOn() && weapon === 'whip';
    if (whip && e) {
      effect('crack', e.clientX, e.clientY);
      flag('ouch', true, true);
      later('ouch', OUCH_MS, () => flag('ouch', null));
      armWhip();
    }
    const verdict = ambientOn() ? meter.click() : 'boop';
    if (verdict === 'boop') {
      if (whip) quip('ouch', 900);
      else boop();
      return;
    }
    flag('boop', null);
    flag('annoyed', true, true);
    later('annoyed', ANNOYED_MS, () => flag('annoyed', null));
    if (verdict === 'flee') {
      trace('hit too often: leaving');
      quip('enough', 1800);
      later('flee', 450, () => window.buddy.fun('flee'));
    } else {
      quip('hey', 1100);
    }
  }

  /** The same for a helper: it winces, gets annoyed, then stomps off to another spot. */
  const miniMeters = new Map();
  function onMiniClick(id, x, y) {
    rest.activity();
    const whip = playOn() && weapon === 'whip';
    if (whip) {
      effect('crack', x, y);
      crew.react(id, 'ouch');
      armWhip();
    }
    if (!ambientOn()) {
      crew.react(id, 'boop');
      return;
    }
    if (!miniMeters.has(id)) miniMeters.set(id, new ClickMeter());
    if (miniMeters.size > 16) miniMeters.delete(miniMeters.keys().next().value);
    const verdict = miniMeters.get(id).click();
    if (verdict === 'boop') {
      if (!whip) crew.react(id, 'boop');
    } else if (verdict === 'annoyed') {
      crew.react(id, 'annoyed');
    } else {
      crew.react(id, 'shoo');
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
      flag('duel', null);
      flag('face', null);
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

  /** A trip around the screen starts (mode) or ends (mode null). */
  function applyMove(m) {
    if (!m) return;
    if (m.mode) {
      moving = m.mode;
      // (No rest.activity(): a trip of its own must not keep it from resting.)
      capture.pointer(false);
      setZone(null);
      hover.closeNow();
      flag('play', null);
      flag('inspect', null);
      flag('move', m.mode === 'walk' ? 'walk' : 'fly');
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
    updateFun();
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
    if (name === 'anger') {
      // Three quick taps, without a mouse.
      [0, 300, 600].forEach((ms, i) => later(`anger-${i}`, ms, () => onClick(null)));
    } else if (name === 'duel') {
      runDemo('duel');
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
    if (data.demo) later('demo-run', 500, () => runDemo(data.demo));
    settings = { ...settings, ...(data.settings || {}) };
    crew.setStrings(settings.strings);
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
    crew.setAgents(data.crew);
    pet.setOn(data.pet);
  });

  window.buddy.onView((next) => applyView(next));
  window.buddy.onLayout((next) => applyLayout(next));
  window.buddy.onMenuItems((items) => renderMenu(items));
  window.buddy.onPaused((value) => setPaused(value));
  window.buddy.onFlight((next) => applyFlight(next));
  window.buddy.onCrew((list) => {
    // Sub-agents at work keep the main character awake.
    rest.activity();
    crewCount = Array.isArray(list) ? list.length : 0;
    crew.setAgents(list);
    updateFun();
  });
  window.buddy.onMove((m) => applyMove(m));
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
    if (!settings.eyeTracking) resetLook();
    renderBubble();
    updateFun();
  });

  reducedMotion.addEventListener('change', () => {
    resetLook();
    updateTyping();
  });

  window.buddy.ready();
})();
