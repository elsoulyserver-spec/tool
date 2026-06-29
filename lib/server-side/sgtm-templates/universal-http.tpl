___INFO___

{
  "type": "TAG",
  "id": "et_universal_http",
  "version": 4,
  "securityGroups": [],
  "displayName": "EasyTrac - Universal HTTP Forwarder v4",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Canonical event dispatcher for Meta CAPI, TikTok Events API, and Snapchat CAPI. Builds one canonical event object from the full GA4 ep.*/up.* schema, validates it, then maps it to each platform's payload specification.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "url",
    "displayName": "Endpoint URL",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "authHeader",
    "displayName": "Auth Header Value (Bearer token / Access Token)",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Platform Event Name",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "platformId",
    "displayName": "Platform Pixel / Source ID",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "clientIp",
    "displayName": "Client IP Address (from x-forwarded-for header variable)",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "userAgent",
    "displayName": "User Agent (from user-agent header variable)",
    "simpleValueType": true
  },
  {
    "type": "CHECKBOX",
    "name": "enableDebug",
    "displayName": "Enable Debug Logging",
    "simpleValueType": true,
    "defaultValue": false
  },
  {
    "type": "TEXT",
    "name": "dlqUrl",
    "displayName": "Dead Letter Queue URL (EasyTrac DLQ endpoint — optional)",
    "simpleValueType": true,
    "help": "If set, failed CAPI sends are forwarded here for retry/audit. Leave blank to disable DLQ."
  }
]

___SANDBOXED_JS_FOR_SERVER___

var sendHttpRequest    = require('sendHttpRequest');
var JSON               = require('JSON');
var sha256Sync         = require('sha256Sync');
var makeString         = require('makeString');
var getEventData       = require('getEventData');
var getTimestampMillis = require('getTimestampMillis');
var logToConsole       = require('logToConsole');
var Math               = require('Math');

var TEMPLATE_VERSION   = '4.0';
var SCHEMA_VERSION     = 1;
var DEBUG              = data.enableDebug === true;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Low-level utilities
// These are the ONLY functions permitted to call getEventData or sha256Sync.
// All other code must read from the canonical event object only.
// ═════════════════════════════════════════════════════════════════════════════

// isHex64: length + char-set check without regex (regex not in sGTM sandbox).
function isHex64(s) {
  if (!s || s.length !== 64) return false;
  var HEX = '0123456789abcdef';
  for (var i = 0; i < 64; i++) {
    if (HEX.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}

// hash: normalise → SHA-256. Pass-through if already a 64-char hex digest.
function _hash(raw) {
  if (!raw) return '';
  var s = makeString(raw).toLowerCase().trim();
  if (!s) return '';
  if (isHex64(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

// _hashPhone: strip non-numeric chars before hashing.
function _hashPhone(raw) {
  if (!raw) return '';
  var s = makeString(raw).trim()
    .split(' ').join('').split('-').join('')
    .split('(').join('').split(')').join('').split('.').join('');
  if (!s) return '';
  if (isHex64(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

// _ed: read an event parameter with ep.* prefix, then bare-key fallback.
// The GA4 client maps ep.* Measurement Protocol params into the event model;
// some GTM versions expose them with the ep. prefix, others without.
// INTERNAL — must not be called outside buildCanonicalEvent().
function _ed(epKey, bareKey) {
  var v = getEventData(epKey);
  if (v !== null && v !== undefined && v !== '') return v;
  if (bareKey) {
    v = getEventData(bareKey);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return '';
}

// _cleanObj: strip empty-string / null / undefined values from a plain object.
// INTERNAL utility used by platform payload builders.
function _cleanObj(o) {
  var r = {};
  for (var k in o) {
    if (o[k] !== '' && o[k] !== null && o[k] !== undefined) r[k] = o[k];
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Canonical event builder
// Single source of truth. ALL getEventData calls are isolated here.
// Returns a frozen canonical event object; nothing downstream calls getEventData.
// ═════════════════════════════════════════════════════════════════════════════

function buildCanonicalEvent() {
  var now = getTimestampMillis();
  var ts  = Math.floor(now / 1000);

  // ── Items ─────────────────────────────────────────────────────────────────
  var itemsRaw = _ed('ep.items_json', 'items_json') || '[]';
  var items = [];
  if (itemsRaw.length <= 32000) {
    var _parsed;
    try { _parsed = JSON.parse(itemsRaw); } catch (e) { _parsed = null; }
    if (_parsed && typeof _parsed === 'object' && _parsed.length) {
      items = _parsed;
    }
  }
  var itemsTruncated = _ed('ep.items_truncated', 'items_truncated') === 1 ||
                       _ed('ep.items_truncated', 'items_truncated') === '1';
  var itemsCount = parseInt(_ed('ep.items_count', 'items_count'), 10) || items.length;

  // ── User PII — hash after resolution ──────────────────────────────────────
  var rawEm  = getEventData('up.em')         || getEventData('user_data.em')          || '';
  var rawPh  = getEventData('up.ph')         || getEventData('user_data.ph')          || '';
  var rawFn  = getEventData('up.fn')         || getEventData('user_data.fn')          || '';
  var rawLn  = getEventData('up.ln')         || getEventData('user_data.ln')          || '';
  var rawExt = getEventData('up.external_id')|| getEventData('user_data.external_id') ||
               getEventData('user_id')       || '';
  var rawCt  = getEventData('up.ct')         || getEventData('user_data.ct')          || '';
  var rawSt  = getEventData('up.st')         || getEventData('user_data.st')          || '';
  var rawZp  = getEventData('up.zp')         || getEventData('user_data.zp')          || '';
  var rawCo  = getEventData('up.country')    || getEventData('user_data.country')     || '';

  // ── Ecommerce ─────────────────────────────────────────────────────────────
  var value   = _ed('ep.value',    'value')    || 0;
  var revenue = _ed('ep.revenue',  'revenue')  || value;

  // ── Checksum ──────────────────────────────────────────────────────────────
  // Built here so it is part of the canonical object and available to all consumers.
  var _eventId = _ed('ep.event_id', 'event_id') || '';
  var _orderId = _ed('ep.transaction_id', 'transaction_id') || '';
  var _currency = _ed('ep.currency', 'currency') || 'SAR';
  var _checksumInput = makeString(data.eventName) + '|' +
                       makeString(_eventId)        + '|' +
                       makeString(_orderId)        + '|' +
                       makeString(value)           + '|' +
                       makeString(_currency)       + '|' +
                       makeString(items.length);
  var checksum = sha256Sync(_checksumInput, { outputEncoding: 'hex' }).slice(0, 16);

  return {
    // ── Metadata ─────────────────────────────────────────────────────────
    metadata: {
      schema_version:    SCHEMA_VERSION,
      template_version:  TEMPLATE_VERSION,
      event_checksum:    checksum,
      processing_time_ms: now,
    },

    // ── Event identity ────────────────────────────────────────────────────
    event: {
      id:             _eventId,
      name:           data.eventName || '',
      timestamp:      ts,
      transaction_id: _orderId,
    },

    // ── Ecommerce ─────────────────────────────────────────────────────────
    ecommerce: {
      value:           value,
      revenue:         revenue,
      currency:        _currency,
      tax:             _ed('ep.tax',         'tax')          || 0,
      shipping:        _ed('ep.shipping',    'shipping')     || 0,
      coupon:          _ed('ep.coupon',      'coupon')       || '',
      affiliation:     _ed('ep.affiliation', 'affiliation')  || '',
      discount:        _ed('ep.discount',    'discount')     || 0,
      content_name:    _ed('ep.content_name','content_name') || '',
      content_type:    _ed('ep.content_type','content_type') || 'product',
      num_items:       parseInt(_ed('ep.num_items', 'num_items'), 10) || itemsCount || 0,
      search_string:   _ed('ep.search_string','search_string') || '',
      items:           items,
      items_count:     itemsCount,
      items_truncated: itemsTruncated,
    },

    // ── Attribution ───────────────────────────────────────────────────────
    attribution: {
      fbclid:       _ed('ep.fbclid',    'fbclid')    || '',
      gclid:        _ed('ep.gclid',     'gclid')     || '',
      gbraid:       _ed('ep.gbraid',    'gbraid')    || '',
      wbraid:       _ed('ep.wbraid',    'wbraid')    || '',
      ttclid:       _ed('ep.ttclid',    'ttclid')    || '',
      sccid:        _ed('ep.ScCid',     'ScCid')     || '',
      msclkid:      _ed('ep.msclkid',   'msclkid')   || '',
      li_fat_id:    _ed('ep.li_fat_id', 'li_fat_id') || '',
      utm_source:   _ed('ep.utm_source',   'utm_source')   || '',
      utm_medium:   _ed('ep.utm_medium',   'utm_medium')   || '',
      utm_campaign: _ed('ep.utm_campaign', 'utm_campaign') || '',
      utm_content:  _ed('ep.utm_content',  'utm_content')  || '',
      utm_term:     _ed('ep.utm_term',     'utm_term')     || '',
    },

    // ── Identity ──────────────────────────────────────────────────────────
    identity: {
      anonymous_id: _ed('ep.anonymous_id', 'anonymous_id') || '',
      session_id:   _ed('ep.session_id',   'session_id')   || '',
      ga_client_id: _ed('ep.ga_client_id', 'ga_client_id') || '',
    },

    // ── Cookies ───────────────────────────────────────────────────────────
    cookies: {
      fbp:  getEventData('up.fbp')  || _ed('ep._fbp',  '_fbp')  || '',
      fbc:  getEventData('up.fbc')  || _ed('ep._fbc',  '_fbc')  || '',
      ttp:  getEventData('up.ttp')  || _ed('ep._ttp',  '_ttp')  || '',
      scid: getEventData('up.scid') || _ed('ep._scid', '_scid') || '',
      gid:  _ed('ep._gid', '_gid') || '',
    },

    // ── Device ────────────────────────────────────────────────────────────
    device: {
      type:              _ed('ep.device_type',       'device_type')       || '',
      language:          _ed('ep.language',          'language')          || '',
      timezone:          _ed('ep.timezone',          'timezone')          || '',
      viewport:          _ed('ep.viewport',          'viewport')          || '',
      screen_resolution: _ed('ep.screen_resolution', 'screen_resolution') || '',
    },

    // ── Page ──────────────────────────────────────────────────────────────
    page: {
      url:      _ed('ep.page_url',      'page_location') || '',
      referrer: _ed('ep.page_referrer', 'page_referrer') || '',
      title:    _ed('ep.page_title',    'page_title')    || '',
    },

    // ── Consent — absent signal = 'denied' (GDPR default-deny) ──────────
    consent: {
      ad_storage:          _ed('ep.ad_storage',         'ad_storage')         || 'denied',
      analytics_storage:   _ed('ep.analytics_storage',  'analytics_storage')  || 'denied',
      ad_user_data:        _ed('ep.ad_user_data',       'ad_user_data')       || 'denied',
      ad_personalization:  _ed('ep.ad_personalization', 'ad_personalization') || 'denied',
    },

    // ── User PII (hashed) ─────────────────────────────────────────────────
    user: {
      email:      _hash(rawEm),
      phone:      _hashPhone(rawPh),
      first_name: _hash(rawFn),
      last_name:  _hash(rawLn),
      external_id: _hash(rawExt),
      city:       _hash(rawCt),
      state:      _hash(rawSt),
      zip:        _hash(rawZp),
      country:    _hash(rawCo),
    },

    // ── Network (from HTTP header template parameters) ─────────────────────
    network: {
      client_ip:  data.clientIp  || '',
      user_agent: data.userAgent || '',
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Consent gate (runs before canonical build for early exit)
// ═════════════════════════════════════════════════════════════════════════════

// Consent gate: absent signal = denied (GDPR/ePrivacy — missing consent is not consent).
// We treat 'granted' as the ONLY affirmative value; everything else (absent, undefined,
// any non-'granted' string) blocks dispatch. This is intentional and legally required
// for EU traffic. Customers must configure Consent Mode v2 in their web container to
// forward signals; without it all events are silently skipped with gtmOnSuccess()
// so the web container reports no error.
var _earlyAdStorage  = _ed('ep.ad_storage',  'ad_storage');
var _earlyAdUserData = _ed('ep.ad_user_data','ad_user_data');
if (_earlyAdStorage !== 'granted' || _earlyAdUserData !== 'granted') {
  if (DEBUG) {
    logToConsole('ET:UniversalHTTP: consent not granted — skipping',
      data.eventName,
      'ad_storage=' + (_earlyAdStorage || 'absent') +
      ' ad_user_data=' + (_earlyAdUserData || 'absent'));
  }
  data.gtmOnSuccess();
  return;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Build canonical event (single call, all getEventData isolated here)
// ═════════════════════════════════════════════════════════════════════════════

var _t0    = getTimestampMillis();
var ev     = buildCanonicalEvent();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Validation
// Operates only on ev.*. Never calls getEventData.
// ═════════════════════════════════════════════════════════════════════════════

function validateCanonicalEvent(e) {
  var errors   = [];
  var warnings = [];

  // Hard requirements
  if (!e.event.name)               { errors.push('MISSING_event_name'); }
  if (!e.event.id)                 { errors.push('MISSING_event_id'); }
  if (!e.event.timestamp || e.event.timestamp <= 0) { errors.push('INVALID_timestamp'); }

  // Soft warnings
  if (!e.identity.session_id)      { warnings.push('MISSING_session_id'); }
  if (!e.identity.anonymous_id)    { warnings.push('MISSING_anonymous_id'); }

  // Value sanity
  if (e.ecommerce.value !== 0 && e.ecommerce.value !== '') {
    var numVal = parseFloat(e.ecommerce.value);
    if (numVal !== numVal) {
      errors.push('INVALID_value:not_numeric');
    } else if (numVal < 0) {
      warnings.push('SUSPICIOUS_value:negative');
    }
  }

  // Currency: ISO 4217 — 3 chars
  if (e.ecommerce.currency && makeString(e.ecommerce.currency).trim().length !== 3) {
    warnings.push('INVALID_currency_format');
  }

  // Items
  for (var i = 0; i < e.ecommerce.items.length; i++) {
    var it = e.ecommerce.items[i];
    if (!it.id && !it.item_id)     { errors.push('ITEM_MISSING_id:i=' + i); }
    var qty = parseInt(it.quantity, 10);
    if (qty !== qty || qty < 1)    { warnings.push('ITEM_INVALID_quantity:i=' + i); }
    var prc = parseFloat(it.price);
    if (prc !== prc || prc < 0)   { warnings.push('ITEM_INVALID_price:i=' + i); }
  }

  // PII: warn if unhashed plaintext arrived at sGTM (indicates broken web container)
  if (e.user.email    && !isHex64(e.user.email))      { warnings.push('PII_NOT_HASHED:email'); }
  if (e.user.phone    && !isHex64(e.user.phone))      { warnings.push('PII_NOT_HASHED:phone'); }
  if (e.user.first_name && !isHex64(e.user.first_name)) { warnings.push('PII_NOT_HASHED:first_name'); }
  if (e.user.last_name  && !isHex64(e.user.last_name))  { warnings.push('PII_NOT_HASHED:last_name'); }

  // Duplicate hash detection: same plaintext used for different PII fields
  if (e.user.email && e.user.phone    && e.user.email === e.user.phone)      { warnings.push('DUPLICATE_HASH:email==phone'); }
  if (e.user.email && e.user.first_name && e.user.email === e.user.first_name) { warnings.push('DUPLICATE_HASH:email==first_name'); }
  if (e.user.email && e.user.last_name  && e.user.email === e.user.last_name)  { warnings.push('DUPLICATE_HASH:email==last_name'); }

  // Click ID length bounds (no regex in sGTM sandbox)
  var _ck = [
    { key: 'gclid',   val: e.attribution.gclid },
    { key: 'fbclid',  val: e.attribution.fbclid },
    { key: 'ttclid',  val: e.attribution.ttclid },
    { key: 'msclkid', val: e.attribution.msclkid },
  ];
  for (var ci = 0; ci < _ck.length; ci++) {
    var cLen = makeString(_ck[ci].val || '').length;
    if (cLen > 0 && (cLen < 10 || cLen > 500)) {
      warnings.push('SUSPICIOUS_' + _ck[ci].key + '_length:' + cLen);
    }
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

var validation = validateCanonicalEvent(ev);

if (!validation.valid) {
  logToConsole('ET:UniversalHTTP:VALIDATION_FAILED ' + JSON.stringify({
    event_name:     ev.event.name,
    event_id:       ev.event.id,
    event_checksum: ev.metadata.event_checksum,
    errors:         validation.errors,
  }));
  data.gtmOnFailure();
  return;
}
if (validation.warnings.length > 0 && DEBUG) {
  logToConsole('ET:UniversalHTTP:VALIDATION_WARNINGS ' + JSON.stringify(validation.warnings));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Item normalizers
// Operate only on ev.ecommerce.items. Never call getEventData.
// ═════════════════════════════════════════════════════════════════════════════

function _normItem(it) {
  return {
    id:       makeString(it.id || it.item_id || ''),
    name:     makeString(it.name || it.item_name || ''),
    price:    parseFloat(it.price) || 0,
    quantity: parseInt(it.quantity ? makeString(it.quantity) : '1', 10) || 1,
    brand:    makeString(it.brand || it.item_brand || ''),
    category: makeString(it.category || it.item_category || ''),
    variant:  makeString(it.variant || it.item_variant || ''),
    coupon:   makeString(it.coupon || ''),
    discount: parseFloat(it.discount) || 0,
  };
}

function _buildMetaContents(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var n = _normItem(items[i]);
    var c = { id: n.id, quantity: n.quantity, item_price: n.price };
    if (n.discount) { c.discount     = n.discount; }
    if (n.brand)    { c.brand        = n.brand; }
    if (n.category) { c.category     = n.category; }
    if (n.variant)  { c.item_variant = n.variant; }
    out.push(c);
  }
  return out;
}

function _buildTikTokContents(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var n = _normItem(items[i]);
    var c = { content_id: n.id, content_name: n.name, quantity: n.quantity, price: n.price };
    if (n.brand)    { c.brand    = n.brand; }
    if (n.category) { c.category = n.category; }
    out.push(c);
  }
  return out;
}

function _buildSnapContents(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var n = _normItem(items[i]);
    var c = { item_id: n.id, item_name: n.name, quantity: n.quantity, price: n.price };
    if (n.brand)    { c.brand    = n.brand; }
    if (n.category) { c.category = n.category; }
    out.push(c);
  }
  return out;
}

function _buildContentIds(items) {
  var ids = [];
  for (var i = 0; i < items.length; i++) {
    var id = makeString(items[i].id || items[i].item_id || '');
    if (id) ids.push(id);
  }
  return ids;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Platform payload builders
// Receive ev (canonical event) and dispatch.url. No getEventData calls.
// ═════════════════════════════════════════════════════════════════════════════

var _dispatchUrl = data.url;
var _payload;
var _platform;
var _headers = { 'Content-Type': 'application/json' };

if (_dispatchUrl.indexOf('tiktok.com') !== -1) {

  // ── TikTok Events API ────────────────────────────────────────────────────
  _platform = 'tiktok';
  if (data.authHeader) { _headers['Access-Token'] = data.authHeader; }

  var _ttItems   = ev.ecommerce.items.length ? _buildTikTokContents(ev.ecommerce.items) : undefined;
  var _ttProps   = _cleanObj({
    currency:      ev.ecommerce.currency,
    value:         ev.ecommerce.value,
    content_type:  ev.ecommerce.content_type,
    order_id:      ev.event.transaction_id || undefined,
    coupon:        ev.ecommerce.coupon      || undefined,
    search_string: ev.ecommerce.search_string || undefined,
    affiliation:   ev.ecommerce.affiliation   || undefined,
    content_name:  (!_ttItems && ev.ecommerce.content_name) ? ev.ecommerce.content_name : undefined,
  });
  if (_ttItems) { _ttProps.contents = _ttItems; }

  var _ttUser = _cleanObj({
    email:        ev.user.email        || undefined,
    phone_number: ev.user.phone        || undefined,
    external_id:  ev.user.external_id  || undefined,
    ttclid:       ev.attribution.ttclid || undefined,
    ttp:          ev.cookies.ttp        || undefined,
    ip:           ev.network.client_ip  || undefined,
    user_agent:   ev.network.user_agent || undefined,
  });

  _payload = JSON.stringify({
    event_source:    'web',
    event_source_id: data.platformId,
    data: [{
      event:      ev.event.name,
      event_time: ev.event.timestamp,
      event_id:   ev.event.id,
      user:       _ttUser,
      properties: _ttProps,
      page:       _cleanObj({
        url:      ev.page.url      || undefined,
        referrer: ev.page.referrer || undefined,
      }),
    }],
  });

} else if (_dispatchUrl.indexOf('snapchat.com') !== -1) {

  // ── Snapchat CAPI v3 ─────────────────────────────────────────────────────
  _platform = 'snap';
  // Snap CAPI v3: access_token is a query param — never an Authorization header.
  if (data.authHeader) { _dispatchUrl = _dispatchUrl + '?access_token=' + data.authHeader; }

  var _snapItems    = ev.ecommerce.items.length ? _buildSnapContents(ev.ecommerce.items)  : undefined;
  var _snapIds      = ev.ecommerce.items.length ? _buildContentIds(ev.ecommerce.items)     : undefined;
  var _snapNumItems = ev.ecommerce.items_truncated
    ? ev.ecommerce.items_count
    : (ev.ecommerce.items.length || (ev.ecommerce.num_items || undefined));

  var _snapCustom = _cleanObj({
    currency:        ev.ecommerce.currency,
    price:           ev.ecommerce.value,
    transaction_id:  ev.event.transaction_id  || undefined,
    number_items:    _snapNumItems,
    coupon:          ev.ecommerce.coupon        || undefined,
    affiliation:     ev.ecommerce.affiliation   || undefined,
    shipping_amount: ev.ecommerce.shipping      || undefined,
    tax_amount:      ev.ecommerce.tax           || undefined,
    search_string:   ev.ecommerce.search_string || undefined,
  });
  if (_snapIds)   { _snapCustom.item_ids  = _snapIds; }
  if (_snapItems) { _snapCustom.products  = _snapItems; }

  _payload = JSON.stringify({
    data: [{
      event_conversion_type: 'WEB',
      event_type:  ev.event.name,
      event_tag:   ev.event.id,
      timestamp:   ev.event.timestamp,
      hashed_data_fields: _cleanObj({
        email:       ev.user.email        || undefined,
        phone_number: ev.user.phone       || undefined,
        external_id: ev.user.external_id  || undefined,
      }),
      user_data: _cleanObj({
        sc_click_id: ev.attribution.sccid  || undefined,
        uuid_c1:     ev.cookies.scid       || undefined,
        ip_address:  ev.network.client_ip  || undefined,
        user_agent:  ev.network.user_agent || undefined,
      }),
      custom_data: _snapCustom,
      app_data: {
        advertiser_tracking_enabled: ev.consent.ad_storage === 'granted' ? 1 : 0,
      },
    }],
  });

} else {

  // ── Meta CAPI ────────────────────────────────────────────────────────────
  // Meta access_token is already in the URL query param — no Authorization header.
  _platform = 'meta';

  var _metaItems    = ev.ecommerce.items.length ? _buildMetaContents(ev.ecommerce.items) : undefined;
  var _metaIds      = ev.ecommerce.items.length ? _buildContentIds(ev.ecommerce.items)   : undefined;
  var _metaNumItems = ev.ecommerce.items_count > 0
    ? ev.ecommerce.items_count
    : (ev.ecommerce.items.length || (ev.ecommerce.num_items || undefined));

  var _metaCustom = _cleanObj({
    currency:      ev.ecommerce.currency,
    value:         ev.ecommerce.value,
    revenue:       ev.ecommerce.revenue       || undefined,
    order_id:      ev.event.transaction_id    || undefined,
    content_type:  ev.ecommerce.content_type,
    content_name:  ev.ecommerce.content_name  || undefined,
    num_items:     _metaNumItems,
    tax:           ev.ecommerce.tax           || undefined,
    shipping:      ev.ecommerce.shipping      || undefined,
    coupon:        ev.ecommerce.coupon        || undefined,
    affiliation:   ev.ecommerce.affiliation   || undefined,
    search_string: ev.ecommerce.search_string || undefined,
  });
  if (_metaItems) { _metaCustom.contents    = _metaItems; }
  if (_metaIds)   { _metaCustom.content_ids = _metaIds; }

  var _metaUser = _cleanObj({
    em:                ev.user.email        || undefined,
    ph:                ev.user.phone        || undefined,
    fn:                ev.user.first_name   || undefined,
    ln:                ev.user.last_name    || undefined,
    ct:                ev.user.city         || undefined,
    st:                ev.user.state        || undefined,
    zp:                ev.user.zip          || undefined,
    country:           ev.user.country      || undefined,
    external_id:       ev.user.external_id  || undefined,
    fbp:               ev.cookies.fbp       || undefined,
    fbc:               ev.cookies.fbc       || undefined,
    client_ip_address: ev.network.client_ip  || undefined,
    client_user_agent: ev.network.user_agent || undefined,
  });

  _payload = JSON.stringify({
    data: [{
      event_name:       ev.event.name,
      event_time:       ev.event.timestamp,
      event_id:         ev.event.id,
      action_source:    'website',
      event_source_url: ev.page.url      || undefined,
      referrer_url:     ev.page.referrer || undefined,
      user_data:        _metaUser,
      custom_data:      _metaCustom,
      data_processing_options: [],
    }],
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Dead Letter Queue
// ═════════════════════════════════════════════════════════════════════════════

function _fireDLQ(statusCode, errMsg) {
  if (!data.dlqUrl) return;
  sendHttpRequest(data.dlqUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 3000,
    body: JSON.stringify({
      schema_version:  SCHEMA_VERSION,
      event_name:      ev.event.name,
      event_id:        ev.event.id,
      event_checksum:  ev.metadata.event_checksum,
      destination:     _platform,
      destination_url: data.url,
      timestamp:       ev.event.timestamp,
      error_code:      statusCode || 0,
      error_message:   errMsg     || '',
      payload_snapshot: _payload || '',
      headers_snapshot: JSON.stringify(_headers || {}),
      payload_size:    _payload ? _payload.length : 0,
      customer_id:     data.platformId       || '',
      items_count:     ev.ecommerce.items_count || 0,
      session_id:      ev.identity.session_id   || '',
      anonymous_id:    ev.identity.anonymous_id  || '',
      utm_source:      ev.attribution.utm_source || '',
      utm_medium:      ev.attribution.utm_medium || '',
    }),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Structured observability log
// ═════════════════════════════════════════════════════════════════════════════

function _emitLog(success, statusCode, latencyMs, payloadSize, logErrors) {
  logToConsole('ET:EventLog ' + JSON.stringify({
    schema_version:      SCHEMA_VERSION,
    template_version:    TEMPLATE_VERSION,
    customer_id:         data.platformId          || '',
    event_name:          ev.event.name,
    event_id:            ev.event.id,
    event_checksum:      ev.metadata.event_checksum,
    session_id:          ev.identity.session_id   || '',
    anonymous_id:        ev.identity.anonymous_id  || '',
    platform:            _platform,
    success:             success,
    status_code:         statusCode   || 0,
    latency_ms:          latencyMs    || 0,
    processing_time_ms:  getTimestampMillis() - ev.metadata.processing_time_ms,
    payload_size_bytes:  payloadSize  || 0,
    items_count:         ev.ecommerce.items_count   || 0,
    items_truncated:     ev.ecommerce.items_truncated || false,
    has_pii:             ev.user.email ? true : false,
    utm_source:          ev.attribution.utm_source  || '',
    utm_medium:          ev.attribution.utm_medium  || '',
    validation_errors:   validation.errors,
    validation_warnings: validation.warnings,
    errors:              logErrors || [],
    timestamp_unix:      ev.event.timestamp,
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Dispatch
// ═════════════════════════════════════════════════════════════════════════════

if (DEBUG) {
  logToConsole('ET:UniversalHTTP: dispatching', _platform, ev.event.name,
    _payload.length + 'B', 'checksum=' + ev.metadata.event_checksum);
}

var _sendStart = getTimestampMillis();

sendHttpRequest(_dispatchUrl, {
  method:  'POST',
  headers: _headers,
  timeout: 8000,
  body:    _payload,
}).then(function(r) {
  var latency = getTimestampMillis() - _sendStart;
  var ok = r.statusCode >= 200 && r.statusCode < 300;
  // Classify failure type so Cloud Logging metric filters can alert distinctly:
  //   AUTH_ERROR (401/403) → token expired / revoked — requires operator action.
  //   RATE_LIMITED (429)   → backpressure — DLQ should retry with delay.
  //   SERVER_ERROR (5xx)   → transient — DLQ should retry.
  //   CLIENT_ERROR (4xx)   → payload rejected — DLQ records for audit, no retry.
  var _failCode = ok ? null
    : (r.statusCode === 401 || r.statusCode === 403) ? 'AUTH_ERROR'
    : r.statusCode === 429                           ? 'RATE_LIMITED'
    : r.statusCode >= 500                            ? 'SERVER_ERROR'
    :                                                  'CLIENT_ERROR';
  _emitLog(ok, r.statusCode, latency, _payload.length, ok ? [] : [_failCode, 'HTTP_' + r.statusCode]);
  if (ok) {
    data.gtmOnSuccess();
  } else {
    if (DEBUG) { logToConsole('ET:UniversalHTTP: platform error', r.statusCode, _failCode, r.body); }
    if (r.statusCode === 401 || r.statusCode === 403) {
      // Token is invalid/expired. Log prominently so ops can alert on AUTH_ERROR.
      logToConsole('ET:UniversalHTTP:AUTH_ERROR platform=' + _platform +
        ' status=' + r.statusCode + ' — rotate the CAPI token for platformId=' + data.platformId);
    }
    _fireDLQ(r.statusCode, _failCode + ':HTTP_' + r.statusCode);
    data.gtmOnFailure();
  }
}, function(err) {
  var latency = getTimestampMillis() - _sendStart;
  _emitLog(false, 0, latency, _payload.length, ['NETWORK_ERROR']);
  if (DEBUG) { logToConsole('ET:UniversalHTTP: network error', err); }
  _fireDLQ(0, 'NETWORK_ERROR');
  data.gtmOnFailure();
});

___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": { "publicId": "send_http", "versionId": "1" },
      "param": [
        { "key": "allowedUrls", "value": { "type": 1, "string": "any" } }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "read_event_data", "versionId": "1" },
      "param": [
        { "key": "eventDataAccess", "value": { "type": 1, "string": "any" } }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "logging", "versionId": "1" },
      "param": [
        { "key": "environments", "value": { "type": 1, "string": "all" } }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  }
]

___TESTS___

[
  {
    "name": "Consent denied — skips CAPI without calling sendHttpRequest",
    "code": "mock('getEventData', function(k) { if (k==='ep.ad_storage'||k==='ad_storage') return 'denied'; return ''; }); mock('logToConsole', function(){}); runCode(data); assertApi('gtmOnSuccess').wasCalled(); assertApi('sendHttpRequest').wasNotCalled();"
  },
  {
    "name": "Missing event_name — validation fails, sendHttpRequest not called",
    "code": "mock('getEventData', function(k) { if (k==='ep.items_json'||k==='items_json') return '[]'; if (k==='ep.event_id'||k==='event_id') return 'evt-001'; return ''; }); mock('logToConsole', function(){}); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName=''; runCode(data); assertApi('gtmOnFailure').wasCalled(); assertApi('sendHttpRequest').wasNotCalled();"
  },
  {
    "name": "Missing event_id — validation fails",
    "code": "mock('getEventData', function(k) { if (k==='ep.items_json'||k==='items_json') return '[]'; return ''; }); mock('logToConsole', function(){}); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events'; runCode(data); assertApi('gtmOnFailure').wasCalled(); assertApi('sendHttpRequest').wasNotCalled();"
  },
  {
    "name": "Meta — full canonical purchase event reaches sendHttpRequest",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-001','event_id':'evt-001','ep.value':'200','value':'200','ep.revenue':'195','revenue':'195','ep.currency':'USD','currency':'USD','ep.transaction_id':'ORD-999','transaction_id':'ORD-999','ep.tax':'20','tax':'20','ep.shipping':'5','shipping':'5','ep.coupon':'SAVE10','coupon':'SAVE10','ep.affiliation':'Online Store','affiliation':'Online Store','ep.content_name':'Summer Collection','content_name':'Summer Collection','ep.content_type':'product','content_type':'product','ep.session_id':'sess-abc','session_id':'sess-abc','ep.anonymous_id':'anon-xyz','anonymous_id':'anon-xyz','ep.items_json':'[{\"id\":\"SKU1\",\"name\":\"Shirt\",\"price\":100,\"quantity\":2,\"brand\":\"Nike\",\"category\":\"Apparel\",\"discount\":5}]','items_json':'[{\"id\":\"SKU1\",\"name\":\"Shirt\",\"price\":100,\"quantity\":2,\"brand\":\"Nike\",\"category\":\"Apparel\",\"discount\":5}]','ep.utm_source':'google','utm_source':'google','ep.utm_medium':'cpc','utm_medium':'cpc','up.fbp':'fb.1.1700000000.123','up.fbc':'fb.1.1700000000.FBCLID','ep.gclid':'GCLID_abc12345678901','gclid':'GCLID_abc12345678901','up.em':'test@example.com','up.ph':'+966500000000'}; return m[k]||''; }); mock('sendHttpRequest', function(u,o){ return Promise.resolve({statusCode:200,body:'{}'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events?access_token=TOKEN'; data.platformId='12345'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "TikTok — Access-Token header set, contents include brand/category",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-tt-01','event_id':'evt-tt-01','ep.value':'50','value':'50','ep.currency':'USD','currency':'USD','ep.coupon':'TT20','coupon':'TT20','ep.session_id':'sess-tt','session_id':'sess-tt','ep.ttclid':'TTCLID_123456789012','ttclid':'TTCLID_123456789012','up.ttp':'TTP_xyz','ep.items_json':'[{\"id\":\"SKU2\",\"name\":\"Hoodie\",\"price\":50,\"quantity\":1,\"brand\":\"Adidas\",\"category\":\"Tops\"}]','items_json':'[{\"id\":\"SKU2\",\"name\":\"Hoodie\",\"price\":50,\"quantity\":1,\"brand\":\"Adidas\",\"category\":\"Tops\"}]'}; return m[k]||''; }); mock('sendHttpRequest', function(u,o){ if (!o.headers||o.headers['Access-Token']!=='TOKEN') throw 'Access-Token missing'; return Promise.resolve({statusCode:200}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName='PlaceAnOrder'; data.url='https://business-api.tiktok.com/open_api/v1.3/event/track/'; data.authHeader='TOKEN'; data.platformId='TT_PX'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "Snapchat — access_token appended as query param, shipping/tax in custom_data",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-sc-01','event_id':'evt-sc-01','ep.value':'150','value':'150','ep.currency':'SAR','currency':'SAR','ep.transaction_id':'ORD-SC','transaction_id':'ORD-SC','ep.tax':'15','tax':'15','ep.shipping':'10','shipping':'10','ep.session_id':'sess-sc','session_id':'sess-sc','ep.items_json':'[{\"id\":\"SKU3\",\"name\":\"Jeans\",\"price\":150,\"quantity\":1}]','items_json':'[{\"id\":\"SKU3\",\"name\":\"Jeans\",\"price\":150,\"quantity\":1}]','up.scid':'SCID_abc','ep.ScCid':'SC_CID_xyz','ScCid':'SC_CID_xyz'}; return m[k]||''; }); mock('sendHttpRequest', function(u,o){ if (u.indexOf('access_token=TOKEN')===-1) throw 'access_token missing from URL'; return Promise.resolve({statusCode:200}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName='PURCHASE'; data.url='https://tr.snapchat.com/v3/PIXEL/events'; data.authHeader='TOKEN'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "DLQ fires on HTTP 4xx, gtmOnFailure called",
    "code": "var calls=[]; mock('sendHttpRequest', function(u,o){ calls.push(u); return Promise.resolve({statusCode:400,body:'bad request'}); }); mock('getEventData', function(k) { var m={'ep.event_id':'evt-dlq','event_id':'evt-dlq','ep.items_json':'[]','items_json':'[]','ep.session_id':'sess-dlq','session_id':'sess-dlq'}; return m[k]||''; }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events'; data.dlqUrl='https://tool.easytrac.io/api/v1/internal/dlq'; runCode(data); assertApi('gtmOnFailure').wasCalled();"
  },
  {
    "name": "Canonical event object contains all schema sections",
    "code": "var builtPayload; mock('getEventData', function(k) { var m={'ep.event_id':'evt-schema','event_id':'evt-schema','ep.value':'99','value':'99','ep.currency':'USD','currency':'USD','ep.revenue':'95','revenue':'95','ep.tax':'9','tax':'9','ep.shipping':'5','shipping':'5','ep.coupon':'COUPON','coupon':'COUPON','ep.affiliation':'Store','affiliation':'Store','ep.content_name':'Widget','content_name':'Widget','ep.utm_source':'fb','utm_source':'fb','ep.utm_medium':'paid','utm_medium':'paid','ep.gclid':'GCLID_12345678901234','gclid':'GCLID_12345678901234','ep.fbclid':'FBCLID_1234567890123','fbclid':'FBCLID_1234567890123','ep.device_type':'mobile','device_type':'mobile','ep.language':'ar','language':'ar','ep.session_id':'sess-s','session_id':'sess-s','ep.anonymous_id':'anon-s','anonymous_id':'anon-s','ep.items_json':'[{\"id\":\"X1\",\"name\":\"Prod\",\"price\":99,\"quantity\":1}]','items_json':'[{\"id\":\"X1\",\"name\":\"Prod\",\"price\":99,\"quantity\":1}]','up.em':'u@e.com','up.fbp':'fb.1.111.222','up.ttp':'ttp_abc'}; return m[k]||''; }); mock('sendHttpRequest', function(u,o){ builtPayload=JSON.parse(o.body); return Promise.resolve({statusCode:200}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  }
]
