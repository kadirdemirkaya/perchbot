'use strict';

/**
 * Renderer: shows the character, the speech bubble, the hover menu and effects.
 *
 * From the main process:
 *   init       { character, settings, view, layout, menu, paused }
 *   view       { state, cssState, text, mono }   every state change
 *   settings   { quiet, eyeTracking }
 *   layout     { side, slotLeft, width, height } where the menu column goes
 *   menu-items [{ id, icon, label }]
 *   paused     true while the screen is locked / the system sleeps
 *   released   the main process let go of the mouse (cursor left the window)
 *   flight     { airborne, boost, tilt } hovering above the ground
 *
 * To the main process (window.buddy): ready(), capture(bool), drag(phase), menu(id).
 *
 * Attributes this page sets on the character wrapper (the character's CSS
 * may use any of them; see characters/README.md):
 *   data-state  data-blink  data-hover  data-greet  data-boop  data-rest
 *   data-mood ("worried")  data-tap ("down" | "up")  data-sway ("a" | "b")
 *   data-fly ("hover" | "boost")  data-land
 *   --look-x / --look-y (-1..1)  --type-line (0..7)  --fly-tilt (-1..1)
 *
 * The character SVG is inlined after removing scripts, event handlers and
 * external references. All text goes through textContent, never innerHTML.
 */

(() => {
  const { CaptureController, HoverMenu, RestTimer, lookVector, createTapRhythm } = window.BuddyInteraction;

  const root = document.documentElement;
  const stage = document.getElementById('stage');
  const holder = document.getElementById('character');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const fx = document.getElementById('fx');
  const menuEl = document.getElementById('menu');
  const tooltip = document.getElementById('tooltip');
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

  let character = null;
  let settings = { quiet: false, eyeTracking: true };
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
  }

  // ---------------------------------------------------------------- view

  function applyView(next) {
    const previous = view;
    view = next;
    holder.dataset.state = next.cssState || next.state;
    flag('mood', next.mood === 'worried' ? 'worried' : null);
    stage.classList.toggle('leaving', next.state === 'goodbye');
    renderBubble();

    // Every event wakes the character; idle starts the rest countdown again.
    rest.setIdle(next.state === 'idle');

    if (next.state !== previous.state) {
      swayAntenna();
      if (next.state === 'done') burstConfetti();
      if (BUSY.has(next.state)) flag('greet', null);
    }
    updateTyping();
  }

  function renderBubble() {
    const text = settings.quiet ? '' : view.text;
    if (!text) {
      bubble.classList.remove('show');
      return;
    }
    bubbleText.textContent = text;
    bubble.classList.toggle('mono', Boolean(view.mono));
    positionBubble();
    bubble.classList.add('show');
  }

  /** Centre the bubble over the character's anchor point, clamped to the slot. */
  function positionBubble() {
    const anchor = (character && character.bubbleAnchor) || { x: 0.5, y: 0.1 };
    const anchorX = CHAR_LEFT + anchor.x * CHAR_SIZE;
    const anchorTop = SLOT_HEIGHT - CHAR_BOTTOM - CHAR_SIZE + anchor.y * CHAR_SIZE;
    const width = bubble.offsetWidth;
    const left = Math.max(6, Math.min(SLOT_WIDTH - width - 6, anchorX - width / 2));
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.bottom = `${Math.round(SLOT_HEIGHT - anchorTop + 10)}px`;
    bubble.style.setProperty('--tail-x', `${Math.round(Math.max(14, Math.min(width - 14, anchorX - left)))}px`);
  }

  function applyLayout(next) {
    if (!next) return;
    layout = next;
    stage.classList.toggle('side-left', next.side === 'left');
    stage.classList.toggle('side-right', next.side !== 'left');
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
      if (!open) hideTooltip();
    },
  });

  /** 'character' | 'menu' | null for the element under the pointer. */
  function zoneOf(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.closest('.menu.open .menu-button')) return 'menu';
    if (holder.contains(el) && el !== holder && el.closest('svg') && el.tagName.toLowerCase() !== 'svg') {
      return 'character';
    }
    return null;
  }

  let lastPointer = null;
  let zone = null;
  let lookFrame = 0;
  let lastActivity = 0;

  function onPointerMove(clientX, clientY) {
    lastPointer = { x: clientX, y: clientY };
    // Synchronous on purpose: releasing the mouse must not wait for a frame.
    const next = drag ? 'character' : zoneOf(document.elementFromPoint(clientX, clientY));
    capture.pointer(next !== null);
    setZone(next);
    if (next && Date.now() - lastActivity > 1000) {
      lastActivity = Date.now();
      rest.activity();
    }
    if (!lookFrame) lookFrame = requestAnimationFrame(updateLook);
    later('look-reset', 1500, resetLook);
  }

  function setZone(next) {
    const enteredCharacter = next === 'character' && zone !== 'character';
    if (next !== zone) {
      const at = lastPointer ? ` at ${Math.round(lastPointer.x)},${Math.round(lastPointer.y)}` : '';
      trace(`pointer zone: ${next || 'none'}${at} (capturing=${capture.capturing})`);
    }
    zone = next;
    hover.set(drag ? null : next);
    flag('hover', next === 'character' || next === 'menu' ? true : null);
    if (enteredCharacter && !drag) greet();
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
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_THRESHOLD) {
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
    else if (completed) boop();
    const under = e ? zoneOf(document.elementFromPoint(e.clientX, e.clientY)) : null;
    capture.endDrag(under !== null);
    setZone(under);
  }

  holder.addEventListener('pointerup', (e) => drag && endDrag(true, e));
  holder.addEventListener('pointercancel', (e) => drag && endDrag(false, e));

  // ---------------------------------------------------------------- hover menu

  function renderMenu(items) {
    const buttons = (items || []).map((item, index) => {
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
      button.addEventListener('mouseenter', () => showTooltip(button, item.label));
      button.addEventListener('mouseleave', hideTooltip);
      button.addEventListener('click', () => {
        rest.activity();
        window.buddy.menu(item.id);
      });
      return button;
    });
    menuEl.replaceChildren(...buttons);
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
      if (!resting) swayAntenna();
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
    if (paused) {
      hover.closeNow();
      setZone(null);
      capture.released();
      rest.stop();
    } else {
      rest.activity();
      scheduleBlink();
    }
    updateTyping();
  }

  // ---------------------------------------------------------------- wiring

  window.buddy.onInit(async (data) => {
    dev = data.dev === true;
    settings = { ...settings, ...(data.settings || {}) };
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
  });

  window.buddy.onView((next) => applyView(next));
  window.buddy.onLayout((next) => applyLayout(next));
  window.buddy.onMenuItems((items) => renderMenu(items));
  window.buddy.onPaused((value) => setPaused(value));
  window.buddy.onFlight((next) => applyFlight(next));
  window.buddy.onSettings((next) => {
    settings = { ...settings, ...next };
    if (!settings.eyeTracking) resetLook();
    renderBubble();
  });

  reducedMotion.addEventListener('change', () => {
    resetLook();
    updateTyping();
  });

  window.buddy.ready();
})();
