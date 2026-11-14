'use strict';

/** One buddy per account (app/instances.js) and what it needs elsewhere. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const instances = require('../app/instances');
const { DEFAULTS, normalizeSettings, patchSettings, loadSettings } = require('../app/settings');
const placement = require('../app/placement');
const { startServer } = require('../app/server');
const { BuddyCore } = require('../app/core');
const { validateEvent } = require('../app/validate');

test('instances: the account argument, its ports and its file', () => {
  assert.equal(instances.accountArg(['electron', '.', '--account=claude-work']), 'claude-work');
  assert.equal(instances.accountArg(['electron', '.']), null, 'no argument: one buddy for all');
  for (const bad of ['--account=', '--account=all', '--account=../x', '--account=a b']) {
    assert.equal(instances.accountArg([bad]), null, bad);
  }
  const ports = instances.candidatePorts(7777, 'claude-work');
  assert.equal(ports.length, instances.PORT_TRIES);
  assert.equal(ports[0], instances.preferredPort(7777, 'claude-work'));
  assert.ok(ports.every((p, i) => p === ports[0] + i));
  assert.ok(ports[0] > 7777 && ports[0] <= 7777 + instances.PORT_SPAN, 'never the shared port');
  assert.equal(instances.preferredPort(7777, 'a'), instances.preferredPort(7777, 'a'), 'stable');
  assert.equal(instances.preferredPort(65530, 'a'), instances.preferredPort(7777, 'a'), 'a base too high: the default');
  assert.equal(instances.instanceFile('/h', 'claude-work'), path.join('/h', 'instances', 'claude-work.json'));
  assert.deepEqual(instances.parseInstance('{"port":7800,"pid":12}'), { port: 7800, pid: 12 });
  assert.deepEqual(instances.parseInstance('{"port":7800}'), { port: 7800, pid: null });
  for (const bad of ['', '{', '{"port":80}', '{"port":"7800"}', 'null']) assert.equal(instances.parseInstance(bad), null, bad);
});

test('instances: buddies of different accounts stand side by side in the corner', () => {
  const known = ['claude-work', 'claude', 'claude-personal'];
  assert.equal(instances.slotIndex('claude', known), 0);
  assert.equal(instances.slotIndex('claude-personal', known), 1);
  assert.equal(instances.slotIndex('claude-work', known), 2);
  assert.equal(instances.slotIndex('new-one', []), 0, 'alone: the corner itself');
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = placement.cornerAnchor(area, 'bottom-right', 1);
  assert.deepEqual(placement.cornerAnchor(area, 'bottom-right', 1, 0), right, 'slot 0: unchanged');
  const second = placement.cornerAnchor(area, 'bottom-right', 1, 1);
  assert.equal(second.y, right.y);
  assert.equal(right.x - second.x, placement.SLOT.width + instances.SIDE_GAP, 'one slot further in');
  const left = placement.cornerAnchor(area, 'bottom-left', 1, 1);
  assert.ok(left.x > placement.cornerAnchor(area, 'bottom-left', 1).x, 'from the left corner: to the right');
  assert.ok(placement.cornerAnchor(area, 'bottom-right', 1, 50).x >= area.width / 2, 'never past the middle');
  // resolveAnchor and a drop near its spot use the same slot.
  const display = { id: 1, workArea: area };
  assert.deepEqual(placement.resolveAnchor({ position: null, corner: 'bottom-right' }, [display], display, 1, 1).anchor, second);
  const near = { x: second.x + 10, y: second.y };
  assert.deepEqual(placement.dropPlacement(near, [display], display, 1, 1), { position: null, corner: 'bottom-right' });
  assert.deepEqual(placement.settleAnchor(near, [display], display, 1, 1), second);
});

test('settings: one buddy per account is off by default; each account keeps its own place', () => {
  assert.equal(DEFAULTS.perAccount, false);
  assert.equal(normalizeSettings({}).perAccount, false);
  assert.equal(normalizeSettings({ perAccount: true }).perAccount, true);
  assert.equal(normalizeSettings({ perAccount: 'yes' }).perAccount, false);
  const s = normalizeSettings({ positions: { 'claude-work': { x: 10.4, y: 20 }, '../bad': { x: 1, y: 1 }, all: { x: 1, y: 1 }, broken: { x: 'a' } } });
  assert.deepEqual(s.positions, { 'claude-work': { x: 10, y: 20 } });
  assert.deepEqual(normalizeSettings({ positions: [1, 2] }).positions, {});
});

test('settings: a change is applied to the file as it is now, so overlays never undo each other', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-test-'));
  const file = path.join(home, 'settings.json');
  // Buddy A has a stale copy; buddy B saved its place and the language meanwhile.
  const stale = normalizeSettings({});
  patchSettings({ language: 'tr', positions: { b: { x: 5, y: 6 } } }, stale, file);
  const saved = patchSettings((current) => ({ positions: { ...current.positions, a: { x: 1, y: 2 } } }), stale, file);
  assert.equal(saved.language, 'tr', "B's language stays");
  assert.deepEqual(saved.positions, { b: { x: 5, y: 6 }, a: { x: 1, y: 2 } }, 'both places');
  assert.deepEqual(loadSettings(file).settings, saved);
  // A broken file: replaced by the caller's settings with the change, as before.
  fs.writeFileSync(file, '{broken');
  const repaired = patchSettings({ size: 'large' }, { ...stale, quiet: true }, file);
  assert.equal(repaired.size, 'large');
  assert.equal(repaired.quiet, true);
});

test('server: an event of another account gets 421 (the hook then starts the right buddy)', async () => {
  const got = [];
  const server = await startServer({ port: 0, onEvent: (evt) => got.push(evt), accept: (evt) => evt.event === 'Demo' || evt.account === 'claude-work' });
  const port = server.address().port;
  const post = (body) =>
    new Promise((resolve) => {
      const text = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/event', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.end(text);
    });
  assert.equal(await post({ v: 1, event: 'Stop', session: 's', ts: 1, account: 'claude-work' }), 204);
  assert.equal(await post({ v: 1, event: 'Stop', session: 's', ts: 1, account: 'claude' }), 421);
  assert.equal(await post({ v: 1, event: 'Stop', session: 's', ts: 1 }), 421, 'no account: not for an account buddy');
  assert.equal(await post({ v: 1, event: 'Demo', session: 's', ts: 1, demo: 'jump' }), 204, 'demos always');
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(got.map((e) => e.account || e.event), ['claude-work', 'Demo']);
});

test('switching the mode: the live sessions go over to the new buddies, each with a resume start', () => {
  const core = new BuddyCore({ liveness: { isAlive: () => true, startTimeOf: (_pid, cb) => cb && cb(null), intervalMs: 1e9 } });
  core.handle({ v: 1, event: 'SessionStart', session: 'a1', ts: 1, account: 'claude-work', pid: 4242 });
  core.handle({ v: 1, event: 'UserPromptSubmit', session: 'b1', ts: 2, account: 'claude' });
  core.handle({ v: 1, event: 'Stop', session: 'c1', ts: 3 });
  const list = core.handover();
  core.dispose();
  assert.deepEqual(list, [
    { session: 'a1', account: 'claude-work', pid: 4242 },
    { session: 'b1', account: 'claude', pid: null },
    { session: 'c1', account: null, pid: null },
  ]);
  const on = instances.handoverLaunches(list, true, 99);
  assert.deepEqual(on.map((l) => l.account), ['claude-work', 'claude'], 'no account: nowhere to go');
  assert.deepEqual(on[0].event, { v: 1, event: 'SessionStart', session: 'a1', ts: 99, source: 'resume', account: 'claude-work', pid: 4242 });
  const off = instances.handoverLaunches(list, false, 99);
  assert.deepEqual(off.map((l) => l.account), [null, null, null], 'all to the one buddy');
  assert.equal(off[1].event.account, 'claude');
  for (const l of [...on, ...off]) assert.ok(validateEvent(l.event), 'a valid first event');
});
