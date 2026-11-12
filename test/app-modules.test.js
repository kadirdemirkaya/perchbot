'use strict';

/** Smaller app modules: validation, characters, i18n, placement, settings, tray menu. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateEvent } = require('../app/validate');
const { discoverCharacters, STATES } = require('../app/characters');
const { LOCALES, translate } = require('../app/i18n');
const { normalizeSettings, loadSettings, saveSettings, rememberAccount, DEFAULTS } = require('../app/settings');
const { buildTrayTemplate, buildFunMenuTemplate } = require('../app/tray');
const { buildMenuItems, MENU_IDS } = require('../app/menu-items');

const ROOT = path.join(__dirname, '..');

test('validateEvent: whitelist, control characters, length limits', () => {
  const evt = validateEvent({
    v: 1,
    event: 'PreToolUse',
    session: 's',
    ts: 5,
    tool: 'Bash',
    id: 'toolu_1',
    detail: 'ls‮ -la\n\u0007' + 'x'.repeat(200),
    secret: 'nope',
  });
  assert.equal(evt.secret, undefined);
  assert.ok(!/[\u0000-\u001f‮]/.test(evt.detail));
  assert.ok(evt.detail.length <= 80);
  assert.equal(validateEvent({ v: 1, event: 'Notification', session: 's', ts: 1, kind: 'Bad Kind' }).kind, undefined);
  assert.equal(validateEvent({ v: 1, event: 'Stop', session: 's', ts: -1 }), null);
  assert.equal(validateEvent({ v: 1, event: 'Stop', session: 's', ts: Infinity }), null);
  assert.equal(validateEvent([]), null);
  assert.equal(validateEvent('x'), null);
});

test('bundled robot character is valid and maps every state', () => {
  const { characters, errors } = discoverCharacters([path.join(ROOT, 'characters')]);
  assert.deepEqual(errors, []);
  const robot = characters.get('robot');
  assert.ok(robot);
  assert.deepEqual(Object.keys(robot.states).sort(), [...STATES].sort());
  assert.equal(robot.license, 'MIT');

  const svg = fs.readFileSync(path.join(robot.dir, robot.svg), 'utf8');
  assert.ok(!/<script/i.test(svg), 'no scripts');
  assert.ok(!/\son\w+\s*=/i.test(svg), 'no event handlers');
  assert.ok(!/(?:xlink:)?href\s*=\s*"(?!#)/i.test(svg), 'no external references');
  assert.ok(!/style\s*=/i.test(svg), 'no inline style attributes (blocked by CSP)');
  assert.ok(!/<image|<text|font-family/i.test(svg), 'no raster images or fonts');

  const css = fs.readFileSync(path.join(robot.dir, robot.css), 'utf8');
  assert.ok(!/url\(|@import/i.test(css), 'no external resources in CSS');
  for (const state of STATES.filter((s) => s !== 'idle')) {
    assert.ok(css.includes(`'${state}'`), `CSS handles ${state}`);
  }
});

test('the bundled robot brings its kids (minis) and its cat (pet), all scripts-free', () => {
  const { characters } = discoverCharacters([path.join(ROOT, 'characters')]);
  const robot = characters.get('robot');
  assert.deepEqual(robot.mini, { svg: 'mini.svg', css: 'mini.css', tints: 5 });
  assert.deepEqual(robot.pet, { svg: 'cat.svg', css: 'cat.css' });
  for (const file of [robot.mini.svg, robot.pet.svg]) {
    const svg = fs.readFileSync(path.join(robot.dir, file), 'utf8');
    assert.ok(!/<script|\son\w+\s*=|style\s*=|<image|<text/i.test(svg), file);
  }
  for (const file of [robot.mini.css, robot.pet.css]) {
    assert.ok(!/url\(|@import/i.test(fs.readFileSync(path.join(robot.dir, file), 'utf8')), file);
  }
});

test('character manifests cannot point outside their folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-buddy-chars-'));
  const make = (id, manifest) => {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'character.json'), JSON.stringify(manifest));
  };
  make('escape', { name: 'x', svg: '../../secret.svg', css: 'a.css' });
  make('missing', { name: 'x', svg: 'nope.svg', css: 'nope.css' });
  make('ok', { name: 'Ok', svg: 'a.svg', css: 'a.css', states: { typing: 'Bad Class!' } });
  fs.writeFileSync(path.join(root, 'ok', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'ok', 'a.css'), '');
  const { characters, errors } = discoverCharacters([root]);
  assert.deepEqual([...characters.keys()], ['ok']);
  assert.equal(errors.length, 2);
  assert.equal(characters.get('ok').states.typing, 'typing', 'invalid class falls back to the state name');
});

test('every locale has the same keys and placeholders as English', () => {
  for (const [code, table] of Object.entries(LOCALES)) {
    for (const section of Object.keys(LOCALES.en).filter((k) => typeof LOCALES.en[k] === 'object')) {
      for (const [key, en] of Object.entries(LOCALES.en[section])) {
        assert.equal(typeof table[section][key], 'string', `${code}.${section}.${key}`);
        const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
        assert.equal(vars(table[section][key]), vars(en), `${code}.${section}.${key} placeholders`);
      }
    }
  }
  assert.equal(translate('tr', 'bubble', 'typing', { file: 'a.js' }), 'a.js düzenleniyor');
  assert.equal(translate('xx', 'bubble', 'done'), 'Done!', 'unknown language falls back to English');
});

test('Demo events: only known behaviours; the hook never sends them', () => {
  const ok = validateEvent({ v: 1, event: 'Demo', session: 'sim', ts: 1, demo: 'anger', extra: 'x' });
  assert.deepEqual(ok, { v: 1, event: 'Demo', session: 'sim', ts: 1, demo: 'anger' });
  assert.equal(validateEvent({ v: 1, event: 'Demo', session: 'sim', ts: 1, demo: 'rm -rf' }), null);
  assert.equal(validateEvent({ v: 1, event: 'Demo', session: 'sim', ts: 1 }), null);
  const send = require('../hooks/send.js');
  assert.equal(send.buildPayload({ hook_event_name: 'Demo', session_id: 's', demo: 'duel' }), null);
});

test('settings: free position and eye tracking are validated', () => {
  assert.deepEqual(normalizeSettings({ position: { x: 100.4, y: 900 } }).position, { x: 100, y: 900 });
  assert.equal(normalizeSettings({ position: { x: 'a', y: 1 } }).position, null);
  assert.equal(normalizeSettings({ position: { x: 1e9, y: 1 } }).position, null);
  assert.equal(normalizeSettings({ eyeTracking: false }).eyeTracking, false);
  assert.equal(normalizeSettings({ eyeTracking: 'no' }).eyeTracking, true);
  assert.equal(normalizeSettings({}).hoverMode, 'auto');
  assert.equal(normalizeSettings({ hoverMode: 'stand' }).hoverMode, 'stand');
  assert.equal(normalizeSettings({ hoverMode: 'fly' }).hoverMode, 'auto');
});

test('characters written before a state existed fall back to an older state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-buddy-chars-'));
  const char = path.join(dir, 'old');
  fs.mkdirSync(char);
  fs.writeFileSync(path.join(char, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(char, 'a.css'), '');
  fs.writeFileSync(
    path.join(char, 'character.json'),
    JSON.stringify({ name: 'Old', svg: 'a.svg', css: 'a.css', states: { waiting: 'hand-up' } }),
  );
  const old = discoverCharacters([dir]).characters.get('old');
  assert.equal(old.states.asking, 'hand-up', 'asking falls back to the declared waiting animation');
  assert.equal(old.states.standby, 'idle');
  assert.equal(old.states.typing, 'typing');
});

test('hover menu items come from settings and are localised', () => {
  const ids = (s) => buildMenuItems({ ...DEFAULTS, ...s }).map((i) => i.id);
  assert.deepEqual(ids({}), ['quiet', 'eyes', 'settings', 'quit']);
  assert.deepEqual(ids({ position: { x: 1, y: 2 } }), ['quiet', 'eyes', 'corner', 'settings', 'quit']);
  const quiet = buildMenuItems({ ...DEFAULTS, quiet: true, language: 'tr' }).find((i) => i.id === 'quiet');
  assert.deepEqual(quiet, { id: 'quiet', icon: 'bubble-off', label: 'Baloncuğu göster' });
  for (const id of ids({ position: { x: 1, y: 2 } })) assert.ok(MENU_IDS.has(id));
  // Every icon used by the menu exists in the page's sprite.
  const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), 'utf8');
  for (const s of [{}, { quiet: true, eyeTracking: false, position: { x: 1, y: 2 } }]) {
    for (const item of buildMenuItems({ ...DEFAULTS, ...s })) assert.ok(html.includes(`id="i-${item.icon}"`), item.icon);
  }
});

test('settings: normalisation, missing and broken files, atomic save', () => {
  assert.deepEqual(normalizeSettings({ corner: 'top-left', size: 'huge', port: 80, language: 'tr', quiet: 'yes' }), {
    ...DEFAULTS,
    language: 'tr',
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-buddy-settings-'));
  const file = path.join(dir, 'nested', 'settings.json');
  assert.deepEqual(loadSettings(file), { settings: { ...DEFAULTS }, error: null });
  saveSettings({ ...DEFAULTS, corner: 'bottom-left' }, file);
  assert.equal(loadSettings(file).settings.corner, 'bottom-left');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'], 'no temp files left behind');
  fs.writeFileSync(file, '{oops');
  const broken = loadSettings(file);
  assert.deepEqual(broken.settings, { ...DEFAULTS });
  assert.match(broken.error, /Could not parse/);
});

test('tray menu reflects settings and calls back', () => {
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const characters = new Map([['robot', { id: 'robot', name: 'Robo', author: 'Agent Buddy contributors' }]]);
  const template = buildTrayTemplate({ settings: { ...DEFAULTS, quiet: true }, characters, sessionCount: 2, on });
  const byLabel = (label) => template.find((item) => item.label === label);
  assert.equal(template[1].label, 'Active sessions: 2');
  assert.equal(byLabel('Quiet mode (hide speech bubble)').checked, true);
  const corner = byLabel('Position').submenu;
  assert.equal(corner.find((i) => i.checked).label, 'Bottom right');
  corner[1].click();
  byLabel('Size').submenu[2].click();
  const hover = byLabel('Hover mode').submenu;
  assert.equal(hover.find((i) => i.checked).label, 'Auto (hover when lifted)');
  hover[1].click();
  byLabel('Language').submenu.find((i) => i.label === 'Türkçe').click();
  assert.equal(byLabel('Eyes follow the cursor').checked, true);
  byLabel('Eyes follow the cursor').click({ checked: false });
  assert.equal(byLabel('Back to the corner'), undefined, 'only shown after a drag');
  byLabel('Quit now').click();
  assert.deepEqual(calls, [
    ['setCorner', 'bottom-left'],
    ['setSize', 'large'],
    ['setHoverMode', 'stand'],
    ['setLanguage', 'tr'],
    ['setEyeTracking', false],
    ['quit'],
  ]);
  const dragged = buildTrayTemplate({ settings: { ...DEFAULTS, position: { x: 5, y: 5 } }, characters, sessionCount: 1, on });
  assert.ok(dragged.find((item) => item.label === 'Back to the corner'));

  const tr = buildTrayTemplate({ settings: { ...DEFAULTS, language: 'tr' }, characters, sessionCount: 1, on });
  assert.equal(tr.at(-1).label, 'Şimdi kapat');
});

test('settings: account filter and known accounts are validated', () => {
  assert.equal(normalizeSettings({}).account, 'all');
  assert.equal(normalizeSettings({ account: 'claude-work' }).account, 'claude-work');
  assert.equal(normalizeSettings({ account: '../x' }).account, 'all');
  assert.deepEqual(normalizeSettings({ knownAccounts: ['a', 'a', 'all', 'b c', 7, 'claude'] }).knownAccounts, ['a', 'claude']);
  assert.equal(normalizeSettings({ knownAccounts: Array.from({ length: 20 }, (_, i) => `acc${i}`) }).knownAccounts.length, 8);
  assert.deepEqual(rememberAccount(['a', 'b'], 'b'), ['b', 'a'], 'most recent first');
  const same = ['a'];
  assert.equal(rememberAccount(same, 'a'), same, 'unchanged: no save needed');
  assert.equal(rememberAccount(same, '../evil'), same);
});

test('tray menu: account submenu, with a note while the chosen account is silent', () => {
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const characters = new Map();
  const settings = { ...DEFAULTS, account: 'claude-work', knownAccounts: ['claude', 'claude-work'] };
  const silent = buildTrayTemplate({ settings, characters, sessionCount: 0, seenAccount: () => false, on });
  const menu = silent.find((i) => i.label === 'Account').submenu;
  assert.equal(menu[0].label, 'All accounts');
  assert.deepEqual(menu.filter((i) => i.type === 'radio').map((i) => i.label), ['All accounts', 'claude', 'claude-work']);
  assert.equal(menu.find((i) => i.checked).label, 'claude-work');
  assert.equal(menu.at(-1).label, 'No events from this account yet');
  assert.equal(menu.at(-1).enabled, false);
  menu[0].click();
  assert.deepEqual(calls, [['setAccount', 'all']]);
  const heard = buildTrayTemplate({ settings, characters, sessionCount: 0, seenAccount: () => true, on });
  assert.ok(!heard.find((i) => i.label === 'Account').submenu.some((i) => i.label === 'No events from this account yet'));
  const tr = buildTrayTemplate({ settings: { ...settings, language: 'tr' }, characters, sessionCount: 0, seenAccount: () => false, on });
  assert.equal(tr.find((i) => i.label === 'Hesap').submenu.at(-1).label, 'Bu hesaptan henüz olay gelmedi');
});

test('ambient life, play mode and the cat: settings, tray, right-click and hover menus', () => {
  assert.equal(normalizeSettings({}).ambientLife, true, 'ambient life on by default');
  assert.equal(normalizeSettings({}).playMode, false, 'play mode off by default');
  assert.equal(normalizeSettings({}).cat, false, 'no cat by default');
  assert.equal(normalizeSettings({ funMode: false }).ambientLife, false, 'the old funMode setting carries over');
  assert.equal(normalizeSettings({ funMode: false, ambientLife: true }).ambientLife, true);
  assert.equal(normalizeSettings({ playMode: 'yes' }).playMode, false);

  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const tray = buildTrayTemplate({ settings: { ...DEFAULTS }, characters: new Map(), sessionCount: 0, on });
  const box = (label) => tray.find((i) => i.label === label);
  assert.equal(box('Ambient life').checked, true);
  assert.equal(box('Play mode').checked, false);
  assert.equal(box('Cat').checked, false);
  box('Ambient life').click({ checked: false });
  box('Play mode').click({ checked: true });
  box('Cat').click({ checked: true });
  assert.deepEqual(calls.splice(0), [['setAmbientLife', false], ['setPlayMode', true], ['setCat', true]]);

  // Defaults: no play, no cat; walks and flights from ambient life.
  const menu = buildFunMenuTemplate({ settings: { ...DEFAULTS }, away: false, on });
  const byLabel = (m, label) => m.find((i) => i.label === label);
  assert.equal(byLabel(menu, 'Play: sword duel').enabled, false);
  assert.equal(byLabel(menu, 'Take the whip').enabled, false);
  assert.equal(byLabel(menu, 'Call the cat').enabled, false);
  byLabel(menu, 'Go for a walk').click();
  byLabel(menu, 'Fly somewhere').click();
  assert.equal(byLabel(menu, 'Come back home').enabled, false, 'already home');
  assert.deepEqual(calls.splice(0), [['trip', 'stroll'], ['trip', 'hop']]);

  const play = buildFunMenuTemplate({ settings: { ...DEFAULTS, playMode: true, cat: true }, away: true, whip: true, catHere: false, on });
  byLabel(play, 'Play: sword duel').click();
  assert.equal(byLabel(play, 'Take the whip').checked, true);
  byLabel(play, 'Take the whip').click({ checked: false });
  byLabel(play, 'Call the cat').click();
  byLabel(play, 'Come back home').click();
  assert.deepEqual(calls.splice(0), [['duel'], ['setWhip', false], ['cat', true], ['trip', 'home']]);
  const catHere = buildFunMenuTemplate({ settings: { ...DEFAULTS, cat: true }, away: false, catHere: true, on });
  byLabel(catHere, 'Send the cat away').click();
  assert.deepEqual(calls.splice(0), [['cat', false]]);

  const still = buildFunMenuTemplate({ settings: { ...DEFAULTS, ambientLife: false, hoverMode: 'stand' }, away: false, on });
  assert.equal(byLabel(still, 'Go for a walk').enabled, false, 'no trips without ambient life');
  assert.equal(byLabel(still, 'Fly somewhere').enabled, false);
  const tr = buildFunMenuTemplate({ settings: { ...DEFAULTS, language: 'tr' }, away: false, on });
  assert.equal(tr[0].label, 'Oyna: kılıç düellosu');

  // Hover menu: a Play button in play mode, a cat button when the cat is enabled.
  const ids = (s, x) => buildMenuItems({ ...DEFAULTS, ...s }, x).map((i) => i.id);
  assert.ok(!ids({}).includes('play') && !ids({}).includes('cat'));
  assert.ok(ids({ playMode: true }).includes('play'));
  assert.ok(MENU_IDS.has('play') && MENU_IDS.has('cat'));
  const cat = (x) => buildMenuItems({ ...DEFAULTS, cat: true }, x).find((i) => i.id === 'cat').label;
  assert.equal(cat({}), 'Call the cat');
  assert.equal(cat({ catHere: true }), 'Send the cat away');
});
