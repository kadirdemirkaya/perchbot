'use strict';

/**
 * Two more jobs for the giant (app/giant.js modes):
 *   "While you were away" (app/away.js, on by default): back at the computer after a while,
 *   and things happened, a giant of it holds up a board with them (counts only).
 *   Stretch breaks (app/breaks.js, off by default): after about fifty minutes at it without
 *   a pause, a giant of it stretches with the user, then twenty seconds for the eyes, and it
 *   goes back to showing the work.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AwayLog, AWAY, LINE_KINDS, boardLines, awayMinutesMs } = require('../app/away');
const { BreakWatch, BREAK } = require('../app/breaks');
const giantLib = require('../app/giant');
const { translate } = require('../app/i18n');
const chat = require('../app/chat');
const { normalizeSettings, DEFAULTS } = require('../app/settings');
const { buildFunMenuTemplate, buildTrayTemplate } = require('../app/tray');
const { DEMOS } = require('../app/validate');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const quipT = (lang) => (key, vars) => translate(lang, 'quip', key, vars);
const MIN = 60000;

// ------------------------------------------------------------------ "While you were away"

test('away log: counts what happened between the last input and now, nothing else', () => {
  const log = new AwayLog();
  const t0 = 10 * 60 * MIN;
  log.note('done', t0 - 5 * MIN); // before the user left: not counted
  log.note('done', t0 + 2 * MIN);
  log.note('commit', t0 + 3 * MIN);
  log.note('push', t0 + 4 * MIN);
  log.note('done', t0 + 9 * MIN);
  log.note('rm -rf', t0 + 9 * MIN); // not a kind: ignored
  log.note('done', NaN);
  const s = log.summary({ since: t0, now: t0 + 20 * MIN, state: 'idle' });
  assert.deepEqual(s, { awayMs: 20 * MIN, done: 2, commits: 1, pushes: 1, waiting: false, bug: false, working: false });
  // How things stand now: waiting (a permission prompt, a question), a check still failing, still at work.
  assert.equal(log.summary({ since: t0, now: t0 + 20 * MIN, state: 'waiting' }).waiting, true);
  assert.equal(log.summary({ since: t0, now: t0 + 20 * MIN, state: 'asking' }).waiting, true);
  assert.equal(log.summary({ since: t0, now: t0 + 20 * MIN, state: 'standby' }).waiting, false, 'an idle prompt is not waiting for an answer');
  assert.equal(log.summary({ since: t0, now: t0 + 20 * MIN, state: 'running' }).working, true);
  assert.equal(log.summary({ since: t0, now: t0 + 20 * MIN, bug: true }).bug, true);
});

test('away log: no board when nothing happened; waiting or a failing check alone are worth one', () => {
  const log = new AwayLog();
  const since = 1000;
  const now = since + 30 * MIN;
  assert.equal(log.summary({ since, now }), null, 'nothing at all');
  assert.equal(log.summary({ since, now, state: 'working' }), null, 'only "still at work": the small one shows that');
  assert.ok(log.summary({ since, now, state: 'waiting' }), 'a question waiting');
  assert.ok(log.summary({ since, now, bug: true }), 'a check still failing');
  for (const bad of [{ since: NaN, now }, { since: now, now: since }, { since, now: undefined + 1 }]) assert.equal(log.summary(bad), null, JSON.stringify(bad));
});

test('away log: bounded (count and age), in memory only', () => {
  const log = new AwayLog({ keep: 3 });
  for (let i = 0; i < 10; i += 1) log.note('done', 1000 + i);
  assert.equal(log.events.length, 3);
  assert.deepEqual(log.events.map((e) => e.at), [1007, 1008, 1009]);
  const old = new AwayLog();
  old.note('done', 0);
  old.note('done', AWAY.maxAgeMs + 10);
  assert.equal(old.events.length, 1, 'older than a day: gone');
  assert.ok(AWAY.keep <= 1000);
  // Nothing is written anywhere: no fs, no network in the module.
  const src = read('app', 'away.js');
  for (const bad of ["require('fs')", "require('node:fs')", "require('http')", "require('net')", "require('electron')"]) assert.ok(!src.includes(bad), bad);
});

test('the board in words: title with the time, plural or not, git in one line, at most four lines', () => {
  const time = chat.formatDuration(awayMinutesMs(18 * MIN + 20000), (key, vars) => translate('tr', 'chat', key, vars));
  assert.equal(time, '18 dk');
  const s = { awayMs: 18 * MIN, done: 2, commits: 1, pushes: 3, waiting: true, bug: true, working: false };
  const tr = boardLines(s, quipT('tr'), time);
  assert.equal(tr.title, 'Sen yokken (18 dk)');
  assert.deepEqual(tr.lines, [
    { kind: 'done', text: '2 iş bitti' },
    { kind: 'git', text: '1 commit · 3 push' },
    { kind: 'waiting', text: 'Claude seni bekliyor' },
    { kind: 'bug', text: 'Bir test hâlâ kırmızı' },
  ]);
  assert.equal(tr.short, '2 iş bitti · 1 commit · 3 push');
  const en = boardLines({ ...s, done: 1, commits: 2, pushes: 1, waiting: false, bug: false, working: true }, quipT('en'), '1 h 5 min');
  assert.equal(en.title, 'While you were away (1 h 5 min)');
  assert.deepEqual(
    en.lines.map((l) => l.text),
    ['1 task done', '2 commits · 1 push', 'Claude is still at work'],
  );
  // Waiting wins over "still at work"; only commits, or only pushes.
  const only = boardLines({ ...s, done: 0, commits: 0, pushes: 1, bug: false, working: true }, quipT('en'), 'x');
  assert.deepEqual(only.lines, [
    { kind: 'git', text: '1 push' },
    { kind: 'waiting', text: 'Claude is waiting for you' },
  ]);
  for (const line of [...tr.lines, ...en.lines]) assert.ok(LINE_KINDS.includes(line.kind), line.kind);
  assert.ok(tr.lines.length <= AWAY.lines);
  // Long words are cut, never more than maxChars.
  const long = boardLines({ ...s }, () => 'x'.repeat(200), 'y');
  for (const text of [long.title, ...long.lines.map((l) => l.text)]) assert.ok(text.length <= AWAY.maxChars);
  assert.equal(boardLines(null, quipT('en'), 'x'), null);
  // Whole minutes, at least one.
  assert.equal(awayMinutesMs(29000), MIN);
  assert.equal(awayMinutesMs(5 * MIN + 31000), 6 * MIN);
});

// ------------------------------------------------------------------ stretch breaks

test('breaks: due after fifty minutes at it, and only while the user pauses for a moment', () => {
  const t0 = 1_000_000;
  const w = new BreakWatch({}, t0);
  assert.equal(BREAK.everyMs, 50 * MIN);
  assert.equal(w.feed(5, t0 + 49 * MIN), false, 'not yet');
  assert.equal(w.dueIn(t0 + 49 * MIN), MIN);
  assert.equal(w.feed(0, t0 + 50 * MIN), false, 'mid-typing: no');
  assert.equal(w.feed(BREAK.pauseS - 1, t0 + 50 * MIN), false);
  assert.equal(w.feed(BREAK.maxPauseS + 1, t0 + 50 * MIN), false, 'a long quiet: maybe not there');
  assert.equal(w.feed(BREAK.pauseS, t0 + 50 * MIN), true, 'a pause: now');
  // Offered, not taken (the page was busy): again a minute later, not before.
  assert.equal(w.feed(10, t0 + 50 * MIN + 10000), false);
  assert.equal(w.feed(10, t0 + 50 * MIN + BREAK.retryMs), true);
  for (const bad of [NaN, -1, 'x', undefined]) assert.equal(new BreakWatch({}, 0).feed(bad, 60 * MIN), false);
});

test('breaks: a real pause starts the clock again; a whole break too; skipped: a quarter of an hour', () => {
  const t0 = 0;
  const w = new BreakWatch({}, t0);
  // Five minutes without input (lunch, a call): a pause.
  assert.equal(w.feed(BREAK.restS, t0 + 40 * MIN), false);
  assert.equal(w.feed(10, t0 + 55 * MIN), false, 'only 15 minutes since the pause');
  assert.equal(w.feed(10, t0 + 90 * MIN), true);
  // A whole break: fifty more minutes.
  w.done(t0 + 91 * MIN);
  assert.equal(w.feed(10, t0 + 140 * MIN), false);
  assert.equal(w.feed(10, t0 + 141 * MIN), true);
  // Skipped: again in fifteen minutes.
  w.snooze(t0 + 142 * MIN);
  assert.equal(w.feed(10, t0 + 156 * MIN), false);
  assert.equal(w.feed(10, t0 + 157 * MIN), true);
  assert.equal(BREAK.snoozeMs, 15 * MIN);
  // Switched on: the fifty minutes start then.
  w.restart(t0 + 200 * MIN);
  assert.equal(w.dueIn(t0 + 200 * MIN), 50 * MIN);
});

test('breaks: a long lock (or sleep) is a pause, a short one is not; nothing is offered while locked', () => {
  const w = new BreakWatch({}, 0);
  w.locked(45 * MIN);
  assert.equal(w.feed(10, 51 * MIN), false, 'locked');
  w.unlocked(45 * MIN + BREAK.restS * 1000);
  assert.equal(w.dueIn(45 * MIN + BREAK.restS * 1000), 50 * MIN, 'clock started again');
  const v = new BreakWatch({}, 0);
  v.locked(45 * MIN);
  v.unlocked(46 * MIN);
  assert.equal(v.feed(10, 50 * MIN), true, 'a minute of lock: still due');
  v.unlocked(47 * MIN); // not locked: nothing
  assert.equal(v.lockedAt, null);
});

// ------------------------------------------------------------------ the giant's two new modes

const SCREENS = [
  [1920, 1040],
  [1536, 824],
  [2400, 1300],
  [1280, 680],
];

test('giant modes: the board walks up, holds it up, walks back; the break stretches, rests the eyes, cheers', () => {
  const { BOARD, BREAK_GIANT, BOARD_PHASES, BREAK_PHASES, boardTimeline, breakTimeline, answerTimeline, timelineFor } = giantLib;
  assert.deepEqual(boardTimeline().map((s) => s.phase), ['walk', 'board', 'back', null]);
  assert.deepEqual(breakTimeline().map((s) => s.phase), ['walk', 'reach', 'lean', 'neck', 'eyes', 'cheer', 'back', null]);
  for (const s of [...boardTimeline(), ...answerTimeline('board')]) assert.ok(s.phase === null || BOARD_PHASES.includes(s.phase));
  for (const s of [...breakTimeline(), ...answerTimeline('break')]) assert.ok(s.phase === null || BREAK_PHASES.includes(s.phase));
  assert.deepEqual(timelineFor('peek'), giantLib.timeline());
  // The board: up long enough to read, short enough not to be in the way.
  assert.ok(BOARD.boardMs >= 6000 && BOARD.boardMs <= 10000);
  assert.ok(BOARD.readMs < BOARD.boardMs);
  // The eyes: the whole count fits (twenty seconds), the whole break under a minute.
  assert.equal(BREAK_GIANT.countFrom, 20);
  assert.ok(BREAK_GIANT.eyesMs >= BREAK_GIANT.countLeadMs + BREAK_GIANT.countFrom * 1000);
  assert.ok(breakTimeline().at(-1).at < 60000);
  // Read / skipped: straight back; skipped says "Okay, later!" first.
  assert.deepEqual(answerTimeline('board').map((s) => s.phase), ['back', null]);
  assert.deepEqual(answerTimeline('break').map((s) => s.phase), ['skip', 'back', null]);
  assert.deepEqual(answerTimeline('peek'), giantLib.foundTimeline());
});

test('giant modes: smaller than the peek, cut lower: the board at its chest and its arms show', () => {
  const { BOARD, BREAK_GIANT, planGiant, SHAPE } = giantLib;
  for (const [width, height] of SCREENS) {
    const area = { x: 0, y: 0, width, height };
    const board = planGiant({ area, mode: 'board', board: { title: 't', lines: [] } });
    const brk = planGiant({ area, mode: 'break' });
    const peek = planGiant({ area });
    for (const [p, own] of [
      [board, BOARD],
      [brk, BREAK_GIANT],
    ]) {
      assert.ok(p, `${width}x${height}`);
      assert.ok(p.factor <= own.factor + 1e-9, `${width}x${height}: ${p.factor}`);
      assert.ok(p.cut >= own.minCut - 1e-9 && p.cut <= own.maxCut + 1e-9, `${width}x${height}: cut ${p.cut}`);
      assert.ok((p.cut - SHAPE.top) * p.size <= height * giantLib.GIANT.heightShare + 1, 'what shows fits the screen');
      assert.ok(p.factor <= peek.factor);
    }
    // The board (49 % to about 72 % of its box, renderer/giant.css) is above the screen's edge.
    assert.ok(board.cut >= 0.76, `${width}x${height}: board cut ${board.cut}`);
    assert.equal(board.mode, 'board');
    assert.equal(brk.mode, 'break');
    assert.equal(peek.mode, 'peek');
  }
  // Too small for it: null (the page puts the board's summary in the bubble instead).
  assert.equal(planGiant({ area: { x: 0, y: 0, width: 900, height: 500 }, mode: 'board' }), null);
});

test('giant modes: the words come as given by main (never from the page), checked again', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const board = giantLib.planGiant({
    area,
    mode: 'board',
    say: { hello: 'Hoş geldin!', listen: 'nope' },
    board: {
      title: 'Sen yokken (18 dk)',
      lines: [
        { kind: 'done', text: '2 iş bitti' },
        { kind: '<img>', text: 'x' },
        { kind: 'git', text: 42 },
        { kind: 'waiting', text: 'a'.repeat(300) },
        { kind: 'bug', text: '1' },
        { kind: 'working', text: '2' },
        { kind: 'done', text: '3' },
      ],
    },
  });
  assert.deepEqual(board.say, { hello: 'Hoş geldin!' });
  assert.equal(board.board.title, 'Sen yokken (18 dk)');
  assert.deepEqual(board.board.lines.map((l) => l.kind), ['done', 'waiting', 'bug', 'working'], 'known kinds only, at most four');
  assert.ok(board.board.lines.every((l) => l.text.length <= 80));
  assert.equal(giantLib.planGiant({ area, mode: 'board' }).board.lines.length, 0);
  const brk = giantLib.planGiant({ area, mode: 'break', say: { reach: 'Mola!', eyes: 3 } });
  assert.deepEqual(Object.keys(brk.say).sort(), ['cheer', 'eyes', 'lean', 'neck', 'reach', 'skip']);
  assert.equal(brk.say.reach, 'Mola!');
  assert.equal(brk.say.eyes, '');
  assert.deepEqual(brk.count, { from: 20, leadMs: 500 });
  assert.equal(brk.board, undefined);
  // An unknown mode is the peek.
  assert.equal(giantLib.planGiant({ area, mode: 'dance' }).mode, 'peek');
});

test('giant modes: the pointer reads the board (after a while) or skips the break; the request is checked', () => {
  const { pointerFound, parseGiantRequest, BOARD, HEARS_BREAK } = giantLib;
  const hit = { x: 0, y: 0, width: 100, height: 100 };
  const on = { x: 50, y: 50 };
  assert.equal(pointerFound({ mode: 'board', phase: 'board', cursor: on, hit, moved: true, inPhaseMs: BOARD.readMs - 1 }), false, 'not read yet');
  assert.equal(pointerFound({ mode: 'board', phase: 'board', cursor: on, hit, moved: true, inPhaseMs: BOARD.readMs }), true);
  assert.equal(pointerFound({ mode: 'board', phase: 'walk', cursor: on, hit, moved: true }), false);
  assert.equal(pointerFound({ mode: 'board', phase: 'board', cursor: on, hit, moved: false, inPhaseMs: 9999 }), false, 'never moved');
  for (const phase of ['reach', 'lean', 'neck', 'eyes']) assert.equal(pointerFound({ mode: 'break', phase, cursor: on, hit, moved: true }), true, phase);
  for (const phase of ['walk', 'cheer', 'skip', 'back']) assert.equal(pointerFound({ mode: 'break', phase, cursor: on, hit, moved: true }), false, phase);
  assert.equal(pointerFound({ mode: 'break', phase: 'eyes', cursor: { x: 150, y: 50 }, hit, moved: true }), false, 'not on it');
  assert.deepEqual([...HEARS_BREAK].sort(), ['eyes', 'lean', 'neck', 'reach']);
  // The peek is as it was.
  assert.equal(pointerFound({ phase: 'listen', cursor: on, hit, moved: true }), true);
  // Requests.
  assert.deepEqual(parseGiantRequest({ op: 'board', feet: { x: 1, y: 2 }, face: 'left', demo: true }), {
    op: 'board',
    feet: { x: 1, y: 2 },
    face: 'left',
    mode: 'board',
    demo: true,
  });
  assert.deepEqual(parseGiantRequest({ op: 'break', feet: { x: 1, y: 2 }, demo: 'yes' }), { op: 'break', feet: { x: 1, y: 2 }, face: 'right', mode: 'break', demo: false });
  assert.equal(parseGiantRequest({ op: 'start', feet: { x: 1, y: 2 } }).mode, undefined, 'the peek keeps its shape');
  assert.equal(parseGiantRequest({ op: 'board', feet: { x: 1, y: 2 }, board: { title: 'evil' } }).board, undefined, 'no words from the page');
  assert.equal(parseGiantRequest({ op: 'dance', feet: { x: 1, y: 2 } }), null);
});

// ------------------------------------------------------------------ the switches, the words, the demos

test('switches: the board on by default, stretch breaks off; both in the tray and the right-click menu', () => {
  assert.equal(DEFAULTS.awayBoard, true);
  assert.equal(DEFAULTS.breakCoach, false);
  assert.equal(normalizeSettings({}).awayBoard, true);
  assert.equal(normalizeSettings({ awayBoard: false }).awayBoard, false);
  assert.equal(normalizeSettings({ awayBoard: 'no' }).awayBoard, true);
  assert.equal(normalizeSettings({ breakCoach: true }).breakCoach, true);
  assert.equal(normalizeSettings({ breakCoach: 1 }).breakCoach, false);
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const fun = buildFunMenuTemplate({ settings: { ...DEFAULTS }, away: false, on });
  const board = fun.find((i) => i.label === 'While you were away: a board');
  const breaks = fun.find((i) => i.label === 'Stretch breaks (every 50 min)');
  assert.equal(board.type, 'checkbox');
  assert.equal(board.checked, true);
  assert.equal(breaks.checked, false);
  board.click({ checked: false });
  breaks.click({ checked: true });
  assert.deepEqual(calls, [
    ['setAwayBoard', false],
    ['setBreakCoach', true],
  ]);
  const tray = JSON.stringify(buildTrayTemplate({ settings: { ...DEFAULTS, language: 'tr' }, characters: [], sessionCount: 0, seenAccount: () => false, soundAvailable: false, instance: null, on }));
  assert.ok(tray.includes('Sen yokken panosu'));
  assert.ok(tray.includes("Esneme molası (50 dk'da bir)"));
  for (const lang of ['en', 'tr']) {
    const loc = JSON.parse(read('app', 'locales', `${lang}.json`));
    for (const key of ['awayBoard', 'breakCoach']) assert.ok(loc.menu[key], `${lang} menu.${key}`);
    for (const key of ['awayTitle', 'awayDoneOne', 'awayDone', 'awayCommitOne', 'awayCommits', 'awayPushOne', 'awayPushes', 'awayWaiting', 'awayBug', 'awayWorking', 'breakReach', 'breakLean', 'breakNeck', 'breakEyes', 'breakCheer', 'breakSkip']) {
      assert.ok(loc.quip[key], `${lang} quip.${key}`);
    }
  }
  assert.ok(DEMOS.has('board') && DEMOS.has('break'));
});

test('main.js: notes the work, makes the board when the user is back, times the breaks from the idle time', () => {
  const main = read('app', 'main.js');
  // What happened: a turn done (core.lastDoneAt), commits and pushes (moments); counts only.
  assert.ok(main.includes("awayLog.note('done');"));
  assert.ok(main.includes("if (kind === 'commit' || kind === 'push') awayLog.note(kind);"));
  // Back: the board's words stay here; the page gets a flag and the short summary.
  const send = main.slice(main.indexOf('function sendPresence('), main.indexOf('function takeBoard('));
  assert.ok(send.includes("if (change.kind === 'back' && settings.awayBoard !== false) {"));
  assert.ok(send.includes('pendingBoard = { board, at: now };'));
  assert.ok(send.includes('msg = { ...change, board: true, summary: board.short };'));
  const take = main.slice(main.indexOf('function takeBoard('), main.indexOf('function demoBoard('));
  assert.ok(take.includes('pendingBoard = null;'), 'taken once');
  assert.ok(take.includes('Date.now() - p.at <= BOARD_FRESH_MS'), 'fresh only');
  // The giant: each mode with its own switch; work ends only the peek.
  const start = main.slice(main.indexOf('function startGiant('), main.indexOf('function showGiant('));
  assert.ok(start.includes("if (!demo && settings.awayBoard === false) return refuse('switched off');"));
  assert.ok(start.includes("board = takeBoard();\n      if (!board) return refuse('nothing to show');"));
  assert.ok(start.includes("if (!demo && !settings.breakCoach) return refuse('switched off');"));
  assert.ok(start.includes('const plan = giantLib.planGiant({ area, from: { x: at.x / s, y: at.y / s }, face, say, mode, board });'));
  assert.ok(main.includes("if (giant && giant.mode === 'peek' && !CALM_STATES.has(snap.state)) endGiant('work came in');"));
  // Breaks: the idle time only, with the switch on; locks; a whole break or a skip.
  assert.ok(main.includes('if (settings.breakCoach && breakWatch.feed(idle)) offerBreak();'));
  assert.ok(main.includes('if (value) breakWatch.locked();\n        else breakWatch.unlocked();'));
  const end = main.slice(main.indexOf('function endGiant(why)'), main.indexOf('function popUpFunMenu('));
  assert.ok(end.includes("if (why === 'over') breakWatch.done();\n      else breakWatch.snooze();"));
  assert.ok(end.includes("const ranOut = why === 'no answer' || why === 'found' || why === 'over';"));
  // Switches and demos.
  assert.ok(main.includes("if (breakCoach) breakWatch.restart();"));
  assert.ok(main.includes("if (!awayBoard && giant && giant.mode === 'board') endGiant('switched off');"));
  assert.ok(main.includes("else if (name === 'board') demoBoard();"));
  assert.ok(main.includes("else if (name === 'break') offerBreak({ demo: true });"));
  // The cursor never leaves main (as for the peek).
  const watch = main.slice(main.indexOf('function watchGiant('), main.indexOf('function endGiant(why)'));
  assert.ok(!/send\([^)]*cursor/.test(watch));
});

test('the page: the board on return (or the summary in the bubble), the break when asked; neither gives way to work', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('if (change.board === true && showBoard(change)) return;'));
  assert.ok(page.includes("giantWhenDown('board', demo);"));
  assert.ok(page.includes("giantWhenDown('break', demo);"));
  assert.ok(page.includes("sayLine(`${quipString('welcomeBack')} ${text}`, BOARD_BUBBLE_MS);"), 'no giant: hello and the summary, as text');
  assert.ok(page.includes("if (giant && giantMode === 'peek' && (!CALM.has(view.state) || paused || (!giantDemo && !ambientOn()))) stopGiant('interrupted');"));
  assert.ok(page.includes("else if (giant && giantMode !== 'peek' && paused) stopGiant('interrupted');"));
  assert.ok(page.includes('window.buddy.onBreak((msg) => onBreak(msg));'));
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onBreak: on('buddy:break'),"));
  // While it is out, the small one's bubble and effects wait too (it may be at work).
  assert.ok(read('app', 'renderer', 'overlay.css').includes('.stage.giant-away :is(.bubble, .trail, .skill-tag, .account-tag, .fx) {\n  visibility: hidden;\n}'));
});

test('the giant\'s page: the board as text with a sign per line, the count, a pose for every phase', () => {
  const html = read('app', 'renderer', 'giant.html');
  assert.ok(html.includes('id="board" class="giant-board" hidden'));
  assert.ok(html.includes('id="count" class="giant-count"'));
  const page = read('app', 'renderer', 'giant.js');
  assert.ok(page.includes('span.textContent = line.text;'));
  assert.ok(page.includes("boardEl.querySelector('.giant-board-title').textContent ="));
  assert.ok(page.includes('countEl.textContent = String(n);'));
  assert.ok(!page.includes('innerHTML'));
  for (const phase of [...giantLib.BOARD_PHASES, ...giantLib.BREAK_PHASES]) assert.ok(page.includes(`'${phase}'`), `page: ${phase}`);
  const css = read('app', 'renderer', 'giant.css');
  for (const kind of LINE_KINDS) assert.ok(css.includes(`.giant-board-lines li.${kind}::before {`), `sign for ${kind}`);
  const robot = read('characters', 'robot', 'robot.css');
  for (const phase of ['reach', 'lean', 'neck', 'eyes', 'skip']) assert.ok(robot.includes(`[data-giant='${phase}']`), `robot.css: ${phase}`);
  // The laptop is put away while it holds the board and while it stretches.
  assert.ok(robot.includes(".buddy-character[data-board] .rb-laptop,\n.buddy-character:is([data-giant='reach'], [data-giant='lean'], [data-giant='neck'], [data-giant='eyes'], [data-giant='cheer'], [data-giant='skip']) .rb-laptop {"));
  // The poses last as long as their phases (keyframes vs app/giant.js).
  const { BREAK_GIANT } = giantLib;
  assert.ok(robot.includes(`rb-giant-tiptoe ${BREAK_GIANT.reachMs / 1000}s`));
  assert.ok(robot.includes(`rb-giant-lean ${BREAK_GIANT.leanMs / 1000}s`));
  assert.ok(robot.includes(`rb-giant-neck ${BREAK_GIANT.neckMs / 1000}s`));
  // The words of every mode get through (planGiant keeps only these).
  assert.ok(page.includes('say(plan.say.hello);'));
  assert.ok(page.includes('say(plan.say.eyes);'));
  assert.ok(page.includes('countDown(plan.count);'));
});
