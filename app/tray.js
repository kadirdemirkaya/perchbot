'use strict';

/**
 * Builds the tray menu template. Pure function (no Electron import) so the
 * structure can be unit-tested; main.js passes it to Menu.buildFromTemplate.
 */

const { translate, languageOptions } = require('./i18n');

/**
 * @param {object} p
 * @param {object} p.settings
 * @param {Map<string, object>} p.characters
 * @param {number} p.sessionCount
 * @param {(account: string) => boolean} [p.seenAccount]  did that account send events in this run?
 * @param {boolean} [p.soundAvailable]  the sound feature is switched on (app/features.js)
 * @param {string|null} [p.instance]  one buddy per account: the account this buddy is for
 * @param {object} p.on  callbacks: setCorner, setSize, setHoverMode, setCharacter, setLanguage,
 *   setQuiet, setEyeTracking, setAmbientLife, setPlayMode, setCat, setSound, setSoundVolume,
 *   setAccount, setPerAccount, backToCorner, openSettings, quit
 */
function buildTrayTemplate({ settings, characters, sessionCount, seenAccount = () => true, soundAvailable = false, instance = null, on }) {
  const t = (key, vars) => translate(settings.language, 'menu', key, vars);
  const radio = (label, checked, click) => ({ label, type: 'radio', checked, click });

  return [
    { label: instance ? `${t('title')} · ${instance}` : t('title'), enabled: false },
    { label: t('sessions', { count: sessionCount }), enabled: false },
    { type: 'separator' },
    {
      label: t('corner'),
      submenu: [
        radio(t('bottomRight'), settings.corner === 'bottom-right', () => on.setCorner('bottom-right')),
        radio(t('bottomLeft'), settings.corner === 'bottom-left', () => on.setCorner('bottom-left')),
      ],
    },
    {
      label: t('size'),
      submenu: ['small', 'medium', 'large'].map((size) =>
        radio(t(size), settings.size === size, () => on.setSize(size)),
      ),
    },
    {
      label: t('hoverMode'),
      submenu: [
        radio(t('hoverAuto'), settings.hoverMode !== 'stand', () => on.setHoverMode('auto')),
        radio(t('hoverStand'), settings.hoverMode === 'stand', () => on.setHoverMode('stand')),
      ],
    },
    {
      label: t('account'),
      submenu: instance ? instanceMenu(instance, t, on) : accountMenu(settings, seenAccount, t, radio, on),
    },
    {
      label: t('character'),
      submenu: [...characters.values()].map((c) =>
        radio(t('characterBy', { name: c.name, author: c.author }), settings.character === c.id, () =>
          on.setCharacter(c.id),
        ),
      ),
    },
    {
      label: t('language'),
      submenu: languageOptions().map((lang) =>
        radio(lang.name, settings.language === lang.code, () => on.setLanguage(lang.code)),
      ),
    },
    {
      label: t('quiet'),
      type: 'checkbox',
      checked: settings.quiet,
      click: (item) => on.setQuiet(Boolean(item && item.checked)),
    },
    {
      label: t('eyeTracking'),
      type: 'checkbox',
      checked: settings.eyeTracking,
      click: (item) => on.setEyeTracking(Boolean(item && item.checked)),
    },
    ...lifeToggles(settings, t, on),
    ...(soundAvailable ? soundItems(settings, t, radio, on) : []),
    ...(settings.position ? [{ label: t('backToCorner'), click: () => on.backToCorner() }] : []),
    { type: 'separator' },
    { label: t('openSettings'), click: () => on.openSettings() },
    { label: t('quit'), click: () => on.quit() },
  ];
}

/**
 * "All accounts" plus every account seen so far (and the selected one, even if
 * it was never seen). A note when the selected account has sent nothing yet.
 */
function accountMenu(settings, seenAccount, t, radio, on) {
  const selected = settings.account || 'all';
  const names = [...(settings.knownAccounts || [])];
  if (selected !== 'all' && !names.includes(selected)) names.unshift(selected);
  const items = [radio(t('allAccounts'), selected === 'all', () => on.setAccount('all'))];
  if (names.length) items.push({ type: 'separator' });
  for (const name of names) items.push(radio(name, selected === name, () => on.setAccount(name)));
  if (selected !== 'all' && !seenAccount(selected)) {
    items.push({ type: 'separator' }, { label: t('noAccountEvents'), enabled: false });
  }
  items.push({ type: 'separator' }, perAccountBox(false, t, on));
  return items;
}

/** One buddy per account: which account this one is for, and the way back to one buddy. */
function instanceMenu(instance, t, on) {
  return [{ label: t('thisAccount', { name: instance }), enabled: false }, { type: 'separator' }, perAccountBox(true, t, on)];
}

function perAccountBox(checked, t, on) {
  return { label: t('perAccount'), type: 'checkbox', checked, click: (item) => on.setPerAccount(Boolean(item && item.checked)) };
}

/** Sound on / off and the volume (only while the sound feature is switched on). */
function soundItems(settings, t, radio, on) {
  return [
    {
      label: t('sound'),
      type: 'checkbox',
      checked: Boolean(settings.sound),
      click: (item) => on.setSound(Boolean(item && item.checked)),
    },
    {
      label: t('workSounds'),
      type: 'checkbox',
      checked: settings.workSounds !== false,
      enabled: Boolean(settings.sound),
      click: (item) => on.setWorkSounds(Boolean(item && item.checked)),
    },
    {
      label: t('soundVolume'),
      submenu: ['low', 'medium', 'high'].map((level) =>
        radio(t(`volume_${level}`), (settings.soundVolume || 'low') === level, () => on.setSoundVolume(level)),
      ),
    },
  ];
}

/** The three switches for the buddy's own life, shared by the tray and the right-click menu. */
function lifeToggles(settings, t, on) {
  const box = (key, checked, set) => ({ label: t(key), type: 'checkbox', checked, click: (item) => set(Boolean(item && item.checked)) });
  return [
    box('ambientLife', settings.ambientLife !== false, on.setAmbientLife),
    box('stayPut', Boolean(settings.stayPut), on.setStayPut),
    box('playMode', Boolean(settings.playMode), on.setPlayMode),
    box('cat', Boolean(settings.cat), on.setCat),
    box('hands', Boolean(settings.hands), on.setHands),
  ];
}

/**
 * The right-click menu on the character: Play (the duel) and the whip (play
 * mode), a walk, a flight, back home (ambient life), the cat, and the three
 * switches.
 * @param {object} p
 * @param {object} p.settings
 * @param {boolean} p.away  the character is somewhere else than its home spot
 * @param {boolean} [p.whip]  the whip is in the user's hand
 * @param {boolean} [p.catHere]  the cat is on screen
 * @param {boolean} [p.pet]  the character has a pet (default true)
 * @param {object} p.on  callbacks: duel, setWhip(bool), trip(kind), cat(bool),
 *   setAmbientLife, setPlayMode, setCat
 */
function buildFunMenuTemplate({ settings, away, whip = false, catHere = false, pet = true, on }) {
  const t = (key) => translate(settings.language, 'fun', key);
  const life = settings.ambientLife !== false;
  const play = Boolean(settings.playMode);
  return [
    // The duel and the cat turn their switch on by themselves (as in the hover menu).
    { label: t('duel'), click: () => on.duel() },
    {
      label: t('whip'),
      type: 'checkbox',
      checked: Boolean(whip) && play,
      enabled: play,
      click: (item) => on.setWhip(Boolean(item && item.checked)),
    },
    { type: 'separator' },
    { label: t('walk'), enabled: life, click: () => on.trip('stroll') },
    { label: t('fly'), enabled: life && settings.hoverMode !== 'stand', click: () => on.trip('hop') },
    { label: t('home'), enabled: Boolean(away), click: () => on.trip('home') },
    { type: 'separator' },
    { label: t(catHere ? 'catAway' : 'catCall'), enabled: Boolean(pet), click: () => on.cat(!catHere) },
    { type: 'separator' },
    ...lifeToggles(settings, (key) => translate(settings.language, 'menu', key), on),
  ];
}

module.exports = { buildTrayTemplate, buildFunMenuTemplate };
