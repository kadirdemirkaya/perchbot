'use strict';

/**
 * The rocket fist's effect window (app/fist.js plans it, main.js opens this
 * page in a click-through window over the buddy's screen): the buddy's
 * forearm, off at the elbow, flies to a Chrome button on a jet of flame,
 * pushes it (main presses the button at that moment, through UI Automation)
 * and flies back onto the arm.
 *
 *   out    from the elbow to the button, faster and faster, smoke behind it
 *   hold   a push into the button, a ring of light and a few sparks
 *   back   back to the elbow, the jet small
 *
 * The forearm is the robot's own (same shapes and colours as robot.svg),
 * drawn along +x: the elbow joint at 0, the middle of the hand at 20. It
 * moves frame by frame only while it flies; nothing is sent back.
 */

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const stage = document.getElementById('stage');
  const fx = document.getElementById('fx');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** The hand's middle, from the elbow joint (robot.svg units). */
  const HAND = 20;

  let stopped = false;
  let frame = 0;

  function svg(name, attrs, parent) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (parent) parent.appendChild(el);
    return el;
  }

  function spark(className, x, y, ms, vars = {}) {
    const el = document.createElement('i');
    el.className = className;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    fx.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /** The forearm with its jet, pointing along +x. */
  function makeFist(size) {
    const outer = svg('g', { class: 'fist' }, stage);
    const g = svg('g', { transform: `scale(${size})` }, outer);
    // The jet out of the elbow end.
    svg('path', { class: 'fist-flame', d: 'M-4 -5.5 Q-16 -6 -30 0 Q-16 6 -4 5.5 Z', fill: '#FF7A2E', opacity: 0.92 }, g);
    svg('path', { class: 'fist-flame', d: 'M-4 -3.2 Q-12 -3.4 -20 0 Q-12 3.4 -4 3.2 Z', fill: '#FFD25A' }, g);
    // The forearm (robot.svg .rb-forearm-front, turned to lie along +x).
    svg('rect', { x: -4, y: -6, width: 23, height: 12, rx: 6, fill: '#7462D6', stroke: '#2A2650', 'stroke-width': 2.6 }, g);
    svg('rect', { x: 9, y: -5.2, width: 3.6, height: 10.4, fill: '#4FD6B4' }, g);
    // The elbow end glows where it came off.
    svg('circle', { class: 'fist-glow', cx: 0, cy: 0, r: 3.6, fill: '#FFB347', stroke: '#2A2650', 'stroke-width': 1.6 }, g);
    // The hand.
    svg('circle', { cx: HAND, cy: 0, r: 6.8, fill: '#FFF6E8', stroke: '#2A2650', 'stroke-width': 2.6 }, g);
    return outer;
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const easeIn = (t) => t * t * (0.35 + 0.65 * t);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  function fly(p) {
    const a = (p.angle * Math.PI) / 180;
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const reach = HAND * p.size;
    // The elbow end: at the elbow when it leaves; the middle of the hand on the button when it hits.
    const start = { x: p.from.x, y: p.from.y };
    const hit = { x: p.to.x - dir.x * reach, y: p.to.y - dir.y * reach };
    const fist = makeFist(p.size);
    const place = (pt, push = 0) => {
      const x = pt.x + dir.x * push;
      const y = pt.y + dir.y * push;
      fist.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${p.angle})`);
    };
    place(start);
    const t0 = performance.now();
    let lastPuff = 0;
    let hitDone = false;
    const total = p.outMs + p.holdMs + p.backMs;

    function step(now) {
      if (stopped) return;
      const t = now - t0;
      let at;
      if (t < p.outMs) {
        const k = easeIn(t / p.outMs);
        at = { x: lerp(start.x, hit.x, k), y: lerp(start.y, hit.y, k) };
        place(at);
      } else if (t < p.outMs + p.holdMs) {
        at = hit;
        if (!hitDone) {
          hitDone = true;
          spark('fist-hit', p.to.x, p.to.y, 400);
          if (!reducedMotion.matches) {
            for (let i = 0; i < 5; i += 1) {
              const b = a + Math.PI + (i - 2) * 0.55;
              spark('fist-spark', p.to.x, p.to.y, 450, { '--dx': `${Math.round(Math.cos(b) * 26)}px`, '--dy': `${Math.round(Math.sin(b) * 26)}px` });
            }
          }
        }
        // A push into the button and back.
        const k = (t - p.outMs) / p.holdMs;
        place(hit, Math.sin(k * Math.PI) * 5 * p.size);
      } else if (t < total) {
        fist.classList.add('back');
        const k = easeInOut((t - p.outMs - p.holdMs) / p.backMs);
        at = { x: lerp(hit.x, start.x, k), y: lerp(hit.y, start.y, k) };
        place(at);
      } else {
        fist.remove();
        return;
      }
      // Smoke behind the jet while it flies out.
      if (at && t < p.outMs && now - lastPuff > 55 && !reducedMotion.matches) {
        lastPuff = now;
        const tail = 26 * p.size;
        spark('fist-puff', at.x - dir.x * tail, at.y - dir.y * tail, 650, { '--s': (0.5 + Math.random() * 0.4).toFixed(2) });
      }
      frame = requestAnimationFrame(step);
    }
    frame = requestAnimationFrame(step);
  }

  window.effects.onPlan((plan) => {
    if (!plan || plan.kind !== 'fist' || stopped) return;
    fly(plan);
  });

  window.effects.onStop(() => {
    stopped = true;
    cancelAnimationFrame(frame);
    stage.replaceChildren();
    fx.replaceChildren();
  });
})();
