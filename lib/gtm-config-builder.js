'use strict';

/**
 * gtm-config-builder.js  v3.0  — EasyTrac Full Server-Side Architecture
 *
 * Architecture:  Web GTM  →  GA4 (transport_url)  →  Server GTM (GA4 Client)  →  Platform APIs
 *
 * WEB CONTAINER
 *   Variables  : Constants (GA4 ID, sGTM URL, pixel IDs)
 *                DataLayer (ecomm data, user_data.*)
 *                URL Params (fbclid, gclid, wbraid, gbraid, ttclid, ScCid + UTMs)
 *                Cookies (_fbp, _fbc, _ttp, _scid, _ga)
 *                Custom JS (FBC builder, page meta, SHA-256 normalise)
 *   Triggers   : All Pages + per-event custom triggers
 *   Tags       : GA4 Config (transport_url → sGTM, user_properties relay)
 *                GA4 Event tags (ecomm + click IDs + cookies)
 *                Meta Pixel, TikTok Pixel, Snapchat Pixel, Google Ads (client-side)
 *
 * SERVER CONTAINER
 *   Variables  : ep.* event_parameters, epn.* numeric params, up.* user_properties
 *                HTTP headers (x-forwarded-for, user-agent)
 *                Request metadata, computed vars (resolved_fbc, resolved_fbp, client_ip_clean)
 *   Client     : GA4 Client — receives /g/collect forwarded from web container
 *   Triggers   : All Events + per-GA4-event custom triggers
 *   Tags       : GA4 Forward → Google Analytics
 *                Meta CAPI   — manual HTTP, NO official template  (et_meta_capi_manual)
 *                TikTok Events API — manual HTTP                  (et_tiktok_events_manual)
 *                Snapchat CAPI     — manual HTTP                  (et_snapchat_capi_manual)
 *                Google Ads EC     — manual HTTP                  (et_gads_ec_manual)
 *
 * Custom template .tpl files live in lib/server-side/sgtm-templates/
 * Import them into your sGTM workspace BEFORE importing this container JSON.
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

/** Constant variable */
function cVar(name, value) {
  return {
    name, type: 'c', variableId: nVid(),
    parameter: [{ type: 'template', key: 'value', value }],
  };
}

/** DataLayer variable v2 */
function dlVar(name, dlKey, defaultVal) {
  const p = [
    { type: 'integer',  key: 'dataLayerVersion', value: '2' },
    { type: 'boolean',  key: 'setDefaultValue',  value: defaultVal !== undefined ? 'true' : 'false' },
    { type: 'template', key: 'name',              value: dlKey },
  ];
  if (defaultVal !== undefined)
    p.push({ type: 'template', key: 'defaultValue', value: String(defaultVal) });
  return { name, type: 'v', variableId: nVid(), parameter: p };
}

/** URL query-string variable */
function urlVar(name, queryKey) {
  return {
    name, type: 'u', variableId: nVid(),
    parameter: [
      { type: 'template', key: 'component', value: 'QUERY' },
      { type: 'template', key: 'queryKey',  value: queryKey },
    ],
  };
}

/** First-party cookie variable */
function cookieVar(name, cookieName) {
  return {
    name, type: 'k', variableId: nVid(),
    parameter: [
      { type: 'template', key: 'name',   value: cookieName },
      { type: 'boolean',  key: 'decode', value: 'false' },
    ],
  };
}

/** Custom JavaScript variable */
function jsVar(name, fn) {
  return {
    name, type: 'jsm', variableId: nVid(),
    parameter: [{ type: 'template', key: 'javascript', value: fn }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable helpers — Server container (sGTM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sGTM Server Model Variable
 * varType: event_name | event_parameter | user_property | ip_override |
 *          user_agent | page_location | page_referrer | page_hostname |
 *          page_path | page_query | header | container_id | debug_mode
 */
function smmVar(name, varType, extra) {
  const p = [{ type: 'template', key: 'varType', value: varType }];
  if (extra) {
    Object.entries(extra).forEach(([k, v]) =>
      p.push({ type: 'template', key: k, value: v })
    );
  }
  return { name, type: 'smm', variableId: nVid(), parameter: p };
}

/** sGTM event_parameter shortcut — reads ep.* from GA4 hit body */
function epVar(name, paramName) {
  return smmVar(name, 'event_parameter', { varName: paramName });
}

/** sGTM user_property shortcut — reads up.* from GA4 hit body */
function upVar(name, propName) {
  return smmVar(name, 'user_property', { varName: propName });
}

/** sGTM HTTP request header variable */
function headerVar(name, headerName) {
  return smmVar(name, 'header', { headerName });
}

/** sGTM Custom JS variable (sandboxed) */
function sjtVar(name, fn) {
  return {
    name, type: 'jsm', variableId: nVid(),
    parameter: [{ type: 'template', key: 'javascript', value: fn }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Web container custom event trigger */
function webEventTrigger(name, eventName, tid) {
  return {
    name, type: 'customEvent', triggerId: tid,
    customEventFilter: [{ type: 'equals', parameter: [
      { type: 'template', key: 'arg0', value: '{{_event}}' },
      { type: 'template', key: 'arg1', value: eventName },
    ]}],
  };
}

/** sGTM custom event trigger — matches GA4 event_name from incoming hit */
function sgtmEventTrigger(name, eventName, tid) {
  return {
    name, type: 'customEvent', triggerId: tid,
    customEventFilter: [{ type: 'equals', parameter: [
      { type: 'template', key: 'arg0', value: '{{ET - event_name}}' },
      { type: 'template', key: 'arg1', value: eventName },
    ]}],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event name maps
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
};

const GADS_EVENT = {
  purchase:          'purchase',
  lead:              'submit_lead_form',
  sign_up:           'sign_up',
  add_to_cart:       'add_to_cart',
};

const ALL_EVENTS = Object.keys(GA4_EVENT);

// ─────────────────────────────────────────────────────────────────────────────
// FBC builder — constructs _fbc from fbclid URL param if cookie is absent
// ─────────────────────────────────────────────────────────────────────────────

const FBC_BUILDER_JS = `function() {
  // Try cookie first
  var cookieFbc = {{ET - Cookie _fbc}};
  if (cookieFbc && cookieFbc !== '') return cookieFbc;
  // Build from fbclid URL param
  var fbclid = {{ET - URL fbclid}};
  if (!fbclid || fbclid === '') return '';
  var ts = Math.floor(Date.now() / 1000);
  return 'fb.1.' + ts + '.' + fbclid;
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper builders — shared
// ─────────────────────────────────────────────────────────────────────────────

/** GA4 event parameter list entry */
function _ep(name, value) {
  return { type: 'map', map: [
    { type: 'template', key: 'name',  value: name  },
    { type: 'template', key: 'value', value: value },
  ]};
}

/** GA4 user property list entry */
function _upProp(name, value) {
  return { type: 'map', map: [
    { type: 'template', key: 'name',  value: name  },
    { type: 'template', key: 'value', value: value },
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
 * @param {string[]} opts.events             — selected event keys
 * @param {string}   opts.ecommPlatform      — 'salla' | 'zid' | ''
 */
function buildWebConfig({
  ga4MeasurementId, sgtmUrl, pixelIds = {},
  events = [], ecommPlatform = '',
} = {}) {
  _reset();

  const ga4Id  = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';
  const sgtm   = (sgtmUrl || '').trim();
  const px     = pixelIds  || {};
  const evList = Array.isArray(events) ? events : [];

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

  // ── DataLayer — ecommerce data ─────────────────────────────────────────────
  variables.push(dlVar('ET - DLV event_id',        'event_id',           ''));
  variables.push(dlVar('ET - DLV value',            'value',              '0'));
  variables.push(dlVar('ET - DLV currency',         'currency',           'SAR'));
  variables.push(dlVar('ET - DLV transaction_id',   'transaction_id',     ''));
  variables.push(dlVar('ET - DLV content_ids',      'content_ids',        ''));
  variables.push(dlVar('ET - DLV content_name',     'content_name',       ''));
  variables.push(dlVar('ET - DLV content_type',     'content_type',       'product'));
  variables.push(dlVar('ET - DLV items',            'items',              ''));
  variables.push(dlVar('ET - DLV quantity',         'quantity',           '1'));
  variables.push(dlVar('ET - DLV num_items',        'num_items',          '1'));
  variables.push(dlVar('ET - DLV search_string',    'search_string',      ''));

  // ── DataLayer — user data (hashed/normalised by store before push) ─────────
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

  // ── URL variables — Click ID capture system ────────────────────────────────
  variables.push(urlVar('ET - URL fbclid',   'fbclid'));   // Meta
  variables.push(urlVar('ET - URL gclid',    'gclid'));    // Google Ads
  variables.push(urlVar('ET - URL wbraid',   'wbraid'));   // Google Ads (iOS app)
  variables.push(urlVar('ET - URL gbraid',   'gbraid'));   // Google Ads (cross-channel)
  variables.push(urlVar('ET - URL ttclid',   'ttclid'));   // TikTok
  variables.push(urlVar('ET - URL ScCid',    'ScCid'));    // Snapchat

  // ── Cookie variables ───────────────────────────────────────────────────────
  variables.push(cookieVar('ET - Cookie _fbp',  '_fbp'));   // Meta browser ID
  variables.push(cookieVar('ET - Cookie _fbc',  '_fbc'));   // Meta click ID cookie
  variables.push(cookieVar('ET - Cookie _ttp',  '_ttp'));   // TikTok browser ID
  variables.push(cookieVar('ET - Cookie _scid', '_scid'));  // Snapchat browser ID
  variables.push(cookieVar('ET - Cookie _ga',   '_ga'));    // GA client ID

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

  // ── Custom JS — FBC builder ────────────────────────────────────────────────
  variables.push(jsVar('ET - JS fbc_builder', FBC_BUILDER_JS));

  // ── Custom JS — value normalisation (normalise only; real hash happens server-side) ─
  // Recommendation: hash PII in your order system and push hashed values via dataLayer.
  variables.push(jsVar('ET - JS email_normalised',
    'function(){var v={{ET - DLV user_email}};return v?String(v).toLowerCase().trim():"";}'));
  variables.push(jsVar('ET - JS phone_normalised',
    'function(){var v={{ET - DLV user_phone}};if(!v)return "";return String(v).replace(/[^0-9+]/g,"").trim();}'));
  variables.push(jsVar('ET - JS fn_normalised',
    'function(){var v={{ET - DLV user_first_name}};return v?String(v).toLowerCase().trim():"";}'));
  variables.push(jsVar('ET - JS ln_normalised',
    'function(){var v={{ET - DLV user_last_name}};return v?String(v).toLowerCase().trim():"";}'));

  // ── TRIGGERS ──────────────────────────────────────────────────────────────

  const allPagesTid = nTid();
  const triggers = [
    { name: 'ET - All Pages', type: 'pageview', triggerId: allPagesTid },
  ];

  const trigMap = {};
  ALL_EVENTS.forEach(key => {
    const tid = nTid();
    trigMap[key] = tid;
    triggers.push(webEventTrigger(
      'ET - Event ' + (GA4_EVENT[key] || key),
      GA4_EVENT[key] || key,
      tid,
    ));
  });

  // ── TAGS ──────────────────────────────────────────────────────────────────

  const tags = [];

  // ──────────────────────────────────────────────────────────────────────────
  // GA4 Configuration Tag
  // transport_url routes all hits through sGTM.
  // User properties relay PII (normalised) to sGTM for server-side hashing + CAPI.
  // ──────────────────────────────────────────────────────────────────────────
  const ga4ConfigParams = [
    { type: 'template', key: 'measurementId', value: '{{ET - GA4 Measurement ID}}' },
    { type: 'boolean',  key: 'sendPageView',  value: 'false' },
    { type: 'template', key: 'userId',        value: '{{ET - DLV external_id}}' },
  ];

  if (sgtm) {
    ga4ConfigParams.push({ type: 'template', key: 'transportUrl', value: '{{ET - sGTM URL}}' });
  }

  // Relay user properties to sGTM — picked up by up.* variables in server container
  ga4ConfigParams.push({
    type: 'list', key: 'userProperties',
    list: [
      _upProp('em',          '{{ET - JS email_normalised}}'),
      _upProp('ph',          '{{ET - JS phone_normalised}}'),
      _upProp('fn',          '{{ET - JS fn_normalised}}'),
      _upProp('ln',          '{{ET - JS ln_normalised}}'),
      _upProp('external_id', '{{ET - DLV external_id}}'),
      _upProp('fbp',         '{{ET - Cookie _fbp}}'),
      _upProp('fbc',         '{{ET - JS fbc_builder}}'),
      _upProp('ttp',         '{{ET - Cookie _ttp}}'),
      _upProp('scid',        '{{ET - Cookie _scid}}'),
    ],
  });

  tags.push({
    name: 'ET - GA4 Configuration',
    type: 'gaawc',
    tagId: nTagId(),
    parameter: ga4ConfigParams,
    firingTriggerId: [allPagesTid],
    tagFiringOption: 'oncePerPage',
    notes: sgtm
      ? 'EasyTrac GA4 Configuration. transport_url routes hits through sGTM for server-side CAPI fan-out. User properties carry normalised PII; sGTM hashes server-side before CAPI calls.'
      : 'EasyTrac GA4 Configuration. No sGTM URL configured — add transport_url to enable server-side routing.',
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GA4 Event Tags — one per selected event
  // Every event carries: ecomm params, click IDs, cookies, UTMs.
  // sGTM reads these via ep.* and up.* variables.
  // ──────────────────────────────────────────────────────────────────────────
  evList.forEach(key => {
    const ga4Ev = GA4_EVENT[key];
    if (!ga4Ev) return;
    const tid = trigMap[key];
    if (!tid) return;

    const eventParameters = [
      // Ecommerce
      _ep('event_id',       '{{ET - DLV event_id}}'),
      _ep('value',          '{{ET - DLV value}}'),
      _ep('currency',       '{{ET - DLV currency}}'),
      _ep('transaction_id', '{{ET - DLV transaction_id}}'),
      _ep('items',          '{{ET - DLV items}}'),
      _ep('content_ids',    '{{ET - DLV content_ids}}'),
      _ep('content_name',   '{{ET - DLV content_name}}'),
      _ep('content_type',   '{{ET - DLV content_type}}'),
      _ep('quantity',       '{{ET - DLV quantity}}'),
      _ep('num_items',      '{{ET - DLV num_items}}'),
      _ep('search_string',  '{{ET - DLV search_string}}'),
      // Click IDs — all captured for server-side attribution
      _ep('fbclid',         '{{ET - URL fbclid}}'),
      _ep('gclid',          '{{ET - URL gclid}}'),
      _ep('wbraid',         '{{ET - URL wbraid}}'),
      _ep('gbraid',         '{{ET - URL gbraid}}'),
      _ep('ttclid',         '{{ET - URL ttclid}}'),
      _ep('ScCid',          '{{ET - URL ScCid}}'),
      // Cookies — forwarded for server-side resolution
      _ep('_fbp',           '{{ET - Cookie _fbp}}'),
      _ep('_fbc',           '{{ET - JS fbc_builder}}'),
      _ep('_ttp',           '{{ET - Cookie _ttp}}'),
      _ep('_scid',          '{{ET - Cookie _scid}}'),
      // Attribution
      _ep('utm_source',     '{{ET - URL utm_source}}'),
      _ep('utm_medium',     '{{ET - URL utm_medium}}'),
      _ep('utm_campaign',   '{{ET - URL utm_campaign}}'),
      _ep('utm_content',    '{{ET - URL utm_content}}'),
      _ep('utm_term',       '{{ET - URL utm_term}}'),
      // Page meta
      _ep('page_url',       '{{ET - JS page_url}}'),
      _ep('page_referrer',  '{{ET - JS page_referrer}}'),
      _ep('event_time',     '{{ET - JS timestamp}}'),
    ];

    const eventParams = [
      { type: 'template', key: 'eventName', value: ga4Ev },
      { type: 'list',     key: 'eventParameters', list: eventParameters },
    ];

    // User properties on conversion events (doubles as sGTM up.* source)
    if (['purchase', 'lead', 'sign_up', 'add_to_cart', 'initiate_checkout'].includes(key)) {
      eventParams.push({
        type: 'list', key: 'userProperties',
        list: [
          _upProp('em',          '{{ET - JS email_normalised}}'),
          _upProp('ph',          '{{ET - JS phone_normalised}}'),
          _upProp('fn',          '{{ET - JS fn_normalised}}'),
          _upProp('ln',          '{{ET - JS ln_normalised}}'),
          _upProp('external_id', '{{ET - DLV external_id}}'),
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
      tagFiringOption: 'oncePerEvent',
      notes: 'EasyTrac — GA4 event relayed to sGTM with full ep.* payload for CAPI fan-out.',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Meta Pixel — client-side (base + event tags)
  // ──────────────────────────────────────────────────────────────────────────
  if (px.meta) {
    const pid = px.meta;

    tags.push({
      name: 'ET - Meta Pixel Base',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
`<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${pid}',{
  em: '{{ET - JS email_normalised}}',
  ph: '{{ET - JS phone_normalised}}',
  fn: '{{ET - JS fn_normalised}}',
  ln: '{{ET - JS ln_normalised}}',
  extern_id: '{{ET - DLV external_id}}'
});
fbq('track','PageView',{},{eventID:'{{ET - DLV event_id}}'});
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
      notes: 'EasyTrac — Meta Pixel (client-side). eventID enables deduplication with CAPI.',
    });

    evList.forEach(key => {
      const mEv = META_EVENT[key];
      if (!mEv || key === 'page_view') return;
      const tid = trigMap[key];
      const isRevenue = key === 'purchase';
      tags.push({
        name: 'ET - Meta Pixel - ' + mEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'template', key: 'html', value:
`<script>
fbq('track','${mEv}',{
  value: parseFloat('{{ET - DLV value}}') || 0,
  currency: '{{ET - DLV currency}}',
  content_ids: [].concat('{{ET - DLV content_ids}}'),
  content_type: '{{ET - DLV content_type}}',
  content_name: '{{ET - DLV content_name}}',
  num_items: parseInt('{{ET - DLV num_items}}') || 1${isRevenue ? ",\n  order_id: '{{ET - DLV transaction_id}}'" : ''}
},{eventID:'{{ET - DLV event_id}}'});
</script>`,
        }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
        notes: `EasyTrac — Meta Pixel ${mEv}. eventID matches CAPI event_id for pixel/CAPI deduplication.`,
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TikTok Pixel — client-side
  // ──────────────────────────────────────────────────────────────────────────
  if (px.tiktok) {
    const tpid = px.tiktok;

    tags.push({
      name: 'ET - TikTok Pixel Base',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
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
  email: '{{ET - JS email_normalised}}',
  phone_number: '{{ET - JS phone_normalised}}',
  external_id: '{{ET - DLV external_id}}'
});
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    evList.forEach(key => {
      const ttEv = TIKTOK_EVENT[key];
      if (!ttEv || key === 'page_view') return;
      const tid = trigMap[key];
      tags.push({
        name: 'ET - TikTok Pixel - ' + ttEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'template', key: 'html', value:
`<script>
ttq.track('${ttEv}',{
  value: parseFloat('{{ET - DLV value}}') || 0,
  currency: '{{ET - DLV currency}}',
  contents: [{
    content_id: '{{ET - DLV content_ids}}',
    content_name: '{{ET - DLV content_name}}',
    quantity: parseInt('{{ET - DLV quantity}}') || 1,
    price: parseFloat('{{ET - DLV value}}') || 0
  }],
  order_id: '{{ET - DLV transaction_id}}'
},{event_id:'{{ET - DLV event_id}}'});
</script>`,
        }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Snapchat Pixel — client-side
  // ──────────────────────────────────────────────────────────────────────────
  if (px.snap) {
    const sid = px.snap;

    tags.push({
      name: 'ET - Snapchat Pixel Base',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
`<script>
(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){
a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};
a.queue=[];var s='script',r=t.createElement(s);r.async=!0;
r.src=n;var u=t.getElementsByTagName(s)[0];
u.parentNode.insertBefore(r,u);})(window,document,'https://sc-static.net/scevent.min.js');
snaptr('init','${sid}',{
  'user_email': '{{ET - JS email_normalised}}',
  'user_phone_number': '{{ET - JS phone_normalised}}'
});
snaptr('track','PAGE_VIEW');
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv || key === 'page_view') return;
      const tid = trigMap[key];
      tags.push({
        name: 'ET - Snapchat Pixel - ' + sEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'template', key: 'html', value:
`<script>
snaptr('track','${sEv}',{
  'price': parseFloat('{{ET - DLV value}}') || 0,
  'currency': '{{ET - DLV currency}}',
  'transaction_id': '{{ET - DLV transaction_id}}',
  'item_ids': [].concat('{{ET - DLV content_ids}}')
});
</script>`,
        }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Google Ads — Global Site Tag + Conversion Tracking
  // ──────────────────────────────────────────────────────────────────────────
  if (px.gads) {
    const convId    = px.gads;
    const convLabel = px.gads_label || '';

    tags.push({
      name: 'ET - Google Ads Global Site Tag',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
`<script async src="https://www.googletagmanager.com/gtag/js?id=${convId}"></script>
<script>
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
gtag('js',new Date());
gtag('config','${convId}',{'allow_enhanced_conversions':true});
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    if (convLabel) {
      tags.push({
        name: 'ET - Google Ads Conversion - Purchase',
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'template', key: 'html', value:
`<script>
gtag('event','conversion',{
  'send_to': '${convId}/${convLabel}',
  'value': parseFloat('{{ET - DLV value}}') || 0,
  'currency': '{{ET - DLV currency}}',
  'transaction_id': '{{ET - DLV transaction_id}}'
});
</script>`,
        }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [trigMap['purchase']].filter(Boolean),
        tagFiringOption: 'oncePerEvent',
      });
    }
  }

  return {
    exportFormatVersion: 2,
    containerVersion: { variable: variables, trigger: triggers, tag: tags },
    _meta: {
      createdBy: 'EasyTrac GTM Config Builder v3',
      architecture: 'Web GTM → GA4 (transport_url) → Server GTM (GA4 Client) → Platform APIs',
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
 * All CAPI tags reference custom sGTM templates (type: et_*_manual).
 * Import companion .tpl files from lib/server-side/sgtm-templates/ into the
 * sGTM workspace BEFORE importing this container JSON.
 *
 * Data flow inside sGTM:
 *   GA4 Client ← /g/collect (from browser → transport_url → sGTM)
 *     ↓
 *   Variables extract: ep.* event params, up.* user props, headers → IP/UA
 *     ↓
 *   Custom Template Tags → sendHttpRequest → Meta CAPI / TikTok / Snap / GAds
 *
 * @param {object}   opts
 * @param {string}   opts.ga4MeasurementId   — e.g. "G-XXXXXXXXXX"
 * @param {string}   opts.sgtmUrl            — sGTM server URL (informational)
 * @param {string[]} opts.platforms          — ['meta','tiktok','snap','gads']
 * @param {string[]} opts.events             — event keys
 * @param {object}   opts.pixelIds           — { meta, tiktok, snap, gads, gads_label }
 * @param {object}   opts.capiTokens         — { meta, tiktok, snap }
 */
function buildServerConfig({
  ga4MeasurementId, sgtmUrl, platforms = [], events = [],
  pixelIds = {}, capiTokens = {},
} = {}) {
  _reset();

  const ga4Id    = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';
  const px       = pixelIds   || {};
  const tok      = capiTokens || {};
  const evList   = Array.isArray(events)    ? events    : [];
  const platList = Array.isArray(platforms) ? platforms : [];

  // ── VARIABLES ─────────────────────────────────────────────────────────────

  const variables = [];

  // ── Constants ─────────────────────────────────────────────────────────────
  variables.push(cVar('ET - GA4 Measurement ID', ga4Id));
  if (sgtmUrl) variables.push(cVar('ET - sGTM URL', sgtmUrl));

  // Pixel IDs — referenced by custom template CAPI tags
  if (px.meta)       variables.push(cVar('ET - Meta Pixel ID',       px.meta));
  if (px.tiktok)     variables.push(cVar('ET - TikTok Pixel ID',     px.tiktok));
  if (px.snap)       variables.push(cVar('ET - Snapchat Pixel ID',   px.snap));
  if (px.gads)       variables.push(cVar('ET - Google Ads ID',       px.gads));
  if (px.gads_label) variables.push(cVar('ET - Google Ads Label',    px.gads_label));

  // CAPI access tokens — stored as constants in sGTM, never exposed to browser
  if (tok.meta)   variables.push(cVar('ET - Meta CAPI Token',      tok.meta));
  if (tok.tiktok) variables.push(cVar('ET - TikTok Events Token',   tok.tiktok));
  if (tok.snap)   variables.push(cVar('ET - Snapchat CAPI Token',   tok.snap));

  // ── Request Metadata ──────────────────────────────────────────────────────
  variables.push(smmVar('ET - event_name',    'event_name'));
  variables.push(smmVar('ET - page_location', 'page_location'));
  variables.push(smmVar('ET - page_referrer', 'page_referrer'));
  variables.push(smmVar('ET - page_hostname', 'page_hostname'));
  variables.push(smmVar('ET - page_path',     'page_path'));
  variables.push(smmVar('ET - debug_mode',    'debug_mode'));

  // ── HTTP Header Variables ─────────────────────────────────────────────────
  // x-forwarded-for is set by Cloud Run / load balancer ingress
  variables.push(headerVar('ET - Header client_ip',  'x-forwarded-for'));
  variables.push(headerVar('ET - Header user_agent', 'user-agent'));
  variables.push(headerVar('ET - Header origin',     'origin'));
  variables.push(headerVar('ET - Header referer',    'referer'));

  // NOTE: jsm (Custom JavaScript) is NOT supported in sGTM server containers.
  // ET - client_ip_clean is replaced by ET - Header client_ip directly in tags.
  // Alias constant so tags referencing this name still resolve to the raw header.
  variables.push(cVar('ET - client_ip_clean', '{{ET - Header client_ip}}'));

  // ── ep.* — Event Parameters extracted from GA4 hit body ──────────────────
  // Core ecommerce (sent as ep.* by Web GTM GA4 Event tags)
  variables.push(epVar('ET - ep event_id',       'event_id'));
  variables.push(epVar('ET - ep transaction_id', 'transaction_id'));
  variables.push(epVar('ET - ep currency',       'currency'));
  variables.push(epVar('ET - ep content_ids',    'content_ids'));
  variables.push(epVar('ET - ep content_name',   'content_name'));
  variables.push(epVar('ET - ep content_type',   'content_type'));
  variables.push(epVar('ET - ep items',          'items'));
  variables.push(epVar('ET - ep num_items',      'num_items'));
  variables.push(epVar('ET - ep search_string',  'search_string'));
  variables.push(epVar('ET - ep event_time',     'event_time'));

  // Click IDs forwarded from web container
  variables.push(epVar('ET - ep fbclid',   'fbclid'));
  variables.push(epVar('ET - ep gclid',    'gclid'));
  variables.push(epVar('ET - ep wbraid',   'wbraid'));
  variables.push(epVar('ET - ep gbraid',   'gbraid'));
  variables.push(epVar('ET - ep ttclid',   'ttclid'));
  variables.push(epVar('ET - ep ScCid',    'ScCid'));

  // Cookies forwarded as ep.*
  variables.push(epVar('ET - ep _fbp',    '_fbp'));
  variables.push(epVar('ET - ep _fbc',    '_fbc'));
  variables.push(epVar('ET - ep _ttp',    '_ttp'));
  variables.push(epVar('ET - ep _scid',   '_scid'));

  // UTM attribution
  variables.push(epVar('ET - ep utm_source',   'utm_source'));
  variables.push(epVar('ET - ep utm_medium',   'utm_medium'));
  variables.push(epVar('ET - ep utm_campaign', 'utm_campaign'));
  variables.push(epVar('ET - ep utm_content',  'utm_content'));
  variables.push(epVar('ET - ep utm_term',     'utm_term'));

  // ── epn.* — Numeric Event Parameters ─────────────────────────────────────
  variables.push(epVar('ET - epn value', 'value'));

  // ── up.* — User Properties from GA4 hit body ─────────────────────────────
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

  // ── Computed Variables ─────────────────────────────────────────────────────
  // jsm (Custom JavaScript) is NOT a valid variable type in sGTM server containers.
  // We use simple ep/up aliases instead — the sGTM tag templates handle fallback logic.
  variables.push(epVar('ET - event_time_unix', 'event_time'));   // alias: ep.event_time
  variables.push(epVar('ET - resolved_fbc',    '_fbc'));          // alias: ep._fbc
  variables.push(upVar('ET - resolved_fbp',    'fbp'));           // alias: up.fbp

  // ── TRIGGERS ──────────────────────────────────────────────────────────────

  const alwaysTid = nTid();
  const triggers = [
    {
      name: 'ET - All Events', type: 'always', triggerId: alwaysTid,
      notes: 'Fires on every event received by the GA4 Client — used by GA4 Forward tag.',
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

  // ── TAGS ──────────────────────────────────────────────────────────────────

  const tags = [];

  // GA4 Forward Tag
  tags.push({
    name: 'ET - GA4 Forward to Google Analytics',
    type: 'sgtmgaaw',
    tagId: nTagId(),
    parameter: [
      { type: 'template', key: 'measurementId', value: '{{ET - GA4 Measurement ID}}' },
    ],
    firingTriggerId: [alwaysTid],
    tagFiringOption: 'oncePerEvent',
    notes: 'EasyTrac — Forwards every GA4 hit received by sGTM onward to Google Analytics 4.',
  });

  // Meta CAPI — manual HTTP
  if (platList.includes('meta') && px.meta) {
    evList.forEach(key => {
      const mEv = META_EVENT[key];
      if (!mEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - Meta CAPI - ' + mEv,
        type: 'et_meta_capi_manual',
        tagId: nTagId(),
        parameter: [
          { type: 'template', key: 'pixelId',         value: '{{ET - Meta Pixel ID}}' },
          { type: 'template', key: 'accessToken',     value: '{{ET - Meta CAPI Token}}' },
          { type: 'template', key: 'eventName',       value: mEv },
          { type: 'template', key: 'eventId',         value: '{{ET - ep event_id}}' },
          { type: 'template', key: 'eventTime',       value: '{{ET - event_time_unix}}' },
          { type: 'template', key: 'actionSource',    value: 'website' },
          { type: 'template', key: 'sourceUrl',       value: '{{ET - page_location}}' },
          { type: 'template', key: 'value',           value: '{{ET - epn value}}' },
          { type: 'template', key: 'currency',        value: '{{ET - ep currency}}' },
          { type: 'template', key: 'orderId',         value: '{{ET - ep transaction_id}}' },
          { type: 'template', key: 'contentIds',      value: '{{ET - ep content_ids}}' },
          { type: 'template', key: 'contentName',     value: '{{ET - ep content_name}}' },
          { type: 'template', key: 'contentType',     value: '{{ET - ep content_type}}' },
          { type: 'template', key: 'numItems',        value: '{{ET - ep num_items}}' },
          { type: 'template', key: 'userEmail',       value: '{{ET - up em}}' },
          { type: 'template', key: 'userPhone',       value: '{{ET - up ph}}' },
          { type: 'template', key: 'userFirstName',   value: '{{ET - up fn}}' },
          { type: 'template', key: 'userLastName',    value: '{{ET - up ln}}' },
          { type: 'template', key: 'userCity',        value: '{{ET - up ct}}' },
          { type: 'template', key: 'userState',       value: '{{ET - up st}}' },
          { type: 'template', key: 'userZip',         value: '{{ET - up zp}}' },
          { type: 'template', key: 'userCountry',     value: '{{ET - up country}}' },
          { type: 'template', key: 'externalId',      value: '{{ET - up external_id}}' },
          { type: 'template', key: 'fbp',             value: '{{ET - resolved_fbp}}' },
          { type: 'template', key: 'fbc',             value: '{{ET - resolved_fbc}}' },
          { type: 'template', key: 'clientIpAddress', value: '{{ET - client_ip_clean}}' },
          { type: 'template', key: 'clientUserAgent', value: '{{ET - Header user_agent}}' },
          { type: 'boolean',  key: 'enableDebug',     value: 'false' },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
        notes: `EasyTrac — Meta CAPI ${mEv} (manual HTTP). Import meta-capi.tpl first.`,
      });
    });
  }

  // TikTok Events API — manual HTTP
  if (platList.includes('tiktok') && px.tiktok) {
    evList.forEach(key => {
      const ttEv = TIKTOK_EVENT[key];
      if (!ttEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - TikTok Events API - ' + ttEv,
        type: 'et_tiktok_events_manual',
        tagId: nTagId(),
        parameter: [
          { type: 'template', key: 'pixelCode',      value: '{{ET - TikTok Pixel ID}}' },
          { type: 'template', key: 'accessToken',    value: '{{ET - TikTok Events Token}}' },
          { type: 'template', key: 'eventName',      value: ttEv },
          { type: 'template', key: 'eventId',        value: '{{ET - ep event_id}}' },
          { type: 'template', key: 'eventTime',      value: '{{ET - event_time_unix}}' },
          { type: 'template', key: 'value',          value: '{{ET - epn value}}' },
          { type: 'template', key: 'currency',       value: '{{ET - ep currency}}' },
          { type: 'template', key: 'orderId',        value: '{{ET - ep transaction_id}}' },
          { type: 'template', key: 'contentIds',     value: '{{ET - ep content_ids}}' },
          { type: 'template', key: 'contentName',    value: '{{ET - ep content_name}}' },
          { type: 'template', key: 'quantity',       value: '{{ET - ep num_items}}' },
          { type: 'template', key: 'userEmail',      value: '{{ET - up em}}' },
          { type: 'template', key: 'userPhone',      value: '{{ET - up ph}}' },
          { type: 'template', key: 'externalId',     value: '{{ET - up external_id}}' },
          { type: 'template', key: 'ttclid',         value: '{{ET - ep ttclid}}' },
          { type: 'template', key: 'ttp',            value: '{{ET - up ttp}}' },
          { type: 'template', key: 'ipAddress',      value: '{{ET - client_ip_clean}}' },
          { type: 'template', key: 'userAgent',      value: '{{ET - Header user_agent}}' },
          { type: 'template', key: 'pageUrl',        value: '{{ET - page_location}}' },
          { type: 'template', key: 'referrer',       value: '{{ET - page_referrer}}' },
          { type: 'boolean',  key: 'enableDebug',    value: 'false' },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
        notes: `EasyTrac — TikTok Events API ${ttEv} (manual HTTP). Import tiktok-events.tpl first.`,
      });
    });
  }

  // Snapchat CAPI — manual HTTP
  if (platList.includes('snap') && px.snap) {
    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv) return;
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - Snapchat CAPI - ' + sEv,
        type: 'et_snapchat_capi_manual',
        tagId: nTagId(),
        parameter: [
          { type: 'template', key: 'pixelId',       value: '{{ET - Snapchat Pixel ID}}' },
          { type: 'template', key: 'accessToken',   value: '{{ET - Snapchat CAPI Token}}' },
          { type: 'template', key: 'eventType',     value: sEv },
          { type: 'template', key: 'eventId',       value: '{{ET - ep event_id}}' },
          { type: 'template', key: 'eventTime',     value: '{{ET - event_time_unix}}' },
          { type: 'template', key: 'price',         value: '{{ET - epn value}}' },
          { type: 'template', key: 'currency',      value: '{{ET - ep currency}}' },
          { type: 'template', key: 'transactionId', value: '{{ET - ep transaction_id}}' },
          { type: 'template', key: 'itemIds',       value: '{{ET - ep content_ids}}' },
          { type: 'template', key: 'userEmail',     value: '{{ET - up em}}' },
          { type: 'template', key: 'userPhone',     value: '{{ET - up ph}}' },
          { type: 'template', key: 'externalId',    value: '{{ET - up external_id}}' },
          { type: 'template', key: 'scid',          value: '{{ET - up scid}}' },
          { type: 'template', key: 'ScCid',         value: '{{ET - ep ScCid}}' },
          { type: 'template', key: 'ipAddress',     value: '{{ET - client_ip_clean}}' },
          { type: 'template', key: 'userAgent',     value: '{{ET - Header user_agent}}' },
          { type: 'template', key: 'pageUrl',       value: '{{ET - page_location}}' },
          { type: 'boolean',  key: 'enableDebug',   value: 'false' },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
        notes: `EasyTrac — Snapchat CAPI ${sEv} (manual HTTP). Import snapchat-capi.tpl first.`,
      });
    });
  }

  // Google Ads EC — manual HTTP
  if (platList.includes('gads') && px.gads) {
    evList.filter(k => GADS_EVENT[k]).forEach(key => {
      const tid = trigMap[key];
      if (!tid) return;
      tags.push({
        name: 'ET - Google Ads EC - ' + GADS_EVENT[key],
        type: 'et_gads_ec_manual',
        tagId: nTagId(),
        parameter: [
          { type: 'template', key: 'conversionActionId', value: '{{ET - Google Ads ID}}' },
          { type: 'template', key: 'conversionLabel',    value: '{{ET - Google Ads Label}}' },
          { type: 'template', key: 'eventId',            value: '{{ET - ep event_id}}' },
          { type: 'template', key: 'eventTime',          value: '{{ET - event_time_unix}}' },
          { type: 'template', key: 'value',              value: '{{ET - epn value}}' },
          { type: 'template', key: 'currency',           value: '{{ET - ep currency}}' },
          { type: 'template', key: 'orderId',            value: '{{ET - ep transaction_id}}' },
          { type: 'template', key: 'userEmail',          value: '{{ET - up em}}' },
          { type: 'template', key: 'userPhone',          value: '{{ET - up ph}}' },
          { type: 'template', key: 'userFirstName',      value: '{{ET - up fn}}' },
          { type: 'template', key: 'userLastName',       value: '{{ET - up ln}}' },
          { type: 'template', key: 'userCity',           value: '{{ET - up ct}}' },
          { type: 'template', key: 'userState',          value: '{{ET - up st}}' },
          { type: 'template', key: 'userZip',            value: '{{ET - up zp}}' },
          { type: 'template', key: 'userCountry',        value: '{{ET - up country}}' },
          { type: 'template', key: 'gclid',              value: '{{ET - ep gclid}}' },
          { type: 'template', key: 'wbraid',             value: '{{ET - ep wbraid}}' },
          { type: 'template', key: 'gbraid',             value: '{{ET - ep gbraid}}' },
          { type: 'boolean',  key: 'enableDebug',        value: 'false' },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
        notes: `EasyTrac — Google Ads EC ${GADS_EVENT[key]} (manual HTTP). Import google-ads-ec.tpl first.`,
      });
    });
  }

  // GA4 Client
  const client = [{
    name: 'ET - GA4 Client',
    type: 'gaaw_client',
    parameter: [
      { type: 'boolean', key: 'activateGoogleAnalytics', value: 'true' },
      { type: 'boolean', key: 'activateGtag',            value: 'true' },
    ],
    priority: 100,
    notes: 'EasyTrac — GA4 Client. Receives /g/collect via transport_url from web container.',
  }];

  return {
    exportFormatVersion: 2,
    containerVersion: { variable: variables, trigger: triggers, tag: tags, client },
    _meta: {
      createdBy: 'EasyTrac GTM Config Builder v3',
      architecture: 'Web GTM → GA4 (transport_url) → Server GTM (GA4 Client) → Platform APIs',
      capiMode: 'manual-http-custom-templates',
      officialTemplates: false,
      ga4Id, platforms: platList, events: evList,
    },
  };
}

module.exports = { buildWebConfig, buildServerConfig };                                                                                         