'use strict';

/**
 * EasyTrac — Retry Queue
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides:
 *   1. Exponential backoff retry for failed CAPI dispatches
 *   2. Per-event, per-platform deduplication (prevents double-fires)
 *   3. In-memory pending map (survives process restarts only via replay on init)
 *   4. Jitter on backoff to avoid thundering-herd on burst failures
 *
 * Deduplication key:  `${platform}::${eventId}`
 * Dedup TTL default:  48 h (covers Meta's 48 h dedup window — longest of all platforms)
 *
 * Retry delays (ms):  [500, 2000, 6000, 18000]  → total max ~26.5 s per item
 * Max retries:        4 (configurable per-call)
 *
 * This module is pure Node.js — it is NOT for use inside sGTM sandboxed JS.
 * sGTM templates have their own lightweight retry in sendHttpRequest callbacks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Base delays for exponential backoff (ms). Index = attempt number (0-based). */
const BASE_DELAYS_MS = [500, 2000, 6000, 18000];

/** Maximum jitter added to each delay (ms). Prevents thundering herd. */
const JITTER_MAX_MS = 300;

/** Default deduplication TTL. 48 h = longest platform window (Meta). */
const DEFAULT_DEDUP_TTL_MS = 48 * 60 * 60 * 1000;

/** Default maximum retry attempts per dispatch. */
const DEFAULT_MAX_RETRIES = 3;

// ── In-memory deduplication store ────────────────────────────────────────────
// Map<string, number>  →  key → expiry timestamp (Date.now() + TTL)
const _dedupStore = new Map();

// ── In-memory pending retry queue ────────────────────────────────────────────
// Map<string, RetryEntry>
const _pendingQueue = new Map();

// ── Cleanup interval: prune expired dedup keys every 10 min ──────────────────
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of _dedupStore) {
    if (now > expiry) _dedupStore.delete(key);
  }
}, 10 * 60 * 1000);

// Allow the process to exit even if the interval is active
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical deduplication key.
 * @param {string} platform  — 'meta' | 'tiktok' | 'snap' | 'gads'
 * @param {string} eventId   — unique event identifier (ep.event_id)
 * @returns {string}
 */
function dedupKey(platform, eventId) {
  return `${platform}::${String(eventId || '')}`;
}

/**
 * Check whether this (platform, eventId) pair has already been dispatched
 * within the TTL window.
 *
 * @param {string} platform
 * @param {string} eventId
 * @returns {boolean}  true = duplicate, skip dispatch
 */
function isDuplicate(platform, eventId) {
  if (!eventId) return false; // no event_id = cannot deduplicate, always send
  const key = dedupKey(platform, eventId);
  const expiry = _dedupStore.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    _dedupStore.delete(key);
    return false;
  }
  return true;
}

/**
 * Mark a (platform, eventId) pair as dispatched.
 * Subsequent calls to isDuplicate() will return true until TTL expires.
 *
 * @param {string} platform
 * @param {string} eventId
 * @param {number} [ttlMs=DEFAULT_DEDUP_TTL_MS]
 */
function markDispatched(platform, eventId, ttlMs = DEFAULT_DEDUP_TTL_MS) {
  if (!eventId) return;
  const key = dedupKey(platform, eventId);
  _dedupStore.set(key, Date.now() + ttlMs);
}

/**
 * Forcibly clear a dedup entry (e.g. after a confirmed failure that should
 * allow retry from a different code path).
 *
 * @param {string} platform
 * @param {string} eventId
 */
function clearDedup(platform, eventId) {
  _dedupStore.delete(dedupKey(platform, eventId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Backoff helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the next delay with jitter.
 * @param {number} attempt  — 0-based attempt index
 * @returns {number}  delay in ms
 */
function backoffDelay(attempt) {
  const base   = BASE_DELAYS_MS[Math.min(attempt, BASE_DELAYS_MS.length - 1)];
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  return base + jitter;
}

/**
 * Promise-based sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Core retry executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute `fn` with automatic retry on failure.
 *
 * @param {object}   opts
 * @param {string}   opts.platform       — 'meta' | 'tiktok' | 'snap' | 'gads'
 * @param {string}   [opts.eventId]      — for deduplication and log correlation
 * @param {string}   [opts.requestId]    — trace ID for log correlation
 * @param {number}   [opts.maxRetries]   — default DEFAULT_MAX_RETRIES
 * @param {Function} [opts.onRetry]      — callback(attempt, delay, error) for logging
 * @param {Function} [opts.onSuccess]    — callback(attempt, result)
 * @param {Function} [opts.onExhausted]  — callback(attempts, lastError)
 * @param {Function} fn                  — async () => result (throws on failure)
 *
 * @returns {Promise<{ success: boolean, result?: any, error?: Error, attempts: number }>}
 */
async function withRetry(opts, fn) {
  const {
    platform    = 'unknown',
    eventId     = '',
    requestId   = '',
    maxRetries  = DEFAULT_MAX_RETRIES,
    onRetry     = null,
    onSuccess   = null,
    onExhausted = null,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Add to in-flight registry
    const queueKey = `${platform}::${eventId}::${requestId}::${attempt}`;
    _pendingQueue.set(queueKey, { platform, eventId, requestId, attempt, startedAt: Date.now() });

    try {
      const result = await fn();
      _pendingQueue.delete(queueKey);

      if (onSuccess) onSuccess(attempt, result);
      return { success: true, result, attempts: attempt + 1 };

    } catch (err) {
      _pendingQueue.delete(queueKey);
      lastError = err;

      if (attempt < maxRetries) {
        const delay = backoffDelay(attempt);
        if (onRetry) onRetry(attempt + 1, delay, err);
        await sleep(delay);
      }
    }
  }

  if (onExhausted) onExhausted(maxRetries + 1, lastError);
  return { success: false, error: lastError, attempts: maxRetries + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue introspection (for monitoring / health endpoints)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a snapshot of currently in-flight retry attempts.
 * Useful for health check endpoints and Cloud Logging dashboards.
 *
 * @returns {{ inFlight: number, dedupEntries: number, entries: object[] }}
 */
function queueStats() {
  const entries = [];
  for (const [key, entry] of _pendingQueue) {
    entries.push({ key, ...entry, ageMs: Date.now() - entry.startedAt });
  }
  return {
    inFlight:    _pendingQueue.size,
    dedupEntries: _dedupStore.size,
    entries,
  };
}

/**
 * Drain the dedup store (e.g. in tests or after a config reload).
 * Does NOT affect in-flight retries.
 */
function resetDedup() {
  _dedupStore.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-specific dedup TTLs (ms)
// Meta  48 h — TikTok 24 h — Snap 24 h — Google Ads 90 d (click window)
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORM_DEDUP_TTL = {
  meta:   48 * 60 * 60 * 1000,
  tiktok: 24 * 60 * 60 * 1000,
  snap:   24 * 60 * 60 * 1000,
  gads:   90 * 24 * 60 * 60 * 1000,
};

/**
 * Mark dispatched using the platform-appropriate TTL.
 * @param {string} platform
 * @param {string} eventId
 */
function markDispatchedForPlatform(platform, eventId) {
  const ttl = PLATFORM_DEDUP_TTL[platform] || DEFAULT_DEDUP_TTL_MS;
  markDispatched(platform, eventId, ttl);
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Deduplication
  isDuplicate,
  markDispatched,
  markDispatchedForPlatform,
  clearDedup,
  resetDedup,
  // Retry
  withRetry,
  backoffDelay,
  // Monitoring
  queueStats,
  // Constants (exposed for tests)
  BASE_DELAYS_MS,
  DEFAULT_DEDUP_TTL_MS,
  DEFAULT_MAX_RETRIES,
  PLATFORM_DEDUP_TTL,
};
