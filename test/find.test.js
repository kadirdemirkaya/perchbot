'use strict';

/** "Come and tell me" (app/find.js): a long turn is done while the user looks elsewhere. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIND, findReason, turnMs } = require('../app/find');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const long = { startedAt: 0, endedAt: FIND.minTurnMs };
const slot = { x: 1400, y: 800 };

test('only after a long turn (2 minutes or more), never for a short one or without one', () => {
  assert.ok(FIND.minTurnMs >= 120000, 'a long turn');
  const far = { x: 300, y: 300 };
  assert.equal(findReason({ turn: long, cursor: far, slot }), null);
  assert.equal(findReason({ turn: { startedAt: 0, endedAt: FIND.minTurnMs - 1 }, cursor: far, slot }), 'short');
  assert.equal(findReason({ turn: null, cursor: far, slot }), 'short');
  assert.equal(findReason({ turn: { startedAt: 5 }, cursor: far, slot }), 'short', 'not over yet');
  assert.equal(turnMs({ startedAt: 1000, endedAt: 181000 }), 180000);
  assert.ok(Number.isNaN(turnMs(null)));
});

test('only when the cursor is far from the robot (scaled with its size) or on another screen', () => {
  const near = { x: slot.x - FIND.farPx + 1, y: slot.y };
  const edge = { x: slot.x - FIND.farPx, y: slot.y };
  assert.equal(findReason({ turn: long, cursor: near, slot }), 'near', 'the user is right there');
  assert.equal(findReason({ turn: long, cursor: edge, slot }), null);
  // Large robot: the same cursor counts as near.
  assert.equal(findReason({ turn: long, cursor: edge, slot, scale: 1.3 }), 'near');
  // Small robot: a little closer is far enough.
  assert.equal(findReason({ turn: long, cursor: { x: slot.x - FIND.farPx * 0.8, y: slot.y }, slot, scale: 0.8 }), null);
  // On another screen it always goes, however close the numbers are.
  assert.equal(findReason({ turn: long, cursor: near, slot, sameDisplay: false }), null);
  assert.equal(findReason({ turn: long, cursor: null, slot }), 'nocursor');
});

test('not while the user is away (no input for a while, or the screen locked)', () => {
  assert.equal(findReason({ turn: long, cursor: { x: 0, y: 0 }, slot, away: true }), 'away');
});

test('wired through main.js: after the "done" bubble, offered to the page, beside the cursor, then back', () => {
  const main = read('app', 'main.js');
  assert.ok(/const FUN_ACTIONS = new Set\(\[[^\]]*'find'/.test(main));
  assert.ok(/const STAY_PUT_BLOCKS = new Set\(\[[^\]]*'find'/.test(main), '"Stay here" keeps it where it is');
  // The transition is seen before lastCoreState moves on; the offer goes after the new view
  // (the page decides by it: still 'done' there, it would say no).
  assert.ok(main.includes('    const findNow = noteFind(snap.state);\n    lastCoreState = snap.state;\n    sendView();\n    if (findNow) offerFind(findNow.turn);'));
  // Remembered on 'done', offered only when the done bubble is over (back to idle or standby).
  assert.ok(main.includes("if (!due || lastCoreState !== 'done' || (state !== 'idle' && state !== 'standby')) return null;"));
  assert.ok(main.includes('const why = demo ? null : findLib.findReason({ turn, cursor, slot, scale: scale(), sameDisplay, away: presence.away || presence.lockedAt !== null });'));
  // Never with ambient life off, "Stay here", "Always stand", or anything else going on.
  assert.ok(main.includes("settings.ambientLife && !settings.stayPut && settings.hoverMode !== 'stand'"));
  assert.ok(main.includes('!paused && !quitting && !drag && !trip && !warping && !flipping && !rampage && !fist && !handsBusy && !peekBack && !typingVisit && !chatOpen'));
  assert.ok(main.includes("else if (action === 'find') settings.ambientLife && goFind();"));
  // A trip of its own kind (no "What's this?" on arrival), not stopped by new work, and back like a look.
  assert.ok(main.includes("plan.kind = 'find';"));
  assert.ok(main.includes("beginTrip(plan, 'find', then, { peek: true });"));
  assert.ok(main.includes("win.webContents.send('buddy:find', { phase: 'here' });\n    lookThenBack(from);"));
  assert.ok(main.includes("else if (name === 'find') demoFind();"));
  // The bridge and the demo list.
  const preload = read('app', 'preload.js');
  assert.ok(preload.includes("onFind: on('buddy:find'),"));
  assert.ok(/const FUN_ACTIONS = new Set\(\[[^\]]*'find'/.test(preload));
  assert.ok(read('app', 'validate.js').includes("  'find',"));
});

test('on the page: only when free (as for a look at the cursor); there, a happy hop and the line', () => {
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('window.buddy.onFind((msg) => onFind(msg));'));
  assert.ok(page.includes('if (settings.stayPut || !ambientOn() || raging || moving || drag || duel.active || hunt.active || chatOpen || guest || guestPending || fisting || typingLook) return;'));
  assert.ok(page.includes('if (!AMBIENT_STATES.has(view.state) || crewCount > 0 || pet.here || zone !== null || rest.resting) return;'));
  assert.ok(page.includes("window.buddy.fun('find');"));
  assert.ok(page.includes("quip('foundYou', FOUND_MS);"));
  assert.ok(page.includes('glee.trigger();\n      burstConfetti();'));
  for (const lang of ['en', 'tr']) {
    const quips = JSON.parse(read('app', 'locales', `${lang}.json`)).quip;
    assert.ok(quips && typeof quips.foundYou === 'string' && quips.foundYou.length > 3, `${lang}: foundYou`);
  }
});
