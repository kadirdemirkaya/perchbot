'use strict';

/**
 * A helper roaming the screen (main.js outings): draws one mini and poses it
 * the way main.js says. main.js moves the window; this page only sets the
 * attributes the character's mini.css animates:
 *   init  { mini: { svgUrl, cssUrl }, tint }   what to draw (shows faded in)
 *   pose  { move: 'walk' | 'fly' | null, face: 'left' | 'right', pose: 'look' | 'play' | 'prank', play }
 *         ('prank': a grinning poke at the cursor)
 *   fade  'out' | 'in'
 * The SVG is inlined after removing scripts, event handlers and external
 * references, as in the main page.
 */
(() => {
  const box = document.getElementById('mini');

  function sanitizeSvg(markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      throw new Error('mini SVG could not be parsed');
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

  const set = (name, value) => {
    if (value === null || value === undefined || value === false) delete box.dataset[name];
    else box.dataset[name] = String(value);
  };

  window.helper.onInit(async (msg) => {
    if (!msg || !msg.mini) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = msg.mini.cssUrl;
    document.head.appendChild(link);
    try {
      const response = await fetch(msg.mini.svgUrl);
      box.replaceChildren(sanitizeSvg(await response.text()));
    } catch (err) {
      console.error(`Agent Buddy helper: ${err.message}`);
      return;
    }
    set('tint', Number.isInteger(msg.tint) ? msg.tint : 0);
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('faded')));
  });

  window.helper.onPose((p) => {
    if (!p) return;
    set('flip', p.face === 'left' ? '1' : null);
    set('fly', p.move === 'fly' ? '1' : null);
    set('travel', p.move === 'walk' ? 'walk' : null);
    set('play', p.pose === 'play' && typeof p.play === 'string' ? p.play : null);
    set('phase', p.move ? 'walk' : p.pose === 'play' ? 'play' : p.pose === 'prank' ? 'prank' : 'look');
  });

  window.helper.onFade((how) => {
    document.body.classList.toggle('faded', how === 'out');
  });
})();
