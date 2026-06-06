'use strict';

/**
 * EasyTrac — Security Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides:
 *   1. Token masking — safe logging of credentials
 *   2. Webhook / request signature validation (HMAC-SHA256)
 *   3. In-memory sliding window rate limiter
 *   4. PII log sanitizer — strips emails, phones, IPs from log objects
 *   5. Secret management patterns for Cloud Run
 *
 * Pure Node.js — NOT for use inside sGTM sandboxed JS.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Token / Secret masking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mask a secret token for safe logging.
 * Shows the last 4 characters only.
 *
 * @param {string} token
 * @returns {string}  e.g. '***…A1B2'
 */
function maskToken(token) {
  if (typeof token !== 'string' || !token) return '[empty]';
  if (token.length <= 4) return '***MASKED***';
  return `***…${token.slice(-4).toUpperCase()}`;
}

/**
 * Mask sensitive keys in an object, returning a safe copy for logging.
 * Recursively traverses nested objects.
 *
 * @param {any}    value
 * @param {Set}    [sensitiveKeys]  — override default set
 * @returns {any}
 */
const DEFAULT_SENSITIVE_KEYS = new Set([
  'accesstoken', 'access_token', 'apikey', 'api_key',
  'token', 'developertoken', 'developer_token',
  'authorization', 'secret', 'password', 'credential',
  'metacacapitoken', 'meta_capi_token',
  'tiktokeventstoken', 'tiktok_events_token',
  'snapchatcapitoken', 'snapchat_capi_token',
  'gadsaccesstoken', 'gads_access_token',
]);

function maskObject(value, sensitiveKeys = DEFAULT_SENSITIVE_KEYS, depth = 0) {
  if (depth > 10) return '[DEEP]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(v => maskObject(v, sensitiveKeys, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (sensitiveKeys.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? maskToken(v) : '***MASKED***';
    } else {
      out[k] = maskObject(v, sensitiveKeys, depth + 1);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PII sanitizer
// ─────────────────────────────────────────────────────────────────────────────

// Regex patterns for PII detection in string values
const PII_PATTERNS = [
  { name: 'email',   re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,   mask: '[EMAIL]'  },
  { name: 'ipv4',    re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,              mask: '[IP]'     },
  { name: 'phone',   re: /\+?\d[\d\s\-().]{7,}\d/g,                               mask: '[PHONE]'  },
];

// Keys whose values are known PII (always masked regardless of value pattern)
const PII_FIELD_KEYS = new Set([
  'em', 'email', 'useremail', 'user_email',
  'ph', 'phone', 'userphone', 'user_phone',
  'fn', 'firstname', 'first_name', 'userfirstname',
  'ln', 'lastname', 'last_name', 'userlastname',
  'external_id', 'externalid',
  'client_ip_address', 'clientipaddress', 'ip', 'ip_address',
  'client_user_agent', 'useragent', 'user_agent',
  'fbp', 'fbc', 'ttp', 'scid',
]);

/**
 * Remove or mask PII from a value before it reaches a log sink.
 * Strings are pattern-scanned; object keys are checked against known PII fields.
 *
 * @param {any}    value
 * @param {number} [depth=0]
 * @returns {any}
 */
function sanitizePii(value, depth = 0) {
  if (depth > 8) return '[DEEP]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let s = value;
    for (const { re, mask } of PII_PATTERNS) {
      s = s.replace(re, mask);
    }
    return s;
  }

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(v => sanitizePii(v, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (PII_FIELD_KEYS.has(k.toLowerCase())) {
      out[k] = '[PII-MASKED]';
    } else {
      out[k] = sanitizePii(v, depth + 1);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. HMAC-SHA256 webhook signature validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 of a payload string using the provided secret.
 *
 * @param {string | Buffer} payload
 * @param {string}          secret
 * @returns {string}  hex digest
 */
function hmacSha256(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Validate an incoming request's HMAC-SHA256 signature.
 * Uses a timing-safe comparison to prevent timing attacks.
 *
 * @param {string | Buffer} rawBody    — raw request body (before JSON.parse)
 * @param {string}          signature  — value from X-Hub-Signature-256 or similar header
 * @param {string}          secret     — shared secret
 * @param {string}          [prefix]   — optional prefix in signature header (e.g. 'sha256=')
 * @returns {boolean}
 */
function validateSignature(rawBody, signature, secret, prefix = '') {
  if (!rawBody || !signature || !secret) return false;
  const expected = prefix + hmacSha256(rawBody, secret);
  const sigBuf   = Buffer.from(signature, 'utf8');
  const expBuf   = Buffer.from(expected,  'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. In-memory sliding window rate limiter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sliding window rate limiter.
 * Tracks request timestamps per key in a circular buffer.
 *
 * Suitable for:
 *   - Per-client rate limiting (key = clientId)
 *   - Per-IP rate limiting   (key = IP)
 *   - Per-event limiting     (key = eventName)
 *
 * NOT a distributed rate limiter — state is process-local.
 * For multi-instance Cloud Run, use Redis or Cloud Memorystore.
 */
class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs    — time window in ms (default: 60_000)
   * @param {number} opts.maxRequests — max requests per key per window (default: 1000)
   */
  constructor({ windowMs = 60_000, maxRequests = 1000 } = {}) {
    this._windowMs    = windowMs;
    this._maxRequests = maxRequests;
    this._store       = new Map(); // key → number[] (timestamps)

    // Periodic cleanup of expired keys
    this._cleanup = setInterval(() => this._prune(), windowMs * 2);
    if (this._cleanup.unref) this._cleanup.unref();
  }

  /**
   * Check whether the key is within the rate limit.
   * Increments the counter if allowed.
   *
   * @param {string} key
   * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
   */
  check(key) {
    const now    = Date.now();
    const window = now - this._windowMs;

    if (!this._store.has(key)) this._store.set(key, []);
    const timestamps = this._store.get(key);

    // Remove timestamps outside the window
    let i = 0;
    while (i < timestamps.length && timestamps[i] <= window) i++;
    if (i > 0) timestamps.splice(0, i);

    if (timestamps.length >= this._maxRequests) {
      const resetMs = timestamps[0] + this._windowMs - now;
      return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
    }

    timestamps.push(now);
    return {
      allowed:   true,
      remaining: this._maxRequests - timestamps.length,
      resetMs:   timestamps[0] + this._windowMs - now,
    };
  }

  /** Remove keys with no recent activity. */
  _prune() {
    const cutoff = Date.now() - this._windowMs;
    for (const [key, ts] of this._store) {
      if (ts.length === 0 || ts[ts.length - 1] <= cutoff) {
        this._store.delete(key);
      }
    }
  }

  /** Reset a specific key. */
  reset(key) { this._store.delete(key); }

  /** Return current count for a key without incrementing. */
  count(key) {
    const now    = Date.now();
    const window = now - this._windowMs;
    return (this._store.get(key) || []).filter(t => t > window).length;
  }

  /** Destroy the cleanup interval (for graceful shutdown). */
  destroy() { clearInterval(this._cleanup); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cloud Run secret management utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a secret from Google Cloud Secret Manager.
 * Requires the Cloud Run service account to have roles/secretmanager.secretAccessor.
 *
 * @param {string} secretName   — full resource name: 'projects/P/secrets/S/versions/latest'
 *                                or short name 'my-secret' (project resolved from env)
 * @returns {Promise<string>}   — secret payload as UTF-8 string
 */
async function readSecret(secretName) {
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();

  // Expand short name to full resource name
  let name = secretName;
  if (!name.startsWith('projects/')) {
    const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIRESTORE_PROJECT_ID;
    if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — cannot expand secret name');
    name = `projects/${project}/secrets/${secretName}/versions/latest`;
  }

  const [version] = await client.accessSecretVersion({ name });
  return version.payload.data.toString('utf8');
}

/**
 * Load all CAPI tokens from Secret Manager into the process environment.
 * Call this once during Cloud Run instance startup (before first request).
 *
 * Expected secrets (configurable via ET_SECRET_* env vars):
 *   ET_META_CAPI_TOKEN_SECRET     → ET_META_CAPI_TOKEN
 *   ET_TIKTOK_EVENTS_TOKEN_SECRET → ET_TIKTOK_EVENTS_TOKEN
 *   ET_SNAP_CAPI_TOKEN_SECRET     → ET_SNAPCHAT_CAPI_TOKEN
 *   ET_GADS_ACCESS_TOKEN_SECRET   → ET_GADS_ACCESS_TOKEN
 *   ET_GADS_DEVELOPER_TOKEN_SECRET → ET_GADS_DEVELOPER_TOKEN
 *
 * @returns {Promise<{ loaded: string[], skipped: string[] }>}
 */
async function loadSecretsFromSecretManager() {
  const mapping = [
    { secretEnvKey: 'ET_META_CAPI_TOKEN_SECRET',      targetEnvKey: 'ET_META_CAPI_TOKEN'      },
    { secretEnvKey: 'ET_TIKTOK_EVENTS_TOKEN_SECRET',  targetEnvKey: 'ET_TIKTOK_EVENTS_TOKEN'  },
    { secretEnvKey: 'ET_SNAP_CAPI_TOKEN_SECRET',      targetEnvKey: 'ET_SNAPCHAT_CAPI_TOKEN'  },
    { secretEnvKey: 'ET_GADS_ACCESS_TOKEN_SECRET',    targetEnvKey: 'ET_GADS_ACCESS_TOKEN'    },
    { secretEnvKey: 'ET_GADS_DEVELOPER_TOKEN_SECRET', targetEnvKey: 'ET_GADS_DEVELOPER_TOKEN' },
  ];

  const loaded  = [];
  const skipped = [];

  await Promise.allSettled(mapping.map(async ({ secretEnvKey, targetEnvKey }) => {
    const secretName = process.env[secretEnvKey];
    if (!secretName) { skipped.push(targetEnvKey); return; }
    // Don't overwrite if already set via --set-secrets (Cloud Run native injection)
    if (process.env[targetEnvKey]) { skipped.push(targetEnvKey); return; }
    try {
      process.env[targetEnvKey] = await readSecret(secretName);
      loaded.push(targetEnvKey);
    } catch (err) {
      process.stderr.write(JSON.stringify({
        severity: 'ERROR',
        message:  `ET: Failed to load secret ${secretName}: ${err.message}`,
      }) + '\n');
    }
  }));

  return { loaded, skipped };
}

/**
 * Generate a constant-time-safe comparison for two strings.
 * Use instead of === when comparing auth tokens to prevent timing attacks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run timingSafeEqual on same-length buffers to prevent length oracle
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Token masking
  maskToken,
  maskObject,
  // PII
  sanitizePii,
  // Signature validation
  hmacSha256,
  validateSignature,
  // Rate limiting
  RateLimiter,
  // Secret management
  readSecret,
  loadSecretsFromSecretManager,
  safeCompare,
  // Constants
  DEFAULT_SENSITIVE_KEYS,
  PII_FIELD_KEYS,
};
