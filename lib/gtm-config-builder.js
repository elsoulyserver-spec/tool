'use strict';

/**
 * gtm-config-builder.js
 * Generates complete GTM container configs for Web + Server containers
 * based on the user's selections (GA4 ID, sGTM URL, pixel IDs, events).
 *
 * Web container includes:
 *   Variables : GA4 ID, sGTM URL, pixel ID constants, DLV (event_id, value,
 *               currency, transaction_id, user_data.*, content_ids, items,
 *               external_id), URL (utm_*, fbclid, gclid, ttclid),
 *               Cookie (_fbp, _fbc, _ga, _ttp), JS (timestamp, page_url, referrer)
 *   Triggers  : All Pages + one custom-event trigger per selected event
 *   Tags      : GA4 Configuration (transport_url → sGTM), GA4 Event tags,
 *               Meta Pixel (base + events), Google Ads (global + conversion),
 *               Snapchat Pixel, TikTok Pixel
 *
 * Server container includes:
 *   Variables : GA4 Measurement ID constant, server-model vars (event_name,
 *               event_id, value, currency, transaction_id, user_data.*,
 *               IP override, user-agent, timestamp)
 *   Client    : GA4 Client (receives /g/collect from web container)
 *   Triggers  : All Events, Purchase event
 *   Tags      : GA4 → Google Analytics forward tag
 */

// ─────────────────────────────────────────────────────────────────────────────
// ID counters (reset before each build so output is deterministic)
// ─────────────────────────────────────────────────────────────────────────────

let _tid = 100;
let _vid = 100;
let _tagId = 100;

function _reset() { _tid = 100; _vid = 100; _tagId = 100; }
function nTid()  { return String(++_tid); }
function nTagId(){ return String(++_tagId); }

// ─────────────────────────────────────────────────────────────────────────────
// Variable helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Constant variable */
function cVar(name, value) {
  return { name, type: 'c', variableId: String(++_vid),
    parameter: [{ type: 'template', key: 'value', value }] };
}

/** DataLayer variable (v2) */
function dlVar(name, dlKey, defaultVal) {
  const p = [
    { type: 'integer',  key: 'dataLayerVersion', value: '2' },
    { type: 'boolean',  key: 'setDefaultValue',  value: defaultVal !== undefined ? 'true' : 'false' },
    { type: 'template', key: 'name',              value: dlKey },
  ];
  if (defaultVal !== undefined)
    p.push({ type: 'template', key: 'defaultValue', value: String(defaultVal) });
  return { name, type: 'v', variableId: String(++_vid), parameter: p };
}

/** URL query-string variable */
function urlVar(name, queryKey) {
  return { name, type: 'u', variableId: String(++_vid), parameter: [
    { type: 'template', key: 'component', value: 'query' },
    { type: 'template', key: 'queryKey',  value: queryKey },
  ]};
}

/** First-party cookie variable */
function cookieVar(name, cookieName) {
  return { name, type: 'k', variableId: String(++_vid), parameter: [
    { type: 'template', key: 'name',   value: cookieName },
    { type: 'boolean',  key: 'decode', value: 'false' },
  ]};
}

/** Custom JavaScript variable */
function jsVar(name, fn) {
  return { name, type: 'jsm', variableId: String(++_vid),
    parameter: [{ type: 'template', key: 'javascript', value: fn }] };
}

/** Server-side model variable (sGTM) */
function smmVar(name, varType, extra) {
  const p = [{ type: 'template', key: 'varType', value: varType }];
  if (extra) Object.entries(extra).forEach(([k, v]) => p.push({ type: 'template', key: k, value: v }));
  return { name, type: 'smm', variableId: String(++_vid), parameter: p };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger helper
// ─────────────────────────────────────────────────────────────────────────────

function customEventTrigger(name, eventName, tid) {
  return {
    name, type: 'customEvent', triggerId: tid,
    customEventFilter: [{ type: 'equals', parameter: [
      { type: 'template', key: 'arg0', value: '{{_event}}' },
      { type: 'template', key: 'arg1', value: eventName },
    ]}],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event name mapping  (Easy Track key → GA4 / platform event names)
// ─────────────────────────────────────────────────────────────────────────────

const GA4_EVENT = {
  purchase:          'purchase',
  add_to_cart:       'add_to_cart',
  view_content:      'view_item',
  initiate_checkout: 'begin_checkout',
  page_view:         'page_view',
  lead:              'generate_lead',
  sign_up:           'sign_up',
  search:            'search',
};

const META_EVENT = {
  purchase:          'Purchase',
  add_to_cart:       'AddToCart',
  view_content:      'ViewContent',
  initiate_checkout: 'InitiateCheckout',
  lead:              'Lead',
  sign_up:           'CompleteRegistration',
};

const SNAP_EVENT = {
  purchase:          'PURCHASE',
  add_to_cart:       'ADD_CART',
  view_content:      'VIEW_CONTENT',
  initiate_checkout: 'START_CHECKOUT',
  lead:              'SIGN_UP',
};

const TIKTOK_EVENT = {
  purchase:          'PlaceAnOrder',
  add_to_cart:       'AddToCart',
  view_content:      'ViewContent',
  initiate_checkout: 'InitiateCheckout',
  lead:              'Contact',
  sign_up:           'CompleteRegistration',
};

// All known event keys (we create triggers for all, fire only for selected)
const ALL_EVENTS = Object.keys(GA4_EVENT);

// ─────────────────────────────────────────────────────────────────────────────
// WEB CONTAINER builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}   opts.ga4MeasurementId  — e.g. "G-XXXXXXXXXX"
 * @param {string}   opts.sgtmUrl           — e.g. "https://gtm.yourdomain.com"
 * @param {object}   opts.pixelIds          — { meta, gads, gads_label, snap, tiktok }
 * @param {string[]} opts.events            — selected event keys
 * @param {string}   opts.ecommPlatform     — 'salla' | 'zid' | ''
 */
function buildWebConfig({ ga4MeasurementId, sgtmUrl, pixelIds = {}, events = [], ecommPlatform = '' } = {}) {
  _reset();

  const ga4Id  = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';
  const sgtm   = (sgtmUrl || '').trim();
  const px     = pixelIds || {};
  const evList = Array.isArray(events) ? events : [];

  // ── VARIABLES ────────────────────────────────────────────────────────────

  const variables = [];

  // Constants
  variables.push(cVar('ET - GA4 Measurement ID', ga4Id));
  if (sgtm) variables.push(cVar('ET - sGTM URL', sgtm));
  if (px.meta)       variables.push(cVar('ET - Meta Pixel ID',         px.meta));
  if (px.gads)       variables.push(cVar('ET - Google Ads ID',         px.gads));
  if (px.gads_label) variables.push(cVar('ET - Google Ads Label',      px.gads_label));
  if (px.snap)       variables.push(cVar('ET - Snapchat Pixel ID',     px.snap));
  if (px.tiktok)     variables.push(cVar('ET - TikTok Pixel ID',       px.tiktok));

  // DataLayer variables — event data
  variables.push(dlVar('ET - DLV event_id',         'event_id',          ''));
  variables.push(dlVar('ET - DLV value',             'value',             '0'));
  variables.push(dlVar('ET - DLV currency',          'currency',          'SAR'));
  variables.push(dlVar('ET - DLV transaction_id',    'transaction_id',    ''));
  variables.push(dlVar('ET - DLV content_ids',       'content_ids',       ''));
  variables.push(dlVar('ET - DLV content_name',      'content_name',      ''));
  variables.push(dlVar('ET - DLV items',             'items',             ''));
  variables.push(dlVar('ET - DLV quantity',          'quantity',          '1'));

  // DataLayer variables — user data (pre-hashed SHA-256 by the DataLayer push)
  variables.push(dlVar('ET - DLV email hashed',     'user_data.em',      ''));
  variables.push(dlVar('ET - DLV phone hashed',     'user_data.ph',      ''));
  variables.push(dlVar('ET - DLV first_name',       'user_data.fn',      ''));
  variables.push(dlVar('ET - DLV last_name',        'user_data.ln',      ''));
  variables.push(dlVar('ET - DLV city',             'user_data.ct',      ''));
  variables.push(dlVar('ET - DLV country',          'user_data.country', ''));
  variables.push(dlVar('ET - DLV external_id',      'external_id',       ''));

  // URL variables — UTM parameters
  variables.push(urlVar('ET - URL utm_source',    'utm_source'));
  variables.push(urlVar('ET - URL utm_medium',    'utm_medium'));
  variables.push(urlVar('ET - URL utm_campaign',  'utm_campaign'));
  variables.push(urlVar('ET - URL utm_content',   'utm_content'));
  variables.push(urlVar('ET - URL utm_term',      'utm_term'));

  // URL variables — click IDs
  variables.push(urlVar('ET - URL fbclid',   'fbclid'));
  variables.push(urlVar('ET - URL gclid',    'gclid'));
  variables.push(urlVar('ET - URL ttclid',   'ttclid'));
  variables.push(urlVar('ET - URL msclkid',  'msclkid'));
  variables.push(urlVar('ET - URL kleid',    'kleid'));

  // Cookie variables
  variables.push(cookieVar('ET - Cookie _fbp', '_fbp'));
  variables.push(cookieVar('ET - Cookie _fbc', '_fbc'));
  variables.push(cookieVar('ET - Cookie _ga',  '_ga'));
  variables.push(cookieVar('ET - Cookie _ttp', '_ttp'));

  // JS custom variables
  variables.push(jsVar('ET - JS timestamp',
    'function(){return Math.floor(Date.now()/1000);}'));
  variables.push(jsVar('ET - JS page_url',
    'function(){return window.location.href;}'));
  variables.push(jsVar('ET - JS page_referrer',
    'function(){return document.referrer;}'));
  variables.push(jsVar('ET - JS page_title',
    'function(){return document.title;}'));

  // ── TRIGGERS ─────────────────────────────────────────────────────────────

  const allPagesTid = nTid();
  const triggers = [
    { name: 'ET - All Pages', type: 'pageview', triggerId: allPagesTid },
  ];

  // One trigger per event key (we build all, tags reference only selected ones)
  const trigMap = {};   // { eventKey: triggerId }
  ALL_EVENTS.forEach(key => {
    const tid = nTid();
    trigMap[key] = tid;
    triggers.push(customEventTrigger(
      'ET - Event ' + (GA4_EVENT[key] || key),
      GA4_EVENT[key] || key,
      tid,
    ));
  });

  // ── TAGS ─────────────────────────────────────────────────────────────────

  const tags = [];

  // ── GA4 Configuration ───────────────────────────────────────────────────
  const ga4ConfigParams = [
    { type: 'template', key: 'measurementId',  value: '{{ET - GA4 Measurement ID}}' },
    { type: 'template', key: 'sendPageView',   value: 'false' },
    // Always send user_id for cross-platform identity
    { type: 'template', key: 'userId',         value: '{{ET - DLV external_id}}' },
  ];
  if (sgtm) {
    ga4ConfigParams.push({ type: 'template', key: 'transport_url', value: '{{ET - sGTM URL}}' });
  }
  // User properties for Enhanced Conversions
  ga4ConfigParams.push({
    type: 'list', key: 'userProperties', list: [
      { type: 'map', map: [
        { type: 'template', key: 'name',  value: 'email' },
        { type: 'template', key: 'value', value: '{{ET - DLV email hashed}}' },
      ]},
      { type: 'map', map: [
        { type: 'template', key: 'name',  value: 'phone_number' },
        { type: 'template', key: 'value', value: '{{ET - DLV phone hashed}}' },
      ]},
      { type: 'map', map: [
        { type: 'template', key: 'name',  value: 'external_id' },
        { type: 'template', key: 'value', value: '{{ET - DLV external_id}}' },
      ]},
    ],
  });

  tags.push({
    name: 'ET - GA4 Configuration',
    type: 'gaawc',
    tagId: nTagId(),
    parameter: ga4ConfigParams,
    firingTriggerId: [allPagesTid],
    tagFiringOption: 'oncePerPage',
    notes: 'Easy Track — GA4 Configuration. transport_url routes hits through sGTM for server-side fan-out.',
  });

  // ── GA4 Event tags (one per selected event) ─────────────────────────────
  evList.forEach(key => {
    const ga4Ev = GA4_EVENT[key];
    if (!ga4Ev) return;
    const tid = trigMap[key];
    if (!tid) return;

    const eventParameters = [
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'event_id' },
                            { type: 'template', key: 'value', value: '{{ET - DLV event_id}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'value' },
                            { type: 'template', key: 'value', value: '{{ET - DLV value}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'currency' },
                            { type: 'template', key: 'value', value: '{{ET - DLV currency}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'transaction_id' },
                            { type: 'template', key: 'value', value: '{{ET - DLV transaction_id}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'items' },
                            { type: 'template', key: 'value', value: '{{ET - DLV items}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'content_ids' },
                            { type: 'template', key: 'value', value: '{{ET - DLV content_ids}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'content_name' },
                            { type: 'template', key: 'value', value: '{{ET - DLV content_name}}' }] },
      // Attribution
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'utm_source' },
                            { type: 'template', key: 'value', value: '{{ET - URL utm_source}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'utm_medium' },
                            { type: 'template', key: 'value', value: '{{ET - URL utm_medium}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'utm_campaign' },
                            { type: 'template', key: 'value', value: '{{ET - URL utm_campaign}}' }] },
      // Click IDs
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'fbclid' },
                            { type: 'template', key: 'value', value: '{{ET - URL fbclid}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'gclid' },
                            { type: 'template', key: 'value', value: '{{ET - URL gclid}}' }] },
      // Cookies
      { type: 'map', map: [{ type: 'template', key: 'name', value: '_fbp' },
                            { type: 'template', key: 'value', value: '{{ET - Cookie _fbp}}' }] },
      { type: 'map', map: [{ type: 'template', key: 'name', value: '_fbc' },
                            { type: 'template', key: 'value', value: '{{ET - Cookie _fbc}}' }] },
      // Timing
      { type: 'map', map: [{ type: 'template', key: 'name', value: 'timestamp' },
                            { type: 'template', key: 'value', value: '{{ET - JS timestamp}}' }] },
    ];

    const eventParams = [
      { type: 'template', key: 'eventName', value: ga4Ev },
      { type: 'list',     key: 'eventParameters', list: eventParameters },
    ];

    // Enhanced Conversions user data (purchase + lead)
    if (['purchase', 'lead', 'sign_up'].includes(key)) {
      eventParams.push({
        type: 'list', key: 'userProperties', list: [
          { type: 'map', map: [{ type: 'template', key: 'name', value: 'email' },
                                { type: 'template', key: 'value', value: '{{ET - DLV email hashed}}' }] },
          { type: 'map', map: [{ type: 'template', key: 'name', value: 'phone_number' },
                                { type: 'template', key: 'value', value: '{{ET - DLV phone hashed}}' }] },
          { type: 'map', map: [{ type: 'template', key: 'name', value: 'first_name' },
                                { type: 'template', key: 'value', value: '{{ET - DLV first_name}}' }] },
          { type: 'map', map: [{ type: 'template', key: 'name', value: 'last_name' },
                                { type: 'template', key: 'value', value: '{{ET - DLV last_name}}' }] },
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
    });
  });

  // ── Meta Pixel (client-side base + events) ──────────────────────────────
  if (px.meta) {
    const pid = px.meta;

    tags.push({
      name: 'ET - Meta Pixel Base',
      type: 'html',
      tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
          `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${pid}',{
  em: '{{ET - DLV email hashed}}',
  ph: '{{ET - DLV phone hashed}}',
  fn: '{{ET - DLV first_name}}',
  ln: '{{ET - DLV last_name}}',
  external_id: '{{ET - DLV external_id}}'
});
fbq('track','PageView');
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    evList.forEach(key => {
      const mEv = META_EVENT[key];
      if (!mEv) return;
      const tid = trigMap[key];

      let body = '';
      if (key === 'purchase') {
        body = `fbq('track','${mEv}',{
  value: '{{ET - DLV value}}',
  currency: '{{ET - DLV currency}}',
  content_ids: '{{ET - DLV content_ids}}',
  content_name: '{{ET - DLV content_name}}',
  order_id: '{{ET - DLV transaction_id}}',
  contents: '{{ET - DLV items}}'
},{eventID:'{{ET - DLV event_id}}'});`;
      } else if (['add_to_cart','view_content','initiate_checkout'].includes(key)) {
        body = `fbq('track','${mEv}',{
  value: '{{ET - DLV value}}',
  currency: '{{ET - DLV currency}}',
  content_ids: '{{ET - DLV content_ids}}',
  content_name: '{{ET - DLV content_name}}'
},{eventID:'{{ET - DLV event_id}}'});`;
      } else {
        body = `fbq('track','${mEv}',{
  value: '{{ET - DLV value}}',
  currency: '{{ET - DLV currency}}'
},{eventID:'{{ET - DLV event_id}}'});`;
      }

      tags.push({
        name: 'ET - Meta Pixel - ' + mEv,
        type: 'html', tagId: nTagId(),
        parameter: [
          { type: 'template', key: 'html', value: `<script>\n${body}\n</script>` },
          { type: 'boolean',  key: 'supportDocumentWrite', value: 'false' },
        ],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
      });
    });
  }

  // ── Google Ads ───────────────────────────────────────────────────────────
  if (px.gads) {
    const rawId    = px.gads.replace(/^AW-/i, '');
    const convId   = 'AW-' + rawId;
    const convLabel = px.gads_label || '';

    // Global site tag
    tags.push({
      name: 'ET - Google Ads Global Tag',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
          `<script async src="https://www.googletagmanager.com/gtag/js?id=${convId}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${convId}');
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    // Conversion tag (purchase)
    if (evList.includes('purchase') && convLabel) {
      tags.push({
        name: 'ET - Google Ads Conversion - Purchase',
        type: 'awct', tagId: nTagId(),
        parameter: [
          { type: 'template', key: 'conversionId',    value: rawId },
          { type: 'template', key: 'conversionLabel', value: convLabel },
          { type: 'template', key: 'revenue',         value: '{{ET - DLV value}}' },
          { type: 'template', key: 'currencyCode',    value: '{{ET - DLV currency}}' },
          { type: 'template', key: 'orderId',         value: '{{ET - DLV transaction_id}}' },
          { type: 'boolean',  key: 'enableEnhancedConversions', value: 'true' },
        ],
        firingTriggerId: [trigMap.purchase].filter(Boolean),
        tagFiringOption: 'oncePerEvent',
      });
    }

    // Remarketing tag
    tags.push({
      name: 'ET - Google Ads Remarketing',
      type: 'html', tagId: nTagId(),
      parameter: [{
        type: 'template', key: 'html', value:
          `<script>
gtag('event','page_view',{
  'send_to': '${convId}',
  'value': '{{ET - DLV value}}',
  'items': '{{ET - DLV items}}'
});
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });
  }

  // ── Snapchat Pixel ───────────────────────────────────────────────────────
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
a.queue=[];var s='script';r=t.createElement(s);r.async=!0;
r.src=n;var u=t.getElementsByTagName(s)[0];
u.parentNode.insertBefore(r,u);})(window,document,
'https://sc-static.net/scevent.min.js');
snaptr('init','${sid}',{
  'user_email': '{{ET - DLV email hashed}}',
  'user_phone_number': '{{ET - DLV phone hashed}}'
});
snaptr('track','PAGE_VIEW');
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    evList.forEach(key => {
      const sEv = SNAP_EVENT[key];
      if (!sEv) return;
      const tid = trigMap[key];
      tags.push({
        name: 'ET - Snapchat - ' + sEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'template', key: 'html', value:
            `<script>
snaptr('track','${sEv}',{
  'price': '{{ET - DLV value}}',
  'currency': '{{ET - DLV currency}}',
  'transaction_id': '{{ET - DLV event_id}}',
  'item_ids': '{{ET - DLV content_ids}}'
});
</script>`,
        }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
      });
    });
  }

  // ── TikTok Pixel ─────────────────────────────────────────────────────────
  if (px.tiktok) {
    const tid_px = px.tiktok;
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
ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)
ttq.setAndDefer(e,ttq.methods[n]);return e};
ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";
ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};
ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};
var o=document.createElement("script");o.type="text/javascript";o.async=!0;
o.src=i+"?sdkid="+e+"&lib="+t;
var a=document.getElementsByTagName("script")[0];
a.parentNode.insertBefore(o,a)};
ttq.load('${tid_px}');ttq.page();
}(window,document,'ttq');
ttq.identify({
  'email': '{{ET - DLV email hashed}}',
  'phone_number': '{{ET - DLV phone hashed}}',
  'external_id': '{{ET - DLV external_id}}'
});
</script>`,
      }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
      firingTriggerId: [allPagesTid],
      tagFiringOption: 'oncePerPage',
    });

    evList.forEach(key => {
      const ttEv = TIKTOK_EVENT[key];
      if (!ttEv) return;
      const tid = trigMap[key];
      tags.push({
        name: 'ET - TikTok - ' + ttEv,
        type: 'html', tagId: nTagId(),
        parameter: [{
          type: 'template', key: 'html', value:
            `<script>
ttq.track('${ttEv}',{
  value: '{{ET - DLV value}}',
  currency: '{{ET - DLV currency}}',
  contents: [{content_id:'{{ET - DLV content_ids}}',content_name:'{{ET - DLV content_name}}',quantity:1}],
  order_id: '{{ET - DLV event_id}}'
});
</script>`,
        }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }],
        firingTriggerId: [tid],
        tagFiringOption: 'oncePerEvent',
      });
    });
  }

  return {
    exportFormatVersion: 2,
    containerVersion: { variable: variables, trigger: triggers, tag: tags },
    _meta: { createdBy: 'Easy Track GTM Config Builder', ecommPlatform, ga4Id, sgtm },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER CONTAINER builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}   opts.ga4MeasurementId
 * @param {string}   opts.sgtmUrl
 * @param {string[]} opts.platforms  — enabled ad platforms e.g. ['meta','tiktok']
 * @param {string[]} opts.events
 */
function buildServerConfig({ ga4MeasurementId, sgtmUrl, platforms = [], events = [] } = {}) {
  _reset();

  const ga4Id = (ga4MeasurementId || '').trim() || 'G-XXXXXXXXXX';

  // ── VARIABLES ─────────────────────────────────────────────────────────────

  const variables = [
    cVar('ET - GA4 Measurement ID', ga4Id),

    // Server model variables — pulled from incoming GA4 hit
    smmVar('ET - event_name',      'event_name'),
    smmVar('ET - event_id',        'event_parameter', { varName: 'event_id' }),
    smmVar('ET - value',           'event_parameter', { varName: 'value' }),
    smmVar('ET - currency',        'event_parameter', { varName: 'currency' }),
    smmVar('ET - transaction_id',  'event_parameter', { varName: 'transaction_id' }),
    smmVar('ET - content_ids',     'event_parameter', { varName: 'content_ids' }),
    smmVar('ET - items',           'event_parameter', { varName: 'items' }),
    smmVar('ET - fbclid',          'event_parameter', { varName: 'fbclid' }),
    smmVar('ET - gclid',           'event_parameter', { varName: 'gclid' }),
    smmVar('ET - _fbp',            'event_parameter', { varName: '_fbp' }),
    smmVar('ET - _fbc',            'event_parameter', { varName: '_fbc' }),
    smmVar('ET - utm_source',      'event_parameter', { varName: 'utm_source' }),
    smmVar('ET - utm_medium',      'event_parameter', { varName: 'utm_medium' }),
    smmVar('ET - utm_campaign',    'event_parameter', { varName: 'utm_campaign' }),

    // User data (hashed by client)
    smmVar('ET - user_email',      'user_property', { varName: 'email' }),
    smmVar('ET - user_phone',      'user_property', { varName: 'phone_number' }),
    smmVar('ET - user_first_name', 'user_property', { varName: 'first_name' }),
    smmVar('ET - user_last_name',  'user_property', { varName: 'last_name' }),
    smmVar('ET - external_id',     'user_property', { varName: 'external_id' }),

    // Request metadata
    smmVar('ET - IP Address',    'ip_override'),
    smmVar('ET - User Agent',    'user_agent'),
    smmVar('ET - Page URL',      'page_location'),
    smmVar('ET - Page Referrer', 'page_referrer'),

    jsVar('ET - Timestamp', 'function(){return Math.floor(Date.now()/1000);}'),
  ];

  // ── TRIGGERS ──────────────────────────────────────────────────────────────

  const alwaysTid   = nTid();
  const purchaseTid = nTid();

  const triggers = [
    { name: 'ET - All Events',    type: 'always', triggerId: alwaysTid },
    {
      name: 'ET - Purchase', type: 'customEvent', triggerId: purchaseTid,
      customEventFilter: [{ type: 'equals', parameter: [
        { type: 'template', key: 'arg0', value: '{{ET - event_name}}' },
        { type: 'template', key: 'arg1', value: 'purchase' },
      ]}],
    },
  ];

  // ── TAGS ──────────────────────────────────────────────────────────────────

  const tags = [
    // GA4 → Google Analytics forward (always on)
    {
      name: 'ET - GA4 Forward to Google',
      type: 'sgtmgaaw',
      tagId: nTagId(),
      parameter: [{ type: 'template', key: 'measurementId', value: '{{ET - GA4 Measurement ID}}' }],
      firingTriggerId: [alwaysTid],
      tagFiringOption: 'oncePerEvent',
      notes: 'Easy Track — Forwards every GA4 event received by sGTM onward to Google Analytics.',
    },
  ];

  // ── GA4 Client ─────────────────────────────────────────────────────────────

  const client = [{
    name: 'ET - GA4 Client',
    type: 'gaaw_client',
    parameter: [
      { type: 'boolean', key: 'activateGoogleAnalytics', value: 'true' },
      { type: 'boolean', key: 'activateGtag',            value: 'true' },
    ],
    priority: 100,
    notes: 'Receives /g/collect requests forwarded from the web container via transport_url.',
  }];

  return {
    exportFormatVersion: 2,
    containerVersion: { variable: variables, trigger: triggers, tag: tags },
    client,
    _meta: { createdBy: 'Easy Track GTM Config Builder', ga4Id, platforms, events },
  };
}

module.exports = { buildWebConfig, buildServerConfig };
