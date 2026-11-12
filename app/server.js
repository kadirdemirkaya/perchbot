'use strict';

/**
 * Local HTTP endpoint the hook script talks to.
 *
 *   POST /event   body: one event (see app/validate.js)   -> 204
 *   GET  /health  -> 200 { app: "agent-buddy", ... }
 *
 * Hardening: binds to 127.0.0.1 only; rejects browser requests (Origin /
 * Sec-Fetch-* headers), foreign Host headers (DNS rebinding), non-JSON
 * bodies, bodies over 4 KB and anything that fails schema validation.
 */

const http = require('node:http');
const { validateEvent, MAX_BODY_BYTES } = require('./validate');

const HOST = '127.0.0.1';

function isBrowserRequest(headers) {
  return (
    headers.origin !== undefined ||
    headers['sec-fetch-site'] !== undefined ||
    headers['sec-fetch-mode'] !== undefined
  );
}

function isAllowedHost(hostHeader, port) {
  return hostHeader === `${HOST}:${port}` || hostHeader === `localhost:${port}`;
}

/**
 * @param {object} options
 * @param {number} options.port  0 picks a free port (used by tests)
 * @param {(evt: object) => void} options.onEvent
 * @param {() => object} [options.getHealth]
 * @returns {Promise<import('node:http').Server>}  rejects with the listen error (e.g. EADDRINUSE)
 */
function startServer({ port, onEvent, getHealth = () => ({}) }) {
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      // One request per connection: a hook sends one event and exits. A client
      // that kept the connection (Windows PowerShell does) would otherwise reuse
      // it after keepAliveTimeout, find it closed and lose that event.
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' };
      if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      res.writeHead(status, headers);
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    const actualPort = server.address() && server.address().port;
    if (isBrowserRequest(req.headers)) return reply(403, { error: 'browser requests are not allowed' });
    if (!isAllowedHost(req.headers.host, actualPort)) return reply(403, { error: 'unexpected Host header' });

    const pathname = (req.url || '').split('?')[0];

    if (pathname === '/health') {
      if (req.method !== 'GET') return reply(405, { error: 'method not allowed' });
      return reply(200, { app: 'agent-buddy', ...getHealth() });
    }

    if (pathname !== '/event') return reply(404, { error: 'not found' });
    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });

    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return reply(415, { error: 'expected application/json' });

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reply(413, { error: 'payload too large' });
      req.destroy();
      return undefined;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reply(413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'invalid JSON' });
      }
      const evt = validateEvent(parsed);
      if (!evt) return reply(400, { error: 'invalid event' });
      try {
        onEvent(evt);
      } catch {
        // A bug in the handler must not turn into an error for the hook.
      }
      return reply(204);
    });
    req.on('error', () => {});
    return undefined;
  });

  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 40;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: HOST, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startServer, HOST };
