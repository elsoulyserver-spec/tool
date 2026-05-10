'use strict';

/**
 * EasyTrac — Config Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised configuration loading and validation for the server-side dispatcher.
 *
 * Layers (highest priority first):
 *   1. Explicit config object passed to loadConfig()
 *   2. Environment variables (ET_* prefix)
 *   3. JSON config file (ET_CONFIG_PATH env var)
 *   4. Hardcoded defaults
 *
 * Per-client config is stored in Firestore and fetched lazily via getClientConfig().
 * Token values are NEVER logged — they are returned but masked in any log calls.
 *
 * Platform enable/disable:
 *   Each platform can be toggled per-client without changing code.
 *   Disabled platforms are skipped in the dispatcher but logged as notices.
 *
 * Event mapping overrides:
 *   Per-client overrides take precedence over the global GA4→Platform event maps
 *   defined in gtm-config-builder.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// ── Default platform event maps ────────────────────────────────────────────────
// These mirror the maps in gtm-config-builder.js.
// Per-client overrides are merged on top.

const DEFAULT_META_EVENT_MAP = {
  page_view:           'PageView',
  view_content:        'ViewContent',
  add_to_cart:         'AddToCart',
  initiate_checkout:   'InitiateCheckout',
  purchase:            'Purchase',
  lead:                'Lead',
  sign_up:             'CompleteRegistration',
  search:              'Search',
};

const DEFAULT_TIKTOK_EVENT_MAP = {
  page_view:           'Pageview',
  view_content:        'ViewContent',
  add_to_cart:         'AddToCart',
  initiate_checkout:   'InitiateCheckout',
  purchase:            'PlaceAnOrder',
  lead:                'SubmitForm',
  sign_up:             'CompleteRegistration',
  search:              'Search',
};

const DEFAULT_SNAP_EVENT_MAP = {
  page_view:           'PAGE_VIEW',
  view_content:        'VIEW_CONTENT',
  add_to_cart:         'ADD_CART',
  initiate_checkout:   'START_CHECKOUT',
  purchase:            'PURCHASE',
  lead:                'SAVE',
  sign_up:             'SIGN_UP',
  search:              'SEARCH',
};

const DEFAULT_GADS_EVENT_MAP = {
  purchase:            'purchase',
  lead:                'submit_lead_form',
  sign_up:             'sign_up',
  add_to_cart:         'add_to_cart',
};

// ── Config schema defaults ─────────────────────────────────────────────────────

/**
 * Returns a fully-defaulted server config object.
 * All values can be overridden by env vars or explicit config.
 */
function defaultConfig() {
  return {
    // Logging
    logLevel:       'info',
    debugMode:      false,

    // Retry behaviour
    maxRetries:     3,
    retryOnStatuses: [429, 500, 502, 503, 504], // HTTP status codes that trigger retry

    // Deduplication
    dedupEnabled:   true,

    // Platforms enabled by default (all on)
    platforms: {
      meta:    { enabled: true },
      tiktok:  { enabled: true },
      snap:    { enabled: true },
      gads:    { enabled: true },
    },

    // Tokens (populated from env vars)
    tokens: {
      meta:          '',
      tiktok:        '',
      snap:          '',
      gadsAccess:    '',
      gadsDeveloper: '',
    },

    // Pixel / account IDs
    pixelIds: {
      meta:           '',
      tiktok:         '',
      snap:           '',
      gadsCustomerId: '',
      gadsConversionActionId: '',
    },

    // Event maps (can be overridden per-client)
    eventMaps: {
      meta:    Object.assign({}, DEFAULT_META_EVENT_MAP),
      tiktok:  Object.assign({}, DEFAULT_TIKTOK_EVENT_MAP),
      snap:    Object.assign({}, DEFAULT_SNAP_EVENT_MAP),
      gads:    Object.assign({}, DEFAULT_GADS_EVENT_MAP),
    },

    // Request timeouts (ms)
    timeouts: {
      meta:   10000,
      tiktok: 10000,
      snap:    8000,
      gads:   10000,
    },

    // Firestore (for multi-client config)
    firestore: {
      projectId:  process.env.FIRESTORE_PROJECT_ID  || process.env.GOOGLE_CLOUD_PROJECT || '',
      collection: process.env.ET_FIRESTORE_COLLECTION || 'et_clients',
    },

    // Cloud Run metadata
    cloudRun: {
      service:  process.env.K_SERVICE   || '',
      revision: process.env.K_REVISION  || '',
      region:   process.env.CLOUD_RUN_REGION || '',
    },
  };
}

// ── Environment variable loader ────────────────────────────────────────────────

/**
 * Load configuration overrides from ET_* environment variables.
 * Never reads raw token values into logs.
 *
 * @returns {object}  partial config object (only env-sourced fields)
 */
function loadFromEnv() {
  const cfg = { tokens: {}, pixelIds: {}, platforms: {} };

  // Log level
  if (process.env.ET_LOG_LEVEL) cfg.logLevel = process.env.ET_LOG_LEVEL.toLowerCase();
  if (process.env.ET_DEBUG === 'true') cfg.debugMode = true;

  // Retry
  if (process.env.ET_MAX_RETRIES) cfg.maxRetries = parseInt(process.env.ET_MAX_RETRIES, 10);
  if (process.env.ET_DEDUP_ENABLED === 'false') cfg.dedupEnabled = false;

  // Tokens (from env — in Cloud Run these come from Secret Manager via --set-secrets)
  if (process.env.ET_META_CAPI_TOKEN)       cfg.tokens.meta          = process.env.ET_META_CAPI_TOKEN;
  if (process.env.ET_TIKTOK_EVENTS_TOKEN)   cfg.tokens.tiktok        = process.env.ET_TIKTOK_EVENTS_TOKEN;
  if (process.env.ET_SNAPCHAT_CAPI_TOKEN)   cfg.tokens.snap          = process.env.ET_SNAPCHAT_CAPI_TOKEN;
  if (process.env.ET_GADS_ACCESS_TOKEN)     cfg.tokens.gadsAccess    = process.env.ET_GADS_ACCESS_TOKEN;
  if (process.env.ET_GADS_DEVELOPER_TOKEN)  cfg.tokens.gadsDeveloper = process.env.ET_GADS_DEVELOPER_TOKEN;

  // Pixel / account IDs
  if (process.env.ET_META_PIXEL_ID)            cfg.pixelIds.meta                   = process.env.ET_META_PIXEL_ID;
  if (process.env.ET_TIKTOK_PIXEL_ID)          cfg.pixelIds.tiktok                 = process.env.ET_TIKTOK_PIXEL_ID;
  if (process.env.ET_SNAP_PIXEL_ID)            cfg.pixelIds.snap                   = process.env.ET_SNAP_PIXEL_ID;
  if (process.env.ET_GADS_CUSTOMER_ID)         cfg.pixelIds.gadsCustomerId         = process.env.ET_GADS_CUSTOMER_ID;
  if (process.env.ET_GADS_CONVERSION_ACTION)   cfg.pixelIds.gadsConversionActionId = process.env.ET_GADS_CONVERSION_ACTION;

  // Platform enable/disable flags
  ['meta','tiktok','snap','gads'].forEach(p => {
    const envKey = `ET_ENABLE_${p.toUpperCase()}`;
    if (process.env[envKey] === 'false') cfg.platforms[p] = { enabled: false };
    if (process.env[envKey] === 'true')  cfg.platforms[p] = { enabled: true  };
  });

  return cfg;
}

/**
 * Load configuration from a JSON file at ET_CONFIG_PATH.
 * Returns empty object if path not set or file not found.
 *
 * @returns {object}
 */
function loadFromFile() {
  const filePath = process.env.ET_CONFIG_PATH;
  if (!filePath) return {};
  try {
    const abs = path.resolve(filePath);
    const raw = fs.readFileSync(abs, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

// ── Deep merge ────────────────────────────────────────────────────────────────

/**
 * Deep merge objects (right-hand values take precedence).
 * Arrays are replaced (not concatenated).
 *
 * @param {...object} sources
 * @returns {object}
 */
function deepMerge(...sources) {
  const result = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = deepMerge(result[k] || {}, v);
      } else if (v !== undefined) {
        result[k] = v;
      }
    }
  }
  return result;
}

// ── Module-level resolved config cache ────────────────────────────────────────
let _resolved = null;

/**
 * Load and merge all configuration sources.
 * Result is cached — subsequent calls return the same object.
 * Call resetConfig() to force reload (e.g. in tests).
 *
 * @param {object} [explicit]  — caller-supplied overrides (highest priority)
 * @returns {object}           — fully-resolved server config
 */
function loadConfig(explicit = {}) {
  if (_resolved && Object.keys(explicit).length === 0) return _resolved;
  _resolved = deepMerge(
    defaultConfig(),
    loadFromFile(),
    loadFromEnv(),
    explicit,
  );
  return _resolved;
}

/** Force the config cache to be rebuilt on next loadConfig() call. */
function resetConfig() {
  _resolved = null;
}

// ── Per-platform config accessors ──────────────────────────────────────────────

/**
 * Get the resolved config for a specific platform.
 * Returns null if the platform is disabled or has no credentials.
 *
 * @param {string} platform  — 'meta' | 'tiktok' | 'snap' | 'gads'
 * @param {object} [cfg]     — resolved config (uses loadConfig() if omitted)
 * @returns {object | null}
 */
function getPlatformConfig(platform, cfg) {
  const c = cfg || loadConfig();
  const plat = (c.platforms || {})[platform];
  if (!plat || plat.enabled === false) return null;

  switch (platform) {
    case 'meta':
      if (!c.tokens.meta || !c.pixelIds.meta) return null;
      return {
        pixelId:         c.pixelIds.meta,
        accessToken:     c.tokens.meta,
        testEventCode:   c.testEventCode || undefined,
        timeout:         (c.timeouts || {}).meta || 10000,
      };

    case 'tiktok':
      if (!c.tokens.tiktok || !c.pixelIds.tiktok) return null;
      return {
        pixelCode:   c.pixelIds.tiktok,
        accessToken: c.tokens.tiktok,
        testMode:    c.debugMode || false,
        timeout:     (c.timeouts || {}).tiktok || 10000,
      };

    case 'snap':
      if (!c.tokens.snap || !c.pixelIds.snap) return null;
      return {
        pixelId:     c.pixelIds.snap,
        accessToken: c.tokens.snap,
        timeout:     (c.timeouts || {}).snap || 8000,
      };

    case 'gads':
      if (!c.tokens.gadsAccess || !c.pixelIds.gadsCustomerId) return null;
      return {
        customerId:           c.pixelIds.gadsCustomerId,
        accessToken:          c.tokens.gadsAccess,
        developerToken:       c.tokens.gadsDeveloper,
        conversionActionId:   c.pixelIds.gadsConversionActionId,
        timeout:              (c.timeouts || {}).gads || 10000,
      };

    default:
      return null;
  }
}

/**
 * Get the event name for a given platform and canonical GA4 event key.
 * Applies per-client overrides on top of the default map.
 *
 * @param {string} platform  — 'meta' | 'tiktok' | 'snap' | 'gads'
 * @param {string} ga4Event  — GA4 event name (e.g. 'purchase')
 * @param {object} [cfg]     — resolved config
 * @returns {string | undefined}
 */
function mapEvent(platform, ga4Event, cfg) {
  const c = cfg || loadConfig();
  const map = ((c.eventMaps || {})[platform]) || {};
  return map[ga4Event];
}

/**
 * Returns list of enabled platform names given the current config.
 *
 * @param {object} [cfg]
 * @returns {string[]}
 */
function enabledPlatforms(cfg) {
  const c = cfg || loadConfig();
  return Object.entries(c.platforms || {})
    .filter(([, v]) => v && v.enabled !== false)
    .map(([k]) => k);
}

/**
 * Validate the resolved config and return an array of issues.
 * Non-fatal — issues are warnings, not errors.
 *
 * @param {object} [cfg]
 * @returns {string[]}
 */
function validateConfig(cfg) {
  const c = cfg || loadConfig();
  const issues = [];
  const ep = enabledPlatforms(c);

  if (ep.length === 0) issues.push('No platforms are enabled — all dispatches will be no-ops');

  ep.forEach(p => {
    const pc = getPlatformConfig(p, c);
    if (!pc) issues.push(`Platform "${p}" is enabled but has no credentials — will be skipped`);
  });

  if (!c.tokens.meta   && ep.includes('meta'))   issues.push('Meta CAPI token is not set');
  if (!c.tokens.tiktok && ep.includes('tiktok')) issues.push('TikTok Events token is not set');
  if (!c.tokens.snap   && ep.includes('snap'))   issues.push('Snapchat CAPI token is not set');
  if (!c.tokens.gadsAccess && ep.includes('gads')) issues.push('Google Ads access token is not set');

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-client config (Firestore-backed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Firestore client config schema (reference — stored in et_clients/{clientId}).
 * Token values are stored encrypted (AES-256-GCM) and decrypted at read time.
 *
 * {
 *   clientId:    string,
 *   clientName:  string,
 *   enabled:     boolean,
 *   platforms: {
 *     meta:    { enabled, pixelId, encryptedToken },
 *     tiktok:  { enabled, pixelId, encryptedToken },
 *     snap:    { enabled, pixelId, encryptedToken },
 *     gads:    { enabled, customerId, conversionActionId, encryptedAccessToken, developerToken },
 *   },
 *   eventMapOverrides: {           // optional — override default event maps
 *     meta:   { purchase: 'Purchase', ... },
 *     tiktok: { ... },
 *     ...
 *   },
 *   testEventCode: string | null,  // Meta test_event_code for staging
 *   createdAt:     Timestamp,
 *   updatedAt:     Timestamp,
 * }
 */

/**
 * Fetch a client config from Firestore.
 * Returns null if Firestore is not configured or client does not exist.
 * Token decryption is the responsibility of the caller.
 *
 * @param {string} clientId
 * @param {object} [cfg]    — resolved global config (for Firestore project ID)
 * @returns {Promise<object | null>}
 */
async function getClientConfig(clientId, cfg) {
  const c = cfg || loadConfig();
  const { projectId, collection } = c.firestore || {};
  if (!projectId || !clientId) return null;

  try {
    // Dynamic require — avoids making @google-cloud/firestore a hard dependency
    // when running without Firestore (e.g. local dev with env-var-only config)
    const { Firestore } = require('@google-cloud/firestore');
    const db = new Firestore({ projectId });
    const doc = await db.collection(collection).doc(clientId).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    // Log but do not throw — fall back to env-var config
    process.stderr.write(JSON.stringify({
      severity: 'WARNING',
      message:  `ET: Failed to fetch Firestore config for client "${clientId}": ${err.message}`,
      clientId,
    }) + '\n');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  loadConfig,
  resetConfig,
  getPlatformConfig,
  mapEvent,
  enabledPlatforms,
  validateConfig,
  getClientConfig,
  deepMerge,
  // Default maps (exposed for tests / overrides)
  DEFAULT_META_EVENT_MAP,
  DEFAULT_TIKTOK_EVENT_MAP,
  DEFAULT_SNAP_EVENT_MAP,
  DEFAULT_GADS_EVENT_MAP,
};
