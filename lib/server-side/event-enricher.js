'use strict';

/**
 * EasyTrac — Event Enricher
 * ─────────────────────────────────────────────────────────────────────────────
 * Automatically adds server-side metadata to every ETPayload before dispatch.
 *
 * Enrichment fields added:
 *   requestId       — UUIDv4, unique per incoming request (for log correlation)
 *   serverTimestamp — Unix seconds, time the server processed the event
 *   serverHostname  — process.env.K_SERVICE (Cloud Run) or OS hostname
 *   environment     — 'production' | 'staging' | 'development' from ENV
 *   transportMethod — 'sgtm-ga4-relay' (always — this is the only inbound path)
 *   revision        — Cloud Run revision name (K_REVISION env var) if present
 *   region          — Cloud Run region (CLOUD_RUN_REGION env var) if present
 *
 * None of these fields are sent to platform APIs — they are for observability.
 * CAPI senders only read the business fields (eventName, userData, value, …).
 *
 * Pure Node.js — NOT for use inside sGTM sandboxed JS.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os = require('os');

// ── UUID v4 (no external deps) ─────────────────────────────────────────────────
// Implements RFC 4122 §4.4 using Math.random().
// For production with very high traffic consider using crypto.randomUUID() (Node 14.17+)
// but Math.random() is sufficient for log correlation IDs.

/**
 * Generate a RFC 4122 v4 UUID.
 * @returns {string}  e.g. '550e8400-e29b-41d4-a716-446655440000'
 */
function uuidV4() {
  // Use crypto.randomUUID if available (Node 14.17+), fall back to Math.random
  try {
    const { randomUUID } = require('crypto');
    if (typeof randomUUID === 'function') return randomUUID();
  } catch (_) { /* ignore */ }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Static server metadata (resolved once at module load) ──────────────────────

const _serverHostname = (
  process.env.K_SERVICE    ||  // Cloud Run service name
  process.env.HOSTNAME      ||  // Docker / K8s
  os.hostname()                  // fallback
).slice(0, 128);                 // cap length for safety

const _revision = (process.env.K_REVISION || '').slice(0, 64);
const _region   = (process.env.CLOUD_RUN_REGION || process.env.FUNCTION_REGION || '').slice(0, 32);

/**
 * Resolve the current environment tag.
 * Priority: ET_ENVIRONMENT > NODE_ENV > K_SERVICE suffix heuristic > 'unknown'
 *
 * @returns {'production' | 'staging' | 'development' | 'unknown'}
 */
function resolveEnvironment() {
  const raw = (process.env.ET_ENVIRONMENT || process.env.NODE_ENV || '').toLowerCase();
  if (raw === 'production' || raw === 'prod')       return 'production';
  if (raw === 'staging'    || raw === 'stage')      return 'staging';
  if (raw === 'development'|| raw === 'dev' || raw === 'local') return 'development';
  // Cloud Run heuristic: service names ending in -prod / -stg
  const svc = (process.env.K_SERVICE || '').toLowerCase();
  if (svc.endsWith('-prod') || svc.endsWith('-production')) return 'production';
  if (svc.endsWith('-stg')  || svc.endsWith('-staging'))    return 'staging';
  return 'unknown';
}

const _environment = resolveEnvironment();

// ─────────────────────────────────────────────────────────────────────────────
// Main enrichment function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich an ETPayload with server-side metadata.
 * Returns a NEW object — original payload is not mutated.
 *
 * Fields added only if not already present (never overwrites caller-set values).
 *
 * @param {object} payload      — ETPayload (may be pre-sanitized or raw)
 * @param {object} [context]    — Optional context from the incoming request
 * @param {string} [context.requestId]       — caller-supplied trace ID (used if provided)
 * @param {string} [context.inboundIp]       — x-forwarded-for first hop
 * @param {string} [context.userAgent]       — inbound user-agent header
 * @param {string} [context.origin]          — inbound origin header
 * @param {string} [context.ga4ClientId]     — GA4 client ID if available
 * @param {string} [context.ga4SessionId]    — GA4 session ID if available
 * @returns {object}  enriched payload
 */
function enrich(payload, context = {}) {
  const p      = payload   || {};
  const ctx    = context   || {};
  const reqId  = p.requestId || ctx.requestId || uuidV4();
  const now    = Math.floor(Date.now() / 1000);

  const enriched = Object.assign({}, p, {
    // Trace / correlation
    requestId:       reqId,

    // Timing — serverTimestamp is when THIS server processed the event,
    // distinct from eventTime which reflects when the user action occurred
    serverTimestamp: p.serverTimestamp || now,

    // Infrastructure metadata
    serverHostname:  p.serverHostname  || _serverHostname,
    environment:     p.environment     || _environment,
    transportMethod: p.transportMethod || 'sgtm-ga4-relay',
  });

  // Cloud Run-specific metadata (only add if present)
  if (_revision) enriched.revision = enriched.revision || _revision;
  if (_region)   enriched.region   = enriched.region   || _region;

  // Enrich userData with server-extracted IP / UA if not already present
  if (ctx.inboundIp || ctx.userAgent) {
    enriched.userData = Object.assign({}, enriched.userData || {});
    if (ctx.inboundIp && !enriched.userData.client_ip_address) {
      // Strip proxy chain — take first IP only
      enriched.userData.client_ip_address = ctx.inboundIp.split(',')[0].trim();
    }
    if (ctx.userAgent && !enriched.userData.client_user_agent) {
      enriched.userData.client_user_agent = ctx.userAgent;
    }
  }

  // Attach GA4 session context for logging / debugging (not sent to CAPIs)
  if (ctx.ga4ClientId)  enriched._ga4ClientId  = enriched._ga4ClientId  || ctx.ga4ClientId;
  if (ctx.ga4SessionId) enriched._ga4SessionId = enriched._ga4SessionId || ctx.ga4SessionId;
  if (ctx.origin)       enriched._inboundOrigin = enriched._inboundOrigin || ctx.origin;

  return enriched;
}

/**
 * Extract the server-side metadata fields from an enriched payload.
 * Useful for building structured log entries without including business data.
 *
 * @param {object} payload  — enriched ETPayload
 * @returns {object}        — metadata-only object
 */
function extractMeta(payload) {
  const p = payload || {};
  const meta = {
    requestId:       p.requestId,
    serverTimestamp: p.serverTimestamp,
    serverHostname:  p.serverHostname,
    environment:     p.environment,
    transportMethod: p.transportMethod,
    eventName:       p.eventName,
    eventId:         p.eventId,
    eventTime:       p.eventTime,
  };
  if (p.revision)        meta.revision        = p.revision;
  if (p.region)          meta.region          = p.region;
  if (p._ga4ClientId)    meta.ga4ClientId    = p._ga4ClientId;
  if (p._ga4SessionId)   meta.ga4SessionId   = p._ga4SessionId;
  if (p._inboundOrigin)  meta.inboundOrigin  = p._inboundOrigin;
  return meta;
}

/**
 * Generate a fresh request ID (useful when building a context object before
 * the payload is constructed).
 *
 * @returns {string}  UUIDv4
 */
function newRequestId() {
  return uuidV4();
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  enrich,
  extractMeta,
  newRequestId,
  uuidV4,
  // Exposed for tests / health checks
  serverHostname: _serverHostname,
  environment:    _environment,
};
