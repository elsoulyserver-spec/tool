'use strict';

/**
 * tiktok-events.js — EasyTrac Server-Side Tracking
 *
 * Manual TikTok Events API sender.
 * NO official TikTok template — pure HTTP via axios.
 *
 * Endpoint: POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 * Docs: https://business-api.tiktok.com/portal/docs?id=1771100865818625
 *
 * Payload spec (TikTok Events API v1.3):
 *   pixel_code   : string  (TikTok Pixel ID)
 *   event        : string  (e.g. "PlaceAnOrder")
 *   event_time   : integer (Unix timestamp)
 *   event_id     : string  (for pixel+CAPI deduplication)
 *   user         : object  (SHA-256 hashed PII + browser signals)
 *   properties   : object  (ecommerce data)
 *   page         : object  (url, referrer)
 *
 * PII must arrive pre-hashed (SHA-256 hex). Call hashPayload() first.
 */

const axios = require('axios');
const { cleanEmpty } = require('../hash-utils');

const TIKTOK_EVENTS_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const TIMEOUT_MS        = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildTikTokPayload — constructs the TikTok Events API body.
 */
function buildTikTokPayload(p, config = {}) {
  const ud = p.userData || {};

  // ── user object ───────────────────────────────────────────────────────────
  const user = cleanEmpty({
    email:       ud.em          || undefined,
    phone_number:ud.ph          || undefined,
    external_id: ud.external_id || undefined,
    ttclid:      p.ttclid       || undefined,
    ttp:         ud.ttp         || undefined,
    ip:          ud.client_ip_address || undefined,
    user_agent:  ud.client_user_agent || undefined,
    // TikTok does not use fbp/fbc but we add ttclid + ttp for attribution
  });

  // ── properties (ecommerce) ────────────────────────────────────────────────
  const contents = _buildContents(p);

  const properties = cleanEmpty({
    value:      p.value > 0    ? p.value    : undefined,
    currency:   p.currency     ? p.currency : undefined,
    order_id:   p.orderId      ? p.orderId  : undefined,
    contents:   contents       ? contents   : undefined,
    search_string: p.searchString || undefined,
    // Optional: query for Search events
    query:      p.searchString || undefined,
  });

  // ── page context ──────────────────────────────────────────────────────────
  const page = cleanEmpty({
    url:      p.sourceUrl     || undefined,
    referrer: p.pageReferrer  || undefined,
  });

  // ── event body ────────────────────────────────────────────────────────────
  const body = cleanEmpty({
    pixel_code:  config.pixelCode,
    event:       p.tiktokEventName || p.eventName,
    event_time:  p.eventTime || Math.floor(Date.now() / 1000),
    event_id:    p.eventId  || undefined,
    user:        Object.keys(user).length       ? user       : undefined,
    properties:  Object.keys(properties).length ? properties : undefined,
    page:        Object.keys(page).length       ? page       : undefined,
  });

  // Wrap in TikTok's required request structure
  return {
    pixel_code: config.pixelCode,
    event:      p.tiktokEventName || p.eventName,
    event_time: p.eventTime || Math.floor(Date.now() / 1000),
    event_id:   p.eventId   || undefined,
    user,
    properties: Object.keys(properties).length ? properties : undefined,
    page:       Object.keys(page).length       ? page       : undefined,
    // test_event_code for TikTok is passed via query param, not body
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender
// ─────────────────────────────────────────────────────────────────────────────

/**
 * send — POST a single event to TikTok Events API.
 *
 * @param {ETPayload} payload
 * @param {object}    config
 * @param {string}    config.pixelCode     — TikTok Pixel ID
 * @param {string}    config.accessToken   — TikTok Events API access token
 * @param {boolean}   [config.testMode]    — send as test event
 * @returns {Promise<TikTokEventsResponse>}
 */
async function send(payload, config = {}) {
  const { pixelCode, accessToken, testMode } = config;

  if (!pixelCode)   throw _err('TikTok Events API: pixelCode is required');
  if (!accessToken) throw _err('TikTok Events API: accessToken is required');

  const body = buildTikTokPayload(payload, config);

  const params = {};
  if (testMode) params.test = 1;

  let response;
  try {
    response = await axios.post(TIKTOK_EVENTS_URL, body, {
      params,
      headers: {
        'Access-Token':  accessToken,
        'Content-Type':  'application/json',
      },
      timeout: TIMEOUT_MS,
      validateStatus: null,
    });
  } catch (networkErr) {
    const e = _err(`TikTok Events API network error: ${networkErr.message}`);
    e.sentPayload = body;
    throw e;
  }

  // TikTok returns code 0 for success
  const tiktokCode = response.data?.code;
  if (response.status < 200 || response.status >= 300 || (tiktokCode !== undefined && tiktokCode !== 0)) {
    const e = _err(`TikTok Events API error: HTTP ${response.status}, code ${tiktokCode}`);
    e.status       = response.status;
    e.responseBody = response.data;
    e.sentPayload  = body;
    throw e;
  }

  return {
    platform:   'tiktok',
    statusCode: response.status,
    code:       tiktokCode,
    message:    response.data?.message ?? null,
    requestId:  response.data?.request_id ?? null,
    raw:        response.data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _buildContents(p) {
  if (p.items && Array.isArray(p.items) && p.items.length) {
    return p.items.map(item => cleanEmpty({
      content_id:   item.item_id || item.id || '',
      content_name: item.item_name || item.name || p.contentName || '',
      content_type: item.content_type || p.contentType || 'product',
      quantity:     item.quantity || 1,
      price:        item.price   || p.value || 0,
    }));
  }
  const ids = _toArray(p.contentIds);
  if (!ids) return undefined;
  return ids.map(id => cleanEmpty({
    content_id:   id,
    content_name: p.contentName || '',
    content_type: p.contentType || 'product',
    quantity:     p.numItems || 1,
    price:        p.value    || 0,
  }));
}

function _toArray(val) {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.length ? val : undefined;
  const s = String(val).trim();
  if (!s) return undefined;
  return s.includes(',') ? s.split(',').map(v => v.trim()) : [s];
}

function _err(msg) {
  return Object.assign(new Error(msg), { platform: 'tiktok' });
}

module.exports = { send, buildTikTokPayload };
