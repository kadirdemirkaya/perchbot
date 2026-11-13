'use strict';

/** Hands (app/hands.js): open a tab / close the last tab in Chrome, only when asked. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createHands, parseAnswer, encodedCommand, SCRIPT, NEW_TAB_NAMES } = require('../app/hands');
const { matchIntent, handIntent } = require('../app/renderer/lib/chat-match');
const chat = require('../app/chat');
const { DEFAULTS, normalizeSettings } = require('../app/settings');
const { buildTrayTemplate } = require('../app/tray');
const { planTrip, REACH_TOP } = require('../app/roam');
const { validateEvent } = require('../app/validate');

const ROOT = path.join(__dirname, '..');

test('typed commands: short "aç" / "kapat" style texts, only with hands on', () => {
  for (const text of ['aç', 'Aç!', 'sekme aç', 'yeni sekme', 'yeni bir sekme aç', 'open', 'open a new tab', 'new tab', 'sekme açar mısın']) {
    assert.equal(handIntent(text), 'newtab', text);
    assert.equal(matchIntent(text, { hands: true }), 'newtab', text);
  }
  for (const text of ['kapat', 'sekmeyi kapat', 'son sekmeyi kapat', 'kapatır mısın', 'close', 'close the tab', 'kapa']) {
    assert.equal(handIntent(text), 'closetab', text);
  }
  // Hands off: never a command.
  assert.notEqual(matchIntent('kapat', { hands: false }), 'closetab');
  assert.notEqual(matchIntent('aç'), 'newtab');
  // Questions and longer texts stay questions.
  for (const text of ['ne yapıyorsun', 'açıklar mısın ne yapıyorsun', 'acil durum', 'how long have you been working on this one now', 'sekme']) {
    assert.equal(handIntent(text), null, text);
  }
  assert.equal(matchIntent('ne yapıyorsun', { hands: true }), 'doing');
});

test('chat: the two commands are accepted, and offered first in the panel while hands are on', () => {
  assert.deepEqual(chat.parseChatRequest({ op: 'ask', intent: 'newtab' }), { op: 'ask', intent: 'newtab' });
  assert.deepEqual(chat.parseChatRequest({ op: 'ask', intent: 'closetab' }), { op: 'ask', intent: 'closetab' });
  assert.equal(chat.parseChatRequest({ op: 'ask', intent: 'rmrf' }), null);
  const off = chat.panelStrings('tr').questions.map((q) => q.id);
  assert.ok(!off.includes('newtab'));
  const on = chat.panelStrings('tr', { hands: true }).questions;
  assert.deepEqual(on.slice(0, 2).map((q) => q.id), ['newtab', 'closetab']);
  assert.deepEqual(on.slice(0, 2).map((q) => q.label), ['Yeni sekme aç', 'Son sekmeyi kapat']);
  // Intent ids pass the page bridge's check (lower case letters only).
  for (const id of chat.HAND_INTENTS) assert.match(id, /^[a-z]{2,12}$/);
});

test('hands: off by default, a tray switch, words in both languages, the press pose', () => {
  assert.equal(DEFAULTS.hands, false);
  assert.equal(normalizeSettings({ hands: true }).hands, true);
  assert.equal(normalizeSettings({ hands: 'yes' }).hands, false);
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const menu = buildTrayTemplate({ settings: { ...DEFAULTS, language: 'tr' }, characters: new Map(), sessionCount: 0, on });
  const item = menu.find((i) => i.label === 'Eller: Chrome sekmeleri');
  assert.equal(item.checked, false);
  item.click({ checked: true });
  assert.deepEqual(calls, [['setHands', true]]);
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['q_newtab', 'q_closetab', 'handsOff', 'handsOnlyWindows', 'handsNewTab', 'handsCloseTab', 'handsNoChrome', 'handsLastTab', 'handsNoButton']) {
      assert.ok(strings.chat[key], `${lang}: ${key}`);
    }
    assert.ok(strings.menu.hands);
  }
  const css = fs.readFileSync(path.join(ROOT, 'characters', 'robot', 'robot.css'), 'utf8');
  assert.ok(css.includes('.buddy-character[data-press] .rb-arm-front {'));
  assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: 'press' }));
  const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');
  assert.ok(preload.includes("onHands: on('buddy:hands')"));
});

test('reach: it may fly close to the top of the screen to press a button there, cursor or not', () => {
  const workArea = { x: 0, y: 0, width: 1536, height: 912 };
  const from = { x: 1300, y: 912 };
  const to = { x: 700, y: REACH_TOP + 10 };
  const reach = planTrip({ kind: 'reach', from, home: from, workArea, to, cursor: to });
  assert.deepEqual(reach.to, to, 'exactly there, even with the cursor right there');
  const goto = planTrip({ kind: 'goto', from, home: from, workArea, to });
  assert.ok(goto.to.y > to.y, 'an ordinary trip keeps the window on the screen');
  assert.equal(planTrip({ kind: 'reach', from, home: from, workArea, to: { x: 700, y: 20 } }).to.y, REACH_TOP, 'not above REACH_TOP');
});

test('the helper: Chrome only, button frames only, no titles, no files, no network', () => {
  // Only button names are looked at, to find "new tab"; never a tab's name (its title).
  const names = SCRIPT.match(/\$\w+\.Current\.Name/g) || [];
  assert.deepEqual([...new Set(names)], ['$b.Current.Name']);
  assert.ok(!/\$(tab|last|t\.tab)\.Current\.Name/.test(SCRIPT));
  assert.ok(!/ValuePattern|TextPattern|LegacyIAccessible|Out-File|Set-Content|Add-Content|Invoke-WebRequest|Invoke-RestMethod|Start-Process|SetCursorPos|mouse_event|SendInput|SendKeys/i.test(SCRIPT));
  assert.ok(SCRIPT.includes('Get-Process chrome'));
  assert.ok(SCRIPT.includes("'Chrome_WidgetWin_1'"));
  assert.ok(SCRIPT.includes('InvokePattern'));
  assert.ok(SCRIPT.includes("if ($tabs.Count -le 1) { return @{ why = 'last' } }"), 'never the only tab');
  for (const name of NEW_TAB_NAMES) assert.ok(SCRIPT.includes(`'${name}'`), name);
  assert.equal(Buffer.from(encodedCommand('x'), 'base64').toString('utf16le'), 'x');
});

test('the helper\'s answers are checked; elsewhere than Windows nothing starts', async () => {
  assert.deepEqual(parseAnswer('{"ok":true,"x":10,"y":0,"w":28,"h":41}'), { ok: true, x: 10, y: 0, w: 28, h: 41 });
  assert.deepEqual(parseAnswer('{"ok":false,"why":"last"}'), { ok: false, why: 'last' });
  assert.deepEqual(parseAnswer('{"ok":false,"why":"<script>"}'), { ok: false, why: 'error' });
  assert.deepEqual(parseAnswer('{"ok":true,"x":"a"}'), { ok: false, why: 'nobutton' });
  assert.deepEqual(parseAnswer('nonsense'), { ok: false, why: 'error' });
  let spawned = 0;
  const elsewhere = createHands({ platform: 'darwin', spawnFn: () => (spawned += 1) });
  assert.deepEqual(await elsewhere.find('newtab'), { ok: false, why: 'unsupported' });
  assert.equal(spawned, 0);
  // A fake helper: "find" and "press" lines in, one JSON line out each.
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const lines = [];
  child.stdin.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      lines.push(line);
      if (line === 'find newtab') child.stdout.write('{"ok":true,"x":2436,"y":0,"w":28,"h":41}\n');
      if (line === 'press close') child.stdout.write('{"ok":false,"why":"last"}\n');
    }
  });
  const hands = createHands({ platform: 'win32', spawnFn: () => child });
  child.stdout.write('ready\n');
  assert.deepEqual(await hands.find('newtab'), { ok: true, x: 2436, y: 0, w: 28, h: 41 });
  assert.deepEqual(await hands.press('close'), { ok: false, why: 'last' });
  assert.deepEqual(await hands.press('everything'), { ok: false, why: 'error' }, 'only the two targets');
  hands.stop();
  assert.deepEqual(lines, ['find newtab', 'press close', 'quit']);
});

test('a hands demo acts only on a test overlay (--dev); a plain overlay never does it for an event', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes("else if ((name === 'newtab' || name === 'closetab') && isDev) runHands(name);"));
  // Otherwise only the chat panel (the user) asks for it.
  const calls = main.match(/runHands\(/g) || [];
  assert.equal(calls.length, 3, 'defined once, called from the chat and from the dev demo');
});

test('typed "open" / "close" always reach main: with hands off it says how to turn them on', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(page.includes('const intent = matchIntent(chatInput.value, { hands: true });'));
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  const off = main.indexOf('if (!settings.hands) {');
  const says = main.indexOf("return handsSay('handsOff');", off);
  assert.ok(off > 0 && says > off && says - off < 200, 'hands off: it says how to turn them on');
  assert.equal(matchIntent('son chrome sekmesini kapatır mısın', { hands: true }), 'closetab');
  assert.equal(matchIntent('aç', { hands: true }), 'newtab');
});
