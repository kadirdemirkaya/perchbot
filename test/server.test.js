'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('../app/server');

let server;
let port;
const received = [];

before(async () => {
  server = await startServer({
    port: 0,
    onEvent: (evt) => received.push(evt),
    getHealth: () => ({ state: 'idle', sessions: 0 }),
  });
  port = server.address().port;
});

after(() => server.close());

function request({ method = 'POST', path = '/event', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', (err) => resolve({ status: 0, error: err.code }));
    req.end(data);
  });
}

const valid = { v: 1, event: 'Stop', session: 'abc', ts: 1, extra: 'dropped' };

test('binds to 127.0.0.1 only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('accepts a valid event and passes on only whitelisted fields', async () => {
  const before = received.length;
  const r = await request({ body: valid });
  assert.equal(r.status, 204);
  assert.equal(received.length, before + 1);
  assert.deepEqual(received.at(-1), { v: 1, event: 'Stop', session: 'abc', ts: 1 });
});

test('health endpoint', async () => {
  const r = await request({ method: 'GET', path: '/health' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).app, 'agent-buddy');
});

test('rejects browser requests (Origin / Sec-Fetch-*)', async () => {
  assert.equal((await request({ body: valid, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request({ body: valid, headers: { Origin: 'null' } })).status, 403);
  assert.equal((await request({ body: valid, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request({ method: 'GET', path: '/health', headers: { 'Sec-Fetch-Mode': 'no-cors' } })).status, 403);
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  assert.equal((await request({ body: valid, headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request({ body: valid, headers: { Host: `localhost:${port}` } })).status, 204);
});

test('requires application/json', async () => {
  const r = await request({ body: JSON.stringify(valid), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
});

test('limits body size', async () => {
  const big = { ...valid, detail: 'x'.repeat(5000) };
  const r = await request({ body: big });
  assert.ok(r.status === 413 || r.error === 'ECONNRESET' || r.error === 'EPIPE', JSON.stringify(r));
});

test('rejects invalid JSON and invalid events', async () => {
  assert.equal((await request({ body: '{nope' })).status, 400);
  assert.equal((await request({ body: { v: 1, event: 'Nope', session: 'a', ts: 1 } })).status, 400);
  assert.equal((await request({ body: { v: 2, event: 'Stop', session: 'a', ts: 1 } })).status, 400);
  assert.equal((await request({ body: { v: 1, event: 'Stop', session: 'a b', ts: 1 } })).status, 400);
  assert.equal((await request({ body: { v: 1, event: 'PreToolUse', session: 'a', ts: 1 } })).status, 400);
});

test('unknown paths and wrong methods', async () => {
  assert.equal((await request({ method: 'GET', path: '/event' })).status, 405);
  assert.equal((await request({ method: 'POST', path: '/health', body: valid })).status, 405);
  assert.equal((await request({ method: 'GET', path: '/' })).status, 404);
});

test('a port that is already taken fails loudly instead of moving on', async () => {
  await assert.rejects(startServer({ port, onEvent: () => {} }), { code: 'EADDRINUSE' });
});
