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
const { buildMenuItems, MENU_IDS, switchFor } = require('../app/menu-items');

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

test('validateEvent: a pid only on SessionStart, only a positive integer', () => {
  const start = (pid) => validateEvent({ v: 1, event: 'SessionStart', session: 's', ts: 1, pid }).pid;
  assert.equal(start(10552), 10552);
  for (const bad of [0, -3, 2.5, '10552', 2 ** 33, null, undefined]) assert.equal(start(bad), undefined, String(bad));
  assert.equal(validateEvent({ v: 1, event: 'Stop', session: 's', ts: 1, pid: 10552 }).pid, undefined);
  assert.equal(validateEvent({ v: 1, event: 'UserPromptSubmit', session: 's', ts: 1, pid: 10552 }).pid, undefined);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-chars-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-chars-'));
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
  const ids = (s, x) => buildMenuItems({ ...DEFAULTS, ...s }, x).map((i) => i.id);
  assert.deepEqual(ids({}), ['quiet', 'eyes', 'play', 'cat', 'chat', 'settings', 'quit', 'giant']);
  assert.deepEqual(ids({ position: { x: 1, y: 2 } }), ['quiet', 'eyes', 'play', 'cat', 'chat', 'corner', 'settings', 'quit', 'giant']);
  const most = ids({ position: { x: 1, y: 2 } }, { soundAvailable: true });
  assert.deepEqual(most, ['quiet', 'eyes', 'play', 'cat', 'chat', 'sound', 'corner', 'settings', 'quit', 'giant']);
  // Two columns of 30 px buttons, rows 36 px apart from y = 70: five rows (to y = 244) fit the 270 px window
  // (a sixth only with every ball there, Follow Windows too: see the giant peek's test).
  assert.ok(Math.ceil(most.length / 2) <= 5, 'at most five rows');
  const quiet = buildMenuItems({ ...DEFAULTS, quiet: true, language: 'tr' }).find((i) => i.id === 'quiet');
  assert.deepEqual(quiet, { id: 'quiet', icon: 'bubble-off', label: 'Baloncuğu göster' });
  for (const id of most) assert.ok(MENU_IDS.has(id));
  // Every icon used by the menu exists in the page's sprite.
  const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), 'utf8');
  for (const s of [{}, { quiet: true, eyeTracking: false, sound: true, position: { x: 1, y: 2 } }]) {
    for (const item of buildMenuItems({ ...DEFAULTS, ...s }, { soundAvailable: true })) assert.ok(html.includes(`id="i-${item.icon}"`), item.icon);
  }
});

test('features: sounds are available (the setting switches them on), and the page agrees', () => {
  const FEATURES = require('../app/features');
  assert.equal(FEATURES.sound, true, 'the user switches sounds on and off in the settings');
  // The page loads lib/sound.js exactly when the feature is on (comments do not count).
  const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/<script[^>]+src="lib\/sound\.js"/.test(html), FEATURES.sound);
  // With the feature on: a speaker button in the hover menu and Sound / Volume in the tray.
  assert.ok(buildMenuItems({ ...DEFAULTS, sound: true }, { soundAvailable: FEATURES.sound }).find((i) => i.id === 'sound'));
  const tray = buildTrayTemplate({ settings: { ...DEFAULTS, sound: true }, characters: new Map(), sessionCount: 0, soundAvailable: FEATURES.sound, on: {} });
  assert.ok(tray.some((item) => item.label === 'Sound' || item.label === 'Volume'), 'tray entries');
  // Switched off, they would all be gone again.
  assert.equal(buildMenuItems({ ...DEFAULTS, sound: true }, { soundAvailable: false }).find((i) => i.id === 'sound'), undefined);
});

test('settings: normalisation, missing and broken files, atomic save', () => {
  assert.deepEqual(normalizeSettings({ corner: 'top-left', size: 'huge', port: 80, language: 'tr', quiet: 'yes' }), {
    ...DEFAULTS,
    language: 'tr',
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-settings-'));
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
  const characters = new Map([['robot', { id: 'robot', name: 'Robo', author: 'Perchbot contributors' }]]);
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

  // Sound (only while the feature is switched on): off by default; a volume submenu.
  assert.equal(byLabel('Sound'), undefined, 'no sound entries while the feature is off');
  calls.length = 0;
  const withSound = buildTrayTemplate({ settings: { ...DEFAULTS }, characters, sessionCount: 2, soundAvailable: true, on });
  const soundEntry = (label) => withSound.find((item) => item.label === label);
  assert.equal(soundEntry('Sound').checked, false);
  soundEntry('Sound').click({ checked: true });
  const volume = soundEntry('Volume').submenu;
  assert.deepEqual(volume.map((i) => i.label), ['Low', 'Medium', 'High']);
  assert.equal(volume.find((i) => i.checked).label, 'Low');
  volume[2].click();
  assert.deepEqual(calls, [['setSound', true], ['setSoundVolume', 'high']]);
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
  const note = menu.find((i) => i.label === 'No events from this account yet');
  assert.equal(note.enabled, false);
  menu[0].click();
  assert.deepEqual(calls, [['setAccount', 'all']]);
  // Last: one buddy per account (off here).
  assert.deepEqual([menu.at(-1).label, menu.at(-1).type, menu.at(-1).checked], ['One buddy per account', 'checkbox', false]);
  menu.at(-1).click({ checked: true });
  assert.deepEqual(calls.at(-1), ['setPerAccount', true]);
  const heard = buildTrayTemplate({ settings, characters, sessionCount: 0, seenAccount: () => true, on });
  assert.ok(!heard.find((i) => i.label === 'Account').submenu.some((i) => i.label === 'No events from this account yet'));
  const tr = buildTrayTemplate({ settings: { ...settings, language: 'tr' }, characters, sessionCount: 0, seenAccount: () => false, on });
  assert.ok(tr.find((i) => i.label === 'Hesap').submenu.some((i) => i.label === 'Bu hesaptan henüz olay gelmedi'));
});

test('tray menu: a buddy of its own account says which one, and leads back to one buddy for all', () => {
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const settings = { ...DEFAULTS, perAccount: true, knownAccounts: ['claude', 'claude-work'] };
  const menu = buildTrayTemplate({ settings, characters: new Map(), sessionCount: 1, instance: 'claude-work', on });
  assert.equal(menu[0].label, 'Perchbot · claude-work');
  const account = menu.find((i) => i.label === 'Account').submenu;
  assert.ok(!account.some((i) => i.type === 'radio'), 'no account filter: it only shows its own');
  assert.equal(account[0].label, 'This buddy: claude-work');
  assert.deepEqual([account.at(-1).type, account.at(-1).checked], ['checkbox', true]);
  account.at(-1).click({ checked: false });
  assert.deepEqual(calls, [['setPerAccount', false]]);
  const tr = buildTrayTemplate({ settings: { ...settings, language: 'tr' }, characters: new Map(), sessionCount: 1, instance: 'claude-work', on });
  assert.equal(tr.find((i) => i.label === 'Hesap').submenu[0].label, 'Bu bot: claude-work');
  // One buddy for all: the title as before.
  assert.equal(buildTrayTemplate({ settings: DEFAULTS, characters: new Map(), sessionCount: 0, on })[0].label, 'Perchbot');
});

test('ambient life, play mode and the cat: settings, tray, right-click and hover menus', () => {
  assert.equal(normalizeSettings({}).ambientLife, true, 'ambient life on by default');
  assert.equal(normalizeSettings({}).playMode, false, 'play mode off by default');
  assert.equal(normalizeSettings({}).sound, false, 'sounds off by default');
  assert.equal(normalizeSettings({}).soundVolume, 'low');
  assert.equal(normalizeSettings({ sound: true, soundVolume: 'high' }).soundVolume, 'high');
  assert.equal(normalizeSettings({ sound: 'yes', soundVolume: 11 }).sound, false);
  assert.equal(normalizeSettings({ soundVolume: 11 }).soundVolume, 'low');
  const soundItem = (s) => buildMenuItems({ ...DEFAULTS, ...s }, { soundAvailable: true }).find((i) => i.id === 'sound');
  assert.deepEqual(soundItem({}), { id: 'sound', icon: 'sound-off', label: 'Turn sounds on' });
  assert.deepEqual(soundItem({ sound: true, language: 'tr' }), { id: 'sound', icon: 'sound', label: 'Sesleri kapat' });
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

  // Defaults: the duel and the cat are offered anyway (they turn their switch on),
  // the whip needs play mode; walks and flights from ambient life.
  const menu = buildFunMenuTemplate({ settings: { ...DEFAULTS }, away: false, on });
  const byLabel = (m, label) => m.find((i) => i.label === label);
  assert.notEqual(byLabel(menu, 'Play: sword duel').enabled, false);
  assert.equal(byLabel(menu, 'Take the whip').enabled, false);
  assert.notEqual(byLabel(menu, 'Call the cat').enabled, false);
  byLabel(menu, 'Play: sword duel').click();
  byLabel(menu, 'Call the cat').click();
  byLabel(menu, 'Go for a walk').click();
  byLabel(menu, 'Fly somewhere').click();
  assert.equal(byLabel(menu, 'Come back home').enabled, false, 'already home');
  assert.deepEqual(calls.splice(0), [['duel'], ['cat', true], ['trip', 'stroll'], ['trip', 'hop']]);
  const petless = buildFunMenuTemplate({ settings: { ...DEFAULTS, cat: true }, away: false, pet: false, on });
  assert.equal(byLabel(petless, 'Call the cat').enabled, false, 'a character without a pet');

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

  // Hover menu: Play and the cat are always there, also with their switches off.
  const ids = (s, x) => buildMenuItems({ ...DEFAULTS, ...s }, x).map((i) => i.id);
  assert.ok(ids({}).includes('play') && ids({}).includes('cat'));
  assert.ok(!ids({}, { pet: false }).includes('cat'), 'no cat button for a character without a pet');
  assert.ok(MENU_IDS.has('play') && MENU_IDS.has('cat'));
  const playItem = (s) => buildMenuItems({ ...DEFAULTS, ...s }).find((i) => i.id === 'play');
  assert.deepEqual(playItem({}), { id: 'play', icon: 'sword', label: 'Play: sword duel', activeLabel: 'Stop the duel' });
  assert.deepEqual(playItem({ language: 'tr' }), { id: 'play', icon: 'sword', label: 'Oyna: kılıç düellosu', activeLabel: 'Düelloyu bitir' });
  const cat = (x) => buildMenuItems({ ...DEFAULTS }, x).find((i) => i.id === 'cat').label;
  assert.equal(cat({}), 'Call the cat');
  assert.equal(cat({ catHere: true }), 'Send the cat away');
  assert.equal(buildMenuItems({ ...DEFAULTS, language: 'tr' }).find((i) => i.id === 'cat').label, 'Kediyi çağır');

  // A button turns on the switch it needs, once; other buttons need nothing.
  assert.deepEqual(switchFor('play', { ...DEFAULTS }), { playMode: true });
  assert.equal(switchFor('play', { ...DEFAULTS, playMode: true }), null);
  assert.deepEqual(switchFor('cat', { ...DEFAULTS }), { cat: true });
  assert.equal(switchFor('cat', { ...DEFAULTS, cat: true }), null);
  assert.equal(switchFor('quiet', { ...DEFAULTS }), null);
});
