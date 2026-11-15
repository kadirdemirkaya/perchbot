'use strict';

/** "Watch me type" (opt-in, Windows): app/typing.js (when and where), app/caret.js (the caret, its position only). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { TYPING, TYPING_STATES, TypingWatch, TypingVisit, standBy } = require('../app/typing');
const { createCaretWatch, parseCaret, encodedCommand, SCRIPT, TERMINALS, CARET_OBJECT } = require('../app/caret');
const { FOLLOW_STATES } = require('../app/follow');
const { SLOT } = require('../app/placement');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const yes = () => 0;
const no = () => 0.99;
/** A caret in field 7 at x (screen DIP), one 12 x 23 cell. */
const at = (x, y = 900, field = 7) => ({ x, y, w: 12, h: 23, field });

/** Feeds a typing spell: the caret one cell further every `every` ms. Returns the offers. */
function typeAlong(watch, { from = 300, steps = 6, t0 = 0, every = 250, field = 7, buddy = null } = {}) {
  const offers = [];
  watch.sample(at(from, 900, field), t0, buddy);
  for (let i = 1; i <= steps; i++) {
    const spot = watch.sample(at(from + 12 * i, 900, field), t0 + i * every, buddy);
    if (spot) offers.push({ spot, t: t0 + i * every });
  }
  return offers;
}

test('typing spell: a caret that keeps moving in the same field is typing; a still one is not', () => {
  const watch = new TypingWatch({ random: yes });
  for (let t = 0; t < 10000; t += 400) assert.equal(watch.sample(at(300), t), null, 'a still caret');
  const offers = typeAlong(watch, { t0: 20000, steps: 3 });
  assert.equal(offers.length, 0, 'three moves are not enough');
  const more = new TypingWatch({ random: yes });
  const got = typeAlong(more, { steps: TYPING.spellMoves });
  assert.equal(got.length, 1, 'four moves: typing');
  assert.deepEqual(got[0].spot, { x: 300 + 12 * TYPING.spellMoves, y: 900, w: 12, h: 23 });
});

test('typing spell: other fields, no caret, or long pauses start it over', () => {
  const watch = new TypingWatch({ random: yes });
  // Moves spread over several fields never add up.
  let t = 0;
  for (let i = 0; i < 12; i++) assert.equal(watch.sample(at(300 + 12 * i, 900, i % 2), (t += 250)), null);
  // No caret (another window in front) in between: over.
  const gaps = new TypingWatch({ random: yes });
  t = 0;
  for (let i = 0; i < 12; i++) {
    gaps.sample(at(300 + 12 * i), (t += 250));
    assert.equal(gaps.sample(null, (t += 250)), null);
  }
  // A pause longer than spellGapMs between moves: a new spell each time.
  const slow = new TypingWatch({ random: yes });
  t = 0;
  for (let i = 0; i < 10; i++) assert.equal(slow.sample(at(300 + 12 * i), (t += TYPING.spellGapMs + 1)), null);
});

test('not every time: the dice once per spell, a gap between visits, and not right next to it', () => {
  // The dice say no: nothing for that whole spell...
  const rolls = [0.99, 0];
  const watch = new TypingWatch({ random: () => rolls.shift() });
  assert.equal(typeAlong(watch, { steps: 12 }).length, 0);
  assert.equal(rolls.length, 1, 'rolled once for the spell');
  // ...and a new spell (after a pause) rolls again.
  const next = typeAlong(watch, { t0: 20000, steps: 6 });
  assert.equal(next.length, 1);
  // About every second or third spell, and once a minute at most.
  assert.ok(TYPING.chance >= 0.3 && TYPING.chance <= 0.5);
  assert.equal(TYPING.gapMs, 60000, 'once a minute at most');
  // A long spell after a no: the dice again after rerollMs.
  const long = new TypingWatch({ random: (() => { const r = [0.99, 0]; return () => r.shift(); })() });
  const longOffers = typeAlong(long, { steps: Math.ceil((TYPING.rerollMs + 1000) / 250) });
  assert.equal(longOffers.length, 1);
  assert.ok(longOffers[0].t >= TYPING.rerollMs);
  // Offered again every retryMs while the spell goes on (the page may have been busy).
  const again = new TypingWatch({ random: yes });
  const offers = typeAlong(again, { steps: 40, every: 250 });
  assert.ok(offers.length >= 2);
  for (let i = 1; i < offers.length; i++) assert.ok(offers[i].t - offers[i - 1].t >= TYPING.retryMs);
  // Visited: nothing more for this spell, and none within the gap.
  const visited = new TypingWatch({ random: yes });
  assert.equal(typeAlong(visited, { steps: 6 }).length, 1);
  visited.visited(1500);
  assert.equal(typeAlong(visited, { t0: 1500, steps: 20 }).length, 0);
  assert.equal(typeAlong(visited, { t0: 1500 + TYPING.gapMs / 2, steps: 20 }).length, 0, 'within the gap');
  assert.equal(typeAlong(visited, { t0: 1500 + TYPING.gapMs + 10000, steps: 6 }).length, 1, 'after it');
  // Typing right next to the buddy: it is there already.
  const near = new TypingWatch({ random: yes });
  assert.equal(typeAlong(near, { steps: 6, buddy: { x: 330, y: 900 } }).length, 0);
  // hold(): the spell starts over.
  const held = new TypingWatch({ random: yes });
  typeAlong(held, { steps: 3 });
  held.hold();
  assert.equal(held.sample(at(400), 1000), null);
  assert.equal(held.sample(at(412), 1250), null, 'one move after hold is not a spell');
});

test('the visit: it reads along while the typing goes on, then the light bulb', () => {
  const visit = new TypingVisit({ start: 0, caret: at(300) });
  // Not before it has looked a moment, even with a still caret.
  assert.equal(visit.sample(at(300), TYPING.lookMinMs - 100), null);
  // Typing on: it keeps reading.
  let t = TYPING.lookMinMs - 100;
  for (let i = 1; i <= 10; i++) assert.equal(visit.sample(at(300 + 12 * i), (t += 250)), null);
  // The caret rests: after doneMs, it got it.
  assert.equal(visit.sample(at(420), t + TYPING.doneMs - 100), null);
  assert.equal(visit.sample(at(420), t + TYPING.doneMs + 10), 'aha');
  // Never longer than maxVisitMs, typing or not.
  const long = new TypingVisit({ start: 0, caret: at(300) });
  assert.equal(long.sample(at(312), TYPING.maxVisitMs), 'aha');
});

test('the visit: it moves along when the caret gets away, and stops when the typing goes elsewhere', () => {
  const visit = new TypingVisit({ start: 0, caret: at(300) });
  assert.equal(visit.sample(at(300 + TYPING.alongPx + 12), 500), 'along', 'far along the line');
  visit.movedTo(at(300 + TYPING.alongPx + 12));
  assert.equal(visit.sample(at(300 + TYPING.alongPx + 24), 750), null, 'reading there now');
  assert.equal(visit.sample(at(300 + TYPING.alongPx + 24, 900 + TYPING.alongLinePx + 5), 1000), 'along', 'another line');
  // Another field (a tab, a window): done here (after the first look).
  const moved = new TypingVisit({ start: 0, caret: at(300) });
  assert.equal(moved.sample(at(312, 900, 8), 500), null, 'too early to say');
  assert.equal(moved.sample(at(312, 900, 8), TYPING.lookMinMs + 10), 'aha');
  // No caret for a few samples (another window in front): done.
  const gone = new TypingVisit({ start: 0, caret: at(300) });
  let t = TYPING.lookMinMs;
  for (let i = 1; i < TYPING.goneSamples; i++) assert.equal(gone.sample(null, (t += 250)), null, 'a moment without is fine');
  assert.equal(gone.sample(null, (t += 250)), 'aha');
});

test('where it stands: just above the line, right of the caret, the line itself free; below near the top', () => {
  const area = { x: 0, y: 0, width: 1536, height: 912 };
  for (const scale of [0.8, 1, 1.3]) {
    const caret = at(400, 800);
    const spot = standBy(caret, area, scale);
    const slotLeft = spot.x - (SLOT.width / 2) * scale;
    assert.ok(slotLeft > caret.x + caret.w, 'its slot starts right of the caret');
    assert.ok(spot.y <= caret.y, 'its feet above the line');
    assert.ok(spot.y >= caret.y - 10 * scale, 'just above it');
    // A line near the top of the screen: no room above, so just below it.
    const high = standBy(at(400, 60), area, scale);
    assert.ok(high.y - SLOT.height * scale >= 60 + 23, 'its slot starts below the line');
  }
  assert.equal(standBy(null, area, 1), null);
});

test('states: as for a look at the cursor (idle or at work, not while Claude Code waits for the user)', () => {
  assert.deepEqual([...TYPING_STATES].sort(), [...FOLLOW_STATES].sort());
  for (const s of ['waiting', 'asking', 'goodbye']) assert.ok(!TYPING_STATES.has(s), s);
});

test('the caret helper: the caret rectangle only, never any text, keys, titles or files', () => {
  // What it asks Windows: the window in front, its class, then way 1 for terminals (the
  // focused element of that process, whether it is a password field, the caret's rectangle)
  // and way 2 when way 1 gives nothing (the focus window's caret object, its location only).
  assert.ok(SCRIPT.includes('GetForegroundWindow') && SCRIPT.includes('AutomationElement.FocusedElement'));
  assert.ok(SCRIPT.includes('if (el.Current.IsPassword) return "{\\"secret\\":true}";'), 'a password field gives nothing');
  assert.ok(SCRIPT.includes('el.Current.ProcessId != (int)pid'), 'only the window in front');
  assert.ok(SCRIPT.includes('ExpandToEnclosingUnit(TextUnit.Character)') && SCRIPT.includes('GetBoundingRectangles()'));
  for (const t of TERMINALS) assert.ok(SCRIPT.includes(`"${t}"`), t);
  // UI Automation (screen reader support: VS Code would change its editor) only for terminals.
  assert.ok(SCRIPT.includes('if (Array.IndexOf(Terminals, kind.ToString()) >= 0) {\n      string first = FromTerminal(pid);\n      if (first != null) return first;\n    }\n    return FromCaretObject(front, thread);'), 'way 2 only when way 1 gives nothing');
  assert.equal((SCRIPT.match(/AutomationElement\.FocusedElement/g) || []).length, 1, 'UI Automation asked in way 1 only');
  assert.ok(SCRIPT.includes('IsHungAppWindow(front)'), 'never waits on a hung window');
  // Way 2: the caret object's location, nothing else of it.
  assert.ok(SCRIPT.includes('AccessibleObjectFromWindow(focus, OBJID_CARET,') && SCRIPT.includes('const uint OBJID_CARET = 0xFFFFFFF8;'));
  assert.ok(SCRIPT.includes('.accLocation(out x, out y, out w, out h, 0);'));
  assert.ok(SCRIPT.includes('if (w <= 0 || h < 4) return "{}";'), 'a hidden caret gives nothing');
  assert.ok(SCRIPT.includes('if (x < box.L || x > box.R || y < box.T + band || y + h > box.B) return "{}";'), 'outside the window or in its top band: nothing');
  assert.ok(SCRIPT.includes(`const int TopBand = ${CARET_OBJECT.topBand};`));
  // ...and nothing else: no text of any kind, no keyboard, no input, no files, no network.
  const forbidden = /GetText|DocumentRange|RangeFromPoint|\.Current\.Name|\.Name\b|ValuePattern|LegacyIAccessible|accName|accValue|accDescription|accHelp|accRole|accState|accKeyboardShortcut|accDefaultAction|accChild|accSelect|accDoDefaultAction|OBJID_CLIENT|AccessibleChildren|GetWindowText|HelpText|Clipboard|SetWindowsHookEx|GetAsyncKeyState|GetKeyState|GetKeyboardState|keybd_event|SendInput|SendKeys|SetFocus|Out-File|Set-Content|Add-Content|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Get-Process/i;
  assert.ok(!forbidden.test(SCRIPT), String(SCRIPT.match(forbidden)));
  // Only what main.js needs goes back: numbers, and the password flag.
  assert.ok(!/ProcessId\s*\+|\+\s*kind|cls\.ToString\(\)\s*\+/.test(SCRIPT), 'no class name or process in the answer');
  assert.equal(Buffer.from(encodedCommand('hi'), 'base64').toString('utf16le'), 'hi');
});

test('the caret helper: answers are checked', () => {
  assert.deepEqual(parseCaret('{"x":218,"y":925,"w":12,"h":23,"field":259217909}'), { x: 218, y: 925, w: 12, h: 23, field: 259217909 });
  assert.deepEqual(parseCaret('{"secret":true}'), { secret: true });
  assert.equal(parseCaret('{}'), null);
  assert.equal(parseCaret('not json'), null);
  assert.equal(parseCaret('[1,2]'), null);
  assert.equal(parseCaret('{"x":"1","y":2,"w":3,"h":4,"field":1}'), null);
  assert.equal(parseCaret('{"x":1.5,"y":2,"w":3,"h":4,"field":1}'), null);
  assert.equal(parseCaret('{"x":1,"y":2,"w":3,"h":0,"field":1}'), null, 'no height');
  assert.equal(parseCaret('{"x":1,"y":2,"w":3,"h":900,"field":1}'), null, 'no caret is that big');
  assert.equal(parseCaret('{"x":1,"y":2,"w":3,"h":20,"field":-1}'), null);
  assert.equal(parseCaret('{"x":1,"y":2,"w":3,"h":20}'), null, 'which field it is in is needed');
  assert.deepEqual(parseCaret('{"x":-1500,"y":2,"w":0,"h":20,"field":3,"text":"secret"}'), { x: -1500, y: 2, w: 0, h: 20, field: 3 }, 'anything else is dropped');
});

test('the caret helper: only on Windows; a quiet helper that stops', async () => {
  let spawned = 0;
  const elsewhere = createCaretWatch({ platform: 'darwin', spawnFn: () => (spawned += 1) });
  assert.equal(elsewhere.supported(), false);
  assert.equal(await elsewhere.where(), null);
  assert.equal(spawned, 0);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const lines = [];
  child.stdin.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      lines.push(line);
      if (line === 'where') child.stdout.write('{"x":10,"y":20,"w":12,"h":23,"field":5}\n');
    }
  });
  let args = null;
  const watch = createCaretWatch({ platform: 'win32', spawnFn: (cmd, a, opts) => ((args = { cmd, a, opts }), child) });
  child.stdout.write('ready\n');
  assert.deepEqual(await watch.where(), { x: 10, y: 20, w: 12, h: 23, field: 5 });
  assert.equal(args.cmd, 'powershell.exe');
  assert.ok(args.a.includes('-EncodedCommand') && args.a.includes('-NoProfile'));
  assert.equal(args.opts.windowsHide, true);
  assert.equal(watch.running, true);
  watch.stop();
  assert.equal(watch.running, false);
  assert.ok(lines.includes('quit'));
});

test('watch me type: off by default, a switch in the tray and the right-click menu, both languages', () => {
  const { DEFAULTS, normalizeSettings } = require('../app/settings');
  const { buildTrayTemplate, buildFunMenuTemplate } = require('../app/tray');
  assert.equal(DEFAULTS.typingPeek, false);
  assert.equal(normalizeSettings({}).typingPeek, false);
  assert.equal(normalizeSettings({ typingPeek: true }).typingPeek, true);
  assert.equal(normalizeSettings({ typingPeek: 'yes' }).typingPeek, false);
  for (const lang of ['en', 'tr']) {
    const locale = JSON.parse(read('app', 'locales', `${lang}.json`));
    assert.ok(locale.menu.typingPeek, lang);
    assert.ok(locale.quip.typingLook && locale.quip.typingAha, lang);
  }
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...a) => calls.push([name, ...a]) });
  const settings = { language: 'en', typingPeek: false, ambientLife: true };
  const find = (items) => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? i.submenu : [])]).find((i) => i.label === 'Watch me type');
  const fun = find(buildFunMenuTemplate({ settings, away: false, on }));
  assert.ok(fun && fun.type === 'checkbox' && fun.checked === false);
  fun.click({ checked: true });
  assert.deepEqual(calls.pop(), ['setTypingPeek', true]);
  const tray = buildTrayTemplate({ settings, sessionCount: 0, characters: [], on, onlineSince: 0 });
  assert.ok(JSON.stringify(tray, (k, v) => (typeof v === 'function' ? undefined : v)).includes('"label":"Watch me type"'));
});

test('watch me type: wired through main.js, the bridge and the page', () => {
  const main = read('app', 'main.js');
  // Only with its switch on, and never with "Stay here"; work (a sent prompt) brings the light bulb.
  assert.ok(main.includes('return Boolean(settings.typingPeek && settings.ambientLife && !settings.stayPut && settings.hoverMode !== \'stand\' && caretWatch.supported());'));
  assert.ok(/const STAY_PUT_BLOCKS = new Set\(\[[^\]]*'typing'/.test(main));
  assert.ok(main.includes("else if (action === 'typing') settings.ambientLife && peekAtTyping();"));
  assert.ok(main.includes('syncTyping();\n    sendSettings();'), 'settings changes start or stop it');
  assert.ok(main.includes("if (typingVisit && ((snap.state === 'thinking' && PROMPT_FROM.has(lastCoreState)) || !typingLib.TYPING_STATES.has(snap.state))) typingAha();"));
  assert.ok(main.includes('caretWatch.stop();'));
  assert.ok(main.includes('if (!BrowserWindow.getFocusedWindow()) raw = await caretWatch.where();'), 'its own chat panel is not asked about');
  for (const q of ['typingLook', 'typingAha']) assert.ok(main.includes(`'${q}'`), q);
  // The bridge: the page hears about it, and may ask to go.
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onTyping: on('buddy:typing'),"));
  // The page: the same checks as for a look at the cursor; reading along holds ambient life back.
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('window.buddy.onTyping((msg) => onTyping(msg));'));
  assert.ok(page.includes("window.buddy.fun('typing');"));
  assert.ok(page.includes('ambientOn() && !typingLook && !duel.active'), 'no ambient plays or trips while it reads along');
  assert.ok(page.includes('if (ambientOn() && AMBIENT_STATES.has(view.state) && !typingLook) story.start();'), 'nor the idle story');
  assert.ok(page.includes("flag('aha', true, true);"));
  // Robo's light bulb comes on for it.
  const css = read('characters', 'robot', 'robot.css');
  assert.ok(css.includes(".buddy-character[data-aha] .rb-bulb {\n  opacity: 1;\n}"));
  // The simulator can show it.
  const { DEMOS } = require('../app/validate');
  assert.ok(DEMOS.has('typing'));
});
