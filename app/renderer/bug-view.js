'use strict';

/**
 * Bug view (bug hunt, app/bugs.js): draws the little red bug beside the buddy.
 * One <div class="buddy-bug"> inside #actors, placed like the cat (an outward
 * offset from the slot edge, layout.bug.x). It never takes the mouse.
 *
 * data-phase on the wrapper: arrive (sits and wiggles) | fight (dodges while
 * the robot fights it; the page sets it) -> squash (the page's finishing blow,
 * with a poof of stars) | escape (gone unfixed). data-hit: a strike connected,
 * a short flinch; data-hop: it hopped out of the way of one. data-rest stops
 * it (the buddy rests, the screen is locked).
 *
 * 'fixed' from the main process does not squash it by itself: the page does,
 * when the robot's last strike lands (or at once without motion).
 */
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Original simple drawing: a round red ladybug-ish beetle, cute, not scary. */
  const SHAPES = [
    // legs (three a side), drawn first so the body covers their roots
    ['path', { class: 'bb-legs', d: 'M14 26l-7-4M14 31H6M15 36l-7 4M34 26l7-4M34 31h8M33 36l7 4', fill: 'none', stroke: '#2A2650', 'stroke-width': 2.4, 'stroke-linecap': 'round' }],
    // antennae
    ['path', { class: 'bb-antennae', d: 'M20 14Q17 7 13 6M28 14Q31 7 35 6', fill: 'none', stroke: '#2A2650', 'stroke-width': 2.2, 'stroke-linecap': 'round' }],
    // head
    ['circle', { cx: 24, cy: 17, r: 7, fill: '#2A2650' }],
    // body: red shell with a middle line and dots
    ['ellipse', { cx: 24, cy: 31, rx: 12, ry: 12.5, fill: '#E2577A', stroke: '#2A2650', 'stroke-width': 2.4 }],
    ['path', { d: 'M24 19.5V43', stroke: '#2A2650', 'stroke-width': 1.8 }],
    ['circle', { cx: 18.5, cy: 28, r: 2.2, fill: '#2A2650' }],
    ['circle', { cx: 29.5, cy: 28, r: 2.2, fill: '#2A2650' }],
    ['circle', { cx: 19.5, cy: 36, r: 1.8, fill: '#2A2650' }],
    ['circle', { cx: 28.5, cy: 36, r: 1.8, fill: '#2A2650' }],
    // eyes
    ['circle', { cx: 21.3, cy: 16, r: 2.1, fill: '#FFFFFF' }],
    ['circle', { cx: 26.7, cy: 16, r: 2.1, fill: '#FFFFFF' }],
    ['circle', { cx: 21.7, cy: 16.4, r: 0.9, fill: '#2A2650' }],
    ['circle', { cx: 27.1, cy: 16.4, r: 0.9, fill: '#2A2650' }],
  ];

  function drawBug() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of SHAPES) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value));
      svg.appendChild(shape);
    }
    return svg;
  }

  /** The poof when it is squashed: little stars flying out (angle in degrees, distance in px). */
  const STARS = [
    [-160, 26],
    [-115, 30],
    [-70, 28],
    [-25, 26],
    [20, 22],
  ];
  /** overlay.css bug-flinch / bug-hop. */
  const REACT_MS = { hit: 320, hop: 500 };
  /** overlay.css bug-arrive: it lands first, then it may dodge. */
  const ARRIVE_MS = 600;

  /**
   * @param {object} o
   * @param {HTMLElement} o.actors
   * @param {(message: string) => void} o.trace
   */
  function createBugView(o) {
    let el = null;
    let spot = null;
    let current = null;
    let resting = false;
    let hitTimer = null;
    let fightTimer = null;
    let bornAt = 0;

    function setLayout(layout) {
      spot = layout && layout.bug ? layout.bug : null;
      if (spot) o.actors.style.setProperty('--bug-size', `${spot.size}px`);
      if (el && spot) el.style.setProperty('--off', `${spot.x}px`);
    }

    function remove() {
      clearTimeout(hitTimer);
      clearTimeout(fightTimer);
      if (el) el.remove();
      el = null;
    }

    /** bug: { id, phase: 'open' | 'fixed' | 'escaped' } or null (from the main process). */
    function setBug(bug) {
      if (!bug) {
        remove();
        current = null;
        return;
      }
      if (!el || !current || current.id !== bug.id) {
        remove();
        el = document.createElement('div');
        el.className = 'buddy-bug';
        el.appendChild(drawBug());
        if (spot) el.style.setProperty('--off', `${spot.x}px`);
        if (resting) el.dataset.rest = '1';
        el.dataset.phase = 'arrive';
        bornAt = performance.now();
        o.actors.appendChild(el);
        o.trace(`bug: ${bug.id} arrives`);
      }
      current = bug;
      if (bug.phase === 'escaped' && el.dataset.phase !== 'squash') {
        clearTimeout(fightTimer);
        el.dataset.phase = 'escape';
        o.trace(`bug: ${bug.id} escapes`);
      }
    }

    /** The page's fight loop: the bug dodges ('fight'), or just sits ('arrive'). */
    function setFight(on) {
      clearTimeout(fightTimer);
      if (!el || !current || current.phase === 'escaped' || el.dataset.phase === 'squash') return;
      const landing = ARRIVE_MS - (performance.now() - bornAt);
      if (on && landing > 0) {
        fightTimer = setTimeout(() => setFight(true), landing);
        return;
      }
      el.dataset.phase = on ? 'fight' : 'arrive';
    }

    /** 'hit': a strike connected, a short flinch. 'hop': it jumped out of the way. */
    function react(kind) {
      if (!el || !REACT_MS[kind] || el.dataset.phase === 'squash' || el.dataset.phase === 'escape') return;
      delete el.dataset.hit;
      delete el.dataset.hop;
      void el.offsetWidth; // restart the animation
      el.dataset[kind] = '1';
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        if (el) delete el.dataset[kind];
      }, REACT_MS[kind]);
    }

    /** The finishing blow (or the fix without motion): flattened, a poof of stars, gone. */
    function squash() {
      if (!el || el.dataset.phase === 'squash') return;
      clearTimeout(fightTimer);
      delete el.dataset.hit;
      delete el.dataset.hop;
      el.dataset.phase = 'squash';
      for (const [angle, distance] of STARS) {
        const star = document.createElement('i');
        star.className = 'bug-star';
        star.style.setProperty('--a', `${angle}deg`);
        star.style.setProperty('--r', `${distance}px`);
        el.appendChild(star);
      }
      o.trace(`bug: ${current ? current.id : '?'} squashed`);
    }

    /** Its middle in page coordinates (for the spark of a strike), or null. */
    function point() {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
    }

    function setRest(value) {
      resting = Boolean(value);
      if (!el) return;
      if (resting) el.dataset.rest = '1';
      else delete el.dataset.rest;
    }

    return {
      setLayout,
      setBug,
      setFight,
      flinch: () => react('hit'),
      dodge: () => react('hop'),
      squash,
      point,
      setRest,
      /** A bug is there and not beaten or gone yet. */
      get here() {
        return Boolean(el && current && current.phase !== 'escaped' && el.dataset.phase !== 'squash');
      },
    };
  }

  window.BuddyBugView = { createBugView };
})();
