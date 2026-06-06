'use strict';

/**
 * snapchat-capi.js — EasyTrac Server-Side Tracking
 *
 * Manual Snapchat Conversions API sender.
 * NO official Snapchat template — pure HTTP via axios.
 *
 * Endpoint: POST https://tr.snapchat.com/v2/conversion
 * Docs: https://marketingapi.snapchat.com/docs/conversion.html
 *
 * Payload spec:
 *   pixel_id       : string  (Snapchat Pixel ID)
 *   event_type     : string  (e.g. "PURCHASE")
 *   event_time     : integer (Unix timestamp in ms for Snap, we convert from seconds)
 *   event_id       : string  (for pixel+CAPI deduplication — "client_dedup_id")
 *   user_data      : object  (SHA-256 hashed PII + browser signals)
 *   custom_data    : object  (ecommerce data)
 *
 * PII must arrive pre-hashed (SHA-256 hex). Call hashPayload() first.
 */

const axios = require('axios');
const { cleanEmpty } = require('../hash-utils');

const SNAP_CAPI_URL = 'https://tr.snapchat.com/v2/conversion';
const TIMEOUT_MS    = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildSnapPayload — constructs the Snapchat CAPI body.
 * Snap expects event_time in milliseconds (not seconds).
 */
function buildSnapPayload(p, config = {}) {
  const ud = p.userData || {};

  // ── user_data ─────────────────────────────────────────────────────────────
  const user_data = cleanEmpty({
    em:          ud.em          ? [ud.em]          : undefined,
    ph:          ud.ph          ? [ud.ph]          : undefined,
    fn:          ud.fn          ? [ud.fn]          : undefined,
    ln:          ud.ln          ? [ud.ln]          : undefined,
    ct:          ud.ct          ? [ud.ct]          : undefined,
    st:          ud.st          ? [ud.st]          : undefined,
    zp:          ud.zp          ? [ud.zp]          : undefined,
    country:     ud.country     ? [ud.country]     : undefined,
    external_id: ud.external_id ? [ud.external_id] : undefined,
    sc_click_id: p.ScCid        || undefined,  // Snapchat click ID
    sc_cookie1:  ud.scid        || undefined,  // _scid cookie
    ip_address:  ud.client_ip_address || undefined,
    user_agent:  ud.client_user_agent || undefined,
  });

  // ── custom_data (ecommerce) ───────────────────────────────────────────────
  const custom_data = cleanEmpty({
    currency:       p.currency || undefined,
    price:          p.value > 0 ? p.value : undefined,
    transaction_id: p.orderId  || undefined,
    item_ids:       _toArray(p.contentIds) || undefined,
    num_items:      p.numItems > 0 ? p.numItems : undefined,
    description:    p.contentName || undefined,
    search_string:  p.searchString || undefined,
  });

  // Snap event_time must be in milliseconds
  const eventTimeMs = (p.eventTime || Math.floor(Date.now() / 1000)) * 1000;

  const body = {
    pixel_id:         config.pixelId,
    event_type:       p.snapEventName || p.eventName,
    event_time:       eventTimeMs,
    event_source_url: p.sourceUrl || undefined,
    client_dedup_id:  p.eventId   || undefined,  // Snap deduplication field
    user_data:        Object.keys(user_data).length  ? user_data  : undefined,
    custom_data:      Object.keys(custom_data).length ? custom_data : undefined,
  };

  // Remove top-level undefineds
  return cleanEmpty(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender
// ─────────────────────────────────────────────────────────────────────────────

/**
 * send — POST a single event to Snapchat CAPI.
 *
 * @param {ETPayload} payload
 * @param {object}    config
 * @param {string}    config.pixelId       — Snapchat Pixel ID
 * @param {string}    config.accessToken   — Snapchat Conversions API token
 * @returns {Promise<SnapCapiResponse>}
 */
async function send(payload, config = {}) {
  const { pixelId, accessToken } = config;

  if (!pixelId)     throw _err('Snapchat CAPI: pixelId is required');
  if (!accessToken) throw _err('Snapchat CAPI: accessToken is required');

  const body = buildSnapPayload(payload, config);

  let response;
  try {
    response = await axios.post(SNAP_CAPI_URL, body, {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: TIMEOUT_MS,
      validateStatus: null,
    });
  } catch (networkErr) {
    const e = _err(`Snapchat CAPI network error: ${networkErr.message}`);
    e.sentPayload = body;
    throw e;
  }

  if (response.status < 200 || response.status >= 300) {
    const e = _err(`Snapchat CAPI HTTP ${response.status}`);
    e.status       = response.status;
    e.responseBody = response.data;
    e.sentPayload  = body;
    throw e;
  }

  return {
    platform:   'snap',
    statusCode: response.status,
    status:     response.data?.status ?? null,
    reason:     response.data?.reason ?? null,
    raw:        response.data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _toArray(val) {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.length ? val : undefined;
  const s = String(val).trim();
  if (!s) return undefined;
  return s.includes(',') ? s.split(',').map(v => v.trim()) : [s];
}

function _err(msg) {
  return Object.assign(new Error(msg), { platform: 'snap' });
}

module.exports = { send, buildSnapPayload };
