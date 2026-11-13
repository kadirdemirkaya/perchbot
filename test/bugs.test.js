'use strict';

/** Bug hunt logic (app/bugs.js): which failures open a bug, which success fixes it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BugWatch, isCheck, checkKey, BUG_TIMINGS: T } = require('../app/bugs');
const { FakeClock } = require('./helpers/fake-clock');

function watch() {
  const clock = new FakeClock();
  const log = [];
  const w = new BugWatch({ clock, now: () => clock.now, onChange: (b) => log.push(b && b.phase) });
  return { clock, log, w };
}

test('bugs: checks are tests, builds, linters and type checks, not grep or git', () => {
  for (const c of ['npm test', 'node --test', 'npx vitest run', 'pytest', 'cargo build', 'go test ./...', 'npx tsc --noEmit', 'npm run lint', 'make']) {
    assert.ok(isCheck(c), c);
  }
  for (const c of ['grep -rn foo', 'ls', 'git status', 'cat a.txt', 'node script.js', 'go run .', '', null]) assert.ok(!isCheck(c), String(c));
  assert.equal(checkKey('npm test -- -t x'), 'npm test');
  assert.equal(checkKey('cargo test -p a'), 'cargo test');
  assert.equal(checkKey('pytest tests/a.py'), 'pytest');
  assert.equal(checkKey('node --test'), 'node --test');
});

test('bugs: a failing check opens a bug, the same check passing fixes it', () => {
  const { clock, log, w } = watch();
  w.toolStart('s', 't1', 'Bash', 'npm test');
  w.toolEnd('s', 't1', false);
  assert.equal(w.current().phase, 'open');
  // Other work in between changes nothing; another check passing does not fix it.
  w.toolStart('s', 't2', 'Bash', 'npm run lint');
  w.toolEnd('s', 't2', true);
  w.toolStart('s', 't3', 'Bash', 'grep -rn x');
  w.toolEnd('s', 't3', false);
  assert.equal(w.current().phase, 'open');
  w.toolStart('s', 't4', 'Bash', 'npm test -- -t parser');
  w.toolEnd('s', 't4', true);
  assert.equal(w.current().phase, 'fixed');
  clock.tick(T.winMs);
  assert.equal(w.current(), null);
  assert.deepEqual(log, ['open', 'fixed', null]);
});

test('bugs: one at a time; a bug nobody fixes, or whose session ends, scuttles off', () => {
  const { clock, log, w } = watch();
  w.toolStart('s', 'a', 'Bash', 'npm test');
  w.toolEnd('s', 'a', false);
  w.toolStart('s', 'b', 'Bash', 'cargo build');
  w.toolEnd('s', 'b', false);
  assert.equal(w.current().key, 'npm test', 'the second failure does not open another');
  clock.tick(T.maxMs);
  assert.equal(w.current().phase, 'escaped');
  clock.tick(T.escapeMs);
  assert.equal(w.current(), null);
  w.toolStart('s', 'c', 'Bash', 'npm test');
  w.toolEnd('s', 'c', false);
  assert.equal(w.current().id, 2);
  w.sessionGone('s');
  assert.equal(w.current().phase, 'escaped');
  // Results without a known start (or of other sessions) change nothing.
  clock.tick(T.escapeMs);
  w.toolEnd('s', 'unknown', false);
  w.toolStart('x', 'd', 'Bash', 'npm test');
  w.toolEnd('s', 'd', false);
  assert.equal(w.current(), null);
  assert.deepEqual(log, ['open', 'escaped', null, 'open', 'escaped', null]);
});
