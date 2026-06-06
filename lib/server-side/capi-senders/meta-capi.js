'use strict';

/**
 * meta-capi.js — EasyTrac Server-Side Tracking
 *
 * Manual Meta Conversions API sender.
 * NO official Meta template — pure HTTP via axios.
 *
 * Endpoint: POST https://graph.facebook.com/v22.0/{PIXEL_ID}/events
 * Docs: https://developers.facebook.com/docs/marketing-api/conversions-api/
 *
 * Payload spec:
 *   - event_name        : string  (e.g. "Purchase")
 *   - event_time        : integer (Unix timestamp)
 *   - event_id          : string  (for pixel+CAPI deduplication)
 *   - action_source     : "website" (always)
 *   - user_data         : object  (SHA-256 hashed PII + browser signals)
 *   - custom_data       : object  (ecommerce data)
 *   - event_source_url  : string  (page URL)
 *
 * All PII in user_data must arrive pre-hashed (SHA-256 hex).
 * Call hashPayload() from payload-builder.js before calling send().
 */

const axios = require('axios');
const { cleanEmpty } = require('../hash-utils');

const META_CAPI_BASE = 'https://graph.facebook.com/v22.0';
const TIMEOUT_MS     = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildMetaPayload — constructs the Meta CAPI events array from an ETPayload.
 * Strips empty/undefined fields before sending.
 *
 * @param {ETPayload} p      — normalised + hashed payload
 * @param {object}    config — { pixelId, accessToken, testEventCode? }
 * @returns {object} Meta API request body
 */
function buildMetaPayload(p, config = {}) {
  const ud = p.userData || {};

  // ── user_data ─────────────────────────────────────────────────────────────
  const user_data = cleanEmpty({
    em:                 ud.em          || undefined,
    ph:                 ud.ph          || undefined,
    fn:                 ud.fn          || undefined,
    ln:                 ud.ln          || undefined,
    ct:                 ud.ct          || undefined,
    st:                 ud.st          || undefined,
    zp:                 ud.zp          || undefined,
    country:            ud.country     || undefined,
    external_id:        ud.external_id || undefined,
    fbp:                ud.fbp         || undefined,
    fbc:                ud.fbc         || undefined,
    client_ip_address:  ud.client_ip_address || undefined,
    client_user_agent:  ud.client_user_agent || undefined,
  });

  // ── custom_data ───────────────────────────────────────────────────────────
  const custom_data = cleanEmpty({
    value:       p.value    > 0           ? p.value    : undefined,
    currency:    p.currency               ? p.currency : undefined,
    order_id:    p.orderId                ? p.orderId  : undefined,
    content_ids: _toArray(p.contentIds),
    content_name:p.contentName            ? p.contentName : undefined,
    content_type:p.contentType            ? p.contentType : undefined,
    num_items:   p.numItems > 0           ? p.numItems    : undefined,
    contents:    _buildContents(p),
    search_string: p.searchString || undefined,
  });

  // ── event data ────────────────────────────────────────────────────────────
  const eventData = cleanEmpty({
    event_name:       p.metaEventName || p.eventName,
    event_time:       p.eventTime     || Math.floor(Date.now() / 1000),
    event_id:         p.eventId       || undefined,
    action_source:    'website',
    event_source_url: p.sourceUrl     || undefined,
    user_data:        Object.keys(user_data).length  ? user_data  : undefined,
    custom_data:      Object.keys(custom_data).length ? custom_data : undefined,
    // Optional: data_processing_options for GDPR/CCPA
    // data_processing_options: [],
  });

  const body = {
    data: [eventData],
  };

  if (config.testEventCode) {
    body.test_event_code = config.testEventCode;
  }

  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender
// ─────────────────────────────────────────────────────────────────────────────

/**
 * send — POST a single event to Meta CAPI.
 *
 * @param {ETPayload} payload  — normalised + hashed payload
 * @param {object}    config
 * @param {string}    config.pixelId
 * @param {string}    config.accessToken
 * @param {string}    [config.testEventCode]  — e.g. "TEST12345"
 * @returns {Promise<MetaCapiResponse>}
 */
async function send(payload, config = {}) {
  const { pixelId, accessToken, testEventCode } = config;

  if (!pixelId)      throw _err('Meta CAPI: pixelId is required');
  if (!accessToken)  throw _err('Meta CAPI: accessToken is required');

  const url  = `${META_CAPI_BASE}/${pixelId}/events`;
  const body = buildMetaPayload(payload, { testEventCode });

  let response;
  try {
    response = await axios.post(url, body, {
      params:  { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
      validateStatus: null, // handle all status codes ourselves
    });
  } catch (networkErr) {
    const e = _err(`Meta CAPI network error: ${networkErr.message}`);
    e.sentPayload = body;
    throw e;
  }

  if (response.status < 200 || response.status >= 300) {
    const e = _err(`Meta CAPI HTTP ${response.status}`);
    e.status       = response.status;
    e.responseBody = response.data;
    e.sentPayload  = body;
    throw e;
  }

  return {
    platform:    'meta',
    statusCode:  response.status,
    eventsReceived: response.data?.events_received ?? null,
    fbtrace_id:  response.data?.fbtrace_id ?? null,
    messages:    response.data?.messages   ?? [],
    raw:         response.data,
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
  // Support comma-separated: "id1,id2"
  return s.includes(',') ? s.split(',').map(v => v.trim()) : [s];
}

function _buildContents(p) {
  if (p.items && Array.isArray(p.items) && p.items.length) {
    return p.items.map(item => cleanEmpty({
      id:       item.item_id || item.id || p.contentIds,
      quantity: item.quantity || 1,
      price:    item.price   || p.value,
    }));
  }
  const ids = _toArray(p.contentIds);
  if (!ids || !ids.length) return undefined;
  return ids.map(id => cleanEmpty({
    id,
    quantity: p.numItems || 1,
    price:    p.value    || undefined,
  }));
}

function _err(msg) {
  return Object.assign(new Error(msg), { platform: 'meta' });
}

module.exports = { send, buildMetaPayload };
