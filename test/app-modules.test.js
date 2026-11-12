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
const { normalizeSettings, loadSettings, saveSettings, DEFAULTS } = require('../app/settings');
const { buildTrayTemplate } = require('../app/tray');
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
