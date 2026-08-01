'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN SESSION — secure secret-key admin login with HttpOnly-cookie sessions.
//
// Primary/browser auth path for the admin dashboard. A single shared secret
// (ADMIN_SECRET_KEY) is exchanged once via POST /api/admin/login for a random,
// server-generated session token stored ONLY in an HttpOnly cookie. The raw
// secret is never returned, never logged, and never stored client-side.
//
// The session layer is storage-agnostic: it talks to an injected
// admin-session-store (in-memory for launch; Redis/Firestore later) via a small
// async interface, so swapping the backend never changes this auth flow.
// Constant-time comparison + per-IP lockout defend the login endpoint.
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { createInMemoryStore } = require('./admin-session-store');

const SESSION_TTL_MS    = 8 * 60 * 60 * 1000; // 8 hours
const MAX_FAILURES      = 5;                   // failed logins before lockout
const FAILURE_WINDOW_MS = 15 * 60 * 1000;      // rolling window for counting
const LOCKOUT_MS        = 15 * 60 * 1000;      // lockout duration once tripped

// Pluggable session store (see admin-session-store.js). Swap via setStore().
let _store = createInMemoryStore();
function setStore(store) { _store = store; }

// ip -> { count, first, lockedUntil } — lockout state is ephemeral by nature and
// intentionally kept process-local.
const _failures = new Map();

function _now() { return Date.now(); }

// Fixed-length, timing-safe comparison. Hashing first means unequal lengths
// don't throw and the comparison never leaks the expected length.
function _safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// True when a non-empty ADMIN_SECRET_KEY is configured.
function isConfigured() {
  return !!(process.env.ADMIN_SECRET_KEY && String(process.env.ADMIN_SECRET_KEY).trim());
}

// In production, a missing secret disables login entirely (fail-closed) rather
// than accepting an empty key.
function isLoginDisabled() {
  return String(process.env.NODE_ENV) === 'production' && !isConfigured();
}

// Constant-time check of a submitted secret against the configured key.
function checkSecret(submitted) {
  if (!isConfigured()) return false;
  const expected = String(process.env.ADMIN_SECRET_KEY).trim();
  return _safeEqual(String(submitted == null ? '' : submitted).trim(), expected);
}

// ── Per-IP lockout ────────────────────────────────────────────────────────────
function isLockedOut(ip) {
  const rec = _failures.get(ip || 'unknown');
  if (!rec) return false;
  return !!(rec.lockedUntil && rec.lockedUntil > _now());
}

function lockoutRemainingMs(ip) {
  const rec = _failures.get(ip || 'unknown');
  if (!rec || !rec.lockedUntil) return 0;
  return Math.max(0, rec.lockedUntil - _now());
}

function recordFailure(ip) {
  const key = ip || 'unknown';
  const now = _now();
  let rec = _failures.get(key);
  if (!rec || (now - rec.first) > FAILURE_WINDOW_MS) {
    rec = { count: 0, first: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  _failures.set(key, rec);
  return rec;
}

function recordSuccess(ip) {
  _failures.delete(ip || 'unknown');
}

// ── Sessions (async — delegate storage to the pluggable store) ─────────────────
async function _prune() {
  const now = _now();
  const entries = await _store.list();
  await Promise.all(entries.map(([token, s]) => (s.exp <= now ? _store.delete(token) : null)));
}

async function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf  = crypto.randomBytes(32).toString('hex');
  const now   = _now();
  const session = { adminId: adminId || 'admin', csrf, createdAt: now, exp: now + SESSION_TTL_MS };
  await _store.set(token, session);
  return { token, csrf, exp: session.exp, adminId: session.adminId };
}

async function verifySession(token) {
  if (!token) return null;
  const s = await _store.get(token);
  if (!s) return null;
  if (s.exp <= _now()) { await _store.delete(token); return null; }
  return s;
}

async function destroySession(token) {
  if (!token) return false;
  return _store.delete(token);
}

// Double-submit CSRF tied to the session: the header value must equal the
// session's csrf secret (which the client mirrors from a readable cookie).
async function verifyCsrf(token, headerValue) {
  const s = await verifySession(token);
  if (!s) return false;
  if (!headerValue) return false;
  return _safeEqual(headerValue, s.csrf);
}

// Test/maintenance helper.
async function _reset() {
  await _store.clear();
  _failures.clear();
}

module.exports = {
  setStore,
  isConfigured,
  isLoginDisabled,
  checkSecret,
  isLockedOut,
  lockoutRemainingMs,
  recordFailure,
  recordSuccess,
  createSession,
  verifySession,
  destroySession,
  verifyCsrf,
  _prune,
  _reset,
  SESSION_TTL_MS,
  MAX_FAILURES,
};
