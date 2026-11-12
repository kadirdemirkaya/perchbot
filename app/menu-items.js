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

/**
 * Order = order on screen: two columns, row by row, the first column on the
 * outer side. Play and the cat come right after the first row so they keep
 * their place whether "Back to the corner" is shown or not.
 */
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
  // Always there, so nobody has to find the switch first: a click turns play
  // mode on by itself (see switchFor). During a duel the page keeps only this
  // button and shows activeLabel; a second click ends the duel.
  { id: 'play', icon: () => 'sword', label: () => 'play', activeLabel: () => 'playStop' },
  // Call the cat (turns the Cat switch on by itself), or send it off again.
  // Only for characters that have a pet.
  {
    id: 'cat',
    icon: () => 'cat',
    label: (s, x) => (x.catHere ? 'catAway' : 'catCall'),
    visible: (s, x) => x.pet !== false,
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

/**
 * @param {object} settings
 * @param {{ catHere?: boolean, pet?: boolean }} [extra]  runtime state: the cat is
 *   on screen; the character has a pet (default true)
 * @returns {Array<{ id: string, icon: string, label: string, activeLabel?: string }>}
 */
function buildMenuItems(settings, extra = {}) {
  const t = (key) => translate(settings.language, 'hover', key);
  return ITEMS.filter((item) => !item.visible || item.visible(settings, extra)).map((item) => {
    const out = { id: item.id, icon: item.icon(settings), label: t(item.label(settings, extra)) };
    if (item.activeLabel) out.activeLabel = t(item.activeLabel(settings, extra));
    return out;
  });
}

/** The switch a menu action needs: the duel needs play mode, calling the cat the Cat switch. */
const NEEDS = { play: 'playMode', cat: 'cat' };

/**
 * The settings patch that turns on what an action needs, or null when it is
 * on already (or the action needs nothing).
 * @param {string} action  'play' | 'cat' | any other menu id
 * @param {object} settings
 * @returns {object|null}
 */
function switchFor(action, settings) {
  const key = NEEDS[action];
  return key && !settings[key] ? { [key]: true } : null;
}

module.exports = { buildMenuItems, MENU_IDS, switchFor };
