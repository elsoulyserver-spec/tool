'use strict';

/**
 * payload-builder.js — EasyTrac Server-Side Tracking
 *
 * Extracts a normalised, platform-agnostic event payload from a raw GA4
 * server-side event object (as received by the sGTM GA4 Client or forwarded
 * via a proxy endpoint).
 *
 * Data sources in the GA4 server event body:
 *   event_name                → top-level
 *   ep.*  (event parameters)  → event.events[0].params
 *   epn.* (numeric ep)        → same object, numeric values
 *   up.*  (user properties)   → event.user_properties
 *   HTTP headers              → provided separately
 *
 * The builder produces a single ETPayload object consumed by all CAPI senders.
 */

const { hashUserData, cleanEmpty } = require('./hash-utils');

// ─────────────────────────────────────────────────────────────────────────────
// Event name maps — GA4 event name → platform event name
// ─────────────────────────────────────────────────────────────────────────────

const META_EVENT_MAP = {
  page_view:      'PageView',
  view_item:      'ViewContent',
  add_to_cart:    'AddToCart',
  begin_checkout: 'InitiateCheckout',
  purchase:       'Purchase',
  generate_lead:  'Lead',
  sign_up:        'CompleteRegistration',
  search:         'Search',
};

const TIKTOK_EVENT_MAP = {
  page_view:      'Pageview',
  view_item:      'ViewContent',
  add_to_cart:    'AddToCart',
  begin_checkout: 'InitiateCheckout',
  purchase:       'PlaceAnOrder',
  generate_lead:  'SubmitForm',
  sign_up:        'CompleteRegistration',
  search:         'Search',
};

const SNAP_EVENT_MAP = {
  page_view:      'PAGE_VIEW',
  view_item:      'VIEW_CONTENT',
  add_to_cart:    'ADD_CART',
  begin_checkout: 'START_CHECKOUT',
  purchase:       'PURCHASE',
  generate_lead:  'SIGN_UP',
  sign_up:        'SIGN_UP',
  search:         'SEARCH',
};

const GADS_EVENT_MAP = {
  purchase:      'purchase',
  generate_lead: 'submit_lead_form',
  sign_up:       'sign_up',
  add_to_cart:   'add_to_cart',
};

// ─────────────────────────────────────────────────────────────────────────────
// GA4 server event parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * parseGA4Event — extracts all fields from a raw GA4 server event object.
 *
 * Supports the Measurement Protocol v2 / sGTM forwarded payload shape:
 * {
 *   client_id, user_id, timestamp_micros,
 *   user_properties: { prop_name: { value: "..." } },
 *   events: [{ name, params: { ep_key: value, ... } }]
 * }
 *
 * @param {object} ga4Event  — raw GA4 MP v2 event body
 * @param {object} headers   — HTTP request headers (x-forwarded-for, user-agent, etc.)
 * @returns {ETPayload}
 */
function parseGA4Event(ga4Event = {}, headers = {}) {
  const event = ga4Event.events?.[0] || {};
  const ep    = event.params || {};       // event parameters (ep.* + epn.*)
  const up    = ga4Event.user_properties || {};

  // User property helper — GA4 MP format wraps values: { prop: { value: "x" } }
  const upGet = (key) => {
    const entry = up[key];
    if (!entry) return '';
    return entry.value ?? entry.string_value ?? entry.int_value ?? entry.double_value ?? '';
  };

  // IP resolution — prefer x-forwarded-for (Cloud Run sets this), fallback to x-real-ip
  const rawIp = headers['x-forwarded-for'] || headers['x-real-ip'] || '';
  const clientIp = rawIp ? String(rawIp).split(',')[0].trim() : '';

  const userAgent = headers['user-agent'] || '';

  // FBC resolution
  let fbc = upGet('fbc') || ep['_fbc'] || '';
  if (!fbc && ep.fbclid) {
    fbc = `fb.1.${Math.floor(Date.now() / 1000)}.${ep.fbclid}`;
  }

  // event_time: use forwarded ep.event_time if present, else now
  const eventTime = (ep.event_time && !isNaN(Number(ep.event_time)))
    ? Number(ep.event_time)
    : Math.floor(Date.now() / 1000);

  /** @type {ETPayload} */
  const payload = {
    // ── Event identity ──────────────────────────────────────────────────────
    eventName:     event.name || '',
    eventId:       String(ep.event_id || ep.transaction_id || `et_${Date.now()}`),
    eventTime,
    actionSource:  'website',

    // ── Page context ────────────────────────────────────────────────────────
    sourceUrl:     ep.page_url || ga4Event.page_location || '',
    pageReferrer:  ep.page_referrer || ga4Event.page_referrer || '',
    pageHostname:  ga4Event.page_hostname || '',

    // ── Ecommerce ────────────────────────────────────────────────────────────
    value:         parseFloat(ep.value) || 0,
    currency:      ep.currency || 'SAR',
    orderId:       ep.transaction_id || '',
    contentIds:    ep.content_ids || '',
    contentName:   ep.content_name || '',
    contentType:   ep.content_type || 'product',
    numItems:      parseInt(ep.num_items || ep.quantity) || 1,
    items:         ep.items || [],
    searchString:  ep.search_string || '',

    // ── Click IDs ────────────────────────────────────────────────────────────
    fbclid:  ep.fbclid  || '',
    gclid:   ep.gclid   || '',
    wbraid:  ep.wbraid  || '',
    gbraid:  ep.gbraid  || '',
    ttclid:  ep.ttclid  || '',
    ScCid:   ep.ScCid   || '',

    // ── User data (raw — will be hashed by hashUserData) ─────────────────────
    userData: {
      em:          upGet('em')          || ep.user_email || '',
      ph:          upGet('ph')          || ep.user_phone || '',
      fn:          upGet('fn')          || '',
      ln:          upGet('ln')          || '',
      ct:          upGet('ct')          || '',
      st:          upGet('st')          || '',
      zp:          upGet('zp')          || '',
      country:     upGet('country')     || '',
      external_id: upGet('external_id') || ga4Event.user_id || '',
      fbp:         upGet('fbp')         || ep._fbp || '',
      fbc,
      ttp:         upGet('ttp')         || ep._ttp || '',
      scid:        upGet('scid')        || ep._scid || '',
      client_ip_address: clientIp,
      client_user_agent: userAgent,
    },

    // ── Attribution ─────────────────────────────────────────────────────────
    utmSource:   ep.utm_source   || '',
    utmMedium:   ep.utm_medium   || '',
    utmCampaign: ep.utm_campaign || '',
    utmContent:  ep.utm_content  || '',
    utmTerm:     ep.utm_term     || '',

    // ── Debug ────────────────────────────────────────────────────────────────
    debugMode: ga4Event.debug_mode || false,

    // ── Event name mappings ──────────────────────────────────────────────────
    metaEventName:   META_EVENT_MAP[event.name]   || event.name || '',
    tiktokEventName: TIKTOK_EVENT_MAP[event.name] || event.name || '',
    snapEventName:   SNAP_EVENT_MAP[event.name]   || event.name || '',
    gadsEventName:   GADS_EVENT_MAP[event.name]   || '',
  };

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flat event builder — for direct proxy use (not via sGTM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildPayloadFromFlat — builds an ETPayload from a flat key-value object.
 * Used when your Node.js server receives a custom POST from a platform webhook
 * or from a direct dataLayer push.
 *
 * @param {object} flat   — { event_name, event_id, value, currency, em, ph, ... }
 * @param {object} headers
 * @returns {ETPayload}
 */
function buildPayloadFromFlat(flat = {}, headers = {}) {
  const rawIp = headers['x-forwarded-for'] || headers['x-real-ip'] || '';
  const clientIp = rawIp ? String(rawIp).split(',')[0].trim() : '';

  let fbc = flat.fbc || flat._fbc || '';
  if (!fbc && flat.fbclid) {
    fbc = `fb.1.${Math.floor(Date.now() / 1000)}.${flat.fbclid}`;
  }

  return {
    eventName:    flat.event_name || '',
    eventId:      String(flat.event_id || flat.transaction_id || `et_${Date.now()}`),
    eventTime:    flat.event_time ? Number(flat.event_time) : Math.floor(Date.now() / 1000),
    actionSource: 'website',
    sourceUrl:    flat.page_url || flat.source_url || '',
    pageReferrer: flat.page_referrer || '',

    value:       parseFloat(flat.value) || 0,
    currency:    flat.currency || 'SAR',
    orderId:     flat.transaction_id || flat.order_id || '',
    contentIds:  flat.content_ids || '',
    contentName: flat.content_name || '',
    contentType: flat.content_type || 'product',
    numItems:    parseInt(flat.num_items || flat.quantity) || 1,
    items:       flat.items || [],
    searchString:flat.search_string || '',

    fbclid: flat.fbclid || '',
    gclid:  flat.gclid  || '',
    wbraid: flat.wbraid || '',
    gbraid: flat.gbraid || '',
    ttclid: flat.ttclid || '',
    ScCid:  flat.ScCid  || '',

    userData: {
      em:          flat.em    || flat.email || '',
      ph:          flat.ph    || flat.phone || '',
      fn:          flat.fn    || flat.first_name || '',
      ln:          flat.ln    || flat.last_name  || '',
      ct:          flat.ct    || flat.city        || '',
      st:          flat.st    || flat.state       || '',
      zp:          flat.zp    || flat.zip         || '',
      country:     flat.country || '',
      external_id: flat.external_id || '',
      fbp:         flat.fbp || flat._fbp || '',
      fbc,
      ttp:         flat.ttp || flat._ttp || '',
      scid:        flat.scid || flat._scid || '',
      client_ip_address: clientIp,
      client_user_agent: headers['user-agent'] || '',
    },

    utmSource:   flat.utm_source   || '',
    utmMedium:   flat.utm_medium   || '',
    utmCampaign: flat.utm_campaign || '',

    debugMode: flat.debug_mode || false,

    metaEventName:   META_EVENT_MAP[flat.event_name]   || flat.event_name || '',
    tiktokEventName: TIKTOK_EVENT_MAP[flat.event_name] || flat.event_name || '',
    snapEventName:   SNAP_EVENT_MAP[flat.event_name]   || flat.event_name || '',
    gadsEventName:   GADS_EVENT_MAP[flat.event_name]   || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash all PII in a payload's userData field
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hashPayload — returns a copy of payload with userData SHA-256 hashed.
 * Call this before passing to CAPI senders.
 */
function hashPayload(payload) {
  return {
    ...payload,
    userData: hashUserData(payload.userData),
  };
}

module.exports = {
  parseGA4Event,
  buildPayloadFromFlat,
  hashPayload,
  META_EVENT_MAP,
  TIKTOK_EVENT_MAP,
  SNAP_EVENT_MAP,
  GADS_EVENT_MAP,
  cleanEmpty,
};
