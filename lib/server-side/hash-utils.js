'use strict';

/**
 * hash-utils.js — EasyTrac Server-Side Tracking
 *
 * SHA-256 hashing utilities for CAPI user data normalisation.
 * All functions are synchronous and return hex-encoded SHA-256 digests.
 *
 * Meta, TikTok and Snapchat all require SHA-256 of normalised PII:
 *   email    → lowercase().trim()
 *   phone    → E.164 format (digits only, with country code prefix)
 *   names    → lowercase().trim()
 *   city     → lowercase().trim()
 *   state    → ISO 3166-2 abbreviation, lowercase
 *   zip      → digits only (US) or as-is (intl), trim whitespace
 *   country  → ISO 3166-1 alpha-2 lowercase  (e.g. "sa", "us")
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Core SHA-256 helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns SHA-256 hex digest of `str`, or '' if input is empty.
 * Already-hashed 64-char hex strings are returned as-is.
 */
function sha256(str) {
  if (!str || str === '') return '';
  const s = String(str).trim();
  if (!s) return '';
  // If already a 64-char lowercase hex string — treat as pre-hashed, pass through
  if (/^[a-f0-9]{64}$/.test(s)) return s;
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise + hash — one function per field
// ─────────────────────────────────────────────────────────────────────────────

/** Hash email: lowercase + trim */
function hashEmail(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

/**
 * Hash phone: strip all non-digit chars except leading +, then hash.
 * Accepts: "+966501234567", "00966501234567", "0501234567"
 * Normalise to E.164 where possible but hash whatever we receive.
 */
function hashPhone(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Remove spaces, dashes, parens — keep digits and leading +
  s = s.replace(/[\s\-().]/g, '');
  if (!s) return '';
  return sha256(s);
}

/** Hash first name: lowercase + trim */
function hashFirstName(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

/** Hash last name: lowercase + trim */
function hashLastName(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

/** Hash city: lowercase + trim */
function hashCity(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

/** Hash state: lowercase + trim (should be ISO abbreviation) */
function hashState(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

/** Hash zip: trim whitespace */
function hashZip(raw) {
  if (!raw) return '';
  return sha256(String(raw).trim());
}

/** Hash country: lowercase ISO 3166-1 alpha-2 */
function hashCountry(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

/**
 * Hash external_id: lowercase + trim.
 * For Meta: can be any consistent identifier.
 * For TikTok: sha256 or plain (platform accepts both — we hash for safety).
 */
function hashExternalId(raw) {
  if (!raw) return '';
  return sha256(String(raw).toLowerCase().trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch hasher — hashes an entire user_data object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hashUserData — normalises and hashes all PII fields in a user_data object.
 *
 * Input keys (raw or pre-hashed):
 *   em, ph, fn, ln, ct, st, zp, country, external_id, fbp, fbc, ttp, scid
 *
 * Output: object with same keys, all sensitive fields SHA-256 hashed.
 * Non-hashable fields (fbp, fbc, ttp, scid, client_ip, user_agent) passed through as-is.
 *
 * @param {object} raw
 * @returns {object} hashed
 */
function hashUserData(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};

  const out = {};

  if (raw.em)          out.em          = hashEmail(raw.em);
  if (raw.ph)          out.ph          = hashPhone(raw.ph);
  if (raw.fn)          out.fn          = hashFirstName(raw.fn);
  if (raw.ln)          out.ln          = hashLastName(raw.ln);
  if (raw.ct)          out.ct          = hashCity(raw.ct);
  if (raw.st)          out.st          = hashState(raw.st);
  if (raw.zp)          out.zp          = hashZip(raw.zp);
  if (raw.country)     out.country     = hashCountry(raw.country);
  if (raw.external_id) out.external_id = hashExternalId(raw.external_id);

  // Browser signals — passed through as-is (not hashable identifiers)
  if (raw.fbp)              out.fbp              = raw.fbp;
  if (raw.fbc)              out.fbc              = raw.fbc;
  if (raw.ttp)              out.ttp              = raw.ttp;
  if (raw.scid)             out.scid             = raw.scid;
  if (raw.client_ip_address) out.client_ip_address = raw.client_ip_address;
  if (raw.client_user_agent) out.client_user_agent = raw.client_user_agent;

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility — remove empty/null/undefined fields from an object (deep = false)
// ─────────────────────────────────────────────────────────────────────────────

function cleanEmpty(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  });
  return out;
}

module.exports = {
  sha256,
  hashEmail,
  hashPhone,
  hashFirstName,
  hashLastName,
  hashCity,
  hashState,
  hashZip,
  hashCountry,
  hashExternalId,
  hashUserData,
  cleanEmpty,
};
