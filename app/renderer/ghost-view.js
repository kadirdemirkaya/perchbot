'use strict';

/**
 * Ghost view (Follow Windows, app/recycle.js): the ghost of a file or folder the user just
 * deleted in Windows, standing at the buddy's feet where its sword comes down (the bug's
 * spot, placement.bugSpot), until the cut. One <div class="buddy-ghost"> inside #actors.
 * It never takes the mouse. Original simple drawings: a page (or a folder) with a ghost's
 * wavy hem and a startled face; its colour tells the type (data-kind, overlay.css):
 * pdf red, word blue, image green, folder yellow, other teal. No name is ever shown.
 *
 * data-phase: rise (it floats up and bobs) -> cut (two halves slide apart and fade, a
 * flash along the cut, little stars) | fade (gone without a cut: the show was stopped).
 */
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KINDS = new Set(['pdf', 'word', 'image', 'folder', 'other']);
  const INK = '#2A2650';

  /** A page with a folded corner and a wavy hem (viewBox 48 x 48). */
  const PAGE = [
    ['path', { class: 'gh-body', d: 'M11 4h18l9 9v29l-4.5-3-4.5 3-4.5-3-4.5 3-4.5-3-4.5 3z', stroke: INK, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }],
    ['path', { class: 'gh-accent', d: 'M29 4v9h9z', stroke: INK, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }],
  ];
  /** A folder with a tab and a wavy hem. */
  const FOLDER = [
    ['path', { class: 'gh-accent', d: 'M6 12h12l4 4H6z', stroke: INK, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }],
    ['path', { class: 'gh-body', d: 'M6 16h36v24l-4.5-3-4.5 3-4.5-3-4.5 3-4.5-3-4.5 3-4.5-3-4.5 3z', stroke: INK, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }],
  ];
  /** The face: two eyes with a shine, and a little "oh!" (dy moves it down for the folder). */
  const face = (dy) => [
    ['circle', { cx: 19.5, cy: 22 + dy, r: 2.6, fill: INK }],
    ['circle', { cx: 28.5, cy: 22 + dy, r: 2.6, fill: INK }],
    ['circle', { cx: 20.3, cy: 21.2 + dy, r: 0.9, fill: '#FFFFFF' }],
    ['circle', { cx: 29.3, cy: 21.2 + dy, r: 0.9, fill: '#FFFFFF' }],
    ['ellipse', { cx: 24, cy: 29.5 + dy, rx: 1.9, ry: 2.3, fill: INK }],
  ];

  function draw(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = kind === 'folder' ? [...FOLDER, ...face(4)] : [...PAGE, ...face(0)];
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value));
      svg.appendChild(shape);
    }
    return svg;
  }

  /** The stars of the cut (angle in degrees, distance in px), as the bug's poof. */
  const STARS = [
    [-150, 24],
    [-95, 28],
    [-40, 24],
    [15, 22],
    [70, 20],
  ];
  /** overlay.css ghost-cut / ghost-fade. */
  const EXIT_MS = 900;
  /** A little bigger than the bug that sits on the same spot (a file is a bigger thing). */
  const SIZE = 1.2;

  /**
   * @param {object} o
   * @param {HTMLElement} o.actors
   * @param {(message: string) => void} o.trace
   */
  function createGhostView(o) {
    let el = null;
    let removeTimer = null;

    function remove() {
      clearTimeout(removeTimer);
      removeTimer = null;
      if (el) el.remove();
      el = null;
    }

    /**
     * A new ghost at the sword's spot.
     * @param {{ kind: string, count?: number, spot?: { x: number, size: number } }} g
     */
    function show(g) {
      remove();
      const kind = g && KINDS.has(g.kind) ? g.kind : 'other';
      el = document.createElement('div');
      el.className = 'buddy-ghost';
      el.dataset.kind = kind;
      el.dataset.phase = 'rise';
      const spot = g && g.spot;
      if (spot && Number.isFinite(spot.x)) el.style.setProperty('--off', `${spot.x}px`);
      if (spot && Number.isFinite(spot.size)) el.style.setProperty('--ghost-size', `${Math.round(spot.size * SIZE)}px`);
      // The same drawing twice, each clipped to one side of the cut (overlay.css).
      for (const half of ['a', 'b']) {
        const part = document.createElement('div');
        part.className = `gh-half gh-${half}`;
        part.appendChild(draw(kind));
        el.appendChild(part);
      }
      const count = g && Number.isInteger(g.count) ? g.count : 1;
      if (count > 1) {
        const badge = document.createElement('span');
        badge.className = 'gh-count';
        badge.textContent = `×${Math.min(count, 99)}${count > 99 ? '+' : ''}`;
        el.appendChild(badge);
      }
      o.actors.appendChild(el);
      o.trace(`windows: a ghost (${kind}${count > 1 ? ` x${count}` : ''}) rises`);
    }

    /** The blade went through: two halves, a flash, stars; gone a moment later. */
    function cut() {
      if (!el || el.dataset.phase !== 'rise') return;
      el.dataset.phase = 'cut';
      const flash = document.createElement('i');
      flash.className = 'gh-flash';
      el.appendChild(flash);
      for (const [angle, distance] of STARS) {
        const star = document.createElement('i');
        star.className = 'bug-star';
        star.style.setProperty('--a', `${angle}deg`);
        star.style.setProperty('--r', `${distance}px`);
        el.appendChild(star);
      }
      o.trace('windows: the ghost is cut');
      const gone = el;
      removeTimer = setTimeout(() => gone === el && remove(), EXIT_MS);
    }

    /** The show ended: a ghost not cut yet just fades away. */
    function clear() {
      if (!el || el.dataset.phase !== 'rise') return;
      el.dataset.phase = 'fade';
      const gone = el;
      removeTimer = setTimeout(() => gone === el && remove(), EXIT_MS);
    }

    /** Its middle in page coordinates (for the spark of the cut), or null. */
    function point() {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.5 };
    }

    return {
      show,
      cut,
      clear,
      point,
      /** A ghost is there, not cut yet. */
      get here() {
        return Boolean(el && el.dataset.phase === 'rise');
      },
    };
  }

  window.BuddyGhostView = { createGhostView };
})();
