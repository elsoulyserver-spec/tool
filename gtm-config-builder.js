'use strict';

const fs   = require('fs');
const path = require('path');

// Phase 2 — Schema versioning.
// Bump SCHEMA_VERSION when the items_json canonical field set changes.
// Bump GENERATOR_VERSION on any release that changes generated container behaviour.
// Both are embedded in every generated container export and in every ET:EventLog entry.
const SCHEMA_VERSION    = 1;
const GENERATOR_VERSION = '4.1';

// ─────────────────────────────────────────────────────────────────────────────
// Load .tpl files for inline embedding inside server container JSON.
// When customTemplate[] is present in the export, GTM registers the templates
// automatically on import — no manual Admin → Templates → Import step needed.
// ─────────────────────────────────────────────────────────────────────────────

function _sanitizeTpl(text) {
  if (text == null) return null;
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function _loadTpl(name) {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, 'server-side', 'sgtm-templates', name + '.tpl'),
      'utf8',
    );
    const clean = _sanitizeTpl(raw);
    if (!clean || clean.indexOf('___SANDBOXED_JS_FOR_SERVER___') === -1) {
      throw new Error('template ' + name + ' is empty or missing required sections');
    }
    return clean;
  } catch (e) {
    return null;
  }
}

const TPL_UNIVERSAL = _loadTpl('universal-http');
const TPL_BEACON    = _loadTpl('et-beacon');

// ─────────────────────────────────────────────────────────────────────────────
// Template fingerprint IDs
// cvt_0_1 = universal HTTP forwarder (Meta, TikTok, Snap)
// cvt_0_2 = EasyTrac beacon
// ─────────────────────────────────────────────────────────────────────────────
const FP_HTTP   = '1';
const FP_BEACON = '2';

function _buildCustomTemplates(platList) {
  const needsHttp = platList.some(p => ['meta', 'tiktok', 'snap'].includes(p));
  if (!needsHttp || !TPL_UNIVERSAL) return [];
  return [{
    accountId:    '0',
    containerId:  '0',
    templateId:   FP_HTTP,
    name:         'ET - Universal HTTP Forwarder',
    fingerprint:  FP_HTTP,
    templateData: TPL_UNIVERSAL,
  }];
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
 *                Meta CAPI, TikTok Events API, Snapchat CAPI — cvt_0_1 universal forwarder
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
  variables.push(jsVar('ET - JS email_normalised',
    'function(){var v={{ET - DLV user_email}};return v?String(v).toLowerCase().trim():"";}'));
  variables.push(jsVar('ET - JS phone_normalised',
    'function(){var v={{ET - DLV user_phone}};if(!v)return "";return String(v).replace(/[^0-9+]/g,"").trim();}'));
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

  // ── Resolved user data ─────────────────────────────────────────────────────
  const isSalla = ecommPlatform === 'salla';
  variables.push(jsVar('ET - JS resolved_em',
    isSalla
      ? 'function(){var v={{ET - DLV salla_em_hash}};return v||"";}'
      : 'function(){return {{ET - JS email_normalised}}||"";}'));
  variables.push(jsVar('ET - JS resolved_ph',
    isSalla
      ? 'function(){var v={{ET - DLV salla_ph_hash}};return v||"";}'
      : 'function(){return {{ET - JS phone_normalised}}||"";}'));
  variables.push(jsVar('ET - JS resolved_fn',
    isSalla
      ? 'function(){var v={{ET - DLV salla_fn}};return v?String(v).toLowerCase().trim():"";}'
      : 'function(){return {{ET - JS fn_normalised}}||"";}'));
  variables.push(jsVar('ET - JS resolved_ln',
    isSalla
      ? 'function(){var v={{ET - DLV salla_ln}};return v?String(v).toLowerCase().trim():"";}'
      : 'function(){return {{ET - JS ln_normalised}}||"";}'));
  variables.push(jsVar('ET - JS resolved_ext_id',
    isSalla
      ? 'function(){var v={{ET - DLV salla_ext_id}};return v||{{ET - DLV external_id}}||"";}'
      : 'function(){return {{ET - DLV external_id}}||"";}'));

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
      _upProp('external_id',  '{{ET - JS resolved_ext_id}}'),
      _upProp('fbp',          '{{ET - Cookie _fbp}}'),
      _upProp('fbc',          '{{ET - JS fbc_builder}}'),
      _upProp('ttp',          '{{ET - Cookie _ttp}}'),
      _upProp('scid',         '{{ET - Cookie _scid}}'),
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
      _ep('event_id',        '{{ET - JS event_id_resolved}}'),
      _ep('value',           '{{ET - DLV value}}'),
      _ep('revenue',         '{{ET - DLV revenue}}'),
      _ep('currency',        '{{ET - DLV currency}}'),
      _ep('transaction_id',  '{{ET - DLV transaction_id}}'),
      _ep('tax',             '{{ET - DLV tax}}'),
      _ep('shipping',        '{{ET - DLV shipping}}'),
      _ep('coupon',          '{{ET - DLV coupon}}'),
      _ep('affiliation',     '{{ET - DLV affiliation}}'),
      // items_json transports the full items array as a canonical JSON string.
      // ep.items is intentionally omitted — GTM serializes arrays as [object Object].
      _ep('items_json',      '{{ET - JS items_json}}'),
      _ep('items_count',     '{{ET - JS items_count}}'),
      _ep('items_truncated', '{{ET - JS items_truncated}}'),
      _ep('content_ids',     '{{ET - DLV content_ids}}'),
      _ep('content_name',    '{{ET - DLV content_name}}'),
      _ep('content_type',    '{{ET - DLV content_type}}'),
      _ep('quantity',        '{{ET - DLV quantity}}'),
      _ep('num_items',       '{{ET - DLV num_items}}'),
      _ep('search_string',   '{{ET - DLV search_string}}'),
      // ── Click IDs ────────────────────────────────────────────────────────
      _ep('fbclid',          '{{ET - URL fbclid}}'),
      _ep('gclid',           '{{ET - URL gclid}}'),
      _ep('wbraid',          '{{ET - URL wbraid}}'),
      _ep('gbraid',          '{{ET - URL gbraid}}'),
      _ep('ttclid',          '{{ET - URL ttclid}}'),
      _ep('ScCid',           '{{ET - URL ScCid}}'),
      _ep('msclkid',         '{{ET - URL msclkid}}'),
      _ep('li_fat_id',       '{{ET - URL li_fat_id}}'),
      // ── Cookies ──────────────────────────────────────────────────────────
      _ep('_fbp',            '{{ET - Cookie _fbp}}'),
      _ep('_fbc',            '{{ET - JS fbc_builder}}'),
      _ep('_ttp',            '{{ET - Cookie _ttp}}'),
      _ep('_scid',           '{{ET - Cookie _scid}}'),
      _ep('_gid',            '{{ET - Cookie _gid}}'),
      _ep('_uetmsclkid',     '{{ET - Cookie _uetmsclkid}}'),
      // ── Attribution ──────────────────────────────────────────────────────
      _ep('utm_source',      '{{ET - URL utm_source}}'),
      _ep('utm_medium',      '{{ET - URL utm_medium}}'),
      _ep('utm_campaign',    '{{ET - URL utm_campaign}}'),
      _ep('utm_content',     '{{ET - URL utm_content}}'),
      _ep('utm_term',        '{{ET - URL utm_term}}'),
      // ── Page metadata ─────────────────────────────────────────────────────
      _ep('page_url',        '{{ET - JS page_url}}'),
      _ep('page_title',      '{{ET - JS page_title}}'),
      _ep('page_referrer',   '{{ET - JS page_referrer}}'),
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
      { type: 'TEMPLATE', key: 'eventName',        value: ga4Ev },
      { type: 'LIST',     key: 'eventParameters',  list: _buildEventParameters() },
    ];

    if (['purchase', 'lead', 'sign_up', 'add_to_cart', 'initiate_checkout', 'contact'].includes(key)) {
      eventParams.push({
        type: 'LIST', key: 'userProperties',
        list: [
          _upProp('em',          '{{ET - JS resolved_em}}'),
          _upProp('ph',          '{{ET - JS resolved_ph}}'),
          _upProp('fn',          '{{ET - JS resolved_fn}}'),
          _upProp('ln',          '{{ET - JS resolved_ln}}'),
          _upProp('external_id', '{{ET - JS resolved_ext_id}}'),
          _upProp('ct',          '{{ET - DLV user_city}}'),
          _upProp('st',          '{{ET - DLV user_state}}'),
          _upProp('zp',          '{{ET - DLV user_zip}}'),
          _upProp('country',     '{{ET - DLV user_country}}'),
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
        { type: 'TEMPLATE', key: 'eventName',       value: safe },
        { type: 'LIST',     key: 'eventParameters', list: _buildEventParameters() },
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
  'user_email': '{{ET - JS resolved_em}}',
  'user_phone_number': '{{ET - JS resolved_ph}}'
});
snaptr('track','PAGE_VIEW');
</script>`,
      }, { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'ONCE_PER_EVENT',
    });

    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv || key === 'page_view') return;
      const tid = trigMap[key];
      tags.push({
        name: 'ET - Snapchat Pixel - ' + sEv,
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

  return {
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
} = {}) {
  _reset();

  const ga4Id      = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';
  const px         = pixelIds   || {};
  const tok        = capiTokens || {};
  const evList     = Array.isArray(events)       ? events       : [];
  const custEvList = Array.isArray(customEvents) ? customEvents : [];
  const platList   = Array.isArray(platforms)    ? platforms    : [];

  const _beaconEnabled = !!(beaconUrl && beaconApiKey && etClientId);

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

  // ── CUSTOM TEMPLATES ─────────────────────────────────────────────────────

  const customTemplates = [
    ..._buildCustomTemplates(platList),
    ...(_beaconEnabled && TPL_BEACON ? [{
      accountId:    '0',
      containerId:  '0',
      templateId:   FP_BEACON,
      name:         'ET - EasyTrac Beacon',
      fingerprint:  FP_BEACON,
      templateData: TPL_BEACON,
    }] : []),
  ];

  // ── TAGS ──────────────────────────────────────────────────────────────────

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

  const _capiUserParams = [
    { type: 'TEMPLATE', key: 'userEmail',      value: '{{User Email}}' },
    { type: 'TEMPLATE', key: 'userPhone',       value: '{{User Phone}}' },
    { type: 'TEMPLATE', key: 'userFirstName',   value: '{{User First Name}}' },
    { type: 'TEMPLATE', key: 'userLastName',    value: '{{User Last Name}}' },
    { type: 'TEMPLATE', key: 'userExternalId',  value: '{{User External ID}}' },
    { type: 'TEMPLATE', key: 'pageLocation',    value: '{{Page Location}}' },
    { type: 'TEMPLATE', key: 'pageReferrer',    value: '{{Page Referrer}}' },
    { type: 'TEMPLATE', key: 'eventValue',      value: '{{ET - epn value}}' },
    { type: 'TEMPLATE', key: 'eventCurrency',   value: '{{ET - ep currency}}' },
    { type: 'TEMPLATE', key: 'orderId',         value: '{{ET - ep transaction_id}}' },
    { type: 'TEMPLATE', key: 'eventId',         value: '{{ET - ep event_id}}' },
  ];

  // Meta CAPI
  if (platList.includes('meta') && px.meta && tok.meta) {
    evList.forEach(key => {
      const mEv = META_EVENT[key];
      if (!mEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - Meta CAPI - ' + mEv,
        type: 'cvt_0_' + FP_HTTP,
        tagId: nTagId(),
        parameter: [
          { type: 'TEMPLATE', key: 'url',        value: 'https://graph.facebook.com/v22.0/{{ET - Meta Pixel ID}}/events?access_token={{ET - Meta CAPI Token}}' },
          { type: 'TEMPLATE', key: 'authHeader', value: '' },
          { type: 'TEMPLATE', key: 'eventName',  value: mEv },
          { type: 'TEMPLATE', key: 'platformId', value: '{{ET - Meta Pixel ID}}' },
          { type: 'TEMPLATE', key: 'clientIp',   value: '{{Client IP}}' },
          { type: 'TEMPLATE', key: 'userAgent',  value: '{{User Agent}}' },
          { type: 'BOOLEAN',  key: 'enableDebug', value: 'false' },
          { type: 'TEMPLATE', key: 'fbp',        value: '{{Cookie - fbp}}' },
          { type: 'TEMPLATE', key: 'fbc',        value: '{{Cookie - fbc}}' },
          ..._capiUserParams,
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — Meta CAPI ${mEv}`,
      });
    });
  }

  // TikTok Events API
  if (platList.includes('tiktok') && px.tiktok && tok.tiktok) {
    evList.forEach(key => {
      const ttEv = TIKTOK_EVENT[key];
      if (!ttEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - TikTok Events API - ' + ttEv,
        type: 'cvt_0_' + FP_HTTP,
        tagId: nTagId(),
        parameter: [
          { type: 'TEMPLATE', key: 'url',        value: 'https://business-api.tiktok.com/open_api/v1.3/event/track/' },
          { type: 'TEMPLATE', key: 'authHeader', value: '{{ET - TikTok Events Token}}' },
          { type: 'TEMPLATE', key: 'eventName',  value: ttEv },
          { type: 'TEMPLATE', key: 'platformId', value: '{{ET - TikTok Pixel ID}}' },
          { type: 'TEMPLATE', key: 'clientIp',   value: '{{Client IP}}' },
          { type: 'TEMPLATE', key: 'userAgent',  value: '{{User Agent}}' },
          { type: 'BOOLEAN',  key: 'enableDebug', value: 'false' },
          { type: 'TEMPLATE', key: 'ttp',        value: '{{Cookie - ttp}}' },
          { type: 'TEMPLATE', key: 'ttclid',     value: '{{Click ID - ttclid}}' },
          ..._capiUserParams,
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — TikTok Events API ${ttEv}`,
      });
    });
  }

  // Snapchat CAPI
  if (platList.includes('snap') && px.snap && tok.snap) {
    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - Snapchat CAPI - ' + sEv,
        type: 'cvt_0_' + FP_HTTP,
        tagId: nTagId(),
        parameter: [
          { type: 'TEMPLATE', key: 'url',        value: 'https://tr.snapchat.com/v3/{{ET - Snapchat Pixel ID}}/events' },
          { type: 'TEMPLATE', key: 'authHeader', value: '{{ET - Snapchat CAPI Token}}' },
          { type: 'TEMPLATE', key: 'eventName',  value: sEv },
          { type: 'TEMPLATE', key: 'platformId', value: '{{ET - Snapchat Pixel ID}}' },
          { type: 'TEMPLATE', key: 'clientIp',   value: '{{Client IP}}' },
          { type: 'TEMPLATE', key: 'userAgent',  value: '{{User Agent}}' },
          { type: 'BOOLEAN',  key: 'enableDebug', value: 'false' },
          { type: 'TEMPLATE', key: 'scid',       value: '{{Cookie - scid}}' },
          { type: 'TEMPLATE', key: 'scCid',      value: '{{Click ID - ScCid}}' },
          ..._capiUserParams,
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'ONCE_PER_EVENT',
        notes: `EasyTrac — Snapchat CAPI ${sEv}`,
      });
    });
  }

  // EasyTrac Beacon
  if (_beaconEnabled && TPL_BEACON) {
    tags.push({
      name: 'ET - EasyTrac Beacon',
      type: 'cvt_0_' + FP_BEACON,
      tagId: nTagId(),
      parameter: [
        { type: 'TEMPLATE', key: 'beaconUrl', value: '{{ET - Beacon URL}}' },
        { type: 'TEMPLATE', key: 'clientId',  value: '{{ET - EasyTrac Client ID}}' },
        { type: 'TEMPLATE', key: 'apiKey',    value: '{{ET - Beacon API Key}}' },
      ],
      firingTriggerId: [alwaysTid],
      tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'EasyTrac — Event presence beacon for health diagnostics.',
    });
  }

  return {
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
      customTemplate: customTemplates,
    },
    _meta: {
      createdBy:        'EasyTrac GTM Config Builder',
      generatorVersion: GENERATOR_VERSION,
      schemaVersion:    SCHEMA_VERSION,
      architecture:     'Web GTM → GA4 (transport_url) → Server GTM (GA4 Client) → Platform APIs',
    },
  };
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

module.exports = { buildWebConfig, buildServerConfig, SCHEMA_VERSION, GENERATOR_VERSION, _dlScanBlock };
