'use strict';

/**
 * lib/secret-manager.js
 *
 * Thin wrapper around the Google Cloud Secret Manager REST API.
 * Zero external dependencies — uses Node.js built-in `https`.
 *
 * Resolution order for MASTER_ENCRYPTION_KEY:
 *   1. GCP Secret Manager (when running on GCP with a configured secret)
 *   2. MASTER_ENCRYPTION_KEY env var (local dev / Railway fallback)
 *   3. Fatal startup error
 *
 * Required env vars (Secret Manager path):
 *   SECRET_MANAGER_PROJECT  — GCP project id (or GOOGLE_CLOUD_PROJECT)
 *   ENCRYPTION_KEY_SECRET   — secret name in Secret Manager (default: master-encryption-key)
 *   ENCRYPTION_KEY_VERSION  — version to fetch (default: 'latest')
 *
 * Key rotation:
 *   1. Create a new version in Secret Manager
 *   2. Call POST /api/admin/rotate-master-key with { oldKeyHex, newKeyHex }
 *      (which calls cryptoVault.rotateKey() across all ss_configs)
 *   3. Disable the old version in Secret Manager
 *
 * Caching: the resolved key is cached in memory for CACHE_TTL_MS (5 min)
 * so we don't hit Secret Manager on every request. Cache is invalidated on
 * version change — call clearCache() after rotating to force re-fetch.
 */

const https   = require('https');
const http    = require('http');

const METADATA_HOST   = 'metadata.google.internal';
const SM_HOST         = 'secretmanager.googleapis.com';
const CACHE_TTL_MS    = 5 * 60 * 1000;   // 5 minutes

let _cachedKey      = null;
let _cacheExpiresAt = 0;
let _cachedVersion  = null;

function _env(name) { return (process.env[name] || '').trim(); }

function _project() {
  return _env('SECRET_MANAGER_PROJECT') || _env('GOOGLE_CLOUD_PROJECT') || _env('GCP_PROJECT');
}

function _secretName() {
  return _env('ENCRYPTION_KEY_SECRET') || 'master-encryption-key';
}

function _secretVersion() {
  return _env('ENCRYPTION_KEY_VERSION') || 'latest';
}

function isConfigured() {
  return !!(_project() && _secretName());
}

// ── Fetch GCP access token from metadata server ───────────────────────────────
let _accessToken = null;
let _accessTokenExp = 0;

function _getGcpToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_accessToken && now < _accessTokenExp - 60) return Promise.resolve(_accessToken);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host:    METADATA_HOST,
      path:    '/computeMetadata/v1/instance/service-accounts/default/token',
      method:  'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 3000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('metadata token HTTP ' + res.statusCode));
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { return reject(new Error('metadata token parse error')); }
        _accessToken    = parsed.access_token;
        _accessTokenExp = now + (parsed.expires_in || 3600);
        resolve(_accessToken);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('metadata token timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Fetch secret payload from Secret Manager REST API ────────────────────────
async function _fetchFromSecretManager() {
  const token  = await _getGcpToken();
  const path   = `/v1/projects/${_project()}/secrets/${_secretName()}/versions/${_secretVersion()}:access`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SM_HOST,
      path,
      method:   'GET',
      headers:  { Authorization: 'Bearer ' + token },
      timeout:  8000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('Secret Manager HTTP ' + res.statusCode + ': ' + raw.slice(0, 200)));
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { return reject(new Error('Secret Manager parse error')); }
        if (!parsed.payload || !parsed.payload.data) {
          return reject(new Error('Secret Manager: missing payload.data'));
        }
        const hexKey = Buffer.from(parsed.payload.data, 'base64').toString('utf8').trim();
        const version = parsed.name || _secretVersion();
        resolve({ hexKey, version });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Secret Manager request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Resolve the master encryption key ────────────────────────────────────────
// Returns { hexKey, source } where source is 'secret_manager' | 'env'.
// Throws only if BOTH sources are absent/unreachable.
async function resolveMasterKey() {
  // Cache hit
  if (_cachedKey && Date.now() < _cacheExpiresAt) {
    return { hexKey: _cachedKey, source: _cachedVersion ? 'secret_manager' : 'env', version: _cachedVersion };
  }

  // Path 1: Secret Manager
  if (isConfigured()) {
    try {
      const { hexKey, version } = await _fetchFromSecretManager();
      _cachedKey      = hexKey;
      _cachedVersion  = version;
      _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return { hexKey, source: 'secret_manager', version };
    } catch (smErr) {
      // Log and fall through to ENV — Secret Manager is unavailable (local dev,
      // missing permissions, metadata server not reachable). Do NOT throw here
      // because Railway deploys don't have the metadata server.
      console.warn('[secret-manager] Secret Manager unavailable — falling back to env var:', smErr.message);
    }
  }

  // Path 2: ENV fallback
  const envKey = _env('MASTER_ENCRYPTION_KEY');
  if (envKey) {
    _cachedKey      = envKey;
    _cachedVersion  = null;
    _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return { hexKey: envKey, source: 'env', version: null };
  }

  // Path 3: fatal — no key from either source
  throw new Error(
    'MASTER_ENCRYPTION_KEY is not available. ' +
    'Set it as a GCP Secret (ENCRYPTION_KEY_SECRET + SECRET_MANAGER_PROJECT) ' +
    'or as an environment variable MASTER_ENCRYPTION_KEY (64 hex chars).'
  );
}

// Invalidate the cache (call after key rotation).
function clearCache() {
  _cachedKey      = null;
  _cachedVersion  = null;
  _cacheExpiresAt = 0;
  _accessToken    = null;
  _accessTokenExp = 0;
}

// ── Startup validation ────────────────────────────────────────────────────────
// Call once at process start. Resolves and validates the key (length + hex).
// Logs the source so operators know which path is active.
// Throws on fatal misconfiguration.
async function validateAtStartup() {
  const { hexKey, source, version } = await resolveMasterKey();
  if (!hexKey || hexKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('MASTER_ENCRYPTION_KEY from ' + source + ' is invalid: must be 64 hex chars (32 bytes)');
  }
  console.log('[secret-manager] encryption key resolved from ' + source +
    (version ? ' version=' + version.split('/').pop() : '') + ' — OK');
  return { source, version };
}

module.exports = { isConfigured, resolveMasterKey, clearCache, validateAtStartup };
