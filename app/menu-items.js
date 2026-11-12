'use strict';

/**
 * The hover menu next to the character, as data. The renderer draws whatever
 * this returns; clicks come back as an item id and are handled in main.js.
 *
 * To add a feature to the menu: add an entry to ITEMS (an id, an icon from
 * app/renderer/index.html's sprite, a label key in locales "hover"), and a
 * handler for the id in main.js.
 */

const { translate } = require('./i18n');

/** Order = order on screen (top to bottom). */
const ITEMS = [
  {
    id: 'quiet',
    icon: (s) => (s.quiet ? 'bubble-off' : 'bubble'),
    label: (s) => (s.quiet ? 'showBubble' : 'hideBubble'),
  },
  {
    id: 'eyes',
    icon: (s) => (s.eyeTracking ? 'eye' : 'eye-off'),
    label: (s) => (s.eyeTracking ? 'eyesOff' : 'eyesOn'),
  },
  {
    id: 'corner',
    icon: () => 'corner',
    label: () => 'backToCorner',
    visible: (s) => Boolean(s.position),
  },
  // Play mode: a sword duel. Cat: call it, or send it off again.
  { id: 'play', icon: () => 'sword', label: () => 'play', visible: (s) => Boolean(s.playMode) },
  { id: 'cat', icon: () => 'cat', label: (s, x) => (x && x.catHere ? 'catAway' : 'catCall'), visible: (s) => Boolean(s.cat) },
  { id: 'settings', icon: () => 'gear', label: () => 'moreSettings' },
  { id: 'quit', icon: () => 'power', label: () => 'quit' },
];

const MENU_IDS = new Set(ITEMS.map((item) => item.id));

/**
 * @param {object} settings
 * @param {{ catHere?: boolean }} [extra]  runtime state that changes a label
 * @returns {Array<{ id: string, icon: string, label: string }>}
 */
function buildMenuItems(settings, extra = {}) {
  return ITEMS.filter((item) => !item.visible || item.visible(settings)).map((item) => ({
    id: item.id,
    icon: item.icon(settings),
    label: translate(settings.language, 'hover', item.label(settings, extra)),
  }));
}

module.exports = { buildMenuItems, MENU_IDS };
