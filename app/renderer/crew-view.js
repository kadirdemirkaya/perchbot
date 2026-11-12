'use strict';

/**
 * Crew view: draws the sub-agent minis that CrewDirector (lib/crew.js)
 * choreographs. One <div class="buddy-mini"> per mini inside #actors, a "+N"
 * badge when not all of them fit, and a "N helpers" badge for characters
 * without mini artwork.
 *
 * Attributes set on each mini (the character's mini CSS may use any):
 *   data-phase  data-tint  data-fly  data-hop  data-talk  data-skill  data-give
 *   data-boop   data-ouch  data-annoyed  data-rest
 *   data-flip   (app CSS mirrors it to face the other way)
 * Positioning (--off, --lift, --walk) and mirroring are done by the app
 * (overlay.css). Minis can be picked up and dropped elsewhere in the crew area
 * (startDrag / dragMove / endDrag); a click without moving is a little boop.
 * All text goes through textContent.
 */
(() => {
  const { CrewDirector, crewLabel } = window.BuddyCrew;

  const TALK_MS = 700;
  const GIVE_MS = 700;
  const BOOP_MS = 500;
  const DRAG_THRESHOLD = 4;
  /** How high a mini can be held above the ground (CSS px). */
  const MAX_LIFT = 110;

  /**
   * @param {object} o
   * @param {HTMLElement} o.actors  container anchored at the slot edge
   * @param {(markup: string) => SVGElement} o.sanitizeSvg
   * @param {(name: string, data: object) => void} o.onCue  main-character cues
   * @param {(id: string) => void} o.onRelease
   * @param {(message: string) => void} o.trace
   */
  function createCrewView(o) {
    const { actors } = o;
    const els = new Map();
    const views = new Map();
    let template = null;
    let side = 'left';
    let lastLayout = null;
    let hover = false;
    let rest = false;
    /** The whole buddy is on a trip: { mode: 'walk' | 'fly', face: 'left' | 'right' } or null. */
    let travel = null;
    let strings = { helpers: '{count} helpers' };
    let agentCount = 0;
    let overflow = 0;
    let talkTimer = 0;
    let talkFirst = true;
    /** The mini the user is holding: { id, el, x, y, startOff, off, lift, grabbed }. */
    let held = null;
    const badge = document.createElement('div');
    badge.className = 'crew-badge';
    actors.appendChild(badge);

    const director = new CrewDirector({
      onUpdate: render,
      onRemove: remove,
      onRelease: (id) => {
        o.trace(`crew: ${id.slice(0, 4)} left`);
        o.onRelease(id);
      },
      onCue: cue,
      onOverflow: (n) => {
        overflow = n;
        renderBadge();
      },
    });

    // ---------------------------------------------------------------- loading

    /** mini: { svgUrl, cssUrl, tints } or null (no mini artwork: badge only). */
    async function setCharacter(mini) {
      // Only the drawings go; the director keeps its minis and redraws them below.
      for (const el of els.values()) el.remove();
      els.clear();
      views.clear();
      template = null;
      const oldLink = document.getElementById('mini-css');
      if (!mini) {
        if (oldLink) oldLink.remove();
        setLayout(lastLayout);
        return;
      }
      const link = document.createElement('link');
      link.id = 'mini-css';
      link.rel = 'stylesheet';
      link.href = mini.cssUrl;
      const response = await fetch(mini.svgUrl);
      const svg = o.sanitizeSvg(await response.text());
      if (oldLink) oldLink.replaceWith(link);
      else document.head.appendChild(link);
      template = svg;
      director.tints = Math.max(1, mini.tints | 0 || 1);
      setLayout(lastLayout); // capacity counts only now that there is artwork
    }

    // ---------------------------------------------------------------- input

    function setLayout(layout) {
      lastLayout = layout || null;
      side = layout && layout.side === 'right' ? 'right' : 'left';
      const crew = (layout && layout.crew) || { capacity: 0, spots: [], report: 0, miniSize: 132 };
      actors.style.setProperty('--mini-size', `${crew.miniSize || 132}px`);
      director.setGeometry({ report: crew.report, spots: crew.spots, capacity: template ? crew.capacity : 0 });
      for (const view of views.values()) render(view);
      renderBadge();
    }

    function setAgents(list) {
      const agents = Array.isArray(list) ? list : [];
      agentCount = agents.filter((a) => a && a.status === 'active').length;
      director.setAgents(agents);
      renderBadge();
    }

    /** The main character hovers: the minis switch their thrusters on too. */
    function setHover(value) {
      hover = Boolean(value);
      for (const view of views.values()) render(view);
    }

    /** The main character goes on a trip and the kids come along (mode null: arrived). */
    function setTravel(mode, face) {
      travel = mode ? { mode, face: face === 'left' ? 'left' : 'right' } : null;
      for (const view of views.values()) render(view);
    }

    /** Resting / paused: every mini stops moving, no chats. */
    function setRest(value) {
      rest = Boolean(value);
      director.setQuiet(rest);
      for (const view of views.values()) render(view);
    }

    function setStrings(next) {
      strings = { ...strings, ...(next || {}) };
      renderBadge();
    }

    // ---------------------------------------------------------------- drawing

    function render(view) {
      if (!template) return;
      const before = views.get(view.id);
      if (before && before.phase !== view.phase) o.trace(`crew: ${view.id.slice(0, 4)} ${view.phase}`);
      views.set(view.id, view);
      let el = els.get(view.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'buddy-mini';
        el.dataset.id = view.id;
        el.appendChild(template.cloneNode(true));
        const tag = document.createElement('div');
        tag.className = 'skill-tag mini-tag';
        tag.appendChild(bookIcon());
        tag.appendChild(document.createElement('span'));
        el.appendChild(tag);
        const dots = document.createElement('div');
        dots.className = 'mini-dots';
        for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement('i'));
        el.appendChild(dots);
        actors.appendChild(el);
        els.set(view.id, el);
        o.trace(`crew: ${view.id.slice(0, 4)} arrived (${view.type})`);
      }
      const set = (name, on, value = '1') => {
        if (on) el.dataset[name] = value;
        else delete el.dataset[name];
      };
      el.dataset.phase = view.phase;
      el.dataset.tint = String(view.tint);
      set('play', Boolean(view.play), view.play || '');
      // The artwork faces right. "in" = towards the main character. On a trip
      // with the main character, everybody faces the way they all go.
      const faceRight = travel ? travel.face !== 'left' : side === 'left' ? view.face === 'in' : view.face === 'out';
      set('flip', !faceRight);
      set('travel', Boolean(travel), travel ? travel.mode : '');
      set('fly', view.fly || hover || Boolean(travel && travel.mode === 'fly'));
      set('hop', view.fly && view.phase === 'walk' && !hover);
      set('rest', rest);
      set('skill', Boolean(view.skill), 'open');
      set('near', view.off < 70);
      el.querySelector('.mini-tag span').textContent = view.skill || '';
      // While held, the pointer moves it (dragMove); landing brings it back to the ground.
      if (view.phase !== 'held') {
        el.style.setProperty('--off', `${view.off}px`);
        el.style.setProperty('--lift', '0px');
        el.style.setProperty('--walk', `${view.walkMs}ms`);
      }
      el.style.zIndex = String(view.fly || view.phase === 'leave' ? 20 : 10 - view.slot);
      if (view.phase === 'chat') startTalk();
    }

    function remove(id) {
      const el = els.get(id);
      if (el) el.remove();
      els.delete(id);
      views.delete(id);
    }

    function renderBadge() {
      let text = '';
      if (!template && agentCount > 0) text = strings.helpers.replace('{count}', String(agentCount));
      else if (template && overflow > 0) text = `+${overflow}`;
      badge.textContent = text;
      badge.classList.toggle('show', Boolean(text));
      // Above the outermost visible mini (or the menu column when there are none).
      const spots = director.geo.spots;
      badge.style.setProperty('--off', `${spots.length ? spots[spots.length - 1] : 32}px`);
    }

    function bookIcon() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-book');
      svg.appendChild(use);
      return svg;
    }

    // ---------------------------------------------------------------- chat and notes

    /** Two minis in a chat take turns: the one facing out talks first. */
    function startTalk() {
      if (talkTimer) return;
      const step = () => {
        const chatting = [...views.values()].filter((v) => v.phase === 'chat');
        if (!chatting.length) {
          talkTimer = 0;
          for (const el of els.values()) delete el.dataset.talk;
          return;
        }
        talkFirst = !talkFirst;
        for (const view of chatting) {
          const el = els.get(view.id);
          if (!el) continue;
          if (!rest && (view.face === 'out') === talkFirst) el.dataset.talk = '1';
          else delete el.dataset.talk;
        }
        talkTimer = setTimeout(step, TALK_MS);
      };
      step();
    }

    function give(id, delay = 0) {
      const el = id ? els.get(id) : null;
      if (!el) return;
      setTimeout(() => {
        el.dataset.give = '1';
        setTimeout(() => delete el.dataset.give, GIVE_MS);
      }, delay);
    }

    function cue(name, data) {
      if (name === 'handoff') {
        give(data.from);
        if (data.to) give(data.to, GIVE_MS / 2);
        else o.onCue('receive-note', data);
        return;
      }
      o.onCue(name, data);
    }

    // ---------------------------------------------------------------- hit testing

    /** Tooltip text for the mini element `el` belongs to, or null. */
    function labelAt(el) {
      const mini = el && el.closest && el.closest('.buddy-mini');
      const view = mini && views.get(mini.dataset.id);
      return view ? { el: mini, text: crewLabel(view) } : null;
    }

    function setMenuOpen(open) {
      actors.classList.toggle('menu-open', Boolean(open));
    }

    // ---------------------------------------------------------------- picking minis up

    /** Pointer pressed on a mini element; returns true when there is a mini to hold. */
    function startDrag(target, clientX, clientY) {
      const el = target && target.closest && target.closest('.buddy-mini');
      const view = el && views.get(el.dataset.id);
      if (!view || view.phase === 'leave') return false;
      held = { id: view.id, el, x: clientX, y: clientY, startOff: view.off, off: view.off, lift: 0, grabbed: false };
      return true;
    }

    function dragMove(clientX, clientY) {
      if (!held) return;
      const dx = clientX - held.x;
      const dy = held.y - clientY;
      if (!held.grabbed) {
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        held.grabbed = director.grab(held.id);
        if (!held.grabbed) return;
        o.trace(`crew: ${held.id.slice(0, 4)} picked up`);
      }
      // Outwards is to the left when the crew stands left of the main character.
      held.off = Math.max(director.geo.report, Math.min(director.maxOff(), held.startOff + (side === 'left' ? -dx : dx)));
      held.lift = Math.max(0, Math.min(MAX_LIFT, dy));
      held.el.style.setProperty('--walk', '0ms');
      held.el.style.setProperty('--off', `${held.off}px`);
      held.el.style.setProperty('--lift', `${held.lift}px`);
    }

    /**
     * Pointer released (drop) or the window lost the mouse (also drop, where it
     * is). Returns the id of the mini when it was a click rather than a drag.
     */
    function endDrag() {
      if (!held) return null;
      const { id, grabbed, off } = held;
      held = null;
      if (grabbed) {
        o.trace(`crew: ${id.slice(0, 4)} dropped`);
        director.dropAt(id, off);
        return null;
      }
      return id;
    }

    /**
     * React to a click: 'boop' (a hop), 'ouch' (a lash of the whip),
     * 'annoyed' (hit twice), 'shoo' (hit too often: it huffs and moves away).
     */
    function react(id, how) {
      const el = els.get(id);
      if (!el) return;
      if (how === 'shoo') {
        o.trace(`crew: ${id.slice(0, 4)} shooed`);
        director.shoo(id);
        return;
      }
      const name = how === 'boop' ? 'boop' : how === 'annoyed' ? 'annoyed' : 'ouch';
      delete el.dataset[name];
      void el.offsetWidth; // restart the animation
      el.dataset[name] = '1';
      setTimeout(() => delete el.dataset[name], name === 'annoyed' ? 1400 : BOOP_MS);
    }

    const isHolding = () => Boolean(held && held.grabbed);
    const isPressing = () => Boolean(held);

    return {
      setCharacter,
      setLayout,
      setAgents,
      setHover,
      setTravel,
      setRest,
      setStrings,
      labelAt,
      setMenuOpen,
      startDrag,
      dragMove,
      endDrag,
      react,
      isHolding,
      isPressing,
    };
  }

  window.BuddyCrewView = { createCrewView };
})();
