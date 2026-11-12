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
 * @param {object} p.on  callbacks: setCorner, setSize, setHoverMode, setCharacter, setLanguage,
 *   setQuiet, setEyeTracking, setAccount, backToCorner, openSettings, quit
 */
function buildTrayTemplate({ settings, characters, sessionCount, seenAccount = () => true, on }) {
  const t = (key, vars) => translate(settings.language, 'menu', key, vars);
  const radio = (label, checked, click) => ({ label, type: 'radio', checked, click });

  return [
    { label: t('title'), enabled: false },
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
      submenu: accountMenu(settings, seenAccount, t, radio, on),
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
  return items;
}

module.exports = { buildTrayTemplate };
