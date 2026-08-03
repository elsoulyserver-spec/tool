'use strict';

const { finalizeContainer } = require('./gtm-entity-registry');

// Phase 2 — Schema versioning.
// Bump SCHEMA_VERSION when the items_json canonical field set changes.
// Bump GENERATOR_VERSION on any release that changes generated container behaviour.
// Both are embedded in every generated container export and in every ET:EventLog entry.
const SCHEMA_VERSION    = 1;
const GENERATOR_VERSION = '5.1';

// ─────────────────────────────────────────────────────────────────────────────
// Native HTTP Request body builders — Server GTM (type: 'http')
//
// All CAPI tags use the native Server GTM HTTP Request tag (type 'http') so
// the container imports into any workspace without community templates.
// Variables are resolved at tag-fire time via GTM template substitution.
//
// ⚠ JSON SAFETY CONTRACT — read before editing any body below.
//
// The native HTTP Request tag substitutes {{Variable}} into this string VERBATIM.
// It performs no JSON escaping, and server GTM has no Custom JavaScript variable
// type in which we could escape (see "jsm is NOT supported in sGTM"). So every
// value placed inside a JSON string literal here MUST already be JSON-escaped by
// the web container, and every value placed in an unquoted numeric slot MUST
// already be coerced to a number there.
//
//   quoted slot   "x":"{{...}}"  → source must be an ET - JS esc * variable
//                                  (or a SHA-256 hex digest / a container constant)
//   unquoted slot "x":{{...}}    → source must be an ET - JS num * variable
//                                  (or ET - JS timestamp / ET - JS items_json)
//
// Interpolating a raw ep.*/up.*/header value into a quoted slot re-opens the
// JSON-injection hole: a product name containing `"` breaks the request, and a
// crafted value can inject sibling keys. tests/capi-json-safety.test.js enforces
// this contract statically and by rendering every generated body.
//
// items_json arrives as a pre-stringified JSON array (from ET - JS items_json
// in the web container). It is embedded unquoted so it becomes a JSON array
// rather than a JSON string — e.g. "contents":[] or "contents":[{...}].
// ─────────────────────────────────────────────────────────────────────────────

function _metaBody(eventName) {
  return (
    '{"data":[{'
    + '"event_name":"' + eventName + '",'
    + '"event_time":{{ET - ep event_time}},'
    + '"event_id":"{{ET - ep event_id}}",'
    + '"action_source":"website",'
    + '"event_source_url":"{{ET - ep page_url}}",'
    + '"user_data":{'
    +   '"em":["{{ET - up em}}"],'
    +   '"ph":["{{ET - up ph}}"],'
    +   '"fn":["{{ET - up fn}}"],'
    +   '"ln":["{{ET - up ln}}"],'
    +   '"external_id":["{{ET - up external_id}}"],'
    +   '"client_ip_address":"{{ET - client_ip_safe}}",'
    +   '"client_user_agent":"{{ET - ep user_agent}}",'
    +   '"fbp":"{{ET - up fbp}}",'
    +   '"fbc":"{{ET - up fbc}}"'
    + '},'
    + '"custom_data":{'
    +   '"value":{{ET - epn value}},'
    +   '"currency":"{{ET - ep currency}}",'
    +   '"num_items":{{ET - ep num_items}},'
    +   '"order_id":"{{ET - ep transaction_id}}",'
    +   '"content_name":"{{ET - ep content_name}}",'
    +   '"content_type":"{{ET - ep content_type}}",'
    +   '"contents":{{ET - ep items_json}}'
    + '}'
    + '}]}'
  );
}

function _tiktokBody(eventName) {
  // TikTok Events API v1.3
  return (
    '{"pixel_code":"{{ET - TikTok Pixel ID}}",'
    + '"event":"' + eventName + '",'
    + '"timestamp":"{{ET - ep event_time}}",'
    + '"event_id":"{{ET - ep event_id}}",'
    + '"properties":{'
    +   '"value":{{ET - epn value}},'
    +   '"currency":"{{ET - ep currency}}",'
    +   '"order_id":"{{ET - ep transaction_id}}",'
    +   '"contents":{{ET - ep items_json}}'
    + '},'
    + '"context":{'
    +   '"user":{'
    +     '"email":"{{ET - up em}}",'
    +     '"phone_number":"{{ET - up ph}}",'
    +     '"external_id":"{{ET - up external_id}}"'
    +   '},'
    +   '"ip":"{{ET - client_ip_safe}}",'
    +   '"user_agent":"{{ET - ep user_agent}}",'
    +   '"ad":{"callback":"{{ET - ep ttclid}}"},'
    +   '"page":{"url":"{{ET - ep page_url}}","referrer":"{{ET - ep page_referrer}}"}'
    + '}'
    + '}'
  );
}

function _snapBody(eventName) {
  // Snapchat Conversions API v3
  return (
    '{"data":[{'
    + '"event_name":"' + eventName + '",'
    + '"event_time":{{ET - ep event_time}},'
    + '"event_conversion_type":"WEB",'
    + '"event_source_url":"{{ET - ep page_url}}",'
    + '"user_data":{'
    +   '"em":["{{ET - up em}}"],'
    +   '"ph":["{{ET - up ph}}"],'
    +   '"client_ip_address":"{{ET - client_ip_safe}}",'
    +   '"client_user_agent":"{{ET - ep user_agent}}",'
    +   '"sc_click_id":"{{ET - ep ScCid}}",'
    +   '"sc_cookie1":"{{ET - up scid}}"'
    + '},'
    + '"custom_data":{'
    +   '"currency":"{{ET - ep currency}}",'
    +   '"price":{{ET - epn value}},'
    +   '"transaction_id":"{{ET - ep transaction_id}}"'
    + '}'
    + '}]}'
  );
}

function _beaconBody() {
  return (
    '{"clientId":"{{ET - EasyTrac Client ID}}",'
    + '"apiKey":"{{ET - Beacon API Key}}",'
    + '"eventName":"{{ET - event_name}}",'
    + '"eventTime":{{ET - ep event_time}},'
    + '"eventId":"{{ET - ep event_id}}",'
    + '"pageUrl":"{{ET - ep page_url}}"'
    + '}'
  );
}

// Safe JSON body builder for tags whose request body is fully computed at
// container-generation time in Node (no runtime {{variable}} substitution
// inside the string). JSON.stringify guarantees valid JSON for every
// combination of present, absent (omit the key with undefined), or explicit
// null optional fields — unlike a hand-written template string, where an
// unquoted numeric slot produces invalid JSON if the value is ever empty.
// Do not use this for bodies that embed GTM {{variable}} placeholders — a
// runtime-resolved value can't be safely embedded unquoted by construction;
// that class of body needs the receiving endpoint to parse a quoted string.
function _safeJsonBody(fields) {
  return JSON.stringify(fields);
}

// Shared header list builder for JSON POST tags
function _jsonHeaders(extraHeaders) {
  const base = [{ type: 'MAP', map: [
    { type: 'TEMPLATE', key: 'name',  value: 'Content-Type' },
    { type: 'TEMPLATE', key: 'value', value: 'application/json' },
  ]}];
  return base.concat(extraHeaders || []);
}

function _authHeader(value) {
  return { type: 'MAP', map: [
    { type: 'TEMPLATE', key: 'name',  value: 'Authorization' },
    { type: 'TEMPLATE', key: 'value', value: value },
  ]};
}

/**
 * gtm-config-builder.js  v4.0  — EasyTrac Full Server-Side Architecture
 *
 * Architecture:  Web GTM  →  GA4 (transport_url)  →  Server GTM (GA4 Client)  →  Platform APIs
 *
 * WEB CONTAINER
 *   Variables  : Constants (GA4 ID, sGTM URL, pixel IDs)
 *                DataLayer (ecomm data incl. coupon/affiliation/tax/shipping, user_data.*)
 *                URL Params (fbclid, gclid, wbraid, gbraid, ttclid, ScCid, msclkid, li_fat_id + UTMs)
 *                Cookies (_fbp, _fbc, _ga, _gid, _ttp, _scid, _uetmsclkid)
 *                Custom JS (FBC builder, page meta, device signals, session/anonymous ID, consent state)
 *   Triggers   : All Pages + per-event custom triggers
 *   Tags       : GA4 Config (transport_url → sGTM, user_properties relay)
 *                GA4 Event tags (full ep.* payload: ecomm + click IDs + cookies + device + session + consent)
 *                Meta Pixel, TikTok Pixel, Snapchat Pixel, Google Ads (client-side)
 *
 * SERVER CONTAINER
 *   Variables  : ep.* event_parameters, epn.* numeric params, up.* user_properties
 *                HTTP headers (x-forwarded-for, user-agent)
 *                Request metadata, computed vars
 *   Client     : GA4 Client — receives /g/collect forwarded from web container
 *   Triggers   : All Events + per-GA4-event custom triggers
 *   Tags       : GA4 Forward → Google Analytics (native sgtmgaaw)
 *                Meta CAPI, TikTok Events API, Snapchat CAPI — native HTTP Request tags
 *
 * v4.0 additions vs v3.1:
 *   - Device signals: screen_resolution, viewport, language, timezone, device_type
 *   - Session management: anonymous_id (localStorage UUID), session_id (sessionStorage, 30-min TTL)
 *   - Consent state: ad_storage, analytics_storage, ad_user_data, ad_personalization
 *   - Missing click IDs: msclkid, li_fat_id
 *   - Missing cookies: _gid, _uetmsclkid
 *   - Ecommerce completeness: coupon, affiliation, tax, shipping, revenue
 *   - contact event added to all platform maps
 *   - customEvents[] support in both builders
 *   - All new fields forwarded as ep.* to sGTM; matching server variables declared
 */

// ─────────────────────────────────────────────────────────────────────────────
// ID counters — reset before each build so output is deterministic
// ─────────────────────────────────────────────────────────────────────────────

let _tid = 100;
let _vid = 100;
let _tagId = 100;

function _reset() { _tid = 100; _vid = 100; _tagId = 100; }
function nTid()   { return String(++_tid); }
function nTagId() { return String(++_tagId); }
function nVid()   { return String(++_vid); }

// ─────────────────────────────────────────────────────────────────────────────
// Variable helpers — Web container
// ─────────────────────────────────────────────────────────────────────────────

function cVar(name, value) {
  return {
    name, type: 'c', variableId: nVid(),
    parameter: [{ type: 'TEMPLATE', key: 'value', value }],
  };
}

function dlVar(name, dlKey, defaultVal) {
  const p = [
    { type: 'INTEGER',  key: 'dataLayerVersion', value: '2' },
    { type: 'BOOLEAN',  key: 'setDefaultValue',  value: defaultVal !== undefined ? 'true' : 'false' },
    { type: 'TEMPLATE', key: 'name',              value: dlKey },
  ];
  if (defaultVal !== undefined)
    p.push({ type: 'TEMPLATE', key: 'defaultValue', value: String(defaultVal) });
  return { name, type: 'v', variableId: nVid(), parameter: p };
}

function urlVar(name, queryKey) {
  return {
    name, type: 'u', variableId: nVid(),
    parameter: [
      { type: 'TEMPLATE', key: 'component', value: 'QUERY' },
      { type: 'TEMPLATE', key: 'queryKey',  value: queryKey },
    ],
  };
}

function cookieVar(name, cookieName) {
  return {
    name, type: 'k', variableId: nVid(),
    parameter: [
      { type: 'TEMPLATE', key: 'name',   value: cookieName },
      { type: 'BOOLEAN',  key: 'decode', value: 'false' },
    ],
  };
}

function jsVar(name, fn) {
  return {
    name, type: 'jsm', variableId: nVid(),
    parameter: [{ type: 'TEMPLATE', key: 'javascript', value: fn }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable helpers — Server container (sGTM)
// ─────────────────────────────────────────────────────────────────────────────

function smmVar(name, varType, extra) {
  const p = [{ type: 'TEMPLATE', key: 'varType', value: varType }];
  if (extra) {
    Object.entries(extra).forEach(([k, v]) =>
      p.push({ type: 'TEMPLATE', key: k, value: v })
    );
  }
  return { name, type: 'smm', variableId: nVid(), parameter: p };
}

function epVar(name, paramName) {
  return smmVar(name, 'event_parameter', { varName: paramName });
}

function upVar(name, propName) {
  return smmVar(name, 'user_property', { varName: propName });
}

function headerVar(name, headerName) {
  return smmVar(name, 'header', { headerName });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger helpers
// ─────────────────────────────────────────────────────────────────────────────

function webEventTrigger(name, eventName, tid) {
  return {
    name, type: 'CUSTOM_EVENT', triggerId: tid,
    customEventFilter: [{ type: 'EQUALS', parameter: [
      { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
      { type: 'TEMPLATE', key: 'arg1', value: eventName },
    ]}],
  };
}

function sgtmEventTrigger(name, eventName, tid) {
  return {
    name, type: 'CUSTOM_EVENT', triggerId: tid,
    customEventFilter: [{ type: 'EQUALS', parameter: [
      { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
      { type: 'TEMPLATE', key: 'arg1', value: eventName },
    ]}],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical event maps
// ─────────────────────────────────────────────────────────────────────────────

const GA4_EVENT = {
  page_view:         'page_view',
  view_content:      'view_item',
  add_to_cart:       'add_to_cart',
  initiate_checkout: 'begin_checkout',
  purchase:          'purchase',
  lead:              'generate_lead',
  sign_up:           'sign_up',
  search:            'search',
  contact:           'contact',
};

const META_EVENT = {
  page_view:         'PageView',
  view_content:      'ViewContent',
  add_to_cart:       'AddToCart',
  initiate_checkout: 'InitiateCheckout',
  purchase:          'Purchase',
  lead:              'Lead',
  sign_up:           'CompleteRegistration',
  search:            'Search',
  contact:           'Contact',
};

const TIKTOK_EVENT = {
  page_view:         'Pageview',
  view_content:      'ViewContent',
  add_to_cart:       'AddToCart',
  initiate_checkout: 'InitiateCheckout',
  purchase:          'PlaceAnOrder',
  lead:              'SubmitForm',
  sign_up:           'CompleteRegistration',
  search:            'Search',
  contact:           'Contact',
};

const SNAP_EVENT = {
  page_view:         'PAGE_VIEW',
  view_content:      'VIEW_CONTENT',
  add_to_cart:       'ADD_CART',
  initiate_checkout: 'START_CHECKOUT',
  purchase:          'PURCHASE',
  lead:              'SIGN_UP',
  sign_up:           'SIGN_UP',
  search:            'SEARCH',
  contact:           'CUSTOM_EVENT_1',
};

const GADS_EVENT = {
  purchase:          'purchase',
  lead:              'submit_lead_form',
  sign_up:           'sign_up',
  add_to_cart:       'add_to_cart',
  contact:           'contact',
};

const ALL_EVENTS = Object.keys(GA4_EVENT);

// ─────────────────────────────────────────────────────────────────────────────
// Custom JavaScript variable bodies
// ─────────────────────────────────────────────────────────────────────────────

// Single source of truth for dataLayer item extraction.
// Generates the backward-scan loop that finds items across all supported push
// shapes: GA4/Zid (ecommerce.items[]), EasyTrac generated (top-level items[]),
// and all Salla UA-era per-event paths (ecommerce.add.products[],
// ecommerce.purchase.products[], [0].products[], data[], [0]).
// Uses prefixed loop vars (_etdl/_eti/_etp) to avoid collisions in any context.
// outVar must be declared before the generated block is executed.
function _dlScanBlock(outVar) {
  const v = outVar;
  return [
    'var _etdl=window.dataLayer||[];',
    'for(var _eti=_etdl.length-1;_eti>=0;_eti--){',
    'var _etp=_etdl[_eti];',
    `if(_etp&&_etp.ecommerce&&_etp.ecommerce.items&&_etp.ecommerce.items.length){${v}=_etp.ecommerce.items;break;}`,
    `if(_etp&&_etp.items&&_etp.items.length){${v}=_etp.items;break;}`,
    `if(_etp&&_etp.ecommerce&&_etp.ecommerce.add&&_etp.ecommerce.add.products&&_etp.ecommerce.add.products.length){${v}=_etp.ecommerce.add.products;break;}`,
    `if(_etp&&_etp.ecommerce&&_etp.ecommerce.purchase&&_etp.ecommerce.purchase.products&&_etp.ecommerce.purchase.products.length){${v}=_etp.ecommerce.purchase.products;break;}`,
    `if(_etp&&_etp[0]&&_etp[0].products&&_etp[0].products.length){${v}=_etp[0].products;break;}`,
    `if(_etp&&_etp.data&&_etp.data.length&&_etp.data[0]&&(_etp.data[0].id||_etp.data[0].sku)){${v}=_etp.data;break;}`,
    `if(_etp&&_etp[0]&&typeof _etp[0]==='object'&&(_etp[0].id||_etp[0].sku)){${v}=[_etp[0]];break;}`,
    '}',
  ].join('');
}

// items_json — serialize the dataLayer items array to a JSON string for transport
// via ep.items_json through GA4 → sGTM. Custom JS variables return a string
// primitive so GTM's template coercion (toString) is a no-op. Applies canonical
// field renaming (item_id→id, item_name→name, etc.) so all sGTM templates speak
// one schema regardless of which platform's dataLayer format pushed the data.
//
// Size strategy (8KB Measurement Protocol limit):
//   1. Try full canonical array.
//   2. If > 4,500 bytes: strip optional fields (brand, category, variant, coupon).
//   3. If still > 4,500 bytes: truncate items and set items_truncated=1.
const ITEMS_JSON_JS = `function() {
  try {
    // Primary: DLV reads top-level 'items' key from the GTM data model.
    var raw = {{ET - DLV items}};

    // Fallback: scan dataLayer for items across GA4/Zid and all Salla native paths.
    if (!raw || !raw.length) { ${_dlScanBlock('raw')} }

    if (!raw || typeof raw !== 'object' || !raw.length) return '[]';
    var LIMIT = 16000;

    // Canonical field map — accepts GA4 ecommerce names and legacy names.
    function norm(it, full) {
      var o = {
        id:       String(it.item_id   || it.id   || ''),
        name:     String(it.item_name || it.name || ''),
        price:    parseFloat(it.price) || 0,
        quantity: parseInt(it.quantity, 10) || 1,
      };
      if (full) {
        if (it.item_brand    || it.brand)    o.brand    = String(it.item_brand    || it.brand);
        var cat = it.item_category || it.category;
        if (cat) o.category = (typeof cat === 'object') ? String(cat.name || cat.title || '') : String(cat);
        if (it.item_variant  || it.variant)  o.variant  = String(it.item_variant  || it.variant);
        if (it.coupon)                       o.coupon   = String(it.coupon);
        if (it.affiliation)                  o.affiliation = String(it.affiliation);
        if (it.discount)                     o.discount = parseFloat(it.discount) || 0;
      }
      return o;
    }

    // Pass 1: full canonical fields
    var full = [];
    for (var i = 0; i < raw.length; i++) full.push(norm(raw[i], true));
    var s = JSON.stringify(full);
    if (s.length <= LIMIT) return s;

    // Pass 2: strip optional fields
    var lean = [];
    for (var j = 0; j < raw.length; j++) lean.push(norm(raw[j], false));
    s = JSON.stringify(lean);
    if (s.length <= LIMIT) return s;

    // Pass 3: sort by revenue desc so highest-value items survive truncation.
    // Items pushed last (lowest-value in common patterns) are dropped first.
    lean.sort(function(a, b) {
      return (b.price * b.quantity) - (a.price * a.quantity);
    });
    var trimmed = [];
    for (var k = 0; k < lean.length; k++) {
      trimmed.push(lean[k]);
      if (JSON.stringify(trimmed).length > LIMIT) { trimmed.pop(); break; }
    }
    return JSON.stringify(trimmed);
  } catch(e) { return '[]'; }
}`;

// items_count — total item count for analytics, always the full raw count.
const ITEMS_COUNT_JS = `function() {
  try {
    var raw = {{ET - DLV items}};
    if (!raw || !raw.length) { ${_dlScanBlock('raw')} }
    return (raw && raw.length) ? parseInt(raw.length, 10) : 0;
  } catch(e) { return 0; }
}`;

// items_truncated — returns 1 if the canonical items array exceeded the transport
// limit and was truncated, 0 otherwise. Platforms can use this to flag partial carts.
const ITEMS_TRUNCATED_JS = `function() {
  try {
    var raw = {{ET - DLV items}};
    if (!raw || !raw.length) { ${_dlScanBlock('raw')} }
    if (!raw || !raw.length) return 0;
    var LIMIT = 16000;
    var lean = [];
    for (var j = 0; j < raw.length; j++) {
      lean.push({ id: String(raw[j].item_id||raw[j].id||''), name: String(raw[j].item_name||raw[j].name||''), price: parseFloat(raw[j].price)||0, quantity: parseInt(raw[j].quantity,10)||1 });
    }
    return JSON.stringify(lean).length > LIMIT ? 1 : 0;
  } catch(e) { return 0; }
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Browser-side primitives injected into Web-container Custom JavaScript variables.
//
// WHY THESE LIVE IN THE WEB CONTAINER:
// Server GTM has no Custom JavaScript variable type (see "jsm is NOT supported in
// sGTM" below), and the native HTTP Request tag substitutes variables into the
// request body VERBATIM — it performs no JSON escaping and no hashing. So both
// have to happen upstream, in the web container, before the value is handed to
// GA4 and forwarded to sGTM as an ep.*/up.* parameter.
// ─────────────────────────────────────────────────────────────────────────────

// JSON string-literal escaping. Returns a value safe to embed BETWEEN the quotes
// of a JSON string ("...HERE..."), so a quote, backslash, control character or
// newline can never terminate the literal or inject sibling keys. Unicode letters
// (Arabic, emoji) pass through unchanged — they are legal inside a JSON string.
const JSON_ESC_JS = `function(v) {
  if (v === null || v === undefined) return '';
  try {
    var s = JSON.stringify(String(v));
    s = s.slice(1, s.length - 1);
    // JSON.stringify leaves U+2028/U+2029 raw. They are legal JSON but break
    // some strict parsers, so escape them explicitly.
    return s.replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029');
  } catch (e) { return ''; }
}`;

// Synchronous SHA-256 (hex). GTM Custom JavaScript variables must return a value
// synchronously, so the async Web Crypto API (crypto.subtle.digest) cannot be
// used — this is a self-contained implementation. UTF-8 encoding is done
// explicitly (including surrogate pairs) so Arabic names and emoji hash to the
// same digest a server-side SHA-256 would produce.
const SHA256_JS = `function(msg) {
  function R(n, x) { return (x >>> n) | (x << (32 - n)); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
           0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
           0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
           0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
           0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
           0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
           0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
           0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var b = [], i, c;
  for (i = 0; i < msg.length; i++) {
    c = msg.charCodeAt(i);
    if (c < 0x80) { b.push(c); }
    else if (c < 0x800) { b.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else if (c < 0xd800 || c >= 0xe000) { b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (msg.charCodeAt(i) & 0x3ff));
           b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  var bitLen = b.length * 8;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  b.push(0, 0, 0, 0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);
  var w = new Array(64), a, bb, cc, d, e, f, g, h, t1, t2, j, s0, s1, S0, S1, ch, mj;
  for (i = 0; i < b.length; i += 64) {
    for (j = 0; j < 16; j++) w[j] = (b[i+j*4] << 24) | (b[i+j*4+1] << 16) | (b[i+j*4+2] << 8) | b[i+j*4+3];
    for (j = 16; j < 64; j++) {
      s0 = R(7, w[j-15]) ^ R(18, w[j-15]) ^ (w[j-15] >>> 3);
      s1 = R(17, w[j-2]) ^ R(19, w[j-2]) ^ (w[j-2] >>> 10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
    }
    a = H[0]; bb = H[1]; cc = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h = H[7];
    for (j = 0; j < 64; j++) {
      S1 = R(6, e) ^ R(11, e) ^ R(25, e);
      ch = (e & f) ^ ((~e) & g);
      t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      S0 = R(2, a) ^ R(13, a) ^ R(22, a);
      mj = (a & bb) ^ (a & cc) ^ (bb & cc);
      t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]+a)|0; H[1] = (H[1]+bb)|0; H[2] = (H[2]+cc)|0; H[3] = (H[3]+d)|0;
    H[4] = (H[4]+e)|0;  H[5] = (H[5]+f)|0;  H[6] = (H[6]+g)|0;  H[7] = (H[7]+h)|0;
  }
  var out = '';
  for (i = 0; i < 8; i++) out += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
  return out;
}`;

const FBC_BUILDER_JS = `function() {
  var cookieFbc = {{ET - Cookie _fbc}};
  if (cookieFbc && cookieFbc !== '') return cookieFbc;
  var fbclid = {{ET - URL fbclid}};
  if (!fbclid || fbclid === '') return '';
  var ts = Math.floor(Date.now() / 1000);
  return 'fb.1.' + ts + '.' + fbclid;
}`;

// anonymous_id: UUID v4 stored in localStorage, gated on consent.
// Falls back to sessionStorage when localStorage is blocked or consent is absent.
// The isHex64-style consent check reads the GTM consent state that was already
// written to dataLayer before this var fires.
const ANONYMOUS_ID_JS = `function() {
  try {
    // Read consent state from google_tag_data (set by Consent Mode v2 banner).
    var adStorage = 'granted';
    try {
      var g = window.google_tag_data;
      if (g && g.ics && g.ics.entries && g.ics.entries.ad_storage) {
        adStorage = g.ics.entries.ad_storage.value || 'granted';
      }
    } catch(ce) {}

    var KEY = '_et_anon_id';
    var existing = localStorage.getItem(KEY);
    if (existing) return existing;

    // Only write a persistent ID when consented.
    var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var v = Math.random() * 16 | 0;
      return (c === 'x' ? v : (v & 0x3 | 0x8)).toString(16);
    });

    if (adStorage !== 'denied') {
      try { localStorage.setItem(KEY, uuid); } catch(le) {}
    }
    // Fallback: session-scoped UUID (cleared when tab closes)
    try {
      var sKey = '_et_anon_s';
      var sId = sessionStorage.getItem(sKey);
      if (sId) return sId;
      sessionStorage.setItem(sKey, uuid);
    } catch(se) {}
    return uuid;
  } catch(e) { return ''; }
}`;

// session_id: timestamp_random stored in localStorage with 30-min inactivity TTL.
// localStorage is shared across tabs so cross-tab attribution works correctly.
// sessionStorage would isolate per-tab and break checkout flows that open new tabs.
const SESSION_ID_JS = `function() {
  try {
    var KEY = '_et_session_id';
    var TS_KEY = '_et_session_ts';
    var TTL = 30 * 60 * 1000;
    var now = Date.now();
    var id = localStorage.getItem(KEY);
    var ts = parseInt(localStorage.getItem(TS_KEY) || '0', 10);
    if (!id || (now - ts) > TTL) {
      id = String(now) + '_' + Math.random().toString(36).slice(2, 6);
      localStorage.setItem(KEY, id);
    }
    localStorage.setItem(TS_KEY, String(now));
    return id;
  } catch(e) {
    // Fallback for localStorage-blocked environments (private browsing in some browsers).
    try {
      var sKey = '_et_sess_s';
      var sId = sessionStorage.getItem(sKey);
      if (sId) return sId;
      var fb = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem(sKey, fb);
      return fb;
    } catch(se) { return ''; }
  }
}`;

// Consent state — reads Consent Mode v2 granted/denied signal.
// Returns 'granted' or 'denied'. Default: 'granted' when no banner is present.
const CONSENT_AD_STORAGE_JS = `function() {
  try {
    var g = window.google_tag_data;
    if (g && g.ics && g.ics.entries && g.ics.entries.ad_storage) {
      return g.ics.entries.ad_storage.value || 'denied';
    }
  } catch(e) {}
  return 'granted';
}`;

const CONSENT_ANALYTICS_JS = `function() {
  try {
    var g = window.google_tag_data;
    if (g && g.ics && g.ics.entries && g.ics.entries.analytics_storage) {
      return g.ics.entries.analytics_storage.value || 'denied';
    }
  } catch(e) {}
  return 'granted';
}`;

const CONSENT_AD_USER_DATA_JS = `function() {
  try {
    var g = window.google_tag_data;
    if (g && g.ics && g.ics.entries && g.ics.entries.ad_user_data) {
      return g.ics.entries.ad_user_data.value || 'denied';
    }
  } catch(e) {}
  return 'granted';
}`;

const CONSENT_AD_PERSONALIZATION_JS = `function() {
  try {
    var g = window.google_tag_data;
    if (g && g.ics && g.ics.entries && g.ics.entries.ad_personalization) {
      return g.ics.entries.ad_personalization.value || 'denied';
    }
  } catch(e) {}
  return 'granted';
}`;

// Device signals
const DEVICE_TYPE_JS = `function() {
  var ua = navigator.userAgent || '';
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|opera mini|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}`;

const SCREEN_RES_JS = `function() {
  try { return screen.width + 'x' + screen.height; } catch(e) { return ''; }
}`;

const VIEWPORT_JS = `function() {
  try {
    return (window.innerWidth || document.documentElement.clientWidth) + 'x' +
           (window.innerHeight || document.documentElement.clientHeight);
  } catch(e) { return ''; }
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper builders — shared
// ─────────────────────────────────────────────────────────────────────────────

function _ep(name, value) {
  return { type: 'MAP', map: [
    { type: 'TEMPLATE', key: 'name',  value: name  },
    { type: 'TEMPLATE', key: 'value', value: value },
  ]};
}

function _upProp(name, value) {
  return { type: 'MAP', map: [
    { type: 'TEMPLATE', key: 'name',  value: name  },
    { type: 'TEMPLATE', key: 'value', value: value },
  ]};
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB CONTAINER BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildWebConfig — generates a complete Web GTM container export JSON.
 *
 * @param {object}   opts
 * @param {string}   opts.ga4MeasurementId   — e.g. "G-XXXXXXXXXX"
 * @param {string}   opts.sgtmUrl            — e.g. "https://gtm.yourdomain.com"
 * @param {object}   opts.pixelIds           — { meta, gads, gads_label, snap, tiktok }
 * @param {string[]} opts.events             — selected event keys from GA4_EVENT
 * @param {string[]} opts.customEvents       — arbitrary custom event names (GA4 event name strings)
 * @param {string}   opts.ecommPlatform      — 'salla' | 'zid' | ''
 */
function buildWebConfig({
  ga4MeasurementId, sgtmUrl, pixelIds = {},
  events = [], customEvents = [], ecommPlatform = '',
} = {}) {
  _reset();

  const ga4Id      = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';
  const sgtm       = (sgtmUrl || '').trim();
  const px         = pixelIds  || {};
  const evList     = Array.isArray(events)       ? events       : [];
  const custEvList = Array.isArray(customEvents) ? customEvents : [];

  // ── VARIABLES ─────────────────────────────────────────────────────────────

  const variables = [];

  // ── Constants ─────────────────────────────────────────────────────────────
  variables.push(cVar('ET - GA4 Measurement ID', ga4Id));
  if (sgtm)          variables.push(cVar('ET - sGTM URL',           sgtm));
  if (px.meta)       variables.push(cVar('ET - Meta Pixel ID',       px.meta));
  if (px.gads)       variables.push(cVar('ET - Google Ads ID',       px.gads));
  if (px.gads_label) variables.push(cVar('ET - Google Ads Label',    px.gads_label));
  if (px.snap)       variables.push(cVar('ET - Snapchat Pixel ID',   px.snap));
  if (px.tiktok)     variables.push(cVar('ET - TikTok Pixel ID',     px.tiktok));

  // ── DataLayer — ecommerce ──────────────────────────────────────────────────
  variables.push(dlVar('ET - DLV event_id',        'event_id',           ''));
  variables.push(dlVar('ET - DLV value',            'value',              '0'));
  variables.push(dlVar('ET - DLV currency',         'currency',           'SAR'));
  variables.push(dlVar('ET - DLV transaction_id',   'transaction_id',     ''));
  variables.push(dlVar('ET - DLV revenue',          'revenue',            '0'));
  variables.push(dlVar('ET - DLV tax',              'tax',                '0'));
  variables.push(dlVar('ET - DLV shipping',         'shipping',           '0'));
  variables.push(dlVar('ET - DLV coupon',           'coupon',             ''));
  variables.push(dlVar('ET - DLV affiliation',      'affiliation',        ''));
  variables.push(dlVar('ET - DLV content_ids',      'content_ids',        ''));
  variables.push(dlVar('ET - DLV content_name',     'content_name',       ''));
  variables.push(dlVar('ET - DLV content_type',     'content_type',       'product'));
  variables.push(dlVar('ET - DLV items',            'items',              ''));
  variables.push(dlVar('ET - DLV quantity',         'quantity',           '1'));
  variables.push(dlVar('ET - DLV num_items',        'num_items',          '1'));
  variables.push(dlVar('ET - DLV search_string',    'search_string',      ''));

  // ── DataLayer — user data ──────────────────────────────────────────────────
  variables.push(dlVar('ET - DLV user_email',       'user_data.em',       ''));
  variables.push(dlVar('ET - DLV user_phone',       'user_data.ph',       ''));
  variables.push(dlVar('ET - DLV user_first_name',  'user_data.fn',       ''));
  variables.push(dlVar('ET - DLV user_last_name',   'user_data.ln',       ''));
  variables.push(dlVar('ET - DLV user_city',        'user_data.ct',       ''));
  variables.push(dlVar('ET - DLV user_state',       'user_data.st',       ''));
  variables.push(dlVar('ET - DLV user_zip',         'user_data.zp',       ''));
  variables.push(dlVar('ET - DLV user_country',     'user_data.country',  ''));
  variables.push(dlVar('ET - DLV external_id',      'external_id',        ''));

  // ── URL variables — UTM parameters ────────────────────────────────────────
  variables.push(urlVar('ET - URL utm_source',   'utm_source'));
  variables.push(urlVar('ET - URL utm_medium',   'utm_medium'));
  variables.push(urlVar('ET - URL utm_campaign', 'utm_campaign'));
  variables.push(urlVar('ET - URL utm_content',  'utm_content'));
  variables.push(urlVar('ET - URL utm_term',     'utm_term'));

  // ── URL variables — Click IDs ─────────────────────────────────────────────
  variables.push(urlVar('ET - URL fbclid',     'fbclid'));    // Meta
  variables.push(urlVar('ET - URL gclid',      'gclid'));     // Google Ads
  variables.push(urlVar('ET - URL wbraid',     'wbraid'));    // Google Ads (iOS app)
  variables.push(urlVar('ET - URL gbraid',     'gbraid'));    // Google Ads (cross-channel)
  variables.push(urlVar('ET - URL ttclid',     'ttclid'));    // TikTok
  variables.push(urlVar('ET - URL ScCid',      'ScCid'));     // Snapchat
  variables.push(urlVar('ET - URL msclkid',    'msclkid'));   // Microsoft Ads
  variables.push(urlVar('ET - URL li_fat_id',  'li_fat_id')); // LinkedIn

  // ── Cookie variables ───────────────────────────────────────────────────────
  variables.push(cookieVar('ET - Cookie _fbp',        '_fbp'));        // Meta browser ID
  variables.push(cookieVar('ET - Cookie _fbc',        '_fbc'));        // Meta click ID cookie
  variables.push(cookieVar('ET - Cookie _ttp',        '_ttp'));        // TikTok browser ID
  variables.push(cookieVar('ET - Cookie _scid',       '_scid'));       // Snapchat browser ID
  variables.push(cookieVar('ET - Cookie _ga',         '_ga'));         // GA client ID
  variables.push(cookieVar('ET - Cookie _gid',        '_gid'));        // GA session (24h)
  variables.push(cookieVar('ET - Cookie _uetmsclkid', '_uetmsclkid')); // Microsoft Ads click ID

  // ── Custom JS — page metadata ──────────────────────────────────────────────
  variables.push(jsVar('ET - JS timestamp',
    'function(){return Math.floor(Date.now()/1000);}'));
  variables.push(jsVar('ET - JS page_url',
    'function(){return window.location.href;}'));
  variables.push(jsVar('ET - JS page_referrer',
    'function(){return document.referrer;}'));
  variables.push(jsVar('ET - JS page_title',
    'function(){return document.title;}'));
  variables.push(jsVar('ET - JS GA client_id',
    "function(){try{return {{ET - Cookie _ga}}.split('.').slice(-2).join('.');}catch(e){return '';}}"));
  variables.push(jsVar('ET - JS language',
    "function(){return navigator.language||navigator.userLanguage||'';}"));
  variables.push(jsVar('ET - JS timezone',
    "function(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch(e){return '';}}"));

  // ── Custom JS — device signals ─────────────────────────────────────────────
  variables.push(jsVar('ET - JS device_type',        DEVICE_TYPE_JS));
  variables.push(jsVar('ET - JS screen_resolution',  SCREEN_RES_JS));
  variables.push(jsVar('ET - JS viewport',           VIEWPORT_JS));

  // ── Custom JS — session / identity management ──────────────────────────────
  variables.push(jsVar('ET - JS anonymous_id', ANONYMOUS_ID_JS));
  variables.push(jsVar('ET - JS session_id',   SESSION_ID_JS));

  // ── Custom JS — Consent Mode v2 state ─────────────────────────────────────
  variables.push(jsVar('ET - JS consent_ad_storage',         CONSENT_AD_STORAGE_JS));
  variables.push(jsVar('ET - JS consent_analytics_storage',  CONSENT_ANALYTICS_JS));
  variables.push(jsVar('ET - JS consent_ad_user_data',       CONSENT_AD_USER_DATA_JS));
  variables.push(jsVar('ET - JS consent_ad_personalization', CONSENT_AD_PERSONALIZATION_JS));

  // ── Custom JS — ecommerce items transport ─────────────────────────────────
  // items_json: canonical JSON string forwarded as ep.items_json through GA4→sGTM.
  // The Custom JS variable returns a string primitive, so GTM's TEMPLATE coercion
  // (toString) is a no-op — the full JSON survives the parameter encoding.
  variables.push(jsVar('ET - JS items_json',      ITEMS_JSON_JS));
  variables.push(jsVar('ET - JS items_count',     ITEMS_COUNT_JS));
  variables.push(jsVar('ET - JS items_truncated', ITEMS_TRUNCATED_JS));

  // ── Custom JS — FBC builder ────────────────────────────────────────────────
  variables.push(jsVar('ET - JS fbc_builder', FBC_BUILDER_JS));

  // ── Custom JS — deterministic event_id fallback ────────────────────────────
  // Uses platform-provided event_id when available. Falls back to a time-bucketed
  // ID (5-second window) so client-side pixel and sGTM CAPI generate the same ID
  // for the same event, preserving deduplication even without a store-provided ID.
  variables.push(jsVar('ET - JS event_id_resolved', `function() {
  var dlId = {{ET - DLV event_id}};
  if (dlId && dlId !== '') return String(dlId);
  // Bucket to nearest 5 seconds — wide enough for sGTM processing lag.
  var bucket = Math.floor(Date.now() / 5000) * 5;
  var anon = {{ET - JS anonymous_id}} || 'x';
  return 'et-' + bucket + '-' + anon.slice(-8);
}`));

  // ── Custom JS — value normalisation ───────────────────────────────────────
  // Canonical pre-hash normalisation. These stay PLAINTEXT and are consumed only
  // by ET - JS pii_hashed below; nothing downstream reads them directly.
  variables.push(jsVar('ET - JS email_normalised',
    'function(){var v={{ET - DLV user_email}};return v?String(v).toLowerCase().trim():"";}'));
  variables.push(jsVar('ET - JS phone_normalised',
    'function(){var v={{ET - DLV user_phone}};if(!v)return "";return String(v).replace(/[^0-9]/g,"");}'));
  variables.push(jsVar('ET - JS fn_normalised',
    'function(){var v={{ET - DLV user_first_name}};return v?String(v).toLowerCase().trim():"";}'));
  variables.push(jsVar('ET - JS ln_normalised',
    'function(){var v={{ET - DLV user_last_name}};return v?String(v).toLowerCase().trim():"";}'));

  // ── Salla — pre-hashed user data ──────────────────────────────────────────
  if (ecommPlatform === 'salla') {
    variables.push(dlVar('ET - DLV salla_em_hash', 'customer.email_hashed', ''));
    variables.push(dlVar('ET - DLV salla_ph_hash', 'customer.phone_hashed', ''));
    variables.push(dlVar('ET - DLV salla_fn',      'customer.first_name',   ''));
    variables.push(dlVar('ET - DLV salla_ln',      'customer.last_name',    ''));
    variables.push(dlVar('ET - DLV salla_ext_id',  'customer.id',           ''));
  }

  const isSalla = ecommPlatform === 'salla';

  // ── PII hashing ───────────────────────────────────────────────────────────
  // Every PII field that platforms require hashed (em, ph, fn, ln, ct, st, zp,
  // country) is SHA-256'd HERE, in the browser, before it is handed to GA4 —
  // sGTM cannot hash without a community template, and the native HTTP Request
  // tag forwards whatever it is given. A value that is already a 64-char hex
  // digest (Salla's customer.email_hashed, or any merchant that pre-hashes) is
  // passed through lowercased and NEVER double-hashed.
  //
  // Computed as one object variable so the SHA-256 implementation is embedded
  // once per container instead of once per field. Nothing here is ever logged.
  const _sallaEm = isSalla ? '{{ET - DLV salla_em_hash}} || {{ET - JS email_normalised}}' : '{{ET - JS email_normalised}}';
  const _sallaPh = isSalla ? '{{ET - DLV salla_ph_hash}} || {{ET - JS phone_normalised}}' : '{{ET - JS phone_normalised}}';
  const _sallaFn = isSalla ? '{{ET - DLV salla_fn}} || {{ET - JS fn_normalised}}' : '{{ET - JS fn_normalised}}';
  const _sallaLn = isSalla ? '{{ET - DLV salla_ln}} || {{ET - JS ln_normalised}}' : '{{ET - JS ln_normalised}}';

  variables.push(jsVar('ET - JS pii_hashed', `function() {
  var sha256 = ${SHA256_JS};
  // norm: canonical form → already-hashed passthrough → SHA-256.
  // Fails safe: an unusable value yields '' rather than leaking or throwing.
  function h(raw, lower, digitsOnly) {
    try {
      if (raw === null || raw === undefined) return '';
      var s = String(raw).trim();
      if (s === '') return '';
      if (/^[a-fA-F0-9]{64}$/.test(s)) return s.toLowerCase();
      if (digitsOnly) s = s.replace(/[^0-9]/g, '');
      else if (lower) s = s.toLowerCase();
      if (s === '') return '';
      return sha256(s);
    } catch (e) { return ''; }
  }
  return {
    em:      h(${_sallaEm}, true,  false),
    ph:      h(${_sallaPh}, false, true),
    fn:      h(${_sallaFn}, true,  false),
    ln:      h(${_sallaLn}, true,  false),
    ct:      h({{ET - DLV user_city}},    true, false),
    st:      h({{ET - DLV user_state}},   true, false),
    zp:      h({{ET - DLV user_zip}},     true, false),
    country: h({{ET - DLV user_country}}, true, false)
  };
}`));

  // ── Resolved user data ─────────────────────────────────────────────────────
  // Thin accessors over ET - JS pii_hashed. Every one of these is a SHA-256 hex
  // digest or '' — plaintext PII never reaches a tag, a pixel or sGTM.
  [['em', 'em'], ['ph', 'ph'], ['fn', 'fn'], ['ln', 'ln']].forEach(([suffix, key]) => {
    variables.push(jsVar('ET - JS resolved_' + suffix,
      `function(){try{return {{ET - JS pii_hashed}}.${key}||'';}catch(e){return '';}}`));
  });
  [['ct', 'ct'], ['st', 'st'], ['zp', 'zp'], ['country', 'country']].forEach(([suffix, key]) => {
    variables.push(jsVar('ET - JS hashed_' + suffix,
      `function(){try{return {{ET - JS pii_hashed}}.${key}||'';}catch(e){return '';}}`));
  });

  // external_id is an opaque merchant customer reference, not PII in the sense
  // the platforms hash — it is escaped (see ET - JS esc external_id) but not hashed.
  variables.push(jsVar('ET - JS resolved_ext_id',
    isSalla
      ? 'function(){var v={{ET - DLV salla_ext_id}};return v||{{ET - DLV external_id}}||"";}'
      : 'function(){return {{ET - DLV external_id}}||"";}'));

  // ── JSON-safe transport values ────────────────────────────────────────────
  // Every field below is interpolated into a native HTTP Request JSON body in
  // the server container, which substitutes variables verbatim. Escaping here is
  // the only place it can happen. The RAW variables are deliberately left
  // untouched — browser pixel snippets render them as JS string literals, not JSON.
  variables.push(jsVar('ET - JS json_escape', JSON_ESC_JS));
  const escVar = (name, sourceRef) =>
    variables.push(jsVar('ET - JS esc ' + name,
      `function(){try{return {{ET - JS json_escape}}(${sourceRef});}catch(e){return '';}}`));

  escVar('event_id',       '{{ET - JS event_id_resolved}}');
  escVar('page_url',       '{{ET - JS page_url}}');
  escVar('page_referrer',  '{{ET - JS page_referrer}}');
  escVar('transaction_id', '{{ET - DLV transaction_id}}');
  escVar('currency',       '{{ET - DLV currency}}');
  escVar('content_name',   '{{ET - DLV content_name}}');
  escVar('content_type',   '{{ET - DLV content_type}}');
  escVar('coupon',         '{{ET - DLV coupon}}');
  escVar('affiliation',    '{{ET - DLV affiliation}}');
  escVar('content_ids',    '{{ET - DLV content_ids}}');
  escVar('search_string',  '{{ET - DLV search_string}}');
  escVar('external_id',    '{{ET - JS resolved_ext_id}}');
  escVar('ttclid',         '{{ET - URL ttclid}}');
  escVar('ScCid',          '{{ET - URL ScCid}}');
  escVar('fbp',            '{{ET - Cookie _fbp}}');
  escVar('fbc',            '{{ET - JS fbc_builder}}');
  escVar('scid',           '{{ET - Cookie _scid}}');
  escVar('ttp',            '{{ET - Cookie _ttp}}');

  // user_agent is sourced here rather than from the sGTM `user-agent` request
  // header: the header is fully attacker-controlled and sGTM has no way to
  // escape it before it lands inside the CAPI JSON body.
  variables.push(jsVar('ET - JS esc user_agent',
    "function(){try{return {{ET - JS json_escape}}(navigator.userAgent||'');}catch(e){return '';}}"));

  // Unquoted numeric slots in the CAPI bodies. Coerced to a finite number here so
  // a hostile or missing dataLayer value can never emit `"value":,`.
  const numVar = (name, sourceRef, dflt) =>
    variables.push(jsVar('ET - JS num ' + name,
      `function(){var n=parseFloat(${sourceRef});return isFinite(n)?n:${dflt};}`));
  numVar('value',     '{{ET - DLV value}}',     '0');
  numVar('num_items', '{{ET - DLV num_items}}', '0');

  // ── TRIGGERS ──────────────────────────────────────────────────────────────

  const allPagesTid = nTid();
  const triggers = [
    { name: 'ET - All Pages', type: 'pageview', triggerId: allPagesTid },
  ];

  const trigMap = {};

  // Standard events
  ALL_EVENTS.forEach(key => {
    const tid = nTid();
    trigMap[key] = tid;
    triggers.push(webEventTrigger(
      'ET - Event ' + (GA4_EVENT[key] || key),
      GA4_EVENT[key] || key,
      tid,
    ));
  });

  // Custom events
  custEvList.forEach(evName => {
    const safe = String(evName).trim();
    if (!safe || trigMap[safe]) return;
    const tid = nTid();
    trigMap[safe] = tid;
    triggers.push(webEventTrigger('ET - Custom Event ' + safe, safe, tid));
  });

  // ── TAGS ──────────────────────────────────────────────────────────────────

  const tags = [];

  // ── GA4 Configuration Tag ─────────────────────────────────────────────────
  const ga4ConfigParams = [
    { type: 'TEMPLATE', key: 'measurementId', value: '{{ET - GA4 Measurement ID}}' },
    { type: 'BOOLEAN',  key: 'sendPageView',  value: 'false' },
    { type: 'TEMPLATE', key: 'userId',        value: '{{ET - DLV external_id}}' },
  ];

  if (sgtm) {
    ga4ConfigParams.push({ type: 'TEMPLATE', key: 'transportUrl', value: '{{ET - sGTM URL}}' });
  }

  // Relay user properties and identity signals to sGTM
  ga4ConfigParams.push({
    type: 'LIST', key: 'userProperties',
    list: [
      _upProp('em',           '{{ET - JS resolved_em}}'),
      _upProp('ph',           '{{ET - JS resolved_ph}}'),
      _upProp('fn',           '{{ET - JS resolved_fn}}'),
      _upProp('ln',           '{{ET - JS resolved_ln}}'),
      _upProp('external_id',  '{{ET - JS esc external_id}}'),
      _upProp('fbp',          '{{ET - JS esc fbp}}'),
      _upProp('fbc',          '{{ET - JS esc fbc}}'),
      _upProp('ttp',          '{{ET - JS esc ttp}}'),
      _upProp('scid',         '{{ET - JS esc scid}}'),
      _upProp('anonymous_id', '{{ET - JS anonymous_id}}'),
    ],
  });

  tags.push({
    name: 'ET - GA4 Configuration',
    type: 'gaawc',
    tagId: nTagId(),
    parameter: ga4ConfigParams,
    firingTriggerId: [allPagesTid],
    tagFiringOption: 'ONCE_PER_EVENT',
    notes: sgtm
      ? 'EasyTrac GA4 Configuration. transport_url routes hits through sGTM for server-side CAPI fan-out.'
      : 'EasyTrac GA4 Configuration. No sGTM URL configured — add transport_url to enable server-side routing.',
  });

  // ── GA4 Event Tags ────────────────────────────────────────────────────────
  // Builds the full canonical ep.* payload for every selected event.
  // sGTM reads every field via ep.* variables — schema is exhaustive by design.

  // The complete set of ep.* parameters forwarded on every event.
  // Fields are null-safe: empty string is the default when data is unavailable.
  function _buildEventParameters() {
    return [
      // ── Ecommerce ────────────────────────────────────────────────────────
      // JSON-safe transport: every ep.* value that is interpolated into a native
      // HTTP Request body downstream is escaped here (see ET - JS esc *), and every
      // value that lands in an UNQUOTED numeric slot is coerced here (ET - JS num *).
      _ep('event_id',        '{{ET - JS esc event_id}}'),
      _ep('value',           '{{ET - JS num value}}'),
      _ep('revenue',         '{{ET - DLV revenue}}'),
      _ep('currency',        '{{ET - JS esc currency}}'),
      _ep('transaction_id',  '{{ET - JS esc transaction_id}}'),
      _ep('tax',             '{{ET - DLV tax}}'),
      _ep('shipping',        '{{ET - DLV shipping}}'),
      _ep('coupon',          '{{ET - JS esc coupon}}'),
      _ep('affiliation',     '{{ET - JS esc affiliation}}'),
      // items_json transports the full items array as a canonical JSON string.
      // ep.items is intentionally omitted — GTM serializes arrays as [object Object].
      _ep('items_json',      '{{ET - JS items_json}}'),
      _ep('items_count',     '{{ET - JS items_count}}'),
      _ep('items_truncated', '{{ET - JS items_truncated}}'),
      _ep('content_ids',     '{{ET - JS esc content_ids}}'),
      _ep('content_name',    '{{ET - JS esc content_name}}'),
      _ep('content_type',    '{{ET - JS esc content_type}}'),
      _ep('quantity',        '{{ET - DLV quantity}}'),
      _ep('num_items',       '{{ET - JS num num_items}}'),
      _ep('search_string',   '{{ET - JS esc search_string}}'),
      // ── Click IDs ────────────────────────────────────────────────────────
      _ep('fbclid',          '{{ET - URL fbclid}}'),
      _ep('gclid',           '{{ET - URL gclid}}'),
      _ep('wbraid',          '{{ET - URL wbraid}}'),
      _ep('gbraid',          '{{ET - URL gbraid}}'),
      _ep('ttclid',          '{{ET - JS esc ttclid}}'),
      _ep('ScCid',           '{{ET - JS esc ScCid}}'),
      _ep('msclkid',         '{{ET - URL msclkid}}'),
      _ep('li_fat_id',       '{{ET - URL li_fat_id}}'),
      // ── Cookies ──────────────────────────────────────────────────────────
      _ep('_fbp',            '{{ET - JS esc fbp}}'),
      _ep('_fbc',            '{{ET - JS esc fbc}}'),
      _ep('_ttp',            '{{ET - JS esc ttp}}'),
      _ep('_scid',           '{{ET - JS esc scid}}'),
      _ep('_gid',            '{{ET - Cookie _gid}}'),
      _ep('_uetmsclkid',     '{{ET - Cookie _uetmsclkid}}'),
      // ── Attribution ──────────────────────────────────────────────────────
      _ep('utm_source',      '{{ET - URL utm_source}}'),
      _ep('utm_medium',      '{{ET - URL utm_medium}}'),
      _ep('utm_campaign',    '{{ET - URL utm_campaign}}'),
      _ep('utm_content',     '{{ET - URL utm_content}}'),
      _ep('utm_term',        '{{ET - URL utm_term}}'),
      // ── Page metadata ─────────────────────────────────────────────────────
      _ep('page_url',        '{{ET - JS esc page_url}}'),
      _ep('page_title',      '{{ET - JS page_title}}'),
      _ep('page_referrer',   '{{ET - JS esc page_referrer}}'),
      _ep('user_agent',      '{{ET - JS esc user_agent}}'),
      _ep('event_time',      '{{ET - JS timestamp}}'),
      _ep('language',        '{{ET - JS language}}'),
      _ep('timezone',        '{{ET - JS timezone}}'),
      // ── Device signals ────────────────────────────────────────────────────
      _ep('device_type',     '{{ET - JS device_type}}'),
      _ep('screen_resolution', '{{ET - JS screen_resolution}}'),
      _ep('viewport',        '{{ET - JS viewport}}'),
      // ── Session / identity ────────────────────────────────────────────────
      _ep('anonymous_id',    '{{ET - JS anonymous_id}}'),
      _ep('session_id',      '{{ET - JS session_id}}'),
      _ep('ga_client_id',    '{{ET - JS GA client_id}}'),
      // ── Consent state ─────────────────────────────────────────────────────
      _ep('ad_storage',          '{{ET - JS consent_ad_storage}}'),
      _ep('analytics_storage',   '{{ET - JS consent_analytics_storage}}'),
      _ep('ad_user_data',        '{{ET - JS consent_ad_user_data}}'),
      _ep('ad_personalization',  '{{ET - JS consent_ad_personalization}}'),
    ];
  }

  // Standard events
  evList.forEach(key => {
    const ga4Ev = GA4_EVENT[key];
    if (!ga4Ev) return;
    const tid = trigMap[key];
    if (!tid) return;

    const eventParams = [
      { type: 'TEMPLATE', key: 'eventName',            value: ga4Ev },
      // GTM rejects a GA4 Event tag with no measurement reference
      // ("measurementIdOverride must not be empty"). Bind it to the GA4 ID so the
      // tag is valid standalone, matching the web (frontend) builder.
      { type: 'TEMPLATE', key: 'measurementIdOverride', value: '{{ET - GA4 Measurement ID}}' },
      { type: 'LIST',     key: 'eventParameters',      list: _buildEventParameters() },
    ];

    if (['purchase', 'lead', 'sign_up', 'add_to_cart', 'initiate_checkout', 'contact'].includes(key)) {
      eventParams.push({
        type: 'LIST', key: 'userProperties',
        list: [
          _upProp('em',          '{{ET - JS resolved_em}}'),
          _upProp('ph',          '{{ET - JS resolved_ph}}'),
          _upProp('fn',          '{{ET - JS resolved_fn}}'),
          _upProp('ln',          '{{ET - JS resolved_ln}}'),
          _upProp('external_id', '{{ET - JS esc external_id}}'),
          _upProp('ct',          '{{ET - JS hashed_ct}}'),
          _upProp('st',          '{{ET - JS hashed_st}}'),
          _upProp('zp',          '{{ET - JS hashed_zp}}'),
          _upProp('country',     '{{ET - JS hashed_country}}'),
        ],
      });
    }

    tags.push({
      name: 'ET - GA4 Event - ' + ga4Ev,
      type: 'gaawe',
      tagId: nTagId(),
      parameter: eventParams,
      firingTriggerId: [tid],
      tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac — GA4 event relayed to sGTM with full canonical ep.* payload.',
    });
  });

  // Custom events — forward with identical canonical payload
  custEvList.forEach(evName => {
    const safe = String(evName).trim();
    if (!safe) return;
    const tid = trigMap[safe];
    if (!tid) return;

    tags.push({
      name: 'ET - GA4 Custom Event - ' + safe,
      type: 'gaawe',
      tagId: nTagId(),
      parameter: [
        { type: 'TEMPLATE', key: 'eventName',            value: safe },
        { type: 'TEMPLATE', key: 'measurementIdOverride', value: '{{ET - GA4 Measurement ID}}' },
        { type: 'LIST',     key: 'eventParameters',      list: _buildEventParameters() },
      ],
      firingTriggerId: [tid],
      tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac — Custom GA4 event forwarded to sGTM with canonical ep.* payload.',
    });
  });

  // ── Meta Pixel — client-side ──────────────────────────────────────────────
  if (px.meta) {
    const pid = px.meta;

    tags.push({
      name: 'ET - Meta Pixel Base',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'TEMPLATE', key: 'html', value:
`<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${pid}',{
  em: '{{ET - JS resolved_em}}',
  ph: '{{ET - JS resolved_ph}}',
  fn: '{{ET - JS resolved_fn}}',
  ln: '{{ET - JS resolved_ln}}',
  extern_id: '{{ET - JS resolved_ext_id}}'
});
fbq('track','PageView',{},{eventID:'{{ET - JS event_id_resolved}}'});
</script>`,
      }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac — Meta Pixel (client-side). eventID enables deduplication with CAPI.',
    });

    evList.forEach(key => {
      const mEv = META_EVENT[key];
      if (!mEv || key === 'page_view') return;
      const tid = trigMap[key];
      const isRevenue = key === 'purchase';
      // Read items from window.dataLayer directly — GTM template variable
      // substitution stringifies arrays as [object Object]. Reading from
      // window.dataLayer gives the actual array object in the browser context.
      tags.push({
        name: 'ET - Meta Pixel - ' + mEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'TEMPLATE', key: 'html', value:
`<script>
fbq('track','${mEv}',(function(){
  var d={value:parseFloat('{{ET - DLV value}}')||0,currency:'{{ET - DLV currency}}',content_type:'product'${isRevenue ? ",order_id:'{{ET - DLV transaction_id}}'" : ''}};
  var its=[];${_dlScanBlock('its')}
  if(its.length){
    d.contents=its.map(function(x){return{id:String(x.item_id||x.id||''),quantity:parseInt(x.quantity)||1,item_price:parseFloat(x.price)||0};});
    d.content_ids=d.contents.map(function(c){return c.id;});
    d.num_items=its.length;
  }else{
    d.content_ids=[].concat('{{ET - DLV content_ids}}');
    d.content_name='{{ET - DLV content_name}}';
    d.num_items=parseInt('{{ET - DLV num_items}}')||1;
  }
  return d;
})(),{eventID:'{{ET - JS event_id_resolved}}'});
</script>`,
        }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — Meta Pixel ${mEv}. contents[] built from dataLayer items. eventID matches CAPI.`,
      });
    });
  }

  // ── TikTok Pixel — client-side ────────────────────────────────────────────
  if (px.tiktok) {
    const tpid = px.tiktok;

    tags.push({
      name: 'ET - TikTok Pixel Base',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'TEMPLATE', key: 'html', value:
`<script>
!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];
ttq.methods=["page","track","identify","instances","debug","on","off","once",
"ready","alias","group","enableCookie","disableCookie"];
ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(
Array.prototype.slice.call(arguments,0)))}};
for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";
ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};
ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};
var o=document.createElement("script");o.type="text/javascript";o.async=!0;
o.src=i+"?sdkid="+e+"&lib="+t;
var a=document.getElementsByTagName("script")[0];
a.parentNode.insertBefore(o,a)};
ttq.load('${tpid}');
ttq.page();
ttq.identify({
  email: '{{ET - JS resolved_em}}',
  phone_number: '{{ET - JS resolved_ph}}',
  external_id: '{{ET - JS resolved_ext_id}}'
});
</script>`,
      }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'ONCE_PER_EVENT',
    });

    evList.forEach(key => {
      const ttEv = TIKTOK_EVENT[key];
      if (!ttEv || key === 'page_view') return;
      const tid = trigMap[key];
      tags.push({
        name: 'ET - TikTok Pixel - ' + ttEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'TEMPLATE', key: 'html', value:
`<script>
ttq.track('${ttEv}',(function(){
  var p={value:parseFloat('{{ET - DLV value}}')||0,currency:'{{ET - DLV currency}}',order_id:'{{ET - DLV transaction_id}}'};
  var its=[];${_dlScanBlock('its')}
  if(its.length){
    p.contents=its.map(function(x){return{content_id:String(x.item_id||x.id||''),content_name:String(x.item_name||x.name||''),quantity:parseInt(x.quantity)||1,price:parseFloat(x.price)||0};});
  }else{
    p.contents=[{content_id:'{{ET - DLV content_ids}}',content_name:'{{ET - DLV content_name}}',quantity:parseInt('{{ET - DLV quantity}}')||1,price:parseFloat('{{ET - DLV value}}')||0}];
  }
  return p;
})(),{event_id:'{{ET - JS event_id_resolved}}'});
</script>`,
        }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
      });
    });
  }

  // ── Snapchat Pixel — client-side ──────────────────────────────────────────
  if (px.snap) {
    const sid = px.snap;

    tags.push({
      name: 'ET - Snapchat Pixel Base',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'TEMPLATE', key: 'html', value:
`<script>
(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){
a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};
a.queue=[];var s='script',r=t.createElement(s);r.async=!0;
r.src=n;var u=t.getElementsByTagName(s)[0];
u.parentNode.insertBefore(r,u);})(window,document,'https://sc-static.net/scevent.min.js');
snaptr('init','${sid}',{
  'user_hashed_email': '{{ET - JS resolved_em}}',
  'user_hashed_phone_number': '{{ET - JS resolved_ph}}'
});
snaptr('track','PAGE_VIEW');
</script>`,
      }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'ONCE_PER_EVENT',
    });

    // SNAP_EVENT maps several EasyTrac event keys onto the same Snapchat
    // event type (e.g. 'lead' and 'sign_up' both -> 'SIGN_UP'). Selecting
    // both would otherwise produce two tags with an identical name, which
    // GTM's importer rejects — disambiguate with the source key on repeat.
    const _snapPixelNamesSeen = {};
    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv || key === 'page_view') return;
      const tid = trigMap[key];
      const snapTagName = _snapPixelNamesSeen[sEv]
        ? 'ET - Snapchat Pixel - ' + sEv + ' (' + key + ')'
        : 'ET - Snapchat Pixel - ' + sEv;
      _snapPixelNamesSeen[sEv] = true;
      tags.push({
        name: snapTagName,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'TEMPLATE', key: 'html', value:
`<script>
snaptr('track','${sEv}',(function(){
  var p={'price':parseFloat('{{ET - DLV value}}')||0,'currency':'{{ET - DLV currency}}','transaction_id':'{{ET - DLV transaction_id}}'};
  var its=[];${_dlScanBlock('its')}
  if(its.length){
    p.content_ids=its.map(function(x){return String(x.item_id||x.id||'');});
    p.number_items=its.length;
  }else{
    p.content_ids=[].concat('{{ET - DLV content_ids}}');
  }
  return p;
})());
</script>`,
        }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
      });
    });
  }

  // ── Google Ads — Global Site Tag + Conversion Tracking ────────────────────
  if (px.gads) {
    const convId    = px.gads;
    const convLabel = px.gads_label || '';

    tags.push({
      name: 'ET - Google Ads Global Site Tag',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'TEMPLATE', key: 'html', value:
`<script async src="https://www.googletagmanager.com/gtag/js?id=${convId}"></script>
<script>
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
gtag('js',new Date());
gtag('config','${convId}',{'allow_enhanced_conversions':true});
</script>`,
      }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'ONCE_PER_EVENT',
    });

    if (convLabel) {
      tags.push({
        name: 'ET - Google Ads Conversion - Purchase',
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'TEMPLATE', key: 'html', value:
`<script>
gtag('event','conversion',{
  'send_to': '${convId}/${convLabel}',
  'value': parseFloat('{{ET - DLV value}}') || 0,
  'currency': '{{ET - DLV currency}}',
  'transaction_id': '{{ET - DLV transaction_id}}'
});
</script>`,
        }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [trigMap['purchase']].filter(Boolean),
        tagFiringOption: 'ONCE_PER_EVENT',
      });
    }
  }

  const webExport = {
    exportFormatVersion: 2,
    containerVersion: { variable: variables, trigger: triggers, tag: tags },
    _meta: {
      createdBy:        'EasyTrac GTM Config Builder',
      generatorVersion: GENERATOR_VERSION,
      schemaVersion:    SCHEMA_VERSION,
      architecture:     'Web GTM → GA4 (transport_url) → Server GTM (GA4 Client) → Platform APIs',
      ecommPlatform, ga4Id, sgtm,
    },
  };
  const { validation } = finalizeContainer(webExport);
  webExport._meta.validation = validation;
  return webExport;
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER CONTAINER BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildServerConfig — generates a complete Server GTM container export JSON.
 *
 * @param {object}   opts
 * @param {string}   opts.ga4MeasurementId
 * @param {string}   opts.sgtmUrl
 * @param {string[]} opts.platforms          — ['meta','tiktok','snap','gads']
 * @param {string[]} opts.events             — event keys from GA4_EVENT
 * @param {string[]} opts.customEvents       — arbitrary GA4 event name strings
 * @param {object}   opts.pixelIds           — { meta, tiktok, snap, gads, gads_label }
 * @param {object}   opts.capiTokens         — { meta, tiktok, snap }
 * @param {string}   opts.beaconUrl
 * @param {string}   opts.beaconApiKey
 * @param {string}   opts.etClientId
 */
function buildServerConfig({
  ga4MeasurementId, sgtmUrl, platforms = [], events = [],
  customEvents = [], pixelIds = {}, capiTokens = {},
  beaconUrl = '', beaconApiKey = '', etClientId = '',
  eventObservabilityUrl = '', eventObservabilityApiKey = '',
  eventObservabilityRolloutEnabled = process.env.EVENT_OBSERVABILITY_SGTM_ROLLOUT_ENABLED === '1',
  eventDebugSamplingRolloutEnabled = process.env.EVENT_DEBUG_SAMPLING_SGTM_ROLLOUT_ENABLED === '1',
  eventDebugSamplingSyntheticTenant = false,
  eventDebugContainerVersion = 'unknown', eventDebugCms = 'unknown',
  eventDebugEnvironment = 'synthetic',
} = {}) {
  _reset();

  const ga4Id      = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';
  const px         = pixelIds   || {};
  const tok        = capiTokens || {};
  const evList     = Array.isArray(events)       ? events       : [];
  const custEvList = Array.isArray(customEvents) ? customEvents : [];
  const platList   = Array.isArray(platforms)    ? platforms    : [];

  const _beaconEnabled = !!(beaconUrl && beaconApiKey && etClientId);
  const _eventObservabilityEnabled = eventObservabilityRolloutEnabled === true &&
    !!(eventObservabilityUrl && eventObservabilityApiKey && etClientId) && evList.includes('purchase');
  const _eventDebugSamplingEnabled = eventDebugSamplingRolloutEnabled === true &&
    eventDebugSamplingSyntheticTenant === true &&
    !!(eventObservabilityUrl && eventObservabilityApiKey && etClientId) && evList.includes('purchase');

  // ── VARIABLES ─────────────────────────────────────────────────────────────

  const variables = [];

  // Constants
  variables.push(cVar('ET - GA4 Measurement ID', ga4Id));
  if (sgtmUrl) variables.push(cVar('ET - sGTM URL', sgtmUrl));

  if (px.meta)       variables.push(cVar('ET - Meta Pixel ID',       px.meta));
  if (px.tiktok)     variables.push(cVar('ET - TikTok Pixel ID',     px.tiktok));
  if (px.snap)       variables.push(cVar('ET - Snapchat Pixel ID',   px.snap));
  if (px.gads)       variables.push(cVar('ET - Google Ads ID',       px.gads));

  const _gadsLabelRaw  = (px.gads_label || '').trim();
  const _gadsLabelSafe = (_gadsLabelRaw && !/^https?:\/\/|:\/\//.test(_gadsLabelRaw)) ? _gadsLabelRaw : 'AbC-DefG1234';
  if (px.gads_label) variables.push(cVar('ET - Google Ads Label', _gadsLabelSafe));

  if (tok.meta)   variables.push(cVar('ET - Meta CAPI Token',      tok.meta));
  if (tok.tiktok) variables.push(cVar('ET - TikTok Events Token',   tok.tiktok));
  if (tok.snap)   variables.push(cVar('ET - Snapchat CAPI Token',   tok.snap));

  if (_beaconEnabled) {
    variables.push(cVar('ET - Beacon URL',         beaconUrl));
    variables.push(cVar('ET - Beacon API Key',     beaconApiKey));
    variables.push(cVar('ET - EasyTrac Client ID', etClientId));
  }
  if (_eventObservabilityEnabled || _eventDebugSamplingEnabled) {
    variables.push(cVar('ET - Event Observability URL', eventObservabilityUrl.replace(/\/$/, '')));
    variables.push(cVar('ET - Event Observability API Key', eventObservabilityApiKey));
  }

  // Request Metadata
  variables.push(smmVar('ET - event_name',    'event_name'));
  variables.push(smmVar('ET - page_location', 'page_location'));
  variables.push(smmVar('ET - page_referrer', 'page_referrer'));
  variables.push(smmVar('ET - page_hostname', 'page_hostname'));
  variables.push(smmVar('ET - page_path',     'page_path'));
  variables.push(smmVar('ET - debug_mode',    'debug_mode'));

  // HTTP Headers
  variables.push(headerVar('ET - Header client_ip',  'x-forwarded-for'));
  variables.push(headerVar('ET - Header user_agent', 'user-agent'));
  variables.push(headerVar('ET - Header origin',     'origin'));
  variables.push(headerVar('ET - Header referer',    'referer'));

  // jsm is NOT supported in sGTM — alias constant instead
  variables.push(cVar('ET - client_ip_clean', '{{ET - Header client_ip}}'));

  // Client IP for CAPI bodies. Deliberately NOT ET - Header client_ip: the raw
  // x-forwarded-for header is caller-supplied, may contain quotes/backslashes,
  // and sGTM offers no way to escape it before it lands inside a JSON string
  // literal. The built-in Client IP Address request variable returns GTM's own
  // parsed address instead. If it ever resolves empty the body degrades to
  // "client_ip_address":"" — still valid JSON, never a broken request.
  variables.push(smmVar('ET - client_ip_safe', 'client_ip_address'));

  // user_agent arrives as an escaped ep.* parameter from the web container
  // (ET - JS esc user_agent) rather than from the fully caller-controlled
  // user-agent request header, for the same reason.
  variables.push(epVar('ET - ep user_agent',     'user_agent'));
  variables.push(epVar('ET - ep page_url',       'page_url'));
  variables.push(epVar('ET - ep page_referrer',  'page_referrer'));

  // ep.* — Ecommerce
  variables.push(epVar('ET - ep event_id',       'event_id'));
  variables.push(epVar('ET - ep transaction_id', 'transaction_id'));
  variables.push(epVar('ET - ep currency',       'currency'));
  variables.push(epVar('ET - ep revenue',        'revenue'));
  variables.push(epVar('ET - ep tax',            'tax'));
  variables.push(epVar('ET - ep shipping',       'shipping'));
  variables.push(epVar('ET - ep coupon',         'coupon'));
  variables.push(epVar('ET - ep affiliation',    'affiliation'));
  variables.push(epVar('ET - ep content_ids',    'content_ids'));
  variables.push(epVar('ET - ep content_name',   'content_name'));
  variables.push(epVar('ET - ep content_type',   'content_type'));
  variables.push(epVar('ET - ep items_json',      'items_json'));
  variables.push(epVar('ET - ep items_count',     'items_count'));
  variables.push(epVar('ET - ep items_truncated', 'items_truncated'));
  variables.push(epVar('ET - ep num_items',      'num_items'));
  variables.push(epVar('ET - ep search_string',  'search_string'));
  variables.push(epVar('ET - ep event_time',     'event_time'));

  // ep.* — Click IDs
  variables.push(epVar('ET - ep fbclid',    'fbclid'));
  variables.push(epVar('ET - ep gclid',     'gclid'));
  variables.push(epVar('ET - ep wbraid',    'wbraid'));
  variables.push(epVar('ET - ep gbraid',    'gbraid'));
  variables.push(epVar('ET - ep ttclid',    'ttclid'));
  variables.push(epVar('ET - ep ScCid',     'ScCid'));
  variables.push(epVar('ET - ep msclkid',   'msclkid'));
  variables.push(epVar('ET - ep li_fat_id', 'li_fat_id'));

  // ep.* — Cookies
  variables.push(epVar('ET - ep _fbp',        '_fbp'));
  variables.push(epVar('ET - ep _fbc',        '_fbc'));
  variables.push(epVar('ET - ep _ttp',        '_ttp'));
  variables.push(epVar('ET - ep _scid',       '_scid'));
  variables.push(epVar('ET - ep _gid',        '_gid'));
  variables.push(epVar('ET - ep _uetmsclkid', '_uetmsclkid'));

  // ep.* — Attribution
  variables.push(epVar('ET - ep utm_source',   'utm_source'));
  variables.push(epVar('ET - ep utm_medium',   'utm_medium'));
  variables.push(epVar('ET - ep utm_campaign', 'utm_campaign'));
  variables.push(epVar('ET - ep utm_content',  'utm_content'));
  variables.push(epVar('ET - ep utm_term',     'utm_term'));

  // ep.* — Device and session signals
  variables.push(epVar('ET - ep device_type',       'device_type'));
  variables.push(epVar('ET - ep screen_resolution',  'screen_resolution'));
  variables.push(epVar('ET - ep viewport',           'viewport'));
  variables.push(epVar('ET - ep language',           'language'));
  variables.push(epVar('ET - ep timezone',           'timezone'));
  variables.push(epVar('ET - ep anonymous_id',       'anonymous_id'));
  variables.push(epVar('ET - ep session_id',         'session_id'));
  variables.push(epVar('ET - ep ga_client_id',       'ga_client_id'));

  // ep.* — Consent state
  variables.push(epVar('ET - ep ad_storage',          'ad_storage'));
  variables.push(epVar('ET - ep analytics_storage',   'analytics_storage'));
  variables.push(epVar('ET - ep ad_user_data',        'ad_user_data'));
  variables.push(epVar('ET - ep ad_personalization',  'ad_personalization'));

  // epn.* — Numeric
  variables.push(epVar('ET - epn value', 'value'));

  // up.* — User Properties
  variables.push(upVar('ET - up em',          'em'));
  variables.push(upVar('ET - up ph',          'ph'));
  variables.push(upVar('ET - up fn',          'fn'));
  variables.push(upVar('ET - up ln',          'ln'));
  variables.push(upVar('ET - up ct',          'ct'));
  variables.push(upVar('ET - up st',          'st'));
  variables.push(upVar('ET - up zp',          'zp'));
  variables.push(upVar('ET - up country',     'country'));
  variables.push(upVar('ET - up external_id', 'external_id'));
  variables.push(upVar('ET - up fbp',         'fbp'));
  variables.push(upVar('ET - up fbc',         'fbc'));
  variables.push(upVar('ET - up ttp',         'ttp'));
  variables.push(upVar('ET - up scid',        'scid'));
  variables.push(upVar('ET - up anonymous_id','anonymous_id'));

  // Computed aliases
  variables.push(epVar('ET - event_time_unix', 'event_time'));
  variables.push(epVar('ET - resolved_fbc',    '_fbc'));
  variables.push(upVar('ET - resolved_fbp',    'fbp'));

  // Standard named SMM variables
  variables.push(smmVar('Event Name', 'event_name'));
  variables.push(smmVar('Client IP',  'ip_override'));
  variables.push(smmVar('User Agent', 'user_agent'));

  // Server Event Data — shared references for CAPI tag parameters
  variables.push(smmVar('User Email',       'user_data.em'));
  variables.push(smmVar('User Phone',       'user_data.ph'));
  variables.push(smmVar('User First Name',  'user_data.fn'));
  variables.push(smmVar('User Last Name',   'user_data.ln'));
  variables.push(smmVar('User External ID', 'user_data.external_id'));
  variables.push(smmVar('User ID',          'user_id'));

  variables.push(smmVar('Cookie - fbp',  '_fbp'));
  variables.push(smmVar('Cookie - fbc',  '_fbc'));
  variables.push(smmVar('Cookie - ttp',  '_ttp'));
  variables.push(smmVar('Cookie - scid', '_scid'));

  variables.push(smmVar('Click ID - ttclid',   'ep.ttclid'));
  variables.push(smmVar('Click ID - ScCid',    'ep.ScCid'));
  variables.push(smmVar('Click ID - gclid',    'gclid'));
  variables.push(smmVar('Click ID - msclkid',  'ep.msclkid'));
  variables.push(smmVar('Click ID - li_fat_id','ep.li_fat_id'));

  variables.push(smmVar('Page Location',   'page_location'));
  variables.push(smmVar('Page Referrer',   'page_referrer'));
  variables.push(smmVar('Campaign ID',     'campaign_id'));
  variables.push(smmVar('Campaign Name',   'campaign_name'));
  variables.push(smmVar('Campaign Source', 'campaign_source'));
  variables.push(smmVar('Campaign Medium', 'campaign_medium'));

  // Consent state — named for use in trigger conditions
  variables.push(epVar('Consent - ad_storage',         'ad_storage'));
  variables.push(epVar('Consent - analytics_storage',  'analytics_storage'));
  variables.push(epVar('Consent - ad_user_data',       'ad_user_data'));
  variables.push(epVar('Consent - ad_personalization', 'ad_personalization'));

  // ── TRIGGERS ──────────────────────────────────────────────────────────────

  const alwaysTid = nTid();
  const triggers = [
    {
      name: 'ET - All Events', type: 'CUSTOM_EVENT', triggerId: alwaysTid,
      customEventFilter: [{ type: 'MATCH_REGEX', parameter: [
        { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
        { type: 'TEMPLATE', key: 'arg1', value: '.*' },
      ]}],
      notes: 'Fires on every event received by the GA4 Client.',
    },
  ];

  const trigMap = {};

  evList.forEach(key => {
    const ga4Ev = GA4_EVENT[key];
    if (!ga4Ev) return;
    const tid = nTid();
    trigMap[key] = tid;
    triggers.push(sgtmEventTrigger('ET - sGTM Event ' + ga4Ev, ga4Ev, tid));
  });

  custEvList.forEach(evName => {
    const safe = String(evName).trim();
    if (!safe || trigMap[safe]) return;
    const tid = nTid();
    trigMap[safe] = tid;
    triggers.push(sgtmEventTrigger('ET - sGTM Custom Event ' + safe, safe, tid));
  });

  // No failure trigger: there is no real signal in this container architecture
  // that a sibling native tag (e.g. the 'sgtmgaaw' GA4 forward tag) failed to
  // deliver. GTM Server-Side only exposes tag-execution outcome to a custom
  // sandboxed JS template's own success/failure callback, reachable only via
  // native tag sequencing config — both forbidden here (no custom templates
  // per the native-HTTP architecture contract; no sequencing dependency per
  // the fail-open requirement). See docs/product/event-observability-v1-implementation-plan.md
  // ("Failure-sample ingestion — removed from V1") for the full rationale.

  // ── CLIENTS ────────────────────────────────────────────────────────────────

  const clients = [
    {
      name: 'GA4',
      type: 'gaaw_client',
      clientId: '1',
      parameter: [
        { type: 'BOOLEAN',  key: 'activateDefaultPaths', value: 'true' },
        { type: 'TEMPLATE', key: 'cookieManagement',     value: 'server' },
        { type: 'TEMPLATE', key: 'cookieName',           value: 'FPID' },
        { type: 'TEMPLATE', key: 'cookieDomain',         value: 'auto' },
        { type: 'TEMPLATE', key: 'cookiePath',           value: '/' },
        { type: 'TEMPLATE', key: 'cookieMaxAgeInSec',    value: '63072000' },
      ],
    },
    {
      name: 'ET - GA4 Client',
      type: 'gaaw_client',
      clientId: '2',
      priority: 100,
      notes: 'EasyTrac — GA4 Client. Receives /g/collect via transport_url from web container.',
    },
  ];

  // ── TAGS ──────────────────────────────────────────────────────────────────
  // All CAPI tags use native sGTM HTTP Request tags (type 'http') — no custom
  // templates required. The container imports into any GTM Server workspace
  // without installing community templates first.

  const tags = [];

  tags.push({
    name: 'ET - GA4 Forward to Google Analytics',
    type: 'sgtmgaaw',
    tagId: nTagId(),
    parameter: [
      { type: 'TEMPLATE', key: 'measurementId', value: '{{ET - GA4 Measurement ID}}' },
    ],
    firingTriggerId: [alwaysTid],
    tagFiringOption: 'ONCE_PER_EVENT',
    notes: 'EasyTrac — Forwards every GA4 hit to Google Analytics 4.',
  });

  // Meta CAPI — native HTTP Request tag
  if (platList.includes('meta') && px.meta && tok.meta) {
    evList.forEach(key => {
      const mEv = META_EVENT[key];
      if (!mEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - Meta CAPI - ' + mEv,
        type: 'http',
        tagId: nTagId(),
        parameter: [
          { type: 'TEMPLATE', key: 'url',         value: 'https://graph.facebook.com/v22.0/{{ET - Meta Pixel ID}}/events?access_token={{ET - Meta CAPI Token}}' },
          { type: 'TEMPLATE', key: 'method',      value: 'POST' },
          { type: 'TEMPLATE', key: 'requestBody', value: _metaBody(mEv) },
          { type: 'LIST',     key: 'headers',     list: _jsonHeaders() },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — Meta Conversions API ${mEv}. Native HTTP Request — no community template needed.`,
      });
    });
  }

  // TikTok Events API — native HTTP Request tag
  if (platList.includes('tiktok') && px.tiktok && tok.tiktok) {
    evList.forEach(key => {
      const ttEv = TIKTOK_EVENT[key];
      if (!ttEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - TikTok Events API - ' + ttEv,
        type: 'http',
        tagId: nTagId(),
        parameter: [
          { type: 'TEMPLATE', key: 'url',         value: 'https://business-api.tiktok.com/open_api/v1.3/event/track/' },
          { type: 'TEMPLATE', key: 'method',      value: 'POST' },
          { type: 'TEMPLATE', key: 'requestBody', value: _tiktokBody(ttEv) },
          { type: 'LIST',     key: 'headers',     list: _jsonHeaders([_authHeader('{{ET - TikTok Events Token}}')]) },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — TikTok Events API ${ttEv}. Native HTTP Request — no community template needed.`,
      });
    });
  }

  // Snapchat CAPI — native HTTP Request tag
  if (platList.includes('snap') && px.snap && tok.snap) {
    const _snapCapiNamesSeen = {};
    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      const snapTagName = _snapCapiNamesSeen[sEv]
        ? 'ET - Snapchat CAPI - ' + sEv + ' (' + key + ')'
        : 'ET - Snapchat CAPI - ' + sEv;
      _snapCapiNamesSeen[sEv] = true;
      tags.push({
        name: snapTagName,
        type: 'http',
        tagId: nTagId(),
        parameter: [
          { type: 'TEMPLATE', key: 'url',         value: 'https://tr.snapchat.com/v3/{{ET - Snapchat Pixel ID}}/events' },
          { type: 'TEMPLATE', key: 'method',      value: 'POST' },
          { type: 'TEMPLATE', key: 'requestBody', value: _snapBody(sEv) },
          { type: 'LIST',     key: 'headers',     list: _jsonHeaders([_authHeader('Bearer {{ET - Snapchat CAPI Token}}')]) },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — Snapchat Conversions API ${sEv}. Native HTTP Request — no community template needed.`,
      });
    });
  }

  // EasyTrac Beacon — native HTTP Request tag
  if (_beaconEnabled) {
    tags.push({
      name: 'ET - EasyTrac Beacon',
      type: 'http',
      tagId: nTagId(),
      parameter: [
        { type: 'TEMPLATE', key: 'url',         value: '{{ET - Beacon URL}}' },
        { type: 'TEMPLATE', key: 'method',      value: 'POST' },
        { type: 'TEMPLATE', key: 'requestBody', value: _beaconBody() },
        { type: 'LIST',     key: 'headers',     list: _jsonHeaders([_authHeader('Bearer {{ET - Beacon API Key}}')]) },
      ],
      firingTriggerId: [alwaysTid],
      tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac — Event presence beacon for health diagnostics.',
    });
  }

  // Phase 1 ships accepted-at-ingestion telemetry only. This is an
  // independent native HTTP tag, never a setup/teardown dependency of the
  // GA4 forward tag — a broken or slow observability endpoint cannot affect
  // GA4 delivery. It measures "purchase event reached the container," not
  // "GA4 confirmed the hit" — there is no real mechanism (see the removed-
  // trigger note above) to observe the latter without violating the
  // native-HTTP / no-sequencing constraints, so this tag does not claim to.
  if (_eventObservabilityEnabled && trigMap.purchase) {
    const obsHeaders = _jsonHeaders([_authHeader('Bearer {{ET - Event Observability API Key}}')]);
    tags.push({
      name: 'ET - Event Telemetry - GA4 purchase', type: 'http', tagId: nTagId(),
      parameter: [
        { type: 'TEMPLATE', key: 'url', value: '{{ET - Event Observability URL}}/api/v1/internal/event-telemetry' },
        { type: 'TEMPLATE', key: 'method', value: 'POST' },
        { type: 'TEMPLATE', key: 'requestBody', value: _safeJsonBody({ eventName: 'purchase', destination: 'ga4', accepted: 1, failed: 0, validationFailed: 0 }) },
        { type: 'LIST', key: 'headers', list: obsHeaders },
      ],
      firingTriggerId: [trigMap.purchase], tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac Event Observability V1 - GA4 purchase aggregate, best effort. Ingestion-only counter, not a GA4 delivery-confirmation signal.',
    });
  }

  // Phase 2.1 debug sampling remains an independent native HTTP tag. It sends
  // only a transient stable key plus bounded field-presence indicators; the
  // backend hashes the key for deterministic sampling and never persists any
  // indicator value. It is not sequenced with, and cannot observe, GA4 delivery.
  if (_eventDebugSamplingEnabled && trigMap.purchase) {
    const debugHeaders = _jsonHeaders([_authHeader('Bearer {{ET - Event Observability API Key}}')]);
    tags.push({
      name: 'ET - Event Debug Sample - GA4 purchase', type: 'http', tagId: nTagId(),
      parameter: [
        { type: 'TEMPLATE', key: 'url', value: '{{ET - Event Observability URL}}/api/v1/internal/event-debug-sample' },
        { type: 'TEMPLATE', key: 'method', value: 'POST' },
        { type: 'TEMPLATE', key: 'requestBody', value: _safeJsonBody({
          sampleKey: '{{ET - ep event_id}}',
          eventName: 'purchase',
          intendedDestination: 'ga4',
          containerVersion: String(eventDebugContainerVersion || 'unknown').slice(0, 128),
          schemaVersion: '1',
          ingestionAccepted: true,
          fieldIndicators: {
            transaction_id: '{{ET - ep transaction_id}}',
            currency: '{{ET - ep currency}}',
            value: '{{ET - epn value}}',
            items: '{{ET - ep items_count}}',
          },
          cms: String(eventDebugCms || 'unknown').toLowerCase().slice(0, 32),
          environment: String(eventDebugEnvironment || 'synthetic').toLowerCase().slice(0, 32),
        }) },
        { type: 'LIST', key: 'headers', list: debugHeaders },
      ],
      firingTriggerId: [trigMap.purchase], tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac Debug Sampling Phase 2.1 - opt-in GA4 purchase sample, best effort, PII-free storage, no destination-delivery signal.',
    });
  }

  const serverExport = {
    exportFormatVersion: 2,
    containerVersion: {
      accountId:          '0',
      containerId:        '0',
      containerVersionId: '0',
      container: {
        accountId:    '0',
        containerId:  '0',
        name:         'ET - Server Container (sGTM)',
        usageContext: ['SERVER'],
      },
      variable:       variables,
      trigger:        triggers,
      tag:            tags,
      client:         clients,
      customTemplate: [],
    },
    _meta: {
      createdBy:        'EasyTrac GTM Config Builder',
      generatorVersion: GENERATOR_VERSION,
      schemaVersion:    SCHEMA_VERSION,
      architecture:     'Web GTM → GA4 (transport_url) → Server GTM (GA4 Client) → Platform APIs',
    },
  };
  const { validation } = finalizeContainer(serverExport);
  serverExport._meta.validation = validation;
  return serverExport;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Event Schema — reference for external consumers
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the complete envelope forwarded as ep.* on every event.
// Fields are always present; value is '' when unavailable (never undefined/null).
// sGTM reads each field via the corresponding epVar/upVar declared above.
//
// CANONICAL_EVENT_SCHEMA = {
//   // Identity
//   anonymous_id, session_id, ga_client_id, external_id, user_id,
//   // User PII (up.* — hashed before CAPI dispatch in sGTM template)
//   em, ph, fn, ln, ct, st, zp, country,
//   // Ecommerce
//   event_id, transaction_id, value, revenue, currency, tax, shipping, coupon,
//   affiliation, content_ids, content_name, content_type, items, quantity,
//   num_items, search_string,
//   // Attribution
//   utm_source, utm_medium, utm_campaign, utm_content, utm_term,
//   fbclid, gclid, wbraid, gbraid, ttclid, ScCid, msclkid, li_fat_id,
//   // Cookies
//   _fbp, _fbc, _ttp, _scid, _gid, _uetmsclkid,
//   // Page
//   page_url, page_title, page_referrer, event_time, language, timezone,
//   // Device
//   device_type, screen_resolution, viewport,
//   // Consent
//   ad_storage, analytics_storage, ad_user_data, ad_personalization,
// }

module.exports = { buildWebConfig, buildServerConfig, SCHEMA_VERSION, GENERATOR_VERSION, _dlScanBlock, _safeJsonBody };
