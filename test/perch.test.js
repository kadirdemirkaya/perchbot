'use strict';

/** Perching on a window's title bar (app/perch.js) and the window scan (app/winscan.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { PERCH, pickPerch, followPerch, parseScan } = require('../app/perch');
const { createScanner, encodedCommand, SCRIPT } = require('../app/winscan');
const { SLOT } = require('../app/placement');

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const areas = [area];
const win = (id, x, y, w, h, max = false) => ({ id, x, y, w, h, max });

test('pickPerch: a spot on the top edge of a window with room above, not covered', () => {
  const windows = [win('1', 600, 500, 700, 400)];
  for (let i = 0; i < 20; i += 1) {
    const spot = pickPerch({ windows, areas, random: () => i / 20 });
    assert.equal(spot.id, '1');
    assert.equal(spot.anchor.y, 500, 'on the top edge');
    assert.ok(spot.anchor.x - SLOT.width / 2 >= 600 && spot.anchor.x + SLOT.width / 2 <= 1300, 'on the window');
    assert.equal(spot.offset, spot.anchor.x - 600);
  }
  // No room above (too close to the top of the screen), maximised, too narrow: nothing.
  assert.equal(pickPerch({ windows: [win('1', 600, 100, 700, 400)], areas }), null);
  assert.equal(pickPerch({ windows: [win('1', 0, 0, 1920, 1040, true)], areas }), null);
  assert.equal(pickPerch({ windows: [win('1', 600, 500, SLOT.width + 10, 400)], areas }), null);
  assert.equal(pickPerch({ windows: [win('1', 600, 500, 700, 400)], areas: [] }), null);
  // Partly covered by a window in front: only the free part of the edge.
  const covered = [win('2', 500, 300, 600, 400), win('1', 600, 500, 900, 400)];
  for (let i = 0; i < 20; i += 1) {
    const spot = pickPerch({ windows: covered, areas, random: () => i / 20 });
    if (spot.id === '1') assert.ok(spot.anchor.x - SLOT.width / 2 >= 1100, `free of the window in front: ${spot.anchor.x}`);
  }
  // Fully covered: only the window in front.
  const hidden = [win('2', 0, 300, 1920, 700), win('1', 600, 500, 700, 400)];
  assert.ok([...Array(10)].every((_, i) => pickPerch({ windows: hidden, areas, random: () => i / 10 }).id === '2'));
  // Rather somewhere new.
  const two = [win('1', 100, 500, 400, 300), win('2', 1300, 500, 400, 300)];
  const near = { x: 300, y: 500 };
  assert.ok([...Array(10)].every((_, i) => pickPerch({ windows: two, areas, from: near, random: () => i / 10 }).id === '2'));
  // Bad input is ignored.
  assert.equal(pickPerch({ windows: [{ id: 1, x: 'a' }, null], areas }), null);
});

test('followPerch: stays, rides along with the window, falls off when it goes', () => {
  const perch = { id: '1', offset: 300, rect: { x: 600, y: 500, w: 700, h: 400 } };
  assert.deepEqual(followPerch(perch, { windows: [win('1', 600, 500, 700, 400)], areas }), { kind: 'stay' });
  const moved = followPerch(perch, { windows: [win('1', 650, 520, 700, 400)], areas });
  assert.equal(moved.kind, 'move');
  assert.deepEqual(moved.anchor, { x: 950, y: 520 }, 'same place along the edge');
  // Narrower: squeezed in.
  const narrow = followPerch({ ...perch, offset: 650 }, { windows: [win('1', 600, 500, 400, 400)], areas });
  assert.equal(narrow.kind, 'move');
  assert.ok(narrow.anchor.x + SLOT.width / 2 <= 1000);
  const fall = (windows) => followPerch(perch, { windows, areas });
  assert.deepEqual(fall([]), { kind: 'fall', why: 'gone' });
  assert.deepEqual(fall([win('1', 0, 0, 1920, 1040, true)]), { kind: 'fall', why: 'maximised' });
  assert.deepEqual(fall([win('1', 600, 50, 700, 400)]), { kind: 'fall', why: 'no room' });
  assert.deepEqual(fall([win('9', 0, 0, 1920, 1040), win('1', 600, 500, 700, 400)]), { kind: 'fall', why: 'covered' });
  assert.deepEqual(fall([win('1', 600 + PERCH.maxJump + 100, 500, 700, 400)]).kind, 'fall');
  assert.ok(PERCH.followMs <= 1000, 'follows a dragged window closely');
});

test('parseScan: only well-formed frames with a numeric handle, a bounded list', () => {
  assert.deepEqual(parseScan('[{"id":123,"x":1,"y":2,"w":300,"h":200,"max":false}]'), [{ id: '123', x: 1, y: 2, w: 300, h: 200, max: false }]);
  assert.equal(parseScan('not json'), null);
  assert.equal(parseScan('{"a":1}'), null);
  assert.deepEqual(parseScan('[{"id":"x1","x":1,"y":2,"w":3,"h":4},{"id":5,"x":"1"},null,{"id":6,"x":0,"y":0,"w":0,"h":5}]'), []);
  const many = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, x: 0, y: 0, w: 10, h: 10 })));
  assert.equal(parseScan(many).length, 64);
});

test('window scan: only on Windows; frames and handles only; a quiet helper that stops', async () => {
  // The helper reads no titles or process names, and writes nothing.
  assert.ok(!/GetWindowText|GetClassName|Process|Out-File|Set-Content|Invoke-WebRequest/i.test(SCRIPT));
  assert.ok(SCRIPT.includes('DwmGetWindowAttribute') && SCRIPT.includes('EnumWindows'));
  assert.equal(Buffer.from(encodedCommand('hi'), 'base64').toString('utf16le'), 'hi');
  // Elsewhere: nothing, and nothing started.
  let spawned = 0;
  const elsewhere = createScanner({ platform: 'linux', spawnFn: () => (spawned += 1) });
  assert.equal(await elsewhere.scan(), null);
  assert.equal(spawned, 0);
  // A fake helper answers each "scan" line with a frame list.
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const lines = [];
  child.stdin.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      lines.push(line);
      if (line === 'scan') child.stdout.write('[{"id":7,"x":10,"y":20,"w":300,"h":200,"max":false}]\n');
    }
  });
  let args = null;
  const scanner = createScanner({ platform: 'win32', spawnFn: (cmd, a, opts) => ((args = { cmd, a, opts }), child) });
  child.stdout.write('ready\n');
  assert.deepEqual(await scanner.scan(), [{ id: '7', x: 10, y: 20, w: 300, h: 200, max: false }]);
  assert.equal(args.cmd, 'powershell.exe');
  assert.ok(args.a.includes('-EncodedCommand') && args.a.includes('-NoProfile'));
  assert.equal(args.opts.windowsHide, true);
  assert.equal(scanner.running, true);
  scanner.stop();
  assert.equal(scanner.running, false);
  assert.ok(lines.includes('quit'));
});
