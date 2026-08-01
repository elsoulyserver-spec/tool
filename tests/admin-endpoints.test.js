// tests/admin-endpoints.test.js
// Black-box HTTP tests for the admin auth + container-deletion endpoints.
// Boots a real server child process with ADMIN_SECRET_KEY set and
// CONTAINER_DELETION_ENABLED unset (default OFF), then asserts:
//   • unauthenticated admin requests are rejected (401)
//   • wrong/right secret behavior + HttpOnly cookie + no secret echoed
//   • delete-container AND retry-cleanup are DISABLED (503) by default
//   • logout invalidates the session
//
// Run: node --test tests/admin-endpoints.test.js

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { spawn } = require('node:child_process');
const path   = require('node:path');

const PORT   = 3137;
const SECRET = 'itest-secret-key';
const ROOT   = path.resolve(__dirname, '..');
let child;

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf,
        json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await req('GET', '/api/admin/session'); return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
      ADMIN_SECRET_KEY: SECRET, CONTAINER_DELETION_ENABLED: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitReady();
});

after(() => { if (child) child.kill(); });

function cookieHeader(setCookies) {
  return (setCookies || []).map(c => c.split(';')[0]).join('; ');
}
function csrfFrom(setCookies) {
  const c = (setCookies || []).find(x => x.startsWith('et_admin_csrf='));
  return c ? c.split(';')[0].split('=')[1] : null;
}

test('GET /api/admin/session without cookie → 401', async () => {
  const r = await req('GET', '/api/admin/session');
  assert.equal(r.status, 401);
  assert.equal(r.json.authenticated, false);
});

test('unauthenticated delete-container → 401 (auth required)', async () => {
  const r = await req('POST', '/api/admin/client/anyuid/delete-container');
  assert.equal(r.status, 401);
});

test('unauthenticated check-cleanup (dry run) → 401', async () => {
  const r = await req('GET', '/api/admin/client/anyuid/check-cleanup');
  assert.equal(r.status, 401);
});

test('wrong secret → 401 and never echoes the key', async () => {
  const r = await req('POST', '/api/admin/login', { body: { secretKey: 'nope' } });
  assert.equal(r.status, 401);
  assert.ok(!r.text.includes('nope'));
  assert.ok(!r.text.includes(SECRET));
});

test('correct secret → 200 + HttpOnly session cookie, no secret in body', async () => {
  const r = await req('POST', '/api/admin/login', {
    headers: { Origin: `http://127.0.0.1:${PORT}` }, body: { secretKey: SECRET } });
  assert.equal(r.status, 200);
  const setc = r.headers['set-cookie'] || [];
  assert.ok(setc.some(c => /^et_admin_session=/.test(c) && /HttpOnly/i.test(c)));
  assert.ok(!r.text.includes(SECRET));
  assert.equal(typeof r.json.csrfToken, 'string');
});

test('delete-container is DISABLED by default → 503 deletion_disabled', async () => {
  const login = await req('POST', '/api/admin/login', {
    headers: { Origin: `http://127.0.0.1:${PORT}` }, body: { secretKey: SECRET } });
  const setc = login.headers['set-cookie'];
  const auth = { Cookie: cookieHeader(setc), 'X-CSRF-Token': csrfFrom(setc), Origin: `http://127.0.0.1:${PORT}` };

  const del = await req('POST', '/api/admin/client/some-uid/delete-container', { headers: auth });
  assert.equal(del.status, 503);
  assert.equal(del.json.code, 'deletion_disabled');

  const retry = await req('POST', '/api/admin/client/some-uid/retry-cleanup', { headers: auth });
  assert.equal(retry.status, 503);
  assert.equal(retry.json.code, 'deletion_disabled');
});

test('check-cleanup (dry run) is NOT gated by the kill-switch (flag OFF)', async () => {
  // Server was started with CONTAINER_DELETION_ENABLED='' (disabled).
  const login = await req('POST', '/api/admin/login', {
    headers: { Origin: `http://127.0.0.1:${PORT}` }, body: { secretKey: SECRET } });
  const auth = { Cookie: cookieHeader(login.headers['set-cookie']) };
  const r = await req('GET', '/api/admin/client/some-uid/check-cleanup', { headers: auth });
  // Authed → not 401; and crucially NOT the deletion kill-switch response
  // (delete/retry return 503 deletion_disabled; the read-only preview must not).
  assert.notEqual(r.status, 401);
  assert.notEqual(r.json && r.json.code, 'deletion_disabled');
});

test('logout invalidates the session', async () => {
  const login = await req('POST', '/api/admin/login', {
    headers: { Origin: `http://127.0.0.1:${PORT}` }, body: { secretKey: SECRET } });
  const setc = login.headers['set-cookie'];
  const cookie = cookieHeader(setc);
  await req('POST', '/api/admin/logout', { headers: { Cookie: cookie, 'X-CSRF-Token': csrfFrom(setc), Origin: `http://127.0.0.1:${PORT}` } });
  const after = await req('GET', '/api/admin/session', { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});
