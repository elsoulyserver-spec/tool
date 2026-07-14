'use strict';

// Tests for the UI migration seam (lib/next-proxy.js).
// Documents BOTH behaviours the launch plan requires:
//   1. which routes are proxied vs. left on the legacy app, and
//   2. the fail-safe fallback so a dead/slow Next service never breaks EasyTrac.
//
// Run: node --test tests/next-proxy.test.js

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');

const nextProxy = require('../lib/next-proxy');

// ── helpers ───────────────────────────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}
function url(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// Minimal HTTP GET that does NOT follow redirects (so we can assert 302s).
function get(base, path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// A stand-in for server.js: proxies migrated routes, else serves "LEGACY".
function startFront({ upstream, timeoutMs, env }) {
  const seamEnv = { NEXT_UI_ENABLED: 'true', MIGRATED_ROUTES: '/home', ...env };
  const server = http.createServer((req, res) => {
    if (nextProxy.shouldProxyToNext(req.url, seamEnv)) {
      return nextProxy.proxyToNext(req, res, { upstream, timeoutMs, env: seamEnv });
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('LEGACY');
  });
  return listen(server);
}

// ── shouldProxyToNext (pure) ────────────────────────────────────────────────────

test('inert by default: nothing is proxied unless NEXT_UI_ENABLED=true', () => {
  assert.strictEqual(nextProxy.shouldProxyToNext('/home', {}), false);
  assert.strictEqual(nextProxy.shouldProxyToNext('/home', { NEXT_UI_ENABLED: 'false' }), false);
  assert.strictEqual(nextProxy.shouldProxyToNext('/_next/x', {}), false);
});

test('enabled: only allowlisted routes are proxied', () => {
  const on = { NEXT_UI_ENABLED: 'true', MIGRATED_ROUTES: '/home' };
  assert.strictEqual(nextProxy.shouldProxyToNext('/home', on), true);
  assert.strictEqual(nextProxy.shouldProxyToNext('/home/', on), true);       // trailing slash
  assert.strictEqual(nextProxy.shouldProxyToNext('/home?x=1', on), true);    // query string
  assert.strictEqual(nextProxy.shouldProxyToNext('/dashboard', on), false);  // not migrated
  assert.strictEqual(nextProxy.shouldProxyToNext('/', on), false);
});

test('the API surface is NEVER proxied, even when migrated', () => {
  const on = { NEXT_UI_ENABLED: 'true', MIGRATED_ROUTES: '/home,/api/x' };
  assert.strictEqual(nextProxy.shouldProxyToNext('/api/x', on), false);
  assert.strictEqual(nextProxy.shouldProxyToNext('/api/managed/health', on), false);
});

test('Next runtime assets are proxied so the page hydrates', () => {
  const on = { NEXT_UI_ENABLED: 'true', MIGRATED_ROUTES: '/home' };
  assert.strictEqual(nextProxy.shouldProxyToNext('/_next/static/chunk.js', on), true);
  assert.strictEqual(nextProxy.shouldProxyToNext('/_next/data/build/home.json', on), true);
});

test('MIGRATED_ROUTES defaults to /home when unset', () => {
  assert.strictEqual(nextProxy.shouldProxyToNext('/home', { NEXT_UI_ENABLED: 'true' }), true);
});

// ── proxyToNext (integration) ───────────────────────────────────────────────────

test('migrated route is proxied to the Next service; others stay legacy', async () => {
  const upstream = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('NEXT:' + req.url);
  }));
  const front = await startFront({ upstream: url(upstream) });
  try {
    const home = await get(url(front), '/home');
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.body, 'NEXT:/home');

    const legacy = await get(url(front), '/dashboard');
    assert.strictEqual(legacy.body, 'LEGACY');

    const api = await get(url(front), '/api/managed/health');
    assert.strictEqual(api.body, 'LEGACY'); // API never proxied
  } finally {
    await close(front); await close(upstream);
  }
});

test('FAIL-SAFE: a dead Next service falls back to the legacy app (302)', async () => {
  // Upstream points at a closed port → connection refused.
  const front = await startFront({ upstream: 'http://127.0.0.1:1' });
  try {
    const res = await get(url(front), '/home');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/dashboard');
  } finally {
    await close(front);
  }
});

test('FAIL-SAFE: a slow Next service times out and falls back (302)', async () => {
  // Upstream that never responds within the timeout.
  const slow = await listen(http.createServer(() => { /* hang forever */ }));
  const front = await startFront({ upstream: url(slow), timeoutMs: 80 });
  try {
    const res = await get(url(front), '/home');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/dashboard');
  } finally {
    await close(front); await close(slow);
  }
});

test('invalid NEXT_UPSTREAM falls back instead of throwing', async () => {
  const front = await startFront({ upstream: 'not-a-url' });
  try {
    const res = await get(url(front), '/home');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/dashboard');
  } finally {
    await close(front);
  }
});
