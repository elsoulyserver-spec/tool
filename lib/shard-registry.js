// ══════════════════════════════════════════════════════════════════════════════
// lib/shard-registry.js
// GCP shard registry — maps shard IDs to GCP project credentials.
//
// A "shard" is a GCP project used for managed Cloud Run deployments. Starting
// with a single shard (easytrack-prod-1); adding prod-2/3/… is config-only.
//
// Required env vars:
//   MANAGED_SHARDS         JSON map: { "<shardId>": { gcpProjectId, region, saKeyEnv } }
//                          saKeyEnv is the name of the env var that holds the SA key JSON.
//   MANAGED_DEFAULT_SHARD  the shardId to use for new tenant placements.
//
// Example value for MANAGED_SHARDS:
//   {"prod-1":{"gcpProjectId":"easytrack-prod-1","region":"me-central1","saKeyEnv":"GCP_SA_KEY_PROD_1"}}
//
// Exports:
//   getShard(id)             → resolved Shard object (throws UNKNOWN_SHARD if missing)
//   pickShardForNewTenant()  → resolved Shard object for the default shard
//   isConfigured()           → boolean
//   _resetForTests()         — clears module-level parse cache (test helper only)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// Module-level parse cache so env is read once per process lifetime.
let _parsed = null;

function _env(name) {
  return (process.env[name] || '').trim();
}

function _parseShards() {
  if (_parsed) return _parsed;

  const raw = _env('MANAGED_SHARDS');
  if (!raw) return (_parsed = {});

  let map;
  try { map = JSON.parse(raw); }
  catch (_) { throw new Error('MANAGED_SHARDS is not valid JSON'); }

  if (typeof map !== 'object' || Array.isArray(map) || map === null) {
    throw new Error('MANAGED_SHARDS must be a JSON object');
  }

  // Validate structure eagerly so misconfiguration is caught at startup.
  for (const [id, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`MANAGED_SHARDS["${id}"] must be an object`);
    }
    if (!entry.gcpProjectId) throw new Error(`MANAGED_SHARDS["${id}"].gcpProjectId is required`);
    if (!entry.region)       throw new Error(`MANAGED_SHARDS["${id}"].region is required`);
    if (!entry.saKeyEnv)     throw new Error(`MANAGED_SHARDS["${id}"].saKeyEnv is required`);
  }

  return (_parsed = map);
}

// Build the resolved Shard object for a given shardId.
// Reads the SA key JSON from the env var named in saKeyEnv at call time (not
// at parse time) so tests can override per-shard keys without reloading the map.
function _resolveEntry(id, entry) {
  const saKeyJson = _env(entry.saKeyEnv);
  if (!saKeyJson) {
    throw new Error(`Shard "${id}": env var ${entry.saKeyEnv} is not set`);
  }
  return {
    id,
    gcpProjectId: entry.gcpProjectId,
    region:       entry.region,
    saKeyJson,    // raw JSON string; callers pass to gcp-auth.getAccessToken
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

function isConfigured() {
  try {
    const map = _parseShards();
    const def = _env('MANAGED_DEFAULT_SHARD');
    return !!(Object.keys(map).length && def && map[def]);
  } catch (_) {
    return false;
  }
}

function getShard(id) {
  if (!id) throw Object.assign(new Error('Shard id is required'), { code: 'UNKNOWN_SHARD' });
  const map = _parseShards();
  const entry = map[id];
  if (!entry) {
    throw Object.assign(new Error(`Unknown shard: "${id}"`), { code: 'UNKNOWN_SHARD' });
  }
  return _resolveEntry(id, entry);
}

function pickShardForNewTenant() {
  const def = _env('MANAGED_DEFAULT_SHARD');
  if (!def) throw new Error('MANAGED_DEFAULT_SHARD is not set');
  return getShard(def);
}

function _resetForTests() {
  _parsed = null;
}

module.exports = { isConfigured, getShard, pickShardForNewTenant, _resetForTests };
