// ══════════════════════════════════════════════════════════════════════════════
// lib/ss-rate-limiter.js
// In-memory rate limiter for /api/ss/* endpoints.
//
// Limits: 100 requests per minute per clientId.
// Lockout:  5-minute block after 5 consecutive validation/auth errors
//           (brute-force indicator for validateUrl / test-event).
// Cleanup:  stale entries pruned every 60 s via setInterval.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const WINDOW_MS   = 60 * 1000;   // 1 minute
const MAX_REQ     = 100;
const LOCKOUT_MS  = 5 * 60 * 1000; // 5 minutes
const ERROR_LIMIT = 5;

// Map<clientId, { count, resetAt, errorStreak, lockedUntil }>
const _store = new Map();

function _now() { return Date.now(); }

function _get(clientId) {
  const now   = _now();
  let entry   = _store.get(clientId);
  if (!entry) {
    entry = { count: 0, resetAt: now + WINDOW_MS, errorStreak: 0, lockedUntil: 0 };
    _store.set(clientId, entry);
  }
  // Roll window if expired
  if (now > entry.resetAt) {
    entry.count   = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  return entry;
}

// ── Main check — call before processing each /api/ss/* request ────────────────
// Returns { allowed: boolean, remaining: number, resetAt: number, locked: boolean }
function check(clientId) {
  if (!clientId) return { allowed: false, remaining: 0, resetAt: 0, locked: false, reason: 'missing_client_id' };

  const entry = _get(clientId);
  const now   = _now();

  // Lockout check
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return {
      allowed:   false,
      remaining: 0,
      resetAt:   entry.lockedUntil,
      locked:    true,
      reason:    'lockout',
    };
  }

  entry.count++;
  const allowed   = entry.count <= MAX_REQ;
  const remaining = Math.max(0, MAX_REQ - entry.count);

  return {
    allowed,
    remaining,
    resetAt: entry.resetAt,
    locked:  false,
    reason:  allowed ? 'ok' : 'rate_limit',
  };
}

// ── Record a suspicious error (brute-force detection) ─────────────────────────
// Call this when validateUrl or test-event returns a connection/auth error.
function recordError(clientId) {
  if (!clientId) return;
  const entry = _get(clientId);
  entry.errorStreak = (entry.errorStreak || 0) + 1;
  if (entry.errorStreak >= ERROR_LIMIT) {
    entry.lockedUntil = _now() + LOCKOUT_MS;
    entry.errorStreak = 0; // reset streak after lockout applied
  }
}

// ── Reset error streak on success ─────────────────────────────────────────────
function recordSuccess(clientId) {
  if (!clientId) return;
  const entry = _get(clientId);
  entry.errorStreak = 0;
}

// ── Prune stale entries every minute ──────────────────────────────────────────
const _pruneInterval = setInterval(function () {
  const now = _now();
  _store.forEach(function (entry, clientId) {
    const expired  = now > entry.resetAt;
    const unlocked = !entry.lockedUntil || now > entry.lockedUntil;
    if (expired && unlocked && entry.errorStreak === 0) {
      _store.delete(clientId);
    }
  });
}, 60 * 1000);

// Allow process to exit cleanly even if this interval is still running
if (_pruneInterval.unref) _pruneInterval.unref();

module.exports = { check, recordError, recordSuccess };
