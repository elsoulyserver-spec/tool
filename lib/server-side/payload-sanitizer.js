'use strict';

/**
 * EasyTrac — Payload Sanitizer
 * ─────────────────────────────────────────────────────────────────────────────
 * Deep-cleans and normalizes an ETPayload before it reaches any CAPI sender.
 *
 * Responsibilities:
 *   • Strip undefined / null / '' fields at every level
 *   • Trim string whitespace
 *   • Coerce and validate numeric fields (value, numItems)
 *   • Normalize currency to uppercase ISO 4217
 *   • Normalize email: lowercase + trim
 *   • Normalize phone: E.164-style stripping
 *   • Validate arrays (contentIds, items)
 *   • Clamp event_time to sane range
 *   • Return a clean copy — does NOT mutate the input
 *
 * Pure Node.js — NOT for use inside sGTM sandboxed JS.
 * sGTM templates handle their own field-level cleaning inline.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Primitives ─────────────────────────────────────────────────────────────────

/**
 * Returns true when a value should be kept.
 * Strips: undefined, null, '', NaN.
 * Keeps: 0, false, valid numbers, non-empty strings, objects, arrays.
 */
function isDefined(v) {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v === 'number' && isNaN(v)) return false;
  return true;
}

/**
 * Recursively remove all empty values from a plain object.
 * Does NOT recurse into Arrays — call cleanArray() separately.
 *
 * @param {object} obj
 * @returns {object}
 */
function cleanObject(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!isDefined(v)) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = cleanObject(v);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Filter and clean an array of strings.
 * Removes non-string / empty / whitespace-only entries.
 *
 * @param {any} val
 * @returns {string[] | undefined}
 */
function cleanStringArray(val) {
  if (!Array.isArray(val)) {
    // Accept comma-separated string → split into array
    if (typeof val === 'string' && val.trim()) {
      return val.split(',').map(s => s.trim()).filter(Boolean);
    }
    return undefined;
  }
  const arr = val.map(s => (typeof s === 'string' ? s.trim() : String(s))).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

// ── String normalizers ─────────────────────────────────────────────────────────

/**
 * Trim and lowercase a string. Returns undefined if empty after normalizing.
 * @param {any} raw
 * @returns {string | undefined}
 */
function normalizeString(raw) {
  if (!isDefined(raw)) return undefined;
  const s = String(raw).toLowerCase().trim();
  return s || undefined;
}

/**
 * Trim a string (preserve case). Returns undefined if empty.
 * @param {any} raw
 * @returns {string | undefined}
 */
function trimString(raw) {
  if (!isDefined(raw)) return undefined;
  const s = String(raw).trim();
  return s || undefined;
}

/**
 * Normalize email address: lowercase + trim.
 * Returns undefined if the result does not look like a plausible email.
 *
 * @param {any} raw
 * @returns {string | undefined}
 */
function normalizeEmail(raw) {
  if (!isDefined(raw)) return undefined;
  const s = String(raw).toLowerCase().trim();
  // Must contain @ and at least one dot after @
  if (!s.includes('@') || !s.split('@')[1]?.includes('.')) return undefined;
  return s;
}

/**
 * Normalize phone number for hashing.
 * Strips spaces, dashes, parentheses, dots.
 * Preserves leading + (for E.164 country code).
 * Returns undefined if fewer than 7 digits remain.
 *
 * @param {any} raw
 * @returns {string | undefined}
 */
function normalizePhone(raw) {
  if (!isDefined(raw)) return undefined;
  let s = String(raw).trim();
  const hasPlus = s.startsWith('+');
  // Strip everything except digits
  s = s.replace(/[^\d]/g, '');
  if (s.length < 7) return undefined;
  return hasPlus ? '+' + s : s;
}

/**
 * Normalize ISO 4217 currency code to uppercase.
 * Returns undefined if not a 3-letter alphabetic string.
 *
 * @param {any} raw
 * @returns {string | undefined}
 */
function normalizeCurrency(raw) {
  if (!isDefined(raw)) return undefined;
  const s = String(raw).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : undefined;
}

/**
 * Normalize a country code to ISO 3166-1 alpha-2 uppercase.
 * Returns undefined if not exactly 2 alphabetic characters.
 *
 * @param {any} raw
 * @returns {string | undefined}
 */
function normalizeCountry(raw) {
  if (!isDefined(raw)) return undefined;
  const s = String(raw).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : undefined;
}

// ── Numeric validators ─────────────────────────────────────────────────────────

/**
 * Coerce a value to a positive finite number.
 * Returns undefined if coercion fails or value is not positive.
 *
 * @param {any} raw
 * @returns {number | undefined}
 */
function positiveNumber(raw) {
  if (!isDefined(raw)) return undefined;
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Coerce a value to a non-negative integer.
 * Returns undefined if coercion fails.
 *
 * @param {any} raw
 * @returns {number | undefined}
 */
function nonNegativeInt(raw) {
  if (!isDefined(raw)) return undefined;
  const n = Math.floor(Number(raw));
  if (!isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Validate and clamp a Unix timestamp (seconds).
 * Accepts timestamps within a 7-day window in either direction of now.
 * Returns current time if the value is out of range or missing.
 *
 * @param {any} raw
 * @returns {number}  Unix timestamp in seconds
 */
function clampEventTime(raw) {
  const now = Math.floor(Date.now() / 1000);
  if (!isDefined(raw)) return now;
  const t = Math.floor(Number(raw));
  if (!isFinite(t)) return now;
  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  // If more than 7 days in the future or more than 7 days in the past → use now
  if (t > now + SEVEN_DAYS || t < now - SEVEN_DAYS) {
    return now;
  }
  return t;
}

// ── User data normalizer ───────────────────────────────────────────────────────

/**
 * Normalize the userData sub-object on an ETPayload.
 * All PII fields are cleaned here before hashing in the CAPI senders.
 *
 * @param {object} ud  — raw userData
 * @returns {object}   — cleaned userData (may be empty object)
 */
function normalizeUserData(ud) {
  if (!ud || typeof ud !== 'object') return {};
  return cleanObject({
    em:                normalizeEmail(ud.em),
    ph:                normalizePhone(ud.ph),
    fn:                normalizeString(ud.fn),
    ln:                normalizeString(ud.ln),
    ct:                normalizeString(ud.ct),
    st:                normalizeString(ud.st),
    zp:                trimString(ud.zp),
    country:           normalizeCountry(ud.country),
    external_id:       trimString(ud.external_id),
    fbp:               trimString(ud.fbp),
    fbc:               trimString(ud.fbc),
    ttp:               trimString(ud.ttp),
    scid:              trimString(ud.scid),
    client_ip_address: trimString(ud.client_ip_address),
    client_user_agent: trimString(ud.client_user_agent),
  });
}

// ── Items array normalizer ─────────────────────────────────────────────────────

/**
 * Normalize a contents/items array.
 * Each item may be a string (treated as id) or an object with id, quantity, price.
 *
 * @param {any} items
 * @returns {object[] | undefined}
 */
function normalizeItems(items) {
  if (!isDefined(items)) return undefined;
  // Accept JSON string
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_) { return undefined; }
  }
  if (!Array.isArray(items)) return undefined;
  const out = items.map(item => {
    if (typeof item === 'string') return cleanObject({ id: item.trim() });
    if (typeof item !== 'object' || item === null) return null;
    return cleanObject({
      id:       trimString(item.id || item.item_id),
      quantity: nonNegativeInt(item.quantity || item.qty),
      price:    positiveNumber(item.price || item.item_price),
    });
  }).filter(Boolean).filter(i => Object.keys(i).length > 0);
  return out.length > 0 ? out : undefined;
}

// ── Main sanitize function ─────────────────────────────────────────────────────

/**
 * Sanitize a full ETPayload.
 * Returns a new object — the original is not mutated.
 *
 * @param {object} payload  — raw ETPayload (from payload-builder.js or event-dispatcher.js)
 * @returns {object}        — clean ETPayload
 */
function sanitize(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const p = payload;

  const clean = cleanObject({
    // ── Core event fields ──────────────────────────────────────────────────
    eventName:    trimString(p.eventName),
    eventId:      trimString(p.eventId),
    eventTime:    clampEventTime(p.eventTime),
    actionSource: trimString(p.actionSource) || 'website',
    sourceUrl:    trimString(p.sourceUrl),
    pageReferrer: trimString(p.pageReferrer),

    // ── Commerce fields ────────────────────────────────────────────────────
    value:       positiveNumber(p.value),
    currency:    normalizeCurrency(p.currency),
    orderId:     trimString(p.orderId),
    contentIds:  cleanStringArray(p.contentIds),
    contentName: trimString(p.contentName),
    contentType: trimString(p.contentType) || 'product',
    numItems:    nonNegativeInt(p.numItems),
    items:       normalizeItems(p.items),
    searchString: trimString(p.searchString),

    // ── Click IDs ──────────────────────────────────────────────────────────
    fbclid: trimString(p.fbclid),
    gclid:  trimString(p.gclid),
    wbraid: trimString(p.wbraid),
    gbraid: trimString(p.gbraid),
    ttclid: trimString(p.ttclid),
    ScCid:  trimString(p.ScCid),

    // ── UTM attribution ────────────────────────────────────────────────────
    utmSource:   trimString(p.utmSource),
    utmMedium:   trimString(p.utmMedium),
    utmCampaign: trimString(p.utmCampaign),
    utmContent:  trimString(p.utmContent),
    utmTerm:     trimString(p.utmTerm),

    // ── User data ──────────────────────────────────────────────────────────
    userData: normalizeUserData(p.userData),

    // ── Platform event name overrides (pre-mapped) ─────────────────────────
    metaEventName:   trimString(p.metaEventName),
    tiktokEventName: trimString(p.tiktokEventName),
    snapEventName:   trimString(p.snapEventName),
    gadsEventName:   trimString(p.gadsEventName),

    // ── Debug / server-added fields (pass through) ─────────────────────────
    debugMode:     p.debugMode === true ? true : undefined,
    requestId:     trimString(p.requestId),
    serverTimestamp: p.serverTimestamp ? Number(p.serverTimestamp) : undefined,
    environment:   trimString(p.environment),
    serverHostname: trimString(p.serverHostname),
    transportMethod: trimString(p.transportMethod),
  });

  return clean;
}

/**
 * Validate the sanitized payload and return an array of warning strings.
 * Non-blocking — warnings are logged but do not halt dispatch.
 *
 * @param {object} payload  — sanitized ETPayload
 * @returns {string[]}      — list of validation warnings
 */
function validate(payload) {
  const warnings = [];
  const p = payload || {};

  if (!p.eventName)   warnings.push('eventName is missing');
  if (!p.eventId)     warnings.push('eventId is missing — deduplication disabled for this event');
  if (!p.eventTime)   warnings.push('eventTime is missing — will default to server time');
  if (!p.userData || Object.keys(p.userData).length === 0) {
    warnings.push('userData is empty — match rates will be lower');
  }
  if (p.eventName === 'purchase' || p.eventName === 'Purchase' || p.eventName === 'PlaceAnOrder') {
    if (!p.value)    warnings.push('purchase event has no value');
    if (!p.currency) warnings.push('purchase event has no currency');
    if (!p.orderId)  warnings.push('purchase event has no orderId — duplicate purchases cannot be detected');
  }

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  sanitize,
  validate,
  // Exported for unit tests and senders that need partial normalization
  normalizeEmail,
  normalizePhone,
  normalizeCurrency,
  normalizeCountry,
  normalizeUserData,
  normalizeItems,
  cleanObject,
  cleanStringArray,
  positiveNumber,
  nonNegativeInt,
  clampEventTime,
  trimString,
  normalizeString,
  isDefined,
};
