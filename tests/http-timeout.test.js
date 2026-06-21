// ════════════════════════════════════════════════════════════════════════════
// tests/http-timeout.test.js
//
// Drives lib/http-timeout against REAL local http servers (no mocks): a normal
// responder, a connect-but-never-reply stall, and a headers-then-stall trickle.
// Proves: normal responses still resolve (no regression), a hang is aborted with
// a retryable ETIMEDOUT, the promise actually settles (worker can't hang), and
// the overall deadline bounds total time even when bytes have started flowing.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');
const { requestWithTimeouts } = require('../lib/http-timeout');

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
function close(server) {
  return new Promise((res) => server.close(res));
}

test('normal response still resolves with { status, data } — no regression', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(server);
  try {
    const { status, data } = await requestWithTimeouts(
      { protocol: 'http:', hostname: '127.0.0.1', port, path: '/', method: 'GET' },
      null, { connectMs: 1000, responseMs: 1000, overallMs: 2000 },
    );
    assert.equal(status, 200);
    assert.equal(data, '{"ok":true}');
  } finally { await close(server); }
});

test('a hanging request is aborted (response timeout) and the promise settles', async () => {
  const sockets = new Set();
  const server  = http.createServer(() => { /* accept, never respond */ });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const port = await listen(server);
  const t0   = Date.now();
  try {
    await requestWithTimeouts(
      { protocol: 'http:', hostname: '127.0.0.1', port, path: '/', method: 'GET' },
      null, { connectMs: 2000, responseMs: 250, overallMs: 5000 },
    );
    assert.fail('expected a timeout rejection');
  } catch (e) {
    assert.equal(e.code, 'ETIMEDOUT');
    assert.equal(e.timeout, true);
    assert.ok(Date.now() - t0 < 2000, 'must abort promptly, not hang');
  } finally {
    sockets.forEach((s) => s.destroy());
    await close(server);
  }
});

test('overall deadline bounds total time even after bytes start flowing', async () => {
  const server = http.createServer((req, res) => {
    res.on('error', () => {});            // swallow EPIPE when we abort mid-stream
    res.writeHead(200);
    res.write('partial');                 // start the body, then never end
  });
  const port = await listen(server);
  const t0   = Date.now();
  try {
    await requestWithTimeouts(
      { protocol: 'http:', hostname: '127.0.0.1', port, path: '/', method: 'GET' },
      null, { connectMs: 2000, responseMs: 2000, overallMs: 350 },
    );
    assert.fail('expected an overall-deadline rejection');
  } catch (e) {
    assert.equal(e.code, 'ETIMEDOUT');
    assert.ok(Date.now() - t0 < 1500, 'overall deadline should cap total time');
  } finally { await close(server); }
});

test('a fast success is not clobbered by a later overall timer (single settle, no leak)', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('{"ok":1}'); });
  const port = await listen(server);
  try {
    const r = await requestWithTimeouts(
      { protocol: 'http:', hostname: '127.0.0.1', port, path: '/', method: 'GET' },
      null, { connectMs: 1000, responseMs: 1000, overallMs: 60 },
    );
    assert.equal(r.status, 200);
    assert.equal(r.data, '{"ok":1}');
    // Let the (cancelled) overall window elapse. If clearAll() didn't cancel the
    // timer, a stale fire would run after settle; the settled-guard keeps it a
    // no-op, and node:test would surface any unhandled rejection. Value must hold.
    await new Promise((res2) => setTimeout(res2, 150));
    assert.equal(r.status, 200);
  } finally { await close(server); }
});
