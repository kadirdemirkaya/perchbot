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
  { id: 'settings', icon: () => 'gear', label: () => 'moreSettings' },
  { id: 'quit', icon: () => 'power', label: () => 'quit' },
];

const MENU_IDS = new Set(ITEMS.map((item) => item.id));

/** @returns {Array<{ id: string, icon: string, label: string, active: boolean }>} */
function buildMenuItems(settings) {
  return ITEMS.filter((item) => !item.visible || item.visible(settings)).map((item) => ({
    id: item.id,
    icon: item.icon(settings),
    label: translate(settings.language, 'hover', item.label(settings)),
  }));
}

module.exports = { buildMenuItems, MENU_IDS };
