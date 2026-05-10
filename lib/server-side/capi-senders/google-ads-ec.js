'use strict';

/**
 * google-ads-ec.js — EasyTrac Server-Side Tracking
 *
 * Manual Google Ads Enhanced Conversions sender.
 * NO official template — pure HTTP via axios.
 *
 * Uses Google Ads API uploadClickConversions endpoint.
 * Docs: https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
 *
 * Two upload modes depending on what click ID is available:
 *   1. gclid  → ClickConversion with gclid
 *   2. wbraid → ClickConversion with wbraid (iOS App campaign)
 *   3. gbraid → ClickConversion with gbraid (cross-channel)
 *
 * Enhanced Conversions (EC) hashes user PII and matches it to signed-in
 * Google accounts — improving conversion measurement for cookieless users.
 *
 * PII must arrive pre-hashed (SHA-256 hex). Call hashPayload() first.
 *
 * NOTE: This sender requires a Google Ads OAuth2 access token.
 * Use the google-auth-library or store a service account token.
 * In sGTM, use the et_gads_ec_manual template which handles OAuth2 internally.
 */

const axios = require('axios');
const { cleanEmpty } = require('../hash-utils');

const GADS_API_BASE = 'https://googleads.googleapis.com/v17';
const TIMEOUT_MS    = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildGadsPayload — constructs the uploadClickConversions request body.
 *
 * @param {ETPayload} p
 * @param {object}    config
 * @param {string}    config.conversionActionId  — full resource name or "AW-xxx/yyy"
 * @returns {object}
 */
function buildGadsPayload(p, config = {}) {
  const ud = p.userData || {};

  // Resolve conversion action resource name
  // Accepts: "AW-12345678/AbCdEfGhIjKlMnOp" or full resource name
  let conversionAction = config.conversionActionId || '';
  if (!conversionAction.startsWith('customers/')) {
    // Try to build resource name from AW-CUSTOMER_ID/LABEL format
    const awMatch = conversionAction.match(/^AW-(\d+)\/(.+)$/);
    if (awMatch && config.customerId) {
      conversionAction = `customers/${config.customerId}/conversionActions/${awMatch[2]}`;
    }
    // If no customer ID available, pass as-is (Google Ads API may reject — log warns)
  }

  // ── user_identifiers (Enhanced Conversions) ────────────────────────────────
  const user_identifiers = [];

  if (ud.em) {
    user_identifiers.push({
      hashedEmail: ud.em, // pre-hashed SHA-256
    });
  }
  if (ud.ph) {
    user_identifiers.push({
      hashedPhoneNumber: ud.ph, // pre-hashed SHA-256
    });
  }
  if (ud.fn || ud.ln || ud.ct || ud.st || ud.zp || ud.country) {
    const addressInfo = cleanEmpty({
      hashedFirstName:     ud.fn      || undefined,
      hashedLastName:      ud.ln      || undefined,
      hashedCity:          ud.ct      || undefined,
      hashedState:         ud.st      || undefined,
      hashedStreetAddress: undefined, // not collected
      postalCode:          ud.zp      || undefined,
      countryCode:         ud.country || undefined,
    });
    if (Object.keys(addressInfo).length) {
      user_identifiers.push({ addressInfo });
    }
  }

  // ── ClickConversion object ─────────────────────────────────────────────────
  const conversion_time = _toGadsTimestamp(p.eventTime);

  const clickConversion = cleanEmpty({
    gclid:                 p.gclid  || undefined,
    wbraid:                p.wbraid || undefined,
    gbraid:                p.gbraid || undefined,
    conversion_action:     conversionAction || undefined,
    conversion_date_time:  conversion_time,
    conversion_value:      p.value > 0 ? p.value : undefined,
    currency_code:         p.currency  || undefined,
    order_id:              p.orderId   || undefined,
    user_identifiers:      user_identifiers.length ? user_identifiers : undefined,
  });

  return {
    conversions: [clickConversion],
    partial_failure: true,
    validate_only: config.validateOnly || false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender
// ─────────────────────────────────────────────────────────────────────────────

/**
 * send — POST to Google Ads uploadClickConversions.
 *
 * @param {ETPayload} payload
 * @param {object}    config
 * @param {string}    config.conversionActionId — "AW-XXXXXXXXXX/label" or full resource name
 * @param {string}    config.customerId         — Google Ads customer ID (digits only)
 * @param {string}    config.accessToken        — OAuth2 bearer token
 * @param {string}    [config.developerToken]   — Google Ads developer token
 * @param {boolean}   [config.validateOnly]     — dry-run mode
 * @returns {Promise<GAdsEcResponse>}
 */
async function send(payload, config = {}) {
  const { customerId, accessToken, developerToken } = config;

  if (!customerId)    throw _err('Google Ads EC: customerId is required');
  if (!accessToken)   throw _err('Google Ads EC: accessToken (OAuth2) is required');
  if (!developerToken) throw _err('Google Ads EC: developerToken is required');

  // Must have at least one click ID
  if (!payload.gclid && !payload.wbraid && !payload.gbraid) {
    throw _err('Google Ads EC: no click ID found (gclid/wbraid/gbraid) — skipping upload');
  }

  const cid  = String(customerId).replace(/-/g, '');
  const url  = `${GADS_API_BASE}/customers/${cid}:uploadClickConversions`;
  const body = buildGadsPayload(payload, { ...config, customerId: cid });

  let response;
  try {
    response = await axios.post(url, body, {
      headers: {
        Authorization:    `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'Content-Type':   'application/json',
        // login-customer-id header required if using MCC account
        ...(config.loginCustomerId ? { 'login-customer-id': config.loginCustomerId } : {}),
      },
      timeout: TIMEOUT_MS,
      validateStatus: null,
    });
  } catch (networkErr) {
    const e = _err(`Google Ads EC network error: ${networkErr.message}`);
    e.sentPayload = body;
    throw e;
  }

  if (response.status < 200 || response.status >= 300) {
    const e = _err(`Google Ads EC HTTP ${response.status}`);
    e.status       = response.status;
    e.responseBody = response.data;
    e.sentPayload  = body;
    throw e;
  }

  // Check partial failures
  const partialErrors = response.data?.partialFailureError;
  if (partialErrors) {
    const e = _err(`Google Ads EC partial failure: ${JSON.stringify(partialErrors)}`);
    e.status       = response.status;
    e.responseBody = response.data;
    e.sentPayload  = body;
    throw e;
  }

  return {
    platform:   'gads',
    statusCode: response.status,
    results:    response.data?.results ?? [],
    raw:        response.data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert Unix timestamp (seconds) to Google Ads required format:
 * "yyyy-MM-dd HH:mm:ss+00:00"
 */
function _toGadsTimestamp(unixSeconds) {
  const d = new Date((unixSeconds || Math.floor(Date.now() / 1000)) * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}

function _err(msg) {
  return Object.assign(new Error(msg), { platform: 'gads' });
}

module.exports = { send, buildGadsPayload };
