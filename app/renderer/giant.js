'use strict';

/**
 * The giant peek (app/giant.js plans it, main.js opens this click-through
 * window over the buddy's screen and sends the phases). This page only
 * listens (giant-preload.js):
 *   init   { plan, character: { svgUrl, cssUrl }, look }   draw it where the small one stands, at its size
 *   phase  { phase }   walk | knock | listen | again | wait | shrug | back | found | dash
 *                      (the board: walk | board | back; the stretch break: walk | reach | lean |
 *                      neck | eyes | cheer | skip | back, see app/giant.js)
 *   stop   cut short: gone at once (the window closes right after)
 * The board ("While you were away") is text in a box it holds at its chest; the stretch
 * break's seconds for the eyes are counted down here (plan.count), one a second.
 * The character's own CSS poses it (data-giant on its wrapper, data-glee when
 * it is found); this page moves it (from the small one's spot up to the glass,
 * bigger with every step, and back), draws rings where its knuckles hit the
 * glass, and shows what it says as text. It is never faded in or out: it starts
 * and ends exactly where the small one is, so the two hand over in place.
 * The SVG is inlined after removing scripts, event handlers and external
 * references, as in the main page.
 */
(() => {
  const clip = document.getElementById('clip');
  const body = document.getElementById('giant');
  const char = document.getElementById('giant-char');
  const rings = document.getElementById('rings');
  const bubble = document.getElementById('bubble');
  const bubbleText = bubble.querySelector('span');
  const boardEl = document.getElementById('board');
  const countEl = document.getElementById('count');
  /** The board's signs (renderer/giant.css); anything else is not drawn. */
  const BOARD_KINDS = new Set(['done', 'git', 'waiting', 'bug', 'working']);

  /** The plan from app/giant.js (page px). */
  let plan = null;
  let ready = false;
  /** A phase that came before the SVG was in (the first one, 'walk'). */
  let pending = null;
  /** Timers of the phase on now (rings, a second hop): cleared at the next one. */
  let phaseTimers = [];
  let blinkTimer = null;

  const later = (ms, fn) => phaseTimers.push(setTimeout(fn, ms));
  const px = (n) => `${Math.round(n * 10) / 10}px`;

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

  /** Model looks (robot.css data-model), as in renderer.js. */
  const LOOKS = new Set(['haiku', 'sonnet', 'opus', 'fable']);

  const set = (name, value) => {
    if (value === null || value === undefined || value === false) delete char.dataset[name];
    else char.dataset[name] = String(value);
  };

  const farTransform = () => `translate(${px(plan.far.x)}, ${px(plan.far.y)}) scale(${plan.far.scale})`;

  /** How long a phase lasts in the plan (until the next one). */
  function lasts(phase) {
    const i = plan.phases.findIndex((s) => s.phase === phase);
    return i >= 0 && plan.phases[i + 1] ? plan.phases[i + 1].at - plan.phases[i].at : 2000;
  }

  window.giant.onInit(async (msg) => {
    if (!msg || !msg.plan || !msg.character) return;
    plan = msg.plan;
    clip.style.left = px(plan.clip.x);
    clip.style.top = px(plan.clip.y);
    clip.style.width = px(plan.clip.width);
    clip.style.height = px(plan.clip.height);
    body.style.left = px(plan.left - plan.clip.x);
    body.style.top = px(plan.top - plan.clip.y);
    body.style.width = px(plan.size);
    body.style.height = px(plan.size);
    body.style.transform = farTransform();
    rings.style.setProperty('--ring', px(plan.size * 0.11));
    // The board's sizes are shares of its box (renderer/giant.css --u).
    body.style.setProperty('--u', px(plan.size / 100));
    if (plan.mode === 'board' && plan.board) fillBoard(plan.board);
    set('face', plan.face);
    // The same model look as the small one (robot.css data-model).
    set('model', LOOKS.has(msg.look) ? msg.look : null);
    // Its CSS first (unstyled, every prop of the SVG would show for a moment).
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = msg.character.cssUrl;
    const styled = new Promise((resolve) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1500);
    });
    document.head.appendChild(link);
    try {
      const response = await fetch(msg.character.svgUrl);
      const svg = sanitizeSvg(await response.text());
      await styled;
      char.replaceChildren(svg);
    } catch (err) {
      console.error(`Perchbot giant: ${err.message}`);
      return;
    }
    ready = true;
    if (pending) onPhase(pending);
    pending = null;
  });

  window.giant.onPhase((msg) => {
    const phase = msg && typeof msg.phase === 'string' ? msg.phase : null;
    if (!phase || !plan) return;
    if (!ready) pending = phase;
    else onPhase(phase);
  });

  window.giant.onStop(() => {
    for (const t of phaseTimers) clearTimeout(t);
    phaseTimers = [];
    clearTimeout(blinkTimer);
    body.style.transition = 'none';
    body.classList.add('gone');
    bubble.classList.remove('show');
    countEl.classList.remove('show');
  });

  /** "While you were away": the title and the lines, as text (each line with its sign). */
  function fillBoard(board) {
    boardEl.querySelector('.giant-board-title').textContent = typeof board.title === 'string' ? board.title : '';
    const list = boardEl.querySelector('.giant-board-lines');
    list.replaceChildren();
    for (const line of Array.isArray(board.lines) ? board.lines : []) {
      if (!line || !BOARD_KINDS.has(line.kind) || typeof line.text !== 'string') continue;
      const li = document.createElement('li');
      li.className = line.kind;
      const span = document.createElement('span');
      span.textContent = line.text;
      li.appendChild(span);
      list.appendChild(li);
    }
    boardEl.hidden = false;
    // It carries the board (robot.css data-board: no laptop, no arm swing).
    set('board', true);
  }

  function onPhase(phase) {
    for (const t of phaseTimers) clearTimeout(t);
    phaseTimers = [];
    set('glee', null);
    set('giant', phase);
    // The seconds for the eyes show only while it looks far away.
    if (phase !== 'eyes') countEl.classList.remove('show');
    if (phase === 'board') {
      // Held up: hello beside its head for a moment, the board stays.
      boardEl.classList.add('up');
      say(plan.say.hello);
      later(2600, () => say(null));
      return;
    }
    if (phase === 'reach' || phase === 'lean' || phase === 'neck') {
      say(plan.say[phase]);
      return;
    }
    if (phase === 'eyes') {
      say(plan.say.eyes);
      countDown(plan.count);
      return;
    }
    if (phase === 'cheer' || phase === 'skip') {
      // Done (a happy hop) or skipped ("Okay, later!").
      if (phase === 'cheer') set('glee', true);
      say(plan.say[phase]);
      return;
    }
    if (phase === 'walk') {
      // From where the small one stands, at its size: it walks up to the glass, bigger and
      // bigger with every step (slowly at first, as when someone walks up to you).
      body.classList.add('shown');
      blink();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          body.style.transition = `transform ${lasts('walk')}ms cubic-bezier(0.5, 0, 0.8, 0.6)`;
          body.style.transform = 'none';
        }),
      );
    } else if (phase === 'knock' || phase === 'again') {
      say(null);
      for (const ms of phase === 'knock' ? plan.knockHits : plan.againHits) later(ms, knockRings);
    } else if (phase === 'listen') {
      say(plan.say.listen);
    } else if (phase === 'wait') {
      say(null);
    } else if (phase === 'shrug') {
      say(plan.say.shrug);
    } else if (phase === 'found') {
      // Two happy hops (the character's glee pose), "There you are!".
      set('glee', true);
      later(700, () => {
        set('glee', null);
        requestAnimationFrame(() => set('glee', true));
      });
      say(plan.say.found);
    } else if (phase === 'back' || phase === 'dash') {
      // It turns round and walks back to its spot (found: runs), smaller and smaller, until it is
      // its own size again right where the small one stands (the window closes then).
      later(phase === 'dash' ? 150 : 250, () => say(null));
      boardEl.classList.remove('up');
      const ms = phase === 'dash' ? plan.dashMs || 1500 : lasts('back');
      set('face', plan.backFace);
      body.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.45, 0.5, 1)`;
      body.style.transform = farTransform();
    }
  }

  /** The middle of its near forearm's cuff (near its knuckles), in window px. */
  function knuckles() {
    const cuff = char.querySelector('.rb-forearm-front > rect:nth-of-type(2)');
    if (cuff) {
      const r = cuff.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const b = body.getBoundingClientRect();
    const x = char.dataset.face === 'left' ? 0.23 : 0.77;
    return { x: b.left + b.width * x, y: b.top + b.height * 0.3 };
  }

  function knockRings() {
    const at = knuckles();
    for (const late of [false, true]) {
      const ring = document.createElement('i');
      ring.className = late ? 'giant-ring late' : 'giant-ring';
      ring.style.left = px(at.x);
      ring.style.top = px(at.y);
      ring.addEventListener('animationend', () => ring.remove());
      rings.appendChild(ring);
    }
  }

  /** What it says beside its head, on the side it faces (null: nothing). */
  function say(text) {
    if (!text) {
      bubble.classList.remove('show');
      return;
    }
    bubbleText.textContent = text;
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const facesLeft = char.dataset.face === 'left';
    const x = facesLeft ? plan.left + plan.size * 0.24 - w : plan.left + plan.size * 0.74;
    const y = plan.top + plan.size * 0.14;
    bubble.style.left = px(Math.min(window.innerWidth - w - 8, Math.max(8, x)));
    bubble.style.top = px(Math.min(window.innerHeight - h - 8, Math.max(8, y)));
    bubble.classList.add('show');
  }

  /** Stretch break: twenty seconds for the eyes, one a second, below what it says. */
  function countDown(count) {
    const from = count && Number.isInteger(count.from) && count.from > 0 && count.from <= 60 ? count.from : 20;
    const lead = count && Number.isFinite(count.leadMs) ? count.leadMs : 500;
    for (let i = 0; i < from; i += 1) later(lead + i * 1000, () => showCount(from - i));
  }

  function showCount(n) {
    countEl.textContent = String(n);
    // Below the bubble, on the side it faces (the bubble is placed by say()).
    const w = countEl.offsetWidth;
    const shown = bubble.classList.contains('show');
    const x = shown ? bubble.offsetLeft + bubble.offsetWidth / 2 - w / 2 : plan.left + plan.size * (char.dataset.face === 'left' ? 0.1 : 0.78);
    const y = shown ? bubble.offsetTop + bubble.offsetHeight + 14 : plan.top + plan.size * 0.24;
    countEl.style.left = px(Math.min(window.innerWidth - w - 8, Math.max(8, x)));
    countEl.style.top = px(Math.min(window.innerHeight - countEl.offsetHeight - 8, Math.max(8, y)));
    countEl.classList.remove('tick');
    void countEl.offsetWidth;
    countEl.classList.add('tick', 'show');
  }

  /** It blinks now and then, as in the main page. */
  function blink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      set('blink', true);
      setTimeout(() => set('blink', null), 130);
      blink();
    }, 2400 + Math.random() * 2600);
  }
})();
