// tests/admin-auth.test.js
// Verifies the admin secret-key auth + storage-agnostic session layer
// (lib/admin-session.js + lib/admin-session-store.js).
//
// Run: node --test tests/admin-auth.test.js

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminSession = require('../lib/admin-session');
const { createInMemoryStore } = require('../lib/admin-session-store');

const SAVED = {};
beforeEach(async () => {
  SAVED.secret = process.env.ADMIN_SECRET_KEY;
  SAVED.nodeEnv = process.env.NODE_ENV;
  adminSession.setStore(createInMemoryStore());
  await adminSession._reset();
});
afterEach(() => {
  if (SAVED.secret === undefined) delete process.env.ADMIN_SECRET_KEY;
  else process.env.ADMIN_SECRET_KEY = SAVED.secret;
  if (SAVED.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED.nodeEnv;
});

// ── Secret comparison ─────────────────────────────────────────────────────────
test('correct secret passes, wrong secret fails', () => {
  process.env.ADMIN_SECRET_KEY = 'super-secret-value';
  assert.equal(adminSession.checkSecret('super-secret-value'), true);
  assert.equal(adminSession.checkSecret('super-secret-value ' /* trimmed */.trim()), true);
  assert.equal(adminSession.checkSecret('wrong'), false);
  assert.equal(adminSession.checkSecret(''), false);
  assert.equal(adminSession.checkSecret(null), false);
});

test('no configured secret → checkSecret always false', () => {
  delete process.env.ADMIN_SECRET_KEY;
  assert.equal(adminSession.isConfigured(), false);
  assert.equal(adminSession.checkSecret('anything'), false);
});

test('production without secret disables login (fail-closed)', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_SECRET_KEY;
  assert.equal(adminSession.isLoginDisabled(), true);
  process.env.ADMIN_SECRET_KEY = 'x';
  assert.equal(adminSession.isLoginDisabled(), false);
});

// ── Sessions ────────────────────────────────────────────────────────────────
test('create → verify → destroy session round-trip', async () => {
  const { token, csrf } = await adminSession.createSession('super-admin');
  assert.ok(token && csrf && token !== csrf);
  const s = await adminSession.verifySession(token);
  assert.ok(s);
  assert.equal(s.adminId, 'super-admin');

  assert.equal(await adminSession.destroySession(token), true);
  assert.equal(await adminSession.verifySession(token), null, 'logout invalidates the session');
});

test('unknown / empty tokens never verify', async () => {
  assert.equal(await adminSession.verifySession('nope'), null);
  assert.equal(await adminSession.verifySession(''), null);
  assert.equal(await adminSession.verifySession(null), null);
});

test('expired session is rejected', async () => {
  const { token } = await adminSession.createSession('super-admin');
  const s = await adminSession.verifySession(token);
  s.exp = Date.now() - 1000; // force-expire in the store
  assert.equal(await adminSession.verifySession(token), null);
});

// ── CSRF (double-submit tied to session) ───────────────────────────────────────
test('CSRF token must match the session', async () => {
  const { token, csrf } = await adminSession.createSession('super-admin');
  assert.equal(await adminSession.verifyCsrf(token, csrf), true);
  assert.equal(await adminSession.verifyCsrf(token, 'bad'), false);
  assert.equal(await adminSession.verifyCsrf(token, ''), false);
  assert.equal(await adminSession.verifyCsrf('no-session', csrf), false);
});

// ── Rate-limit / lockout ───────────────────────────────────────────────────────
test('lockout trips after repeated failures and clears on success', () => {
  const ip = '203.0.113.7';
  assert.equal(adminSession.isLockedOut(ip), false);
  for (let i = 0; i < adminSession.MAX_FAILURES; i++) adminSession.recordFailure(ip);
  assert.equal(adminSession.isLockedOut(ip), true);
  assert.ok(adminSession.lockoutRemainingMs(ip) > 0);
  adminSession.recordSuccess(ip);
  assert.equal(adminSession.isLockedOut(ip), false);
});

// ── Storage-agnostic abstraction ───────────────────────────────────────────────
test('session layer delegates to the injected store (swappable backend)', async () => {
  const calls = { set: 0, get: 0, delete: 0 };
  const map = new Map();
  const spyStore = {
    async set(k, v) { calls.set++; map.set(k, v); },
    async get(k)    { calls.get++; return map.has(k) ? map.get(k) : null; },
    async delete(k) { calls.delete++; return map.delete(k); },
    async list()    { return Array.from(map.entries()); },
    async clear()   { map.clear(); },
  };
  adminSession.setStore(spyStore);

  const { token } = await adminSession.createSession('admin');
  assert.equal(calls.set, 1, 'createSession writes through the store');
  assert.ok(await adminSession.verifySession(token));
  assert.ok(calls.get >= 1, 'verifySession reads through the store');
  await adminSession.destroySession(token);
  assert.equal(calls.delete, 1, 'destroySession deletes through the store');
});
