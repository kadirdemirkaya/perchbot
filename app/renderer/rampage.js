'use strict';

/**
 * The rampage's effect window (app/rampage.js plans it, main.js opens this
 * page in a click-through window over the buddy's screen):
 *
 *   beams     two red beams from the buddy's eyes sweep along a line, then
 *             along more lines elsewhere; each line is left burnt (a dark
 *             char with a hot core that cools)
 *   missiles  fly out of the hatch in its chest on arcs, with smoke trails;
 *             each one bursts (flash, shock ring, debris, smoke) and leaves
 *             a blast mark with cracks and glowing embers
 *   chase     for five seconds the beams go after the cursor (main.js says
 *             where it is: its position only), a little slower than a quick
 *             hand, burning a trail; missiles fly at where the cursor is
 *   heal      5-10 s after the last blast the marks sparkle and fade away
 *
 * Only the beams and the missiles in flight move frame by frame (a shared
 * requestAnimationFrame that runs only while something flies); everything
 * else is a short CSS animation, and the marks are still pictures. All text
 * free; nothing is sent back to the main process.
 */

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const burns = document.getElementById('burns');
  const fx = document.getElementById('fx');
  const beams = document.getElementById('beams');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let timers = [];
  let stopped = false;

  function at(ms, fn) {
    timers.push(setTimeout(() => !stopped && fn(), Math.max(0, ms)));
  }

  function svg(name, attrs, parent) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (parent) parent.appendChild(el);
    return el;
  }

  /** A short-lived effect element at (x, y): removed when its animation is over. */
  function spark(className, x, y, ms, vars = {}) {
    const el = document.createElement('i');
    el.className = className;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    fx.appendChild(el);
    setTimeout(() => el.remove(), ms);
    return el;
  }

  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const easeIn = (t) => t * t * (0.4 + 0.6 * t);

  // ---------------------------------------------------------------- one frame loop for what flies

  const movers = new Set();
  let ticking = false;

  function tick(now) {
    for (const m of [...movers]) if (stopped || m(now) === false) movers.delete(m);
    if (movers.size && !stopped) requestAnimationFrame(tick);
    else ticking = false;
  }

  function move(fn) {
    movers.add(fn);
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(tick);
    }
  }

  // ---------------------------------------------------------------- the beams

  function fireBeams(l) {
    const d = `M${l.from.x} ${l.from.y} Q${l.ctrl.x} ${l.ctrl.y} ${l.to.x} ${l.to.y}`;
    // The burn: a wide soot halo, the charred line, and a hot core that cools down.
    const ash = svg('path', { d, class: 'scorch-ash' }, burns);
    const halo = svg('path', { d, class: 'scorch-halo' }, burns);
    const char = svg('path', { d, class: 'scorch-line' }, burns);
    const hot = svg('path', { d, class: 'scorch-hot' }, burns);
    const len = char.getTotalLength();
    for (const p of [ash, halo, char, hot]) {
      p.style.strokeDasharray = `${len} ${len}`;
      p.style.strokeDashoffset = `${len}`;
    }
    const lines = l.eyes.map((eye) =>
      ['glow', 'ray', 'core'].map((kind) => svg('line', { class: `beam-${kind}`, x1: eye.x, y1: eye.y, x2: eye.x, y2: eye.y }, beams)),
    );
    const flares = l.eyes.map((eye) => spark('eye-flare', eye.x, eye.y, l.ms + 200));
    document.body.classList.add('firing');
    const spot = document.createElement('i');
    spot.className = 'hit-spot';
    fx.appendChild(spot);
    const start = performance.now();
    let lastPuff = 0;
    move((now) => {
      const t = Math.min(1, (now - start) / l.ms);
      const done = len * easeInOut(t);
      const p = char.getPointAtLength(done);
      for (const group of lines) {
        for (const line of group) {
          line.setAttribute('x2', p.x.toFixed(1));
          line.setAttribute('y2', p.y.toFixed(1));
        }
      }
      spot.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      const off = `${(len - done).toFixed(1)}`;
      ash.style.strokeDashoffset = off;
      halo.style.strokeDashoffset = off;
      char.style.strokeDashoffset = off;
      hot.style.strokeDashoffset = off;
      if (now - lastPuff > 90) {
        lastPuff = now;
        spark('smoke smoke-small', p.x + rand(-6, 6), p.y + rand(-6, 6), 1300, { '--dx': `${rand(-14, 14).toFixed(0)}px` });
        for (let i = 0; i < 2; i += 1) {
          spark('cinder', p.x, p.y, 700, { '--dx': `${rand(-46, 46).toFixed(0)}px`, '--dy': `${rand(-50, 10).toFixed(0)}px` });
        }
      }
      if (t < 1) return true;
      beams.replaceChildren();
      document.body.classList.remove('firing');
      spot.remove();
      for (const f of flares) f.remove();
      hot.classList.add('cool');
      return false;
    });
  }

  // ---------------------------------------------------------------- the missiles

  function missileSprite() {
    const el = svg('svg', { class: 'missile', viewBox: '0 0 40 16' });
    // Flame at the tail (flickers), fins, body, a window band, a red nose.
    svg('path', { class: 'missile-flame', d: 'M9 5 Q1 8 9 11 Q5 8 9 5 Z' }, el);
    svg('path', { d: 'M12 2 L17 6 H12 Z M12 14 L17 10 H12 Z', fill: '#4FD6B4', stroke: '#2A2650', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }, el);
    svg('rect', { x: '9.5', y: '5', width: '22', height: '6', rx: '3', fill: '#EDEAF7', stroke: '#2A2650', 'stroke-width': '1.6' }, el);
    svg('rect', { x: '18', y: '5', width: '3', height: '6', fill: '#8C7BEA' }, el);
    svg('path', { d: 'M30 5 Q37 6 38.5 8 Q37 10 30 11 Z', fill: '#FF5A6E', stroke: '#2A2650', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }, el);
    return el;
  }

  function launch(m) {
    const d = `M${m.from.x} ${m.from.y} Q${m.ctrl.x} ${m.ctrl.y} ${m.to.x} ${m.to.y}`;
    // An invisible copy of the route, to measure it (in the page: lengths need a laid-out element).
    const route = svg('path', { d, fill: 'none', stroke: 'none' }, burns.querySelector('defs'));
    const len = route.getTotalLength();
    const sprite = missileSprite();
    fx.appendChild(sprite);
    spark('launch-puff', m.from.x, m.from.y, 900);
    const start = performance.now();
    let lastPuff = 0;
    move((now) => {
      const t = Math.min(1, (now - start) / m.ms);
      const s = len * easeIn(t);
      const p = route.getPointAtLength(s);
      const q = route.getPointAtLength(Math.min(len, s + 2));
      const back = s >= len - 2 ? route.getPointAtLength(Math.max(0, s - 2)) : p;
      const angle = Math.atan2(q.y - back.y, q.x - back.x) * (180 / Math.PI);
      sprite.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${angle.toFixed(1)}deg)`;
      if (now - lastPuff > 24) {
        lastPuff = now;
        spark('smoke smoke-trail', p.x, p.y, 900, { '--dx': `${rand(-8, 8).toFixed(0)}px` });
      }
      if (t < 1) return true;
      sprite.remove();
      route.remove();
      blast(m.to);
      return false;
    });
  }

  // ---------------------------------------------------------------- the chase: after the cursor

  /** Where the cursor is (page px), or null: on another screen, or not told yet. */
  let aim = null;
  /** Where the chasing beams hit now (missiles fly there when the cursor is away). */
  let chasePoint = null;

  function chase(c) {
    let p = { x: c.from.x, y: c.from.y };
    chasePoint = p;
    // The trail it burns: the same layers as the burn line, a path that grows as it goes.
    let d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    const trail = ['scorch-ash', 'scorch-halo', 'scorch-line', 'scorch-hot'].map((cls) => svg('path', { d, class: cls }, burns));
    let last = { ...p };
    const lines = c.eyes.map((eye) =>
      ['glow', 'ray', 'core'].map((kind) => svg('line', { class: `beam-${kind}`, x1: eye.x, y1: eye.y, x2: p.x, y2: p.y }, beams)),
    );
    const flares = c.eyes.map((eye) => spark('eye-flare', eye.x, eye.y, c.ms + 200));
    document.body.classList.add('firing');
    const spot = document.createElement('i');
    spot.className = 'hit-spot';
    fx.appendChild(spot);
    const start = performance.now();
    let prev = start;
    let lastPuff = 0;
    /** Where the beams were drawn last frame: nothing to redraw while they rest on the cursor. */
    let drawn = null;
    move((now) => {
      const dt = Math.min(64, now - prev) / 1000;
      prev = now;
      // Towards the cursor, at most c.speed px a second.
      if (aim) {
        const dx = aim.x - p.x;
        const dy = aim.y - p.y;
        const dist = Math.hypot(dx, dy);
        const step = c.speed * dt;
        p = dist <= step ? { x: aim.x, y: aim.y } : { x: p.x + (dx / dist) * step, y: p.y + (dy / dist) * step };
        chasePoint = p;
      }
      if (!drawn || drawn.x !== p.x || drawn.y !== p.y) {
        drawn = p;
        for (const group of lines) {
          for (const line of group) {
            line.setAttribute('x2', p.x.toFixed(1));
            line.setAttribute('y2', p.y.toFixed(1));
          }
        }
        spot.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      }
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 6) {
        last = { ...p };
        d += ` L${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        for (const path of trail) path.setAttribute('d', d);
      }
      if (now - lastPuff > 140) {
        lastPuff = now;
        spark('smoke smoke-small', p.x + rand(-6, 6), p.y + rand(-6, 6), 1300, { '--dx': `${rand(-14, 14).toFixed(0)}px` });
        spark('cinder', p.x, p.y, 700, { '--dx': `${rand(-46, 46).toFixed(0)}px`, '--dy': `${rand(-50, 10).toFixed(0)}px` });
      }
      if (now - start < c.ms) return true;
      beams.replaceChildren();
      document.body.classList.remove('firing');
      spot.remove();
      for (const f of flares) f.remove();
      trail[3].classList.add('cool');
      return false;
    });
  }

  /** A chasing missile: out of the hatch, up and over, at where the cursor is now. */
  function launchAt(c, l) {
    const target = aim || chasePoint || c.from;
    const area = c.area;
    const to = {
      x: Math.round(Math.min(area.x + area.width - 20, Math.max(area.x + 20, target.x))),
      y: Math.round(Math.min(area.y + area.height - 20, Math.max(area.y + 20, target.y))),
    };
    const top = Math.min(c.hatch.y, to.y) - (120 + Math.random() * 160);
    const ctrl = { x: Math.round((c.hatch.x + to.x) / 2 + rand(-120, 120)), y: Math.round(Math.max(area.y + 12, top)) };
    launch({ from: { ...c.hatch }, ctrl, to, ms: l.ms });
  }

  // ---------------------------------------------------------------- a blast and its mark

  function blast(p) {
    spark('blast-flash', p.x, p.y, 600);
    spark('blast-ring', p.x, p.y, 750);
    spark('blast-ring blast-ring-late', p.x, p.y, 900);
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2 + rand(-0.3, 0.3);
      const r = rand(50, 110);
      spark(i % 3 ? 'debris' : 'debris debris-hot', p.x, p.y, 900, {
        '--dx': `${(Math.cos(a) * r).toFixed(0)}px`,
        '--dy': `${(Math.sin(a) * r - 30).toFixed(0)}px`,
        '--rot': `${rand(-540, 540).toFixed(0)}deg`,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      spark('smoke smoke-big', p.x + rand(-22, 22), p.y + rand(-10, 10), 2200, {
        '--dx': `${rand(-30, 30).toFixed(0)}px`,
        '--d': `${(i * 0.12).toFixed(2)}s`,
      });
    }
    blastMark(p);
  }

  /** A blotch of soot with cracks running out of it and a few embers that cool down. */
  function blastMark(p) {
    const g = svg('g', { class: 'mark', transform: `translate(${p.x} ${p.y}) rotate(${rand(0, 360).toFixed(0)})` }, burns);
    const blob = (lo, hi) => {
      const points = [];
      const n = 16;
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2;
        const r = rand(lo, hi);
        points.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r * 0.84).toFixed(1)}`);
      }
      return points.join(' ');
    };
    // Ash around it (it shows on dark windows too), the char, a rim that glows and cools.
    svg('polygon', { points: blob(70, 96), class: 'mark-ash' }, g);
    svg('polygon', { points: blob(46, 68), fill: 'url(#char)' }, g);
    svg('ellipse', { rx: '30', ry: '25', class: 'mark-rim' }, g);
    // Chips thrown out of it.
    for (let i = 0; i < 7; i += 1) {
      const a = rand(0, Math.PI * 2);
      const r = rand(70, 110);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * 0.84;
      const k = rand(3, 6);
      const pts = [
        [x - k, y],
        [x, y - k * 0.8],
        [x + k, y + k * 0.4],
      ];
      svg('polygon', { points: pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' '), class: 'mark-chip' }, g);
    }
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + rand(-0.35, 0.35);
      let x = Math.cos(a) * 18;
      let y = Math.sin(a) * 18;
      let path = `M${x.toFixed(1)} ${y.toFixed(1)}`;
      for (let k = 0; k < 3; k += 1) {
        const step = rand(16, 28);
        const turn = a + rand(-0.6, 0.6);
        x += Math.cos(turn) * step;
        y += Math.sin(turn) * step;
        path += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      svg('path', { d: path, class: 'crack' }, g);
    }
    svg('circle', { r: '34', fill: 'url(#glow)', class: 'mark-glow' }, g);
    for (let i = 0; i < 9; i += 1) {
      const a = rand(0, Math.PI * 2);
      const r = rand(4, 34);
      svg('circle', { cx: (Math.cos(a) * r).toFixed(1), cy: (Math.sin(a) * r).toFixed(1), r: rand(1.6, 3.4).toFixed(1), class: 'ember' }, g).style.setProperty(
        'animation-delay',
        `${rand(0, 0.6).toFixed(2)}s`,
      );
    }
  }

  // ---------------------------------------------------------------- healing: the marks sparkle and fade

  function heal(ms) {
    document.body.style.setProperty('--heal-ms', `${ms}ms`);
    document.body.classList.add('healing');
    const spots = [...burns.querySelectorAll('.mark')].map((g) => {
      const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') || '');
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });
    for (const line of burns.querySelectorAll('.scorch-line')) {
      const len = line.getTotalLength();
      if (len > 0) for (const f of [0.15, 0.5, 0.85]) spots.push(line.getPointAtLength(len * f));
    }
    spots.filter(Boolean).forEach((p, i) => {
      for (let k = 0; k < 3; k += 1) {
        spark('sparkle', p.x + rand(-30, 30), p.y + rand(-24, 24), 1200, { '--d': `${(i * 0.06 + k * 0.15).toFixed(2)}s` });
      }
    });
  }

  // ---------------------------------------------------------------- the show

  window.effects.onPlan((plan) => {
    if (!plan || typeof plan !== 'object' || !plan.laser) return;
    stopped = false;
    if (reducedMotion.matches) return;
    at(plan.laser.at, () => fireBeams(plan.laser));
    for (const b of Array.isArray(plan.beams) ? plan.beams : []) {
      if (b && Array.isArray(b.eyes) && b.from && b.ctrl && b.to) at(b.at, () => fireBeams(b));
    }
    for (const m of plan.missiles || []) at(m.at, () => launch(m));
    const c = plan.chase;
    if (c && Array.isArray(c.eyes) && c.hatch && c.from && c.area) {
      at(c.at, () => chase(c));
      for (const l of c.launches || []) at(l.at, () => launchAt(c, l));
    }
    at(plan.healAt, () => heal(Math.max(200, plan.endAt - plan.healAt)));
  });

  // Where the cursor is, during the chase (a position, or null).
  window.effects.onAim((p) => {
    aim = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  });

  window.effects.onStop(() => {
    stopped = true;
    for (const id of timers) clearTimeout(id);
    timers = [];
    movers.clear();
    beams.replaceChildren();
    fx.replaceChildren();
  });
})();
