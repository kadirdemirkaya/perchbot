'use strict';

/** Hands (app/hands.js): open / close Chrome, a tab, YouTube; only when asked. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createHands, parseAnswer, encodedCommand, chromePath, SCRIPT, NEW_TAB_NAMES, SITES } = require('../app/hands');
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

test('chat: the commands are accepted, and shown in rows above the questions where hands work', () => {
  assert.deepEqual(chat.parseChatRequest({ op: 'ask', intent: 'newtab' }), { op: 'ask', intent: 'newtab' });
  assert.deepEqual(chat.parseChatRequest({ op: 'ask', intent: 'closetab' }), { op: 'ask', intent: 'closetab' });
  assert.equal(chat.parseChatRequest({ op: 'ask', intent: 'rmrf' }), null);
  // Not on Windows: no command rows, the questions as before.
  const elsewhere = chat.panelStrings('tr');
  assert.deepEqual(elsewhere.commands, []);
  assert.deepEqual(elsewhere.questions.map((q) => q.id), [...chat.INTENTS]);
  // Windows: the rows (hands on or off: with them off, a command asks to turn them on).
  const rows = chat.panelStrings('tr', { commands: true }).commands;
  assert.deepEqual(rows.map((r) => r.items.map((c) => c.id)), chat.HAND_GROUPS.map((g) => [...g.items]));
  const tab = rows.find((r) => r.label === 'Sekme');
  assert.deepEqual(tab.items, [
    { id: 'newtab', label: '+ Yeni', title: 'Yeni sekme aç' },
    { id: 'closetab', label: '× Son', title: 'Son sekmeyi kapat' },
  ]);
  assert.deepEqual(chat.panelStrings('tr', { commands: true }).questions.map((q) => q.id), [...chat.INTENTS], 'questions unchanged');
  // Intent ids pass the page bridge's check (lower case letters only), and the bridge knows them all.
  for (const id of chat.HAND_INTENTS) assert.match(id, /^[a-z]{2,12}$/);
  const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');
  const listed = preload.match(/const HAND_INTENTS = new Set\((\[[^\]]*\])\);/);
  assert.ok(listed, 'preload lists the commands');
  assert.deepEqual(JSON.parse(listed[1].replace(/'/g, '"')), [...chat.HAND_INTENTS]);
  for (const group of chat.HAND_GROUPS) {
    for (const lang of ['en', 'tr']) {
      const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'locales', `${lang}.json`), 'utf8')).chat;
      assert.ok(strings[`g_${group.id}`], `${lang}: g_${group.id}`);
      for (const id of group.items) assert.ok(strings[`c_${id}`] && strings[`q_${id}`], `${lang}: ${id}`);
    }
  }
});

test('hands: off by default, a tray switch, words in both languages, the press pose', () => {
  assert.equal(DEFAULTS.hands, false);
  assert.equal(normalizeSettings({ hands: true }).hands, true);
  assert.equal(normalizeSettings({ hands: 'yes' }).hands, false);
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const menu = buildTrayTemplate({ settings: { ...DEFAULTS, language: 'tr' }, characters: new Map(), sessionCount: 0, on });
  const item = menu.find((i) => i.label === 'Eller: Chrome');
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

test('the helper: Chrome only, button frames only, no titles, no addresses read, no files, no network', () => {
  // Only button names are looked at, to find "new tab"; never a tab's name (its title).
  const names = SCRIPT.match(/\$\w+\.Current\.Name/g) || [];
  assert.deepEqual([...new Set(names)], ['$b.Current.Name']);
  assert.ok(!/\$(tab|last|t\.tab)\.Current\.Name/.test(SCRIPT));
  assert.ok(!/TextPattern|LegacyIAccessible|Out-File|Set-Content|Add-Content|Invoke-WebRequest|Invoke-RestMethod|Start-Process|SetCursorPos|mouse_event|SendInput|SendKeys|keybd_event|Clipboard/i.test(SCRIPT));
  // The address bar is written, never read: SetValue with the one fixed text, nothing else of ValuePattern.
  assert.ok(!/\.Current\.Value|\.Value\b|IsReadOnly|GetValue/.test(SCRIPT.replace(/ValuePattern/g, '')), 'no value is read');
  assert.deepEqual(SCRIPT.match(/\$vp\.\w+/g), ['$vp.SetValue']);
  assert.ok(SCRIPT.includes(`$Typed = '${SITES.youtube.typed}'`));
  assert.equal(SITES.youtube.typed, 'youtube.com');
  assert.equal(SITES.youtube.url, 'https://www.youtube.com/');
  // Enter goes to that Chrome window only (posted to its handle), never to the window in front.
  const posts = SCRIPT.match(/PostMessage\(\$h, 0x010[01], \[IntPtr\]0x0D,/g) || [];
  assert.equal(posts.length, 2);
  assert.equal((SCRIPT.match(/::PostMessage\(/g) || []).length, 2);
  assert.ok(SCRIPT.includes('$h = [IntPtr]$t.win.Current.NativeWindowHandle'));
  assert.ok(!/GetForegroundWindow|SetForegroundWindow|SetFocus/.test(SCRIPT));
  // Closing Chrome: the window's own Close (as its x), never a process kill.
  assert.ok(SCRIPT.includes('$wp.Close()'));
  assert.ok(!/Stop-Process|taskkill|\.Kill\(/i.test(SCRIPT));
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
      if (line === 'type bar') child.stdout.write('{"ok":false,"why":"enter"}\n');
    }
  });
  const hands = createHands({ platform: 'win32', spawnFn: () => child });
  child.stdout.write('ready\n');
  assert.deepEqual(await hands.find('newtab'), { ok: true, x: 2436, y: 0, w: 28, h: 41 });
  assert.deepEqual(await hands.press('close'), { ok: false, why: 'last' });
  assert.deepEqual(await hands.press('everything'), { ok: false, why: 'error' }, 'only the known targets');
  assert.deepEqual(await hands.press('bar'), { ok: false, why: 'error' }, 'the bar is typed into, not pressed');
  assert.deepEqual(await hands.type(), { ok: false, why: 'enter' });
  hands.stop();
  assert.deepEqual(lines, ['find newtab', 'press close', 'type bar', 'quit']);
  assert.deepEqual(parseAnswer('{"ok":false,"why":"enter"}'), { ok: false, why: 'enter' });
  assert.deepEqual(parseAnswer('{"ok":true,"x":200,"y":139,"w":2400,"h":31}'), { ok: true, x: 200, y: 139, w: 2400, h: 31 }, 'a wide address bar');
});

test('opening Chrome: chrome.exe from its install folders, with no address or the one fixed address', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const at = (want) => (p) => p === want;
  assert.equal(chromePath({ env, exists: () => false }), null);
  const user = path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(chromePath({ env, exists: at(user) }), user);
  const machine = path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(chromePath({ env, exists: () => true }), machine, 'the machine-wide one first');
  const started = [];
  const launchFn = (exe, args, opts) => {
    started.push([exe, args, opts.detached]);
    return { on() {}, unref() {} };
  };
  const hands = createHands({ platform: 'win32', launchFn, findChrome: () => 'C:\\chrome.exe', spawnFn: () => assert.fail('no helper needed') });
  assert.deepEqual(hands.launch(), { ok: true });
  assert.deepEqual(hands.launch('youtube'), { ok: true });
  assert.deepEqual(hands.launch('https://example.com'), { ok: false, why: 'error' }, 'only the known sites');
  assert.deepEqual(hands.launch('__proto__'), { ok: false, why: 'error' });
  assert.deepEqual(started, [
    ['C:\\chrome.exe', [], true],
    ['C:\\chrome.exe', ['https://www.youtube.com/'], true],
  ]);
  assert.deepEqual(createHands({ platform: 'win32', launchFn, findChrome: () => null }).launch(), { ok: false, why: 'noapp' });
  assert.deepEqual(createHands({ platform: 'darwin', launchFn }).launch(), { ok: false, why: 'unsupported' });
  assert.equal(started.length, 2);
});

test('close Chrome asks first; the Yes counts only for the command that asked, for a while', () => {
  assert.deepEqual([...chat.HAND_CONFIRM], ['closechrome']);
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes('if (chat.HAND_CONFIRM.has(intent) && !confirmed) {'));
  assert.ok(main.includes("ipcMain.on('buddy:hands-go', (event, intent) => {"));
  assert.ok(main.includes('if (!fromPage(event) || !handsConfirm || handsConfirm.intent !== intent) return;'));
  assert.ok(main.includes('const fresh = Date.now() - handsConfirm.at < HANDS_CONFIRM_MS;'));
  const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');
  assert.ok(preload.includes("if (HAND_INTENTS.has(intent)) ipcRenderer.send('buddy:hands-go', intent);"));
  const page = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(page.includes("if (msg.confirm) askHands(msg.confirm, 'go');"));
  assert.ok(page.includes("if (id === 'yes') window.buddy.handsGo(ask.intent);"));
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'locales', `${lang}.json`), 'utf8')).chat;
    for (const key of ['handsSureCloseChrome', 'handsOpenChrome', 'handsCloseChrome', 'handsYoutube', 'handsTyping', 'handsNoApp']) assert.ok(strings[key], `${lang}: ${key}`);
  }
});

test('the poses: a press on its own chest (open Chrome), typing at the address bar (YouTube)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'characters', 'robot', 'robot.css'), 'utf8');
  assert.ok(css.includes('.buddy-character[data-press="chest"] .rb-arm-front {'));
  assert.ok(css.includes('.buddy-character[data-press="type"]:not([data-rest]) .rb-forearm-front {'));
  const page = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(page.includes("const how = msg.press === 'chest' || msg.press === 'type' ? msg.press : true;"));
  for (const name of ['openchrome', 'closechrome', 'youtube']) assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: name }), name);
});

test('a hands demo acts only on a test overlay (--dev); a plain overlay never does it for an event', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes("else if (chat.HAND_SET.has(name) && isDev) runHands(name, { confirmed: true });"));
  // Otherwise only the chat panel (the user) asks for it.
  const calls = main.match(/runHands\(/g) || [];
  assert.equal(calls.length, 5, 'defined once, called from the chat, from the two "Yes" in the bubble and from the dev demo');
});

test('a command with hands off asks to turn them on first', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes('chat.panelStrings(settings.language, { commands: hands.supported() })'), 'rows on Windows, hands on or off');
  const off = main.indexOf('if (!settings.hands) {');
  const asks = main.indexOf("send('buddy:hands', { ask: { intent, text: handsText('handsAskOn'), yes: handsText('handsYes'), no: handsText('handsNo') } })", off);
  assert.ok(off > 0 && asks > off && asks - off < 400, 'hands off: it asks to turn them on');
  // "Yes": only from our page, only the known commands; it turns hands on and does it.
  assert.ok(main.includes("if (!fromPage(event) || !chat.HAND_SET.has(intent)) return;"));
  assert.ok(/actions\.setHands\(true\);\s+runHands\(intent, \{ confirmed: true \}\);/.test(main));
  const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');
  assert.ok(preload.includes("if (HAND_INTENTS.has(intent)) ipcRenderer.send('buddy:hands-on', intent);"));
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['handsAskOn', 'handsYes', 'handsNo']) assert.ok(strings.chat[key], `${lang}: ${key}`);
  }
});
