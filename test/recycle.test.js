'use strict';

/** Follow Windows (app/recycle.js): a file deleted in Windows gets its ghost cut by the sword. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RECYCLE, KINDS, isRecordName, extFromRecord, kindOf, DeleteBatch, userSid, recycleDirs, createRecycleWatcher, supported } = require('../app/recycle');
const { SlashShow, SLASH_TIMINGS } = require('../app/renderer/lib/fun');
const { DEFAULTS, normalizeSettings } = require('../app/settings');
const { buildMenuItems, MENU_IDS } = require('../app/menu-items');
const { validateEvent } = require('../app/validate');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/** A $I record as Windows 10/11 writes it (v2): the path length counts the closing NUL. */
function recordV2(original) {
  const chars = original.length + 1;
  const buf = Buffer.alloc(28 + chars * 2);
  buf.writeBigUInt64LE(2n, 0);
  buf.writeBigUInt64LE(4096n, 8);
  buf.writeBigUInt64LE(133800000000000000n, 16);
  buf.writeUInt32LE(chars, 24);
  buf.write(original, 28, 'utf16le');
  return buf;
}

/** The older layout (v1): the path in a fixed 520-byte field. */
function recordV1(original) {
  const buf = Buffer.alloc(24 + 520);
  buf.writeBigUInt64LE(1n, 0);
  buf.writeBigUInt64LE(4096n, 8);
  buf.writeBigUInt64LE(133800000000000000n, 16);
  buf.write(original, 24, 'utf16le');
  return buf;
}

test('the $I record gives the extension only (v2 and v1), never the name or the path', () => {
  assert.equal(extFromRecord(recordV2('C:\\Users\\someone\\Desktop\\Quarterly Report.PDF')), 'pdf');
  assert.equal(extFromRecord(recordV2('D:\\work\\notes.final.docx')), 'docx', 'the last extension');
  assert.equal(extFromRecord(recordV2('C:\\Users\\someone\\Pictures')), '', 'no extension (a folder, or a file without one)');
  assert.equal(extFromRecord(recordV2('C:\\x\\.gitignore')), '', 'a dot file has no extension');
  assert.equal(extFromRecord(recordV1('C:\\old\\photo.JPG')), 'jpg');
  assert.equal(extFromRecord(recordV2('C:\\x\\odd.' + 'a'.repeat(30))), '', 'an odd "extension" counts as none');
  // Not a record (or not yet written completely): null, the watcher reads it again.
  assert.equal(extFromRecord(Buffer.alloc(10)), null);
  assert.equal(extFromRecord(Buffer.alloc(600)), null, 'version 0');
  const cut = recordV2('C:\\x\\a.pdf').subarray(0, 32);
  assert.equal(extFromRecord(cut), null, 'path shorter than its length says');
  assert.equal(extFromRecord('not a buffer'), null);
  // Only the extension comes out: nothing of the name, the folders or the drive.
  const out = extFromRecord(recordV2('C:\\Users\\someone\\Secret Plans\\salary-list.xlsx'));
  assert.equal(out, 'xlsx');
  assert.ok(!/someone|Secret|salary|Users/i.test(out));
});

test('file types: pdf red, word blue, image green, folder yellow, everything else teal', () => {
  assert.deepEqual(KINDS, ['pdf', 'word', 'image', 'folder', 'other']);
  assert.equal(kindOf('pdf'), 'pdf');
  for (const ext of ['doc', 'docx', 'rtf', 'odt']) assert.equal(kindOf(ext), 'word', ext);
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) assert.equal(kindOf(ext), 'image', ext);
  assert.equal(kindOf('', true), 'folder');
  assert.equal(kindOf('pdf', true), 'folder', 'a folder named x.pdf is still a folder');
  for (const ext of ['', 'txt', 'zip', 'exe', null]) assert.equal(kindOf(ext), 'other', String(ext));
  // The page colours each of them (overlay.css), the teal one by default.
  const css = read('app', 'renderer', 'overlay.css');
  for (const kind of ['pdf', 'word', 'image', 'folder']) assert.ok(css.includes(`.buddy-ghost[data-kind='${kind}']`), kind);
  assert.ok(/\.buddy-ghost \{[^}]*--gh-accent: #1fa88e;/.test(css), 'other: teal');
  assert.ok(isRecordName('$IAB12CD.pdf') && isRecordName('$iab12cd') && isRecordName('$IXY9Z01.docx'));
  for (const name of ['$RAB12CD.pdf', 'desktop.ini', '', null, 'x$IAB.pdf']) assert.ok(!isRecordName(name), String(name));
});

test('deletes that come together are one show: the first one\'s type, how many, and of which kind', () => {
  const clock = new FakeClock();
  const batches = [];
  const batch = new DeleteBatch({ onBatch: (b) => batches.push(b), clock, now: () => clock.now });
  batch.add('pdf');
  clock.tick(RECYCLE.burstMs - 1);
  assert.deepEqual(batches, [], 'waits for more');
  clock.tick(1);
  assert.deepEqual(batches, [{ kind: 'pdf', count: 1, kinds: { pdf: 1 } }]);
  // Five files selected and deleted at once.
  batches.length = 0;
  for (const kind of ['word', 'image', 'image', 'folder', 'nonsense']) {
    batch.add(kind);
    clock.tick(50);
  }
  clock.tick(RECYCLE.burstMs);
  assert.deepEqual(batches, [{ kind: 'word', count: 5, kinds: { word: 1, image: 2, folder: 1, other: 1 } }]);
  // A long stream of deletes: one show at most burstMaxMs after its first, the rest a new batch.
  batches.length = 0;
  for (let i = 0; i < 20; i++) {
    batch.add('pdf');
    clock.tick(RECYCLE.burstMs - 100);
  }
  clock.tick(RECYCLE.burstMs);
  assert.ok(batches.length >= 2, 'not one endless batch');
  assert.equal(batches.reduce((n, b) => n + b.count, 0), 20, 'every delete counted once');
  // Gone before the burst was over: nothing.
  batches.length = 0;
  batch.add('pdf');
  batch.dispose();
  clock.tick(RECYCLE.burstMaxMs);
  assert.deepEqual(batches, []);
});

test('the user\'s SID from whoami, and only Recycle Bin folders that exist', async () => {
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const ok = (cmd, args, opts, cb) => {
    assert.equal(cmd, 'whoami');
    assert.deepEqual(args, ['/user', '/fo', 'csv', '/nh']);
    assert.equal(opts.windowsHide, true);
    cb(null, `"desktop-x\\someone","${sid}"\r\n`);
  };
  assert.equal(await userSid({ run: ok }), sid);
  assert.equal(await userSid({ run: (c, a, o, cb) => cb(new Error('no whoami')) }), null);
  assert.equal(await userSid({ run: () => { throw new Error('spawn failed'); } }), null);
  const there = new Set([`C:\\$Recycle.Bin\\${sid}`, `E:\\$Recycle.Bin\\${sid}`]);
  const fsp = { stat: async (dir) => { if (!there.has(dir)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return { isDirectory: () => true }; } };
  assert.deepEqual(await recycleDirs(sid, { fsp }), [`C:\\$Recycle.Bin\\${sid}`, `E:\\$Recycle.Bin\\${sid}`]);
  assert.deepEqual(await recycleDirs(null, { fsp }), []);
  assert.deepEqual(await recycleDirs('..\\..\\x', { fsp }), [], 'only a real SID makes a path');
  assert.equal(supported('win32'), true);
  assert.equal(supported('darwin'), false);
  assert.equal(supported('linux'), false);
});

/** Wait until check() is true (fs.watch is asynchronous), at most `ms`. */
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
}

test('the watcher: old records are ignored, a new delete is reported once with its type only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-recycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Already in the bin before it starts: old.
  fs.writeFileSync(path.join(dir, '$IOLD001.txt'), recordV2('C:\\x\\old.txt'));
  fs.writeFileSync(path.join(dir, '$ROLD001.txt'), 'old');
  const seen = [];
  const watch = await createRecycleWatcher({ dirs: [dir], onDelete: (b) => seen.push(b), timings: { burstMs: 80, burstMaxMs: 300, retryMs: 20 } });
  t.after(() => watch.stop());
  assert.deepEqual(watch.dirs, [dir]);

  // Windows touches an old record: nothing.
  fs.writeFileSync(path.join(dir, '$IOLD001.txt'), recordV2('C:\\x\\old.txt'));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, [], 'an old record touched is not a delete');

  // A new delete: a PDF.
  fs.writeFileSync(path.join(dir, '$RNEW001.pdf'), 'pdf');
  fs.writeFileSync(path.join(dir, '$INEW001.pdf'), recordV2('C:\\Users\\someone\\Desktop\\Private.pdf'));
  assert.ok(await until(() => seen.length > 0), 'reported');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, [{ kind: 'pdf', count: 1, kinds: { pdf: 1 } }], 'once, the type only (rename + change are one)');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['count', 'kind', 'kinds'], 'nothing else leaves the watcher');

  // A folder: its $R is a directory.
  fs.mkdirSync(path.join(dir, '$RNEW002'));
  fs.writeFileSync(path.join(dir, '$INEW002'), recordV2('C:\\Users\\someone\\Desktop\\Holiday'));
  assert.ok(await until(() => seen.length > 1), 'the folder reported');
  assert.equal(seen[1].kind, 'folder');

  // Stopped: nothing more.
  watch.stop();
  fs.writeFileSync(path.join(dir, '$RNEW003.png'), 'png');
  fs.writeFileSync(path.join(dir, '$INEW003.png'), recordV2('C:\\x\\a.png'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.length, 2);
});

test('the setting: off by default, booleans only', () => {
  assert.equal(DEFAULTS.followWindows, false);
  assert.equal(normalizeSettings({}).followWindows, false);
  assert.equal(normalizeSettings({ followWindows: true }).followWindows, true);
  assert.equal(normalizeSettings({ followWindows: 'yes' }).followWindows, false);
});

test('the 8th ball: Windows only, last (every other ball keeps its place), on / off with the user\'s words', () => {
  const ids = (s, x) => buildMenuItems({ ...DEFAULTS, ...s }, x).map((i) => i.id);
  // Without it (not Windows): exactly as before.
  assert.deepEqual(ids({}), ['quiet', 'eyes', 'play', 'cat', 'chat', 'settings', 'quit']);
  assert.deepEqual(ids({}, { windows: false }), ['quiet', 'eyes', 'play', 'cat', 'chat', 'settings', 'quit']);
  // On Windows: the same, plus this one at the very end.
  assert.deepEqual(ids({}, { windows: true }), ['quiet', 'eyes', 'play', 'cat', 'chat', 'settings', 'quit', 'windows']);
  const most = ids({ position: { x: 1, y: 2 } }, { soundAvailable: true, windows: true });
  assert.deepEqual(most, ['quiet', 'eyes', 'play', 'cat', 'chat', 'sound', 'corner', 'settings', 'quit', 'windows']);
  assert.ok(Math.ceil(most.length / 2) <= 5, 'still at most five rows');
  assert.ok(MENU_IDS.has('windows'));
  const item = (s) => buildMenuItems({ ...DEFAULTS, ...s }, { windows: true }).find((i) => i.id === 'windows');
  assert.deepEqual(item({}), { id: 'windows', icon: 'bin-off', label: 'Follow Windows' });
  assert.deepEqual(item({ followWindows: true }), { id: 'windows', icon: 'bin', label: 'Stop following Windows' });
  assert.deepEqual(item({ language: 'tr' }), { id: 'windows', icon: 'bin-off', label: "Windows'u takip et" });
  assert.deepEqual(item({ language: 'tr', followWindows: true }), { id: 'windows', icon: 'bin', label: "Windows'u takip etme" });
  const html = read('app', 'renderer', 'index.html');
  for (const icon of ['bin', 'bin-off']) assert.ok(html.includes(`id="i-${icon}"`), icon);
  // Only the ball switches it: no tray entry.
  assert.ok(!read('app', 'tray.js').includes('followWindows'));
});

test('the cut: guard, windup, strike (the blade goes through), win, end; stop() at any time', () => {
  const clock = new FakeClock();
  const log = [];
  const show = new SlashShow({ clock, onPhase: (p) => log.push(p), onStrike: () => log.push('cut') });
  show.start();
  show.start();
  assert.deepEqual(log, ['guard'], 'a second start does nothing');
  clock.tick(SLASH_TIMINGS.guardMs);
  clock.tick(SLASH_TIMINGS.windupMs);
  assert.deepEqual(log, ['guard', 'windup', 'strike', 'cut']);
  clock.tick(SLASH_TIMINGS.strikeMs);
  clock.tick(SLASH_TIMINGS.winMs);
  assert.deepEqual(log, ['guard', 'windup', 'strike', 'cut', 'win', 'end']);
  assert.equal(show.active, false);
  const total = SLASH_TIMINGS.guardMs + SLASH_TIMINGS.windupMs + SLASH_TIMINGS.strikeMs + SLASH_TIMINGS.winMs;
  assert.ok(total <= 3000, 'a short show (main keeps it busy for 3 s)');

  // Stopped in the middle: 'end' once, nothing after.
  log.length = 0;
  show.start();
  clock.tick(SLASH_TIMINGS.guardMs);
  show.stop();
  show.stop();
  clock.tick(10000);
  assert.deepEqual(log, ['guard', 'windup', 'end']);

  // Stopped from inside onPhase (something took the character over): no timer left behind.
  const log2 = [];
  const taken = new SlashShow({ clock, onPhase: (p) => { log2.push(p); if (p === 'windup') taken.stop(); }, onStrike: () => log2.push('cut') });
  taken.start();
  clock.tick(10000);
  assert.deepEqual(log2, ['guard', 'windup', 'end']);
  assert.equal(clock.timers.size, 0);
});

test('wired through main.js: off = nothing watched; busy = let go; the page decides; to the cursor or on the spot', () => {
  const main = read('app', 'main.js');
  // Off by default: started and stopped with the switch (settings changes, startup), stopped on quit.
  assert.ok(main.includes('return Boolean(settings.followWindows && (recycleLib.supported() || devRecycleDir()));'));
  assert.ok(main.includes('    syncWindows();\n    // "Watch me type" starts or stops'));
  assert.ok(main.includes('    // Follow Windows: the Recycle Bin is watched only with its switch on (off by default).\n    syncWindows();'));
  assert.ok(main.includes('caretWatch.stop();\n    stopRecycleWatch();'), 'stopped on quit');
  assert.ok(main.includes("const dir = isDev ? names.envValue('RECYCLE_DIR') : null;"), 'the test folder only on a dev overlay');
  // Busy (anything going on, or Claude Code not idle): let go, no queue.
  assert.ok(main.includes("const SLASH_STATES = new Set(['idle', 'standby']);"));
  assert.ok(main.includes('Date.now() >= slashUntil && SLASH_STATES.has(core.snapshot().state)'));
  assert.ok(main.includes('!paused && !quitting && !drag && !trip && !warping && !flipping && !rampage && !fist && !handsBusy && !peekBack && !typingVisit && !chatOpen &&\n        Date.now() >= slashUntil'));
  assert.ok(main.includes("log.devOnly(`follow windows: ${what}, busy: let go`);\n      return;"));
  // The page is asked; it answers with a trip or the cut on the spot ("Stay here" too: not blocked).
  assert.ok(/const FUN_ACTIONS = new Set\(\[[^\]]*'slash', 'slash-here'/.test(main));
  assert.ok(!/const STAY_PUT_BLOCKS = new Set\(\[[^\]]*'slash/.test(main), '"Stay here": it cuts where it stands');
  assert.ok(main.includes("else if (action === 'slash' || action === 'slash-here') goSlash(action === 'slash-here');"));
  assert.ok(main.includes("if (!settings.ambientLife || settings.stayPut || settings.hoverMode === 'stand') return null;"));
  assert.ok(main.includes("beginTrip(plan, 'slash', () => slashHere(offer, from, true), { peek: true });"));
  assert.ok(main.includes("if (plan) plan.kind = 'slash';"));
  // The ghost stands where the bug would (the sword's reach).
  assert.ok(main.includes('const spot = placement.bugSpot(pageLayout.side, 0.5);'));
  // The ball, the demo, the line.
  assert.ok(main.includes("windows: recycleLib.supported() });"));
  assert.ok(main.includes("case 'windows':\n        if (recycleLib.supported()) actions.setFollowWindows(!settings.followWindows);"));
  assert.ok(main.includes("else if (name === 'slash') demoSlash();"));
  assert.ok(main.includes("'slashed'];"));
  assert.ok(validateEvent({ v: 1, event: 'Demo', session: 's', ts: 1, demo: 'slash' }), 'slash is a valid demo');
  // Privacy: main never sees a name, only { kind, count }.
  const section = main.slice(main.indexOf('// ------------------------------------------------------------------ follow windows'), main.indexOf('const presence = new PresenceWatch();'));
  assert.ok(section.length > 1000);
  assert.ok(!/original|basename|\.name\b|readFile/.test(section), 'no names, no file reads in main');
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onWindows: on('buddy:windows'),"));
  assert.ok(/const FUN_ACTIONS = new Set\(\[[^\]]*'slash', 'slash-here'/.test(preload));
});

test('on the page: only when free (resting: it wakes); the ghost rises, one cut, "Slashed!"', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('window.buddy.onWindows((msg) => onWindows(msg));'));
  assert.ok(page.includes('!motionAllowed() || raging || moving || drag || duel.active || hunt.active || bugView.here || chatOpen || guest || guestPending || fisting || typingLook || lasering || cuddling || patPending ||'));
  assert.ok(page.includes('crew.isPressing() || zone !== null || slashing || !AMBIENT_STATES.has(view.state) || crewCount > 0,'));
  assert.ok(page.includes('if (rest.resting) rest.activity();\n      window.buddy.fun(here ? \'slash-here\' : \'slash\');'), 'resting: it wakes up for it');
  assert.ok(page.includes('const here = Boolean(settings.stayPut || !ambientOn() || pet.here);'));
  assert.ok(page.includes("if (phase === 'win') quip('slashed', SLASH_QUIP_MS);"));
  // Nothing of its own during the cut (plays, wander, the bug fight); anything that takes over stops it.
  assert.ok(page.includes('!guestPending && !lasering && !slashing;'));
  assert.ok(page.includes('!slashing && !typingLook && !duel.active'));
  assert.ok(page.includes('    !duel.active &&\n    !slashing &&'));
  assert.ok(page.includes('if (slashing && slashTakenOver()) slash.stop();'));
  // A duel or the bug hunt that took over keeps its poses.
  assert.ok(page.includes("if (!hunt.active && !duel.active) flag('duel', null);"));
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(read('app', 'locales', `${lang}.json`));
    assert.ok(typeof strings.quip.slashed === 'string' && strings.quip.slashed.length > 3, `${lang}: slashed`);
  }
  // The ghost view: loaded before the page script, text only through textContent.
  const html = read('app', 'renderer', 'index.html');
  assert.ok(html.indexOf('src="ghost-view.js"') > 0 && html.indexOf('src="ghost-view.js"') < html.indexOf('src="renderer.js"'));
  const ghost = read('app', 'renderer', 'ghost-view.js');
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(ghost));
  assert.ok(ghost.includes('badge.textContent ='));
  // Reduced motion: it stands still and just disappears.
  assert.ok(read('app', 'renderer', 'overlay.css').includes(".buddy-ghost:is([data-phase='cut'], [data-phase='fade']) {\n    visibility: hidden;"));
});
