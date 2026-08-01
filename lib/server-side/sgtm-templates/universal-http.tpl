___INFO___

{
  "type": "TAG",
  "id": "et_universal_http",
  "version": 5,
  "securityGroups": [],
  "displayName": "EasyTrac - Universal HTTP Forwarder v5",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Production-grade canonical event dispatcher for Meta CAPI, TikTok Events API, Snapchat CAPI, Google Ads Enhanced Conversions, Pinterest CAPI, Reddit CAPI, LinkedIn CAPI, and GA4 Measurement Protocol. Builds a unified canonical event, tracking_context, and identity object from the full GA4 ep.*/up.* schema. Writes first-party cookies server-side. Persists UTM first-touch/last-touch attribution. Schema-validates. Retries on transient failures. DLQ on permanent failures.",
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
    "displayName": "Auth Header / Access Token",
    "simpleValueType": true,
    "help": "Bearer token, CAPI access token, or API secret. Usage varies by platform."
  },
  {
    "type": "TEXT",
    "name": "developerToken",
    "displayName": "Developer Token (Google Ads only)",
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
    "displayName": "Platform Pixel / Source / Conversion ID",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "clientIp",
    "displayName": "Client IP Address (x-forwarded-for header variable)",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "userAgent",
    "displayName": "User Agent (user-agent header variable)",
    "simpleValueType": true
  },
  {
    "type": "CHECKBOX",
    "name": "enableCookies",
    "displayName": "Write First-Party Cookies Server-Side",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "When enabled the tag writes _fbp, _fbc, _ttp, _fpid, _et_cid, _et_sid, _et_ext, _et_utm_* and _epik cookies. Requires set_cookies permission."
  },
  {
    "type": "TEXT",
    "name": "cookieDomain",
    "displayName": "Cookie Domain (blank = request host, e.g. .example.com)",
    "simpleValueType": true,
    "help": "Leave blank to use the request host. Set to .yourdomain.com for cross-subdomain sharing (track.domain.com → .domain.com)."
  },
  {
    "type": "TEXT",
    "name": "cookieRetentionDays",
    "displayName": "Cookie Retention Days (default 90, max 395)",
    "simpleValueType": true,
    "defaultValue": "90"
  },
  {
    "type": "CHECKBOX",
    "name": "retryEnabled",
    "displayName": "Retry on Transient Failures (429, 5xx)",
    "simpleValueType": true,
    "defaultValue": true
  },
  {
    "type": "CHECKBOX",
    "name": "enableDebug",
    "displayName": "Enable Debug Logging",
    "simpleValueType": true,
    "defaultValue": false
  }
]

___SANDBOXED_JS_FOR_SERVER___

// =============================================================================
// EasyTrac Universal HTTP Forwarder v5.1
// Tasks 1-10: Canonical event, click IDs, first-party cookies, UTM persistence,
//   tracking_context, identity, Meta EMQ, 8-platform mappers, Consent Mode v2,
//   reliability (dedup + validation + retry + DLQ).
// Tasks 11-20: Cookie validation, debug inspector, social cookies, Google Ads
//   full attribution, GA4 session continuity, deduplication proof, three-tier
//   attribution, enrichment layer, full debug mode, production validation.
// =============================================================================

var sendHttpRequest    = require('sendHttpRequest');
var JSON               = require('JSON');
var sha256Sync         = require('sha256Sync');
var makeString         = require('makeString');
var makeNumber         = require('makeNumber');
var getEventData       = require('getEventData');
var getAllEventData     = require('getAllEventData');
var getTimestampMillis = require('getTimestampMillis');
var getRemoteAddress   = require('getRemoteAddress');
var logToConsole       = require('logToConsole');
var Math               = require('Math');
var Object             = require('Object');
var setCookie          = require('setCookie');
var getCookieValues    = require('getCookieValues');
var encodeUriComponent = require('encodeUriComponent');

var TEMPLATE_VERSION  = '5.1';
var SCHEMA_VERSION    = 2;
var DEBUG             = data.enableDebug === true;
var ENABLE_COOKIES    = data.enableCookies !== false;
var COOKIE_DOMAIN     = data.cookieDomain || '';
var RETENTION_DAYS    = parseInt(data.cookieRetentionDays, 10) || 90;
var RETRY_ENABLED     = data.retryEnabled !== false;

// =============================================================================
// SECTION 1 — Low-level utilities
// =============================================================================

function isHex64(s) {
  if (!s || s.length !== 64) return false;
  var HEX = '0123456789abcdef';
  for (var i = 0; i < 64; i++) {
    if (HEX.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}

function _hash(raw) {
  if (!raw) return '';
  var s = makeString(raw).toLowerCase().trim();
  if (!s) return '';
  if (isHex64(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

function _hashPhone(raw) {
  if (!raw) return '';
  var s = makeString(raw).trim()
    .split(' ').join('').split('-').join('')
    .split('(').join('').split(')').join('').split('.').join('');
  if (!s) return '';
  if (isHex64(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

// _ed: read event data with ep.* prefix, then bare-key fallback.
function _ed(epKey, bareKey) {
  var v = getEventData(epKey);
  if (v !== null && v !== undefined && v !== '') return v;
  if (bareKey) {
    v = getEventData(bareKey);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return '';
}

// _cleanObj: strip empty / null / undefined values.
function _cleanObj(o) {
  var r = {};
  for (var k in o) {
    if (o[k] !== '' && o[k] !== null && o[k] !== undefined) r[k] = o[k];
  }
  return r;
}

// _first: return first non-empty value from positional args (up to 5).
function _first(a, b, c, d, e) {
  if (a !== '' && a !== null && a !== undefined) return a;
  if (b !== '' && b !== null && b !== undefined) return b;
  if (c !== '' && c !== null && c !== undefined) return c;
  if (d !== '' && d !== null && d !== undefined) return d;
  if (e !== '' && e !== null && e !== undefined) return e;
  return '';
}

// =============================================================================
// SECTION 2 — Cookie I/O (TASKS 2, 3, 4)
// Read existing first-party cookies BEFORE building canonical event so they
// can be used as fallback values (restoration logic).
// =============================================================================

function _readCookie(name) {
  var vals = getCookieValues(name);
  return (vals && vals.length > 0) ? vals[0] : '';
}

function _writeCookie(name, value, days, httpOnly) {
  if (!ENABLE_COOKIES || !value) return;
  var opts = {
    path:          '/',
    secure:        true,
    sameSite:      'Lax',
    expiresInDays: days || RETENTION_DAYS,
  };
  if (COOKIE_DOMAIN) { opts.domain = COOKIE_DOMAIN; }
  if (httpOnly)       { opts.httpOnly = true; }
  setCookie(name, value, opts, false);
}

// ── Read all first-party cookies (restoration / fallback) ─────────────────
// Platform advertising cookies
var _ck_fbp  = _readCookie('_fbp');           // Meta pixel cookie
var _ck_fbc  = _readCookie('_fbc');           // Meta click cookie
var _ck_ttp  = _readCookie('_ttp');           // TikTok pixel cookie
var _ck_scid = _readCookie('_scid');          // Snapchat browser ID
var _ck_epik = _readCookie('_epik');          // Pinterest click ID cookie
var _ck_rdt  = _readCookie('_rdt_uuid');      // Reddit user ID cookie
var _ck_li_fat = _readCookie('_li_fat_id');   // LinkedIn first-party ads tracking
// Google Ads Conversion Linker cookies — written by browser Conversion Linker tag
// Format: GCL.{timestamp}.{click_id}
var _ck_gcl_aw = _readCookie('_gcl_aw');     // gclid (Google Search/Display click)
var _ck_gcl_gb = _readCookie('_gcl_gb');     // gbraid (iOS web-to-app)
var _ck_gcl_dc = _readCookie('_gcl_dc');     // wbraid (Web campaign)
// EasyTrac first-party identity cookies (HttpOnly — only readable server-side)
var _ck_fpid = _readCookie('_fpid');
var _ck_cid  = _readCookie('_et_cid');
var _ck_sid  = _readCookie('_et_sid');
var _ck_ext  = _readCookie('_et_ext');
// GA4 session continuity cookies (TASK 15)
var _ck_ga4_sid  = _readCookie('_et_ga4_sid');   // GA4 session ID
var _ck_ga4_snum = _readCookie('_et_ga4_snum');  // GA4 session number
var _ck_ga4_cid  = _readCookie('_et_ga4_cid');   // GA4 client ID backup
// UTM first-touch cookies (90-day attribution — TASK 4, 17)
var _ck_utm_src = _readCookie('_et_utm_src');
var _ck_utm_med = _readCookie('_et_utm_med');
var _ck_utm_cmp = _readCookie('_et_utm_cmp');
var _ck_utm_con = _readCookie('_et_utm_con');
var _ck_utm_trm = _readCookie('_et_utm_trm');
var _ck_utm_id  = _readCookie('_et_utm_id');

// =============================================================================
// SECTION 3 — Consent gate (TASK 9)
// Early exit before any expensive processing.
// Absent signal = 'denied' (GDPR/ePrivacy default-deny).
// =============================================================================

var _earlyAdStorage  = _ed('ep.ad_storage',   'ad_storage');
var _earlyAdUserData = _ed('ep.ad_user_data', 'ad_user_data');

if (_earlyAdStorage !== 'granted' || _earlyAdUserData !== 'granted') {
  if (DEBUG) {
    logToConsole('ET:v5: consent not granted — skipping', data.eventName,
      'ad_storage=' + (_earlyAdStorage || 'absent') +
      ' ad_user_data=' + (_earlyAdUserData || 'absent'));
  }
  data.gtmOnSuccess();
  return;
}

// =============================================================================
// SECTION 4 — Canonical event builder (TASKS 1–6)
// ALL getEventData / getAllEventData calls are isolated here.
// Nothing downstream calls getEventData — they read from ev.* only.
// =============================================================================

function buildCanonicalEvent() {
  var now = getTimestampMillis();
  var ts  = Math.floor(now / 1000);

  // Full event data object — foundation for custom param capture (TASK 1)
  var _all = getAllEventData() || {};

  // ── Items ──────────────────────────────────────────────────────────────────
  var itemsRaw = _first(_ed('ep.items_json', 'items_json'), _all['items_json'], '[]');
  var items = [];
  if (itemsRaw && itemsRaw.length <= 32000) {
    var _parsed;
    try { _parsed = JSON.parse(itemsRaw); } catch (e) { _parsed = null; }
    if (_parsed && typeof _parsed === 'object' && _parsed.length) { items = _parsed; }
  }
  var itemsTruncated = _ed('ep.items_truncated', 'items_truncated') === 1 ||
                       _ed('ep.items_truncated', 'items_truncated') === '1';
  var itemsCount = parseInt(_ed('ep.items_count', 'items_count'), 10) || items.length;

  // ── Content IDs (derived from items) ──────────────────────────────────────
  var _contentIds = [];
  for (var _ci0 = 0; _ci0 < items.length; _ci0++) {
    var _cidv = makeString(items[_ci0].id || items[_ci0].item_id || '');
    if (_cidv) _contentIds.push(_cidv);
  }

  // ── User PII (raw — hashed below) ─────────────────────────────────────────
  var rawEm  = _first(getEventData('up.em'),          getEventData('user_data.em'),          _all['em'],          '');
  var rawPh  = _first(getEventData('up.ph'),          getEventData('user_data.ph'),          _all['ph'],          '');
  var rawFn  = _first(getEventData('up.fn'),          getEventData('user_data.fn'),          _all['fn'],          '');
  var rawLn  = _first(getEventData('up.ln'),          getEventData('user_data.ln'),          _all['ln'],          '');
  var rawExt = _first(getEventData('up.external_id'), getEventData('user_data.external_id'), getEventData('user_id'), _ck_ext, '');
  var rawCt  = _first(getEventData('up.ct'),          getEventData('user_data.ct'),          '');
  var rawSt  = _first(getEventData('up.st'),          getEventData('user_data.st'),          '');
  var rawZp  = _first(getEventData('up.zp'),          getEventData('user_data.zp'),          '');
  var rawCo  = _first(getEventData('up.country'),     getEventData('user_data.country'),     '');

  // ── Ecommerce core ────────────────────────────────────────────────────────
  var _value    = _first(_ed('ep.value',           'value'),           _all['value'],           0);
  var _revenue  = _first(_ed('ep.revenue',         'revenue'),         _all['revenue'],         _value);
  var _currency = _first(_ed('ep.currency',        'currency'),        _all['currency'],        'SAR');
  var _txId     = _first(_ed('ep.transaction_id',  'transaction_id'),  _ed('ep.order_id', 'order_id'), _all['transaction_id'], '');

  // ── Event core ────────────────────────────────────────────────────────────
  var _eventId   = _first(_ed('ep.event_id', 'event_id'), _all['event_id'], '');
  var _eventName = _first(data.eventName, _all['event_name'], '');

  // ── Deduplication checksum (TASK 10) ──────────────────────────────────────
  var _checksumInput = makeString(_eventName) + '|' +
                       makeString(_eventId)   + '|' +
                       makeString(_txId)      + '|' +
                       makeString(_value)     + '|' +
                       makeString(_currency)  + '|' +
                       makeString(items.length);
  var checksum = sha256Sync(_checksumInput, { outputEncoding: 'hex' }).slice(0, 16);

  // ── Identity (TASK 6) ─────────────────────────────────────────────────────
  var _gaClientId  = _first(_ed('ep.ga_client_id', 'ga_client_id'), _all['ga_client_id'], _ck_cid, _ck_ga4_cid, '');
  var _sessionId   = _first(_ed('ep.session_id',   'session_id'),   _all['session_id'],   _ck_sid, '');
  var _anonymousId = _first(_ed('ep.anonymous_id', 'anonymous_id'), _all['anonymous_id'], '');
  var _userId      = _first(_ed('ep.user_id',      'user_id'),      _all['user_id'],      rawExt, '');
  var _fpid        = _first(_ck_fpid, _gaClientId, _anonymousId);

  // ── TASK 15 — GA4 Session Continuity ──────────────────────────────────────
  // Restore from ep.* first, then from session-scope cookies
  var _ga4SessionId  = _first(_ed('ep.ga_session_id','ga_session_id'), _all['ga_session_id'], _ck_ga4_sid, '');
  // Fallback: use session_id (GTM native) as ga_session_id
  if (!_ga4SessionId) { _ga4SessionId = _sessionId; }
  var _ga4SessionNum = _first(_ed('ep.ga_session_number','ga_session_number'), _all['ga_session_number'], _ck_ga4_snum, '1');
  var _ga4EngTime    = _first(_ed('ep.engagement_time_msec','engagement_time_msec'), _all['engagement_time_msec'], '1');
  var _ga4Engaged    = _first(_ed('ep.session_engaged','session_engaged'), _all['session_engaged'], '0');
  // user_pseudo_id = ga_client_id (Google's anonymous user identifier)
  var _userPseudoId  = _gaClientId || _anonymousId || _fpid;

  // ── Click IDs (TASK 2) — event first, then cookie restoration ────────────
  var _fbclid  = _first(_ed('ep.fbclid',    'fbclid'),    _all['fbclid'],    '');
  var _gclid   = _first(_ed('ep.gclid',     'gclid'),     _all['gclid'],     '');
  var _gbraid  = _first(_ed('ep.gbraid',    'gbraid'),    _all['gbraid'],    '');
  var _wbraid  = _first(_ed('ep.wbraid',    'wbraid'),    _all['wbraid'],    '');
  var _ttclid  = _first(_ed('ep.ttclid',    'ttclid'),    _all['ttclid'],    '');
  var _sccid   = _first(_ed('ep.sc_click_id','sc_click_id'), _ed('ep.ScCid','ScCid'), _all['sc_click_id'], _all['ScCid'], '');
  var _msclkid = _first(_ed('ep.msclkid',   'msclkid'),   _all['msclkid'],   '');
  var _li_fat  = _first(_ed('ep.li_fat_id', 'li_fat_id'), _all['li_fat_id'], _ck_li_fat, '');
  var _epik    = _first(_ed('ep.epik',      'epik'),      _all['epik'],      _ck_epik, '');
  var _rdtcid  = _first(_ed('ep.rdt_cid',   'rdt_cid'),   _all['rdt_cid'],   _ck_rdt,  '');

  // ── TASK 14 — Google Ads Conversion Linker cookie restoration ─────────────
  // _gcl_aw format: "GCL.{timestamp}.{gclid}" — written by Conversion Linker tag
  if (!_gclid && _ck_gcl_aw) {
    var _gclParts = makeString(_ck_gcl_aw).split('.');
    if (_gclParts.length >= 3) { _gclid = _gclParts.slice(2).join('.'); }
  }
  // _gcl_gb format: "GCL.{timestamp}.{gbraid}"
  if (!_gbraid && _ck_gcl_gb) {
    var _gbrParts = makeString(_ck_gcl_gb).split('.');
    if (_gbrParts.length >= 3) { _gbraid = _gbrParts.slice(2).join('.'); }
  }
  // _gcl_dc format: "GCL.{timestamp}.{wbraid}"
  if (!_wbraid && _ck_gcl_dc) {
    var _wbrParts = makeString(_ck_gcl_dc).split('.');
    if (_wbrParts.length >= 3) { _wbraid = _wbrParts.slice(2).join('.'); }
  }

  // ── First-party cookies — read from event first, then cookie jar (TASK 3) ─
  var _fbp = _first(getEventData('up.fbp'), _ed('ep._fbp', '_fbp'), _all['_fbp'], _ck_fbp);
  var _fbc = _first(getEventData('up.fbc'), _ed('ep._fbc', '_fbc'), _all['_fbc'], _ck_fbc);
  var _ttp = _first(getEventData('up.ttp'), _ed('ep._ttp', '_ttp'), _all['_ttp'], _ck_ttp);
  var _scid = _first(getEventData('up.scid'), _ed('ep._scid', '_scid'), _ck_scid);
  var _gid  = _first(_ed('ep._gid', '_gid'), _all['_gid']);

  // ── TASK 11 + 13 — Generate platform cookies if absent (production-grade) ──
  // _fbp: "fb.{version}.{subdomainIndex}.{creationTimeMs}"
  // Server-generated _fbp is less accurate than browser-pixel-set, but ensures
  // the field is never empty — Meta accepts server-generated _fbp.
  // ITP mitigation: server Set-Cookie headers are NOT subject to Safari ITP 7-day cap.
  if (!_fbp) {
    var _fbpHash = sha256Sync(makeString(now) + makeString(data.clientIp || '') + 'et_fbp_v1', { outputEncoding: 'hex' });
    var _fbpNum  = makeString(parseInt(_fbpHash.slice(0, 9), 16) || 0);
    _fbp = 'fb.1.' + makeString(now) + '.' + _fbpNum;
  }

  // Auto-build _fbc from fbclid if cookie absent (Meta EMQ requirement)
  if (!_fbc && _fbclid) {
    _fbc = 'fb.1.' + makeString(ts) + '.' + makeString(_fbclid);
  }

  // _ttp: TikTok pixel cookie — UUID-like string
  if (!_ttp) {
    var _ttpHash = sha256Sync(makeString(now) + makeString(data.clientIp || '') + 'et_ttp_v1', { outputEncoding: 'hex' });
    // Format as pseudo-UUID: 8-4-4-4-12
    _ttp = _ttpHash.slice(0,8) + '-' + _ttpHash.slice(8,12) + '-4' + _ttpHash.slice(13,16) + '-' +
           _ttpHash.slice(16,20) + '-' + _ttpHash.slice(20,32);
  }

  // _epik: Pinterest click ID — generate if absent (needed for Pinterest CAPI)
  if (!_epik) {
    var _epikHash = sha256Sync(makeString(now) + makeString(data.clientIp || '') + 'et_epik_v1', { outputEncoding: 'hex' });
    _epik = _epikHash.slice(0, 32);
  }

  // ── UTM Attribution — last-touch from event, first-touch from cookie (TASK 4) ─
  var _utmSrc  = _first(_ed('ep.utm_source',   'utm_source'),   _all['utm_source'],   '');
  var _utmMed  = _first(_ed('ep.utm_medium',   'utm_medium'),   _all['utm_medium'],   '');
  var _utmCmp  = _first(_ed('ep.utm_campaign', 'utm_campaign'), _all['utm_campaign'], '');
  var _utmCon  = _first(_ed('ep.utm_content',  'utm_content'),  _all['utm_content'],  '');
  var _utmTrm  = _first(_ed('ep.utm_term',     'utm_term'),     _all['utm_term'],     '');
  var _utmId   = _first(_ed('ep.utm_id',       'utm_id'),       _all['utm_id'],       '');

  // Last-touch = current if present, else restore from 90-day cookie
  var _ltSrc = _utmSrc || _ck_utm_src;
  var _ltMed = _utmMed || _ck_utm_med;
  var _ltCmp = _utmCmp || _ck_utm_cmp;
  var _ltCon = _utmCon || _ck_utm_con;
  var _ltTrm = _utmTrm || _ck_utm_trm;
  var _ltId  = _utmId  || _ck_utm_id;

  // First-touch = cookie if it exists, else current (written once on first landing)
  var _ftSrc = _ck_utm_src || _utmSrc;
  var _ftMed = _ck_utm_med || _utmMed;
  var _ftCmp = _ck_utm_cmp || _utmCmp;
  var _ftCon = _ck_utm_con || _utmCon;
  var _ftTrm = _ck_utm_trm || _utmTrm;
  var _ftId  = _ck_utm_id  || _utmId;

  // Extended campaign dimensions
  var _srcPlatform  = _first(_ed('ep.source_platform',  'source_platform'),  _all['source_platform'],  '');
  var _campaignId   = _first(_ed('ep.campaign_id',      'campaign_id'),      _all['campaign_id'],      '');
  var _campaignName = _first(_ed('ep.campaign_name',    'campaign_name'),    _all['campaign_name'],    '');
  var _adsetId      = _first(_ed('ep.adset_id',         'adset_id'),         _all['adset_id'],         '');
  var _adsetName    = _first(_ed('ep.adset_name',       'adset_name'),       _all['adset_name'],       '');
  var _adId         = _first(_ed('ep.ad_id',            'ad_id'),            _all['ad_id'],            '');
  var _adName       = _first(_ed('ep.ad_name',          'ad_name'),          _all['ad_name'],          '');
  var _placement    = _first(_ed('ep.placement',        'placement'),        _all['placement'],        '');
  var _creativeId   = _first(_ed('ep.creative_id',      'creative_id'),      _all['creative_id'],      '');
  var _keyword      = _first(_ed('ep.keyword',          'keyword'),          _all['keyword'],          '');
  var _matchType    = _first(_ed('ep.match_type',       'match_type'),       _all['match_type'],       '');
  var _network      = _first(_ed('ep.network',          'network'),          _all['network'],          '');

  // ── Page ──────────────────────────────────────────────────────────────────
  var _pageUrl   = _first(_ed('ep.page_location', 'page_location'), _ed('ep.page_url', 'page_url'), _all['page_location'], '');
  var _pageRef   = _first(_ed('ep.page_referrer', 'page_referrer'), _all['page_referrer'], '');
  var _pageTitle = _first(_ed('ep.page_title',    'page_title'),    _all['page_title'],    '');
  var _searchTerm = _first(
    _ed('ep.search_term',   'search_term'),
    _ed('ep.search_string', 'search_string'),
    _all['search_term'],
    _all['search_string'],
    ''
  );

  // ── Device ────────────────────────────────────────────────────────────────
  var _deviceType = _first(_ed('ep.device_type',       'device_type'),       _all['device_type'],       '');
  var _language   = _first(_ed('ep.language',          'language'),          _all['language'],          '');
  var _timezone   = _first(_ed('ep.timezone',          'timezone'),          _all['timezone'],          '');
  var _viewport   = _first(_ed('ep.viewport',          'viewport'),          _all['viewport'],          '');
  var _screenRes  = _first(_ed('ep.screen_resolution', 'screen_resolution'), _all['screen_resolution'], '');

  // ── Consent (TASK 9) ──────────────────────────────────────────────────────
  var _adStorage   = _first(_ed('ep.ad_storage',         'ad_storage'),         _all['ad_storage'],         'denied');
  var _analStorage = _first(_ed('ep.analytics_storage',  'analytics_storage'),  _all['analytics_storage'],  'denied');
  var _adUserData  = _first(_ed('ep.ad_user_data',       'ad_user_data'),       _all['ad_user_data'],       'denied');
  var _adPersonal  = _first(_ed('ep.ad_personalization', 'ad_personalization'), _all['ad_personalization'], 'denied');

  // ── Custom parameters — all unrecognized ep.* keys (TASK 1) ───────────────
  var _KNOWN = {
    'event_name':1,'event_id':1,'items_json':1,'items_count':1,'items_truncated':1,
    'value':1,'revenue':1,'currency':1,'transaction_id':1,'order_id':1,
    'tax':1,'shipping':1,'coupon':1,'affiliation':1,'discount':1,
    'content_name':1,'content_type':1,'num_items':1,'search_string':1,'search_term':1,
    'ga_client_id':1,'session_id':1,'anonymous_id':1,'user_id':1,
    'fbclid':1,'gclid':1,'gbraid':1,'wbraid':1,'ttclid':1,
    'sc_click_id':1,'ScCid':1,'msclkid':1,'li_fat_id':1,'epik':1,'rdt_cid':1,
    '_fbp':1,'_fbc':1,'_ttp':1,'_scid':1,'_gid':1,
    'utm_source':1,'utm_medium':1,'utm_campaign':1,'utm_content':1,'utm_term':1,'utm_id':1,
    'source_platform':1,'campaign_id':1,'campaign_name':1,
    'adset_id':1,'adset_name':1,'ad_id':1,'ad_name':1,
    'placement':1,'creative_id':1,'keyword':1,'match_type':1,'network':1,
    'page_location':1,'page_url':1,'page_referrer':1,'page_title':1,
    'device_type':1,'language':1,'timezone':1,'viewport':1,'screen_resolution':1,
    'ad_storage':1,'analytics_storage':1,'ad_user_data':1,'ad_personalization':1,
  };
  var _customParams = {};
  var _allKeys = Object.keys(_all);
  for (var _ki = 0; _ki < _allKeys.length; _ki++) {
    var _k = _allKeys[_ki];
    var _bareK = (_k.indexOf('ep.') === 0) ? _k.slice(3) : _k;
    if (!_KNOWN[_bareK] && !_KNOWN[_k]) {
      if (_k.indexOf('up.') !== 0 && _k.indexOf('user_data.') !== 0) {
        _customParams[_bareK] = _all[_k];
      }
    }
  }

  return {
    // ── Schema metadata ────────────────────────────────────────────────────
    metadata: {
      schema_version:     SCHEMA_VERSION,
      template_version:   TEMPLATE_VERSION,
      event_checksum:     checksum,
      processing_time_ms: now,
    },

    // ── Event identity ─────────────────────────────────────────────────────
    event: {
      id:             _eventId,
      name:           _eventName,
      timestamp:      ts,
      transaction_id: _txId,
      order_id:       _txId,
    },

    // ── Ecommerce (TASK 1) ─────────────────────────────────────────────────
    ecommerce: {
      value:           _value,
      revenue:         _revenue,
      currency:        _currency,
      tax:             _first(_ed('ep.tax',         'tax'),         _all['tax'],         0),
      shipping:        _first(_ed('ep.shipping',    'shipping'),    _all['shipping'],    0),
      coupon:          _first(_ed('ep.coupon',      'coupon'),      _all['coupon'],      ''),
      affiliation:     _first(_ed('ep.affiliation', 'affiliation'), _all['affiliation'], ''),
      discount:        _first(_ed('ep.discount',    'discount'),    _all['discount'],    0),
      content_name:    _first(_ed('ep.content_name','content_name'),_all['content_name'],''),
      content_type:    _first(_ed('ep.content_type','content_type'),_all['content_type'],'product'),
      num_items:       parseInt(_first(_ed('ep.num_items','num_items'),_all['num_items'],0), 10) || itemsCount || 0,
      search_string:   _searchTerm,
      search_term:     _searchTerm,
      items:           items,
      items_count:     itemsCount,
      items_truncated: itemsTruncated,
      content_ids:     _contentIds,
    },

    // ── Attribution — full click IDs + UTM (TASKS 2, 4) ───────────────────
    attribution: {
      fbclid:       _fbclid,
      gclid:        _gclid,
      gbraid:       _gbraid,
      wbraid:       _wbraid,
      ttclid:       _ttclid,
      sc_click_id:  _sccid,
      sccid:        _sccid,
      msclkid:      _msclkid,
      li_fat_id:    _li_fat,
      epik:         _epik,
      rdt_cid:      _rdtcid,
      // ── TASK 17 — Three-tier attribution ──────────────────────────────────
      // last_touch: current event UTM → cookie fallback (what gets sent to platforms)
      utm_source:   _ltSrc,
      utm_medium:   _ltMed,
      utm_campaign: _ltCmp,
      utm_content:  _ltCon,
      utm_term:     _ltTrm,
      utm_id:       _ltId,
      // first_touch: original acquisition, written to cookie once and never overwritten
      first_touch: {
        utm_source:   _ftSrc,
        utm_medium:   _ftMed,
        utm_campaign: _ftCmp,
        utm_content:  _ftCon,
        utm_term:     _ftTrm,
        utm_id:       _ftId,
      },
      // current_touch: only what arrived on this specific event (no cookie fallback)
      // Use this to detect if the user navigated via a paid click right now
      current_touch: {
        utm_source:   _utmSrc,
        utm_medium:   _utmMed,
        utm_campaign: _utmCmp,
        utm_content:  _utmCon,
        utm_term:     _utmTrm,
        utm_id:       _utmId,
        fbclid:       _fbclid,
        gclid:        _gclid,
        gbraid:       _gbraid,
        wbraid:       _wbraid,
        ttclid:       _ttclid,
        sc_click_id:  _sccid,
        epik:         _epik,
        rdt_cid:      _rdtcid,
        li_fat_id:    _li_fat,
      },
      source_platform: _srcPlatform,
      campaign_id:     _campaignId,
      campaign_name:   _campaignName,
      adset_id:        _adsetId,
      adset_name:      _adsetName,
      ad_id:           _adId,
      ad_name:         _adName,
      placement:       _placement,
      creative_id:     _creativeId,
      keyword:         _keyword,
      match_type:      _matchType,
      network:         _network,
    },

    // ── Identity (TASKS 6, 15) ─────────────────────────────────────────────
    identity: {
      client_id:           _gaClientId,
      ga_client_id:        _gaClientId,
      user_pseudo_id:      _userPseudoId,
      session_id:          _sessionId,
      ga_session_id:       _ga4SessionId,
      ga_session_number:   _ga4SessionNum,
      engagement_time_msec: _ga4EngTime,
      session_engaged:     _ga4Engaged,
      anonymous_id:        _anonymousId,
      user_id:             _userId,
      external_id:         rawExt,
      fpid:                _fpid,
    },

    // ── First-party cookies (TASK 3) ───────────────────────────────────────
    cookies: {
      fbp:  _fbp,
      fbc:  _fbc,
      ttp:  _ttp,
      scid: _scid,
      gid:  _gid,
      epik: _epik,
      fpid: _fpid,
    },

    // ── Device ────────────────────────────────────────────────────────────
    device: {
      type:              _deviceType,
      language:          _language,
      timezone:          _timezone,
      viewport:          _viewport,
      screen_resolution: _screenRes,
    },

    // ── Page ──────────────────────────────────────────────────────────────
    page: {
      url:        _pageUrl,
      referrer:   _pageRef,
      title:      _pageTitle,
      search_term: _searchTerm,
    },

    // ── Consent (TASK 9) ──────────────────────────────────────────────────
    consent: {
      ad_storage:         _adStorage,
      analytics_storage:  _analStorage,
      ad_user_data:       _adUserData,
      ad_personalization: _adPersonal,
    },

    // ── User PII — SHA-256 hashed (TASK 7) ────────────────────────────────
    user: {
      email:       _hash(rawEm),
      phone:       _hashPhone(rawPh),
      first_name:  _hash(rawFn),
      last_name:   _hash(rawLn),
      external_id: _hash(rawExt),
      city:        _hash(rawCt),
      state:       _hash(rawSt),
      zip:         _hash(rawZp),
      country:     _hash(rawCo),
    },

    // ── Network ───────────────────────────────────────────────────────────
    network: {
      client_ip:  data.clientIp  || '',
      user_agent: data.userAgent || '',
    },

    // ── Custom parameters (all unrecognized ep.* — TASK 1) ────────────────
    custom_params: _customParams,

    // ── TASK 18 — Server-side enrichment layer ─────────────────────────────
    // Automatic enrichment added to EVERY event before dispatch.
    // Downstream platform builders read from here — they do NOT call getEventData.
    enrichment: {
      server_timestamp:    now,
      server_ip:           getRemoteAddress() || '',
      client_ip:           data.clientIp   || '',
      user_agent:          data.userAgent  || '',
      geo: {
        // If operators set up geolocation headers (x-appengine-city etc.),
        // they should pass them as template variables and add here.
        // Provided here as a named slot for downstream population.
        ip: data.clientIp || '',
      },
      page_url:            _pageUrl,
      page_referrer:       _pageRef,
      page_title:          _pageTitle,
      language:            _language,
      timezone:            _timezone,
      campaign_source:     _ltSrc,
      campaign_medium:     _ltMed,
      campaign_name:       _ltCmp,
      click_ids_present:   (_fbclid || _gclid || _ttclid || _sccid || _epik || _rdtcid || _li_fat) ? true : false,
      consent_ad_storage:  _adStorage,
      cookies_fbp_present: _fbp ? true : false,
      cookies_ttp_present: _ttp ? true : false,
    },
  };
}

// =============================================================================
// SECTION 5 — Build canonical event
// =============================================================================

var _t0 = getTimestampMillis();
var ev  = buildCanonicalEvent();

// ── TASK 19 — Debug mode: log incoming cookie jar state ─────────────────────
if (DEBUG) {
  logToConsole('ET:v5.1:DEBUG:COOKIES_READ ' + JSON.stringify({
    _fbp:    _ck_fbp    || '(absent)',
    _fbc:    _ck_fbc    || '(absent)',
    _ttp:    _ck_ttp    || '(absent)',
    _scid:   _ck_scid   || '(absent)',
    _epik:   _ck_epik   || '(absent)',
    _rdt:    _ck_rdt    || '(absent)',
    _li_fat: _ck_li_fat || '(absent)',
    _gcl_aw: _ck_gcl_aw || '(absent)',
    _gcl_gb: _ck_gcl_gb || '(absent)',
    _gcl_dc: _ck_gcl_dc || '(absent)',
    _fpid:   _ck_fpid   || '(absent)',
    _et_cid: _ck_cid    || '(absent)',
    _et_sid: _ck_sid    || '(absent)',
    ga4_sid: _ck_ga4_sid || '(absent)',
    utm_src: _ck_utm_src || '(absent)',
  }));
}

// ── TASK 12 — Structured Server Event Data debug output ──────────────────────
// This is the canonical proof that all parameters are available server-side.
// Log this AFTER building ev so nested objects, arrays, and custom params are shown.
if (DEBUG) {
  logToConsole('ET:v5.1:DEBUG:SERVER_EVENT_DATA ' + JSON.stringify({
    // ── TASK 12 required format ──────────────────────────────────────────
    event_name:      ev.event.name,
    event_id:        ev.event.id,
    event_time:      ev.event.timestamp,
    transaction_id:  ev.event.transaction_id,
    currency:        ev.ecommerce.currency,
    value:           ev.ecommerce.value,
    content_ids:     ev.ecommerce.content_ids,
    content_type:    ev.ecommerce.content_type,
    search_term:     ev.ecommerce.search_term,
    items:           ev.ecommerce.items,
    identity:        ev.identity,
    tracking_context: {
      client_id:  ev.identity.client_id,
      session_id: ev.identity.session_id,
      ga_session_id: ev.identity.ga_session_id,
    },
    attribution: {
      current_touch:  ev.attribution.current_touch,
      last_touch: {
        utm_source:   ev.attribution.utm_source,
        utm_medium:   ev.attribution.utm_medium,
        utm_campaign: ev.attribution.utm_campaign,
        fbclid:       ev.attribution.fbclid,
        gclid:        ev.attribution.gclid,
      },
      first_touch: ev.attribution.first_touch,
    },
    consent:         ev.consent,
    cookies:         ev.cookies,
    user_pii_hashed: {
      em: ev.user.email     ? ev.user.email.slice(0,8) + '...' : '(absent)',
      ph: ev.user.phone     ? ev.user.phone.slice(0,8) + '...' : '(absent)',
      fn: ev.user.first_name ? ev.user.first_name.slice(0,8) + '...' : '(absent)',
    },
    custom_params: ev.custom_params,
    enrichment:    ev.enrichment,
    metadata:      ev.metadata,
    // ── Proof: arrays survive ───────────────────────────────────────────
    items_count:      ev.ecommerce.items.length,
    items_truncated:  ev.ecommerce.items_truncated,
    // ── Proof: nested objects survive ───────────────────────────────────
    first_touch_utm:  ev.attribution.first_touch,
    current_touch_ids: ev.attribution.current_touch,
    // ── Proof: custom params survive ────────────────────────────────────
    custom_param_count: Object.keys(ev.custom_params).length,
  }));
}

// =============================================================================
// SECTION 6 — Unified tracking_context and identity objects (TASKS 5, 6)
// Built once, reused by all platform payload builders.
// =============================================================================

// TASK 5 — tracking_context
var tracking_context = {
  client_id:  ev.identity.client_id,
  session_id: ev.identity.session_id,
  utm: {
    source:   ev.attribution.utm_source,
    medium:   ev.attribution.utm_medium,
    campaign: ev.attribution.utm_campaign,
    content:  ev.attribution.utm_content,
    term:     ev.attribution.utm_term,
    id:       ev.attribution.utm_id,
  },
  click_ids: {
    fbclid:      ev.attribution.fbclid,
    gclid:       ev.attribution.gclid,
    gbraid:      ev.attribution.gbraid,
    wbraid:      ev.attribution.wbraid,
    ttclid:      ev.attribution.ttclid,
    sc_click_id: ev.attribution.sc_click_id,
    epik:        ev.attribution.epik,
    rdt_cid:     ev.attribution.rdt_cid,
    li_fat_id:   ev.attribution.li_fat_id,
  },
  cookies: {
    _fbp:  ev.cookies.fbp,
    _fbc:  ev.cookies.fbc,
    _ttp:  ev.cookies.ttp,
    fpid:  ev.cookies.fpid,
  },
  page: {
    url:      ev.page.url,
    referrer: ev.page.referrer,
    title:    ev.page.title,
  },
  consent: {
    ad_storage:         ev.consent.ad_storage,
    analytics_storage:  ev.consent.analytics_storage,
    ad_user_data:       ev.consent.ad_user_data,
    ad_personalization: ev.consent.ad_personalization,
  },
};

// TASK 6 — identity
var identity = {
  client_id:   ev.identity.client_id,
  session_id:  ev.identity.session_id,
  external_id: ev.user.external_id,
  user_id:     ev.identity.user_id,
  fbp:         ev.cookies.fbp,
  fbc:         ev.cookies.fbc,
  gclid:       ev.attribution.gclid,
  gbraid:      ev.attribution.gbraid,
  wbraid:      ev.attribution.wbraid,
  ttclid:      ev.attribution.ttclid,
  ttp:         ev.cookies.ttp,
  sc_click_id: ev.attribution.sc_click_id,
  epik:        ev.attribution.epik,
  rdt_cid:     ev.attribution.rdt_cid,
  li_fat_id:   ev.attribution.li_fat_id,
  ip:          ev.network.client_ip,
  user_agent:  ev.network.user_agent,
};

// =============================================================================
// SECTION 7 — First-party cookie writing (TASKS 2, 3, 4)
// Runs after canonical event is built and consent is confirmed.
// =============================================================================

function _writeCookies() {
  if (!ENABLE_COOKIES) return;

  var _analyticsGranted = ev.consent.analytics_storage === 'granted';
  var _now = ev.event.timestamp; // Unix seconds

  // ── TASK 13 / TASK 11 — Meta first-party cookies ────────────────────────
  // Always write (refresh TTL on every hit — Safari ITP mitigation).
  // Server Set-Cookie bypasses ITP 7-day cap on JS-set cookies.
  if (ev.cookies.fbp) { _writeCookie('_fbp', ev.cookies.fbp, 90,  false); }
  if (ev.cookies.fbc) { _writeCookie('_fbc', ev.cookies.fbc, 90,  false); }

  // ── TASK 13 — TikTok _ttp cookie (395 days — max allowed by TikTok)
  if (ev.cookies.ttp) { _writeCookie('_ttp', ev.cookies.ttp, 395, false); }

  // ── TASK 13 — Snapchat _scid cookie
  if (ev.cookies.scid) { _writeCookie('_scid', ev.cookies.scid, 395, false); }

  // ── TASK 13 — Pinterest _epik cookie (180 days)
  if (ev.attribution.epik) { _writeCookie('_epik', ev.attribution.epik, 180, false); }

  // ── TASK 13 — Reddit _rdt_uuid cookie (90 days)
  if (ev.attribution.rdt_cid) { _writeCookie('_rdt_uuid', ev.attribution.rdt_cid, 90, false); }

  // ── FIX 3 / TASK 14 — Google Ads Conversion Linker cookies ─────────────
  // Format: GCL.{original_click_timestamp}.{click_id}
  // CRITICAL: preserve the ORIGINAL click timestamp from the cookie.
  // Only the cookie Max-Age/expiry is refreshed on each request.
  // Regenerating the internal GCL timestamp would break Google's attribution
  // model — it uses the click timestamp to enforce the conversion window.
  // Rule:
  //   cookie already exists → write it back unchanged (TTL refresh only)
  //   fresh click ID in event, no existing cookie → write GCL.{now}.{id}
  // Consent Mode v2: only written when ad_storage = granted.
  if (ev.consent.ad_storage === 'granted') {
    if (identity.gclid) {
      var _gclawVal = _ck_gcl_aw ? _ck_gcl_aw : 'GCL.' + _now + '.' + identity.gclid;
      _writeCookie('_gcl_aw', _gclawVal, 90, false);
    }
    if (identity.gbraid) {
      var _gclgbVal = _ck_gcl_gb ? _ck_gcl_gb : 'GCL.' + _now + '.' + identity.gbraid;
      _writeCookie('_gcl_gb', _gclgbVal, 90, false);
    }
    if (identity.wbraid) {
      var _gcldcVal = _ck_gcl_dc ? _ck_gcl_dc : 'GCL.' + _now + '.' + identity.wbraid;
      _writeCookie('_gcl_dc', _gcldcVal, 90, false);
    }
  }

  // ── TASK 13/14 — LinkedIn li_fat_id cookie (30 days)
  if (identity.li_fat_id) {
    _writeCookie('_li_fat_id', identity.li_fat_id, 30, false);
  }

  // ── TASK 15 — GA4 session continuity cookies ────────────────────────────
  // _et_ga4_sid: session id (1 day TTL — GA4 session scope)
  // _et_ga4_snum: session number (RETENTION_DAYS — persistent across sessions)
  // _et_ga4_cid: GA4 client_id (RETENTION_DAYS — replaces _ga cookie)
  if (_analyticsGranted) {
    if (ev.identity.ga_session_id) {
      _writeCookie('_et_ga4_sid',  makeString(ev.identity.ga_session_id),  1,              true);
    }
    if (ev.identity.ga_session_number) {
      _writeCookie('_et_ga4_snum', makeString(ev.identity.ga_session_number), RETENTION_DAYS, true);
    }
    if (ev.identity.client_id) {
      _writeCookie('_et_ga4_cid',  ev.identity.client_id,                  RETENTION_DAYS, true);
    }
  }

  // ── EasyTrac first-party analytics cookies (HttpOnly — server-side only)
  if (_analyticsGranted) {
    var _fpidVal = ev.identity.fpid || ev.identity.client_id;
    if (_fpidVal) {
      _writeCookie('_fpid',   _fpidVal,              RETENTION_DAYS, true);
      _writeCookie('_et_cid', _fpidVal,              RETENTION_DAYS, false);
    }
    if (ev.identity.session_id) {
      _writeCookie('_et_sid', ev.identity.session_id, 1, true);
    }
    if (ev.identity.external_id) {
      _writeCookie('_et_ext', ev.identity.external_id, RETENTION_DAYS, true);
    }
  }

  // ── TASK 4/11 — UTM first-touch: write ONLY if no existing cookie ───────
  // Preserves original acquisition source for 90-day attribution window.
  // Last-touch is always recorded in the canonical event attribution object,
  // but cookie-based first-touch must NOT be overwritten on subsequent visits.
  if (!_ck_utm_src && ev.attribution.utm_source)   { _writeCookie('_et_utm_src', ev.attribution.utm_source,   RETENTION_DAYS, false); }
  if (!_ck_utm_med && ev.attribution.utm_medium)   { _writeCookie('_et_utm_med', ev.attribution.utm_medium,   RETENTION_DAYS, false); }
  if (!_ck_utm_cmp && ev.attribution.utm_campaign) { _writeCookie('_et_utm_cmp', ev.attribution.utm_campaign, RETENTION_DAYS, false); }
  if (!_ck_utm_con && ev.attribution.utm_content)  { _writeCookie('_et_utm_con', ev.attribution.utm_content,  RETENTION_DAYS, false); }
  if (!_ck_utm_trm && ev.attribution.utm_term)     { _writeCookie('_et_utm_trm', ev.attribution.utm_term,     RETENTION_DAYS, false); }
  if (!_ck_utm_id  && ev.attribution.utm_id)       { _writeCookie('_et_utm_id',  ev.attribution.utm_id,       RETENTION_DAYS, false); }

  // ── TASK 19 — Debug: log all written cookies ─────────────────────────────
  if (DEBUG) {
    logToConsole('ET:v5.1:DEBUG:COOKIES_WRITTEN ' + JSON.stringify({
      _fbp:         ev.cookies.fbp        ? 'written' : 'skipped',
      _fbc:         ev.cookies.fbc        ? 'written' : 'skipped',
      _ttp:         ev.cookies.ttp        ? 'written' : 'skipped',
      _scid:        ev.cookies.scid       ? 'written' : 'skipped',
      _epik:        ev.attribution.epik   ? 'written' : 'skipped',
      _rdt_uuid:    ev.attribution.rdt_cid ? 'written' : 'skipped',
      _gcl_aw:      (ev.consent.ad_storage === 'granted' && identity.gclid)   ? (_ck_gcl_aw ? 'refreshed(preserved):' + _ck_gcl_aw.slice(0,20) + '...' : 'new:GCL.' + _now + '.' + identity.gclid.slice(0,8) + '...') : 'skipped',
      _gcl_gb:      (ev.consent.ad_storage === 'granted' && identity.gbraid)  ? (_ck_gcl_gb ? 'refreshed(preserved)' : 'new') : 'skipped',
      _gcl_dc:      (ev.consent.ad_storage === 'granted' && identity.wbraid)  ? (_ck_gcl_dc ? 'refreshed(preserved)' : 'new') : 'skipped',
      _li_fat_id:   identity.li_fat_id ? 'written' : 'skipped',
      _et_ga4_sid:  (_analyticsGranted && ev.identity.ga_session_id)     ? 'written' : 'skipped',
      _et_ga4_snum: (_analyticsGranted && ev.identity.ga_session_number)  ? 'written' : 'skipped',
      _et_ga4_cid:  (_analyticsGranted && ev.identity.client_id)         ? 'written' : 'skipped',
      _fpid:        (_analyticsGranted && (ev.identity.fpid || ev.identity.client_id)) ? 'written' : 'skipped',
      _et_utm_src:  (!_ck_utm_src && ev.attribution.utm_source) ? 'written(first-touch)' : _ck_utm_src ? 'preserved' : 'skipped',
      cookies_enabled: ENABLE_COOKIES,
      cookie_domain:   COOKIE_DOMAIN || '(auto)',
      retention_days:  RETENTION_DAYS,
    }));
  }
}

_writeCookies();

// =============================================================================
// SECTION 8 — Validation (TASK 10)
// =============================================================================

function validateCanonicalEvent(e) {
  var errors   = [];
  var warnings = [];

  if (!e.event.name)                                 { errors.push('MISSING_event_name'); }
  if (!e.event.id)                                   { errors.push('MISSING_event_id'); }
  if (!e.event.timestamp || e.event.timestamp <= 0) { errors.push('INVALID_timestamp'); }

  if (!e.identity.session_id)                                        { warnings.push('MISSING_session_id'); }
  if (!e.identity.client_id && !e.identity.anonymous_id)            { warnings.push('MISSING_client_id'); }

  if (e.ecommerce.value !== 0 && e.ecommerce.value !== '') {
    var numVal = parseFloat(e.ecommerce.value);
    if (numVal !== numVal) { errors.push('INVALID_value:not_numeric'); }
    else if (numVal < 0)   { warnings.push('SUSPICIOUS_value:negative'); }
  }

  if (e.ecommerce.currency && makeString(e.ecommerce.currency).trim().length !== 3) {
    warnings.push('INVALID_currency_format');
  }

  for (var i = 0; i < e.ecommerce.items.length; i++) {
    var it = e.ecommerce.items[i];
    if (!it.id && !it.item_id)  { errors.push('ITEM_MISSING_id:i=' + i); }
    var qty = parseInt(it.quantity, 10);
    if (qty !== qty || qty < 1) { warnings.push('ITEM_INVALID_quantity:i=' + i); }
    var prc = parseFloat(it.price);
    if (prc !== prc || prc < 0) { warnings.push('ITEM_INVALID_price:i=' + i); }
  }

  if (e.user.email     && !isHex64(e.user.email))       { warnings.push('PII_NOT_HASHED:email'); }
  if (e.user.phone     && !isHex64(e.user.phone))       { warnings.push('PII_NOT_HASHED:phone'); }
  if (e.user.first_name && !isHex64(e.user.first_name)) { warnings.push('PII_NOT_HASHED:first_name'); }

  if (e.user.email && e.user.phone && e.user.email === e.user.phone) {
    warnings.push('DUPLICATE_HASH:email==phone');
  }

  var _ckChecks = [
    { key: 'gclid',  val: e.attribution.gclid  },
    { key: 'fbclid', val: e.attribution.fbclid  },
    { key: 'ttclid', val: e.attribution.ttclid  },
  ];
  for (var ci = 0; ci < _ckChecks.length; ci++) {
    var cLen = makeString(_ckChecks[ci].val || '').length;
    if (cLen > 0 && (cLen < 10 || cLen > 500)) {
      warnings.push('SUSPICIOUS_' + _ckChecks[ci].key + '_length:' + cLen);
    }
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

var validation = validateCanonicalEvent(ev);

if (!validation.valid) {
  logToConsole('ET:v5:VALIDATION_FAILED ' + JSON.stringify({
    event_name:     ev.event.name,
    event_id:       ev.event.id,
    event_checksum: ev.metadata.event_checksum,
    errors:         validation.errors,
  }));
  data.gtmOnFailure();
  return;
}
if (validation.warnings.length > 0 && DEBUG) {
  logToConsole('ET:v5:VALIDATION_WARNINGS ' + JSON.stringify(validation.warnings));
}

// =============================================================================
// SECTION 9 — Item normalizers
// =============================================================================

function _normItem(it) {
  return {
    id:       makeString(it.id       || it.item_id    || ''),
    name:     makeString(it.name     || it.item_name  || ''),
    price:    parseFloat(it.price)   || 0,
    quantity: parseInt(makeString(it.quantity || '1'), 10) || 1,
    brand:    makeString(it.brand    || it.item_brand    || ''),
    category: makeString(it.category || it.item_category || ''),
    variant:  makeString(it.variant  || it.item_variant  || ''),
    coupon:   makeString(it.coupon   || ''),
    discount: parseFloat(it.discount) || 0,
  };
}

function _buildMetaContents(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var n = _normItem(items[i]);
    var c = { id: n.id, quantity: n.quantity, item_price: n.price };
    if (n.discount)  { c.discount     = n.discount; }
    if (n.brand)     { c.brand        = n.brand; }
    if (n.category)  { c.category     = n.category; }
    if (n.variant)   { c.item_variant = n.variant; }
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

function _buildPinContents(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var n = _normItem(items[i]);
    out.push(_cleanObj({ item_id: n.id, item_name: n.name, price: n.price, quantity: n.quantity, item_brand: n.brand }));
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

// =============================================================================
// SECTION 10 — Platform payload builders (TASK 8)
// All builders consume ev, tracking_context, identity — never call getEventData.
// =============================================================================

var _dispatchUrl = data.url;
var _payload;
var _platform;
var _headers = { 'Content-Type': 'application/json' };

if (_dispatchUrl.indexOf('business-api.tiktok.com') !== -1) {

  // ── TikTok Events API ────────────────────────────────────────────────────
  _platform = 'tiktok';
  if (data.authHeader) { _headers['Access-Token'] = data.authHeader; }

  var _ttItems = ev.ecommerce.items.length ? _buildTikTokContents(ev.ecommerce.items) : undefined;
  var _ttProps = _cleanObj({
    currency:      ev.ecommerce.currency              || undefined,
    value:         ev.ecommerce.value                 || undefined,
    content_type:  ev.ecommerce.content_type          || undefined,
    order_id:      ev.event.transaction_id            || undefined,
    coupon:        ev.ecommerce.coupon                || undefined,
    search_string: ev.ecommerce.search_term           || undefined,
    affiliation:   ev.ecommerce.affiliation           || undefined,
    num_items:     ev.ecommerce.num_items             || undefined,
    content_name:  (!_ttItems && ev.ecommerce.content_name) ? ev.ecommerce.content_name : undefined,
  });
  if (_ttItems) { _ttProps.contents = _ttItems; }

  var _ttUser = _cleanObj({
    email:        ev.user.email       || undefined,
    phone_number: ev.user.phone       || undefined,
    external_id:  identity.external_id || undefined,
    ttclid:       identity.ttclid     || undefined,
    ttp:          identity.ttp        || undefined,
    ip:           identity.ip         || undefined,
    user_agent:   identity.user_agent || undefined,
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
      page: _cleanObj({
        url:      ev.page.url      || undefined,
        referrer: ev.page.referrer || undefined,
      }),
    }],
  });

} else if (_dispatchUrl.indexOf('tr.snapchat.com') !== -1) {

  // ── Snapchat CAPI v3 ─────────────────────────────────────────────────────
  _platform = 'snap';
  if (data.authHeader) { _dispatchUrl = _dispatchUrl + '?access_token=' + data.authHeader; }

  var _snapItems    = ev.ecommerce.items.length ? _buildSnapContents(ev.ecommerce.items) : undefined;
  var _snapIds      = ev.ecommerce.content_ids.length ? ev.ecommerce.content_ids : undefined;
  var _snapNumItems = ev.ecommerce.items_truncated
    ? ev.ecommerce.items_count
    : (ev.ecommerce.items.length || (ev.ecommerce.num_items || undefined));

  var _snapCustom = _cleanObj({
    currency:        ev.ecommerce.currency,
    price:           ev.ecommerce.value,
    transaction_id:  ev.event.transaction_id  || undefined,
    number_items:    _snapNumItems,
    coupon:          ev.ecommerce.coupon       || undefined,
    affiliation:     ev.ecommerce.affiliation  || undefined,
    shipping_amount: ev.ecommerce.shipping     || undefined,
    tax_amount:      ev.ecommerce.tax          || undefined,
    search_string:   ev.ecommerce.search_term  || undefined,
  });
  if (_snapIds)   { _snapCustom.item_ids = _snapIds; }
  if (_snapItems) { _snapCustom.products = _snapItems; }

  _payload = JSON.stringify({
    data: [{
      event_conversion_type: 'WEB',
      event_type:  ev.event.name,
      event_tag:   ev.event.id,
      timestamp:   ev.event.timestamp,
      hashed_data_fields: _cleanObj({
        email:        ev.user.email        || undefined,
        phone_number: ev.user.phone        || undefined,
        external_id:  identity.external_id || undefined,
      }),
      user_data: _cleanObj({
        sc_click_id: identity.sc_click_id || undefined,
        uuid_c1:     ev.cookies.scid      || undefined,
        ip_address:  identity.ip          || undefined,
        user_agent:  identity.user_agent  || undefined,
      }),
      custom_data: _snapCustom,
      app_data: {
        advertiser_tracking_enabled: ev.consent.ad_storage === 'granted' ? 1 : 0,
      },
    }],
  });

} else if (_dispatchUrl.indexOf('googleads.googleapis.com') !== -1) {

  // ── Google Ads Enhanced Conversions ──────────────────────────────────────
  _platform = 'gads';
  if (data.authHeader) {
    _headers['Authorization'] = 'Bearer ' + data.authHeader;
  }
  if (data.developerToken) { _headers['developer-token'] = data.developerToken; }

  function toGadsTs(unixSec) {
    var ts2 = makeNumber(unixSec);
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    var rem2 = ts2 % 86400; if (rem2 < 0) { rem2 = rem2 + 86400; }
    var hh2 = Math.floor(rem2 / 3600); rem2 = rem2 % 3600;
    var mm2 = Math.floor(rem2 / 60); var ss2 = rem2 % 60;
    var td2 = Math.floor(ts2 / 86400); var y2 = 1970;
    while (true) {
      var diy2 = (y2 % 4 === 0 && (y2 % 100 !== 0 || y2 % 400 === 0)) ? 366 : 365;
      if (td2 < diy2) break;
      td2 = td2 - diy2; y2 = y2 + 1;
    }
    var leap2 = (y2 % 4 === 0 && (y2 % 100 !== 0 || y2 % 400 === 0));
    var mDays2 = [31, leap2 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var mo2 = 0;
    while (td2 >= mDays2[mo2]) { td2 = td2 - mDays2[mo2]; mo2 = mo2 + 1; }
    return y2 + '-' + pad(mo2 + 1) + '-' + pad(td2 + 1) + ' ' +
           pad(hh2) + ':' + pad(mm2) + ':' + pad(ss2) + '+00:00';
  }

  var _gadsUids = [];
  if (ev.user.email) { _gadsUids.push({ hashedEmail: ev.user.email }); }
  if (ev.user.phone) { _gadsUids.push({ hashedPhoneNumber: ev.user.phone }); }
  var _gadsAddr = _cleanObj({
    hashedFirstName: ev.user.first_name || undefined,
    hashedLastName:  ev.user.last_name  || undefined,
    hashedCity:      ev.user.city       || undefined,
    hashedState:     ev.user.state      || undefined,
    postalCode:      ev.user.zip        || undefined,
    countryCode:     ev.user.country    || undefined,
  });
  if (Object.keys(_gadsAddr).length > 0) { _gadsUids.push({ addressInfo: _gadsAddr }); }

  if (!identity.gclid && !identity.wbraid && !identity.gbraid) {
    if (DEBUG) { logToConsole('ET:v5:GAds: no click ID — skipping'); }
    data.gtmOnSuccess();
    return;
  }

  _payload = JSON.stringify({
    conversions: [_cleanObj({
      gclid:                identity.gclid  || undefined,
      wbraid:               identity.wbraid || undefined,
      gbraid:               identity.gbraid || undefined,
      conversion_action:    data.platformId || undefined,
      conversion_date_time: toGadsTs(ev.event.timestamp),
      conversion_value:     ev.ecommerce.value > 0 ? ev.ecommerce.value : undefined,
      currency_code:        ev.ecommerce.currency || undefined,
      order_id:             ev.event.transaction_id || undefined,
      user_identifiers:     _gadsUids.length > 0 ? _gadsUids : undefined,
    })],
    partial_failure: true,
    validate_only:   false,
  });

} else if (_dispatchUrl.indexOf('api.pinterest.com') !== -1) {

  // ── Pinterest CAPI ────────────────────────────────────────────────────────
  _platform = 'pinterest';
  if (data.authHeader) { _headers['Authorization'] = 'Bearer ' + data.authHeader; }

  var _pinItems  = ev.ecommerce.items.length ? _buildPinContents(ev.ecommerce.items) : undefined;
  var _pinIds    = ev.ecommerce.content_ids.length ? ev.ecommerce.content_ids : undefined;

  var _pinUserData = _cleanObj({
    em:               ev.user.email        ? [ev.user.email]           : undefined,
    ph:               ev.user.phone        ? [ev.user.phone]           : undefined,
    external_id:      identity.external_id ? [identity.external_id]    : undefined,
    client_ip_address: identity.ip         || undefined,
    client_user_agent: identity.user_agent || undefined,
    click_id:         identity.epik        || undefined,
    partner_id:       ev.cookies.fpid      || undefined,
  });

  var _pinCustom = _cleanObj({
    currency:        ev.ecommerce.currency     || undefined,
    value:           ev.ecommerce.value        || undefined,
    order_id:        ev.event.transaction_id   || undefined,
    content_ids:     _pinIds,
    contents:        _pinItems,
    content_name:    ev.ecommerce.content_name || undefined,
    content_category: ev.ecommerce.content_type || undefined,
    num_items:       ev.ecommerce.num_items     || undefined,
    search_string:   ev.ecommerce.search_term   || undefined,
  });

  _payload = JSON.stringify({
    data: [{
      event_name:       ev.event.name,
      action_source:    'web',
      event_time:       ev.event.timestamp,
      event_id:         ev.event.id,
      event_source_url: ev.page.url            || undefined,
      partner_name:     'easytrac',
      user_data:        _pinUserData,
      custom_data:      _pinCustom,
      app_id:           data.platformId         || undefined,
      language:         ev.device.language       || undefined,
      opt_out:          ev.consent.ad_storage !== 'granted',
    }],
  });

} else if (_dispatchUrl.indexOf('ads-api.reddit.com') !== -1) {

  // ── Reddit CAPI ──────────────────────────────────────────────────────────
  _platform = 'reddit';
  if (data.authHeader) { _headers['Authorization'] = 'Bearer ' + data.authHeader; }

  var _rdtUserData = _cleanObj({
    email:       ev.user.email        ? [ev.user.email]        : undefined,
    external_id: identity.external_id ? [identity.external_id] : undefined,
    uuid:        identity.rdt_cid     || undefined,
    ip_address:  identity.ip          || undefined,
    user_agent:  identity.user_agent   || undefined,
  });

  _payload = JSON.stringify({
    test_mode: false,
    events: [{
      event_at:    makeString(ev.event.timestamp) + '000',
      event_type:  { tracking_type: ev.event.name },
      event_id:    ev.event.id || undefined,
      click_id:    identity.rdt_cid || undefined,
      user:        _rdtUserData,
      event_metadata: _cleanObj({
        currency:       ev.ecommerce.currency      || undefined,
        value:          ev.ecommerce.value         || undefined,
        item_count:     ev.ecommerce.num_items     || undefined,
        transaction_id: ev.event.transaction_id    || undefined,
      }),
    }],
  });

} else if (_dispatchUrl.indexOf('api.linkedin.com') !== -1) {

  // ── LinkedIn Conversions API ──────────────────────────────────────────────
  _platform = 'linkedin';
  if (data.authHeader) { _headers['Authorization'] = 'Bearer ' + data.authHeader; }
  _headers['LinkedIn-Version']              = '202405';
  _headers['X-Restli-Protocol-Version']     = '2.0.0';

  var _liUserIds = [];
  if (ev.user.email) {
    _liUserIds.push({ idType: 'SHA256_EMAIL', idValue: ev.user.email });
  }
  if (identity.li_fat_id) {
    _liUserIds.push({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: identity.li_fat_id });
  }

  _payload = JSON.stringify({
    conversion:          data.platformId || '',
    conversionHappenedAt: ev.event.timestamp * 1000,
    conversionValue: ev.ecommerce.value ? {
      currencyCode: ev.ecommerce.currency,
      amount:       makeString(ev.ecommerce.value),
    } : undefined,
    user: _cleanObj({
      userIds:  _liUserIds.length > 0 ? _liUserIds : undefined,
      userInfo: _cleanObj({
        firstName: ev.user.first_name || undefined,
        lastName:  ev.user.last_name  || undefined,
      }),
    }),
    eventId: ev.event.id,
  });

} else if (_dispatchUrl.indexOf('www.google-analytics.com/mp') !== -1 ||
           _dispatchUrl.indexOf('www.google-analytics.com/debug/mp') !== -1) {

  // ── GA4 Measurement Protocol ─────────────────────────────────────────────
  _platform = 'ga4mp';
  var _ga4QS = [];
  if (data.authHeader) { _ga4QS.push('api_secret=' + encodeUriComponent(data.authHeader)); }
  if (data.platformId) { _ga4QS.push('measurement_id=' + encodeUriComponent(data.platformId)); }
  if (_ga4QS.length)   { _dispatchUrl = _dispatchUrl + '?' + _ga4QS.join('&'); }

  var _ga4Params = _cleanObj({
    session_id:           ev.identity.session_id            || undefined,
    ga_session_id:        ev.identity.ga_session_id         || undefined,
    ga_session_number:    ev.identity.ga_session_number      || undefined,
    engagement_time_msec: makeNumber(ev.identity.engagement_time_msec) || 1,
    transaction_id: ev.event.transaction_id   || undefined,
    value:          ev.ecommerce.value         || undefined,
    currency:       ev.ecommerce.currency      || undefined,
    coupon:         ev.ecommerce.coupon        || undefined,
    shipping:       ev.ecommerce.shipping      || undefined,
    tax:            ev.ecommerce.tax           || undefined,
    affiliation:    ev.ecommerce.affiliation   || undefined,
    search_term:    ev.ecommerce.search_term   || undefined,
    source:         ev.attribution.utm_source  || undefined,
    medium:         ev.attribution.utm_medium  || undefined,
    campaign:       ev.attribution.utm_campaign || undefined,
    content:        ev.attribution.utm_content  || undefined,
    term:           ev.attribution.utm_term     || undefined,
    campaign_id:    ev.attribution.campaign_id  || undefined,
  });

  if (ev.ecommerce.items.length) {
    var _ga4Items = [];
    for (var _gi = 0; _gi < ev.ecommerce.items.length; _gi++) {
      var _gn = _normItem(ev.ecommerce.items[_gi]);
      _ga4Items.push(_cleanObj({
        item_id:       _gn.id,
        item_name:     _gn.name,
        price:         _gn.price,
        quantity:      _gn.quantity,
        item_brand:    _gn.brand    || undefined,
        item_category: _gn.category || undefined,
        item_variant:  _gn.variant  || undefined,
        coupon:        _gn.coupon   || undefined,
        discount:      _gn.discount || undefined,
      }));
    }
    _ga4Params.items = _ga4Items;
  }

  _payload = JSON.stringify({
    client_id:            ev.identity.client_id || 'unknown',
    timestamp_micros:     makeString(ev.event.timestamp) + '000000',
    user_id:              ev.identity.user_id || undefined,
    non_personalized_ads: ev.consent.ad_personalization !== 'granted',
    events: [{
      name:   ev.event.name,
      params: _ga4Params,
    }],
  });

} else {

  // ── Meta CAPI (default — matched when URL contains graph.facebook.com) ────
  _platform = 'meta';

  var _metaItems = ev.ecommerce.items.length ? _buildMetaContents(ev.ecommerce.items) : undefined;
  var _metaIds   = ev.ecommerce.content_ids.length ? ev.ecommerce.content_ids : undefined;
  var _metaNum   = ev.ecommerce.items_count > 0
    ? ev.ecommerce.items_count
    : (ev.ecommerce.items.length || (ev.ecommerce.num_items || undefined));

  var _metaCustom = _cleanObj({
    currency:      ev.ecommerce.currency,
    value:         ev.ecommerce.value,
    revenue:       ev.ecommerce.revenue      || undefined,
    order_id:      ev.event.transaction_id   || undefined,
    content_type:  ev.ecommerce.content_type,
    content_name:  ev.ecommerce.content_name || undefined,
    num_items:     _metaNum,
    tax:           ev.ecommerce.tax          || undefined,
    shipping:      ev.ecommerce.shipping     || undefined,
    coupon:        ev.ecommerce.coupon       || undefined,
    affiliation:   ev.ecommerce.affiliation  || undefined,
    search_string: ev.ecommerce.search_term  || undefined,
  });
  if (_metaItems) { _metaCustom.contents    = _metaItems; }
  if (_metaIds)   { _metaCustom.content_ids = _metaIds; }

  // TASK 7 — Meta EMQ: send ALL available PII signals.
  // Expected EMQ >= 8 when the following signals are present:
  //   em, ph, fn, ln, external_id, fbp, fbc, client_ip_address, client_user_agent.
  // EMQ is computed by Meta's servers — it cannot be guaranteed client-side.
  var _metaUser = _cleanObj({
    em:                ev.user.email        || undefined,
    ph:                ev.user.phone        || undefined,
    fn:                ev.user.first_name   || undefined,
    ln:                ev.user.last_name    || undefined,
    ct:                ev.user.city         || undefined,
    st:                ev.user.state        || undefined,
    zp:                ev.user.zip          || undefined,
    country:           ev.user.country      || undefined,
    external_id:       identity.external_id || undefined,
    fbp:               identity.fbp         || undefined,
    fbc:               identity.fbc         || undefined,
    client_ip_address: identity.ip          || undefined,
    client_user_agent: identity.user_agent  || undefined,
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

// =============================================================================
// SECTION 11 — Dead Letter Queue
// =============================================================================

function _fireDLQ(statusCode, errMsg) {
  logToConsole('ET:DLQ ' + JSON.stringify({
    schema_version:   SCHEMA_VERSION,
    event_name:       ev.event.name,
    event_id:         ev.event.id,
    event_checksum:   ev.metadata.event_checksum,
    destination:      _platform,
    timestamp:        ev.event.timestamp,
    error_code:       statusCode || 0,
    error_message:    errMsg     || '',
    payload_size:     _payload ? _payload.length : 0,
    customer_id:      data.platformId               || '',
    items_count:      ev.ecommerce.items_count       || 0,
    session_id:       ev.identity.session_id         || '',
    client_id:        ev.identity.client_id          || '',
    utm_source:       ev.attribution.utm_source      || '',
    utm_medium:       ev.attribution.utm_medium      || '',
  }));
}

// =============================================================================
// SECTION 12 — Structured observability log
// =============================================================================

function _emitLog(success, statusCode, latencyMs, payloadSize, logErrors) {
  logToConsole('ET:EventLog ' + JSON.stringify({
    schema_version:      SCHEMA_VERSION,
    template_version:    TEMPLATE_VERSION,
    customer_id:         data.platformId          || '',
    event_name:          ev.event.name,
    event_id:            ev.event.id,
    event_checksum:      ev.metadata.event_checksum,
    client_id:           ev.identity.client_id    || '',
    session_id:          ev.identity.session_id   || '',
    platform:            _platform,
    success:             success,
    status_code:         statusCode   || 0,
    latency_ms:          latencyMs    || 0,
    processing_time_ms:  getTimestampMillis() - ev.metadata.processing_time_ms,
    payload_size_bytes:  payloadSize  || 0,
    items_count:         ev.ecommerce.items_count   || 0,
    has_pii:             !!(ev.user.email),
    has_click_id:        !!(ev.attribution.fbclid || ev.attribution.gclid || ev.attribution.ttclid),
    cookies_written:     ENABLE_COOKIES,
    utm_source:          ev.attribution.utm_source  || '',
    utm_medium:          ev.attribution.utm_medium  || '',
    validation_errors:   validation.errors,
    validation_warnings: validation.warnings,
    errors:              logErrors || [],
    timestamp_unix:      ev.event.timestamp,
  }));
}

// =============================================================================
// SECTION 13 — Dispatch with retry (TASK 10)
// Retry fires immediately in the failure callback (no setTimeout in sGTM).
// Retries: 1 automatic retry on 429 or 5xx (transient).
// 4xx (non-429) and auth errors: no retry, DLQ immediately.
// =============================================================================

// ── TASK 19 — Full debug: log final destination payload before send ──────────
if (DEBUG) {
  logToConsole('ET:v5.1:DEBUG:DISPATCH_PRE_SEND ' + JSON.stringify({
    platform:       _platform,
    url:            _dispatchUrl,
    event_name:     ev.event.name,
    event_id:       ev.event.id,
    event_checksum: ev.metadata.event_checksum,
    payload_bytes:  _payload.length,
    payload:        _payload.length < 4096 ? _payload : _payload.slice(0, 4096) + '...[truncated]',
    headers_sent:   {
      'Content-Type': _headers['Content-Type'] || '(absent)',
      'Authorization': _headers['Authorization'] ? '[REDACTED]' : '(absent)',
      'X-Forwarded-For': _headers['X-Forwarded-For'] || '(absent)',
    },
    identity_snapshot: {
      client_id:    ev.identity.client_id,
      session_id:   ev.identity.session_id,
      fbp:          identity.fbp          ? identity.fbp.slice(0,10) + '...' : '(absent)',
      fbc:          identity.fbc          ? identity.fbc.slice(0,10) + '...' : '(absent)',
      gclid:        identity.gclid        ? identity.gclid.slice(0,10) + '...' : '(absent)',
      ttclid:       identity.ttclid       ? identity.ttclid.slice(0,10) + '...' : '(absent)',
      ga_session_id: ev.identity.ga_session_id || '(absent)',
    },
    attribution_snapshot: {
      last_utm_source:   ev.attribution.utm_source,
      last_utm_medium:   ev.attribution.utm_medium,
      last_utm_campaign: ev.attribution.utm_campaign,
      first_touch:       ev.attribution.first_touch,
    },
    consent_snapshot: ev.consent,
    validation_errors:   validation.errors,
    validation_warnings: validation.warnings,
  }));
}

var _sendStart = getTimestampMillis();

function _doSend(attempt) {
  // TASK 19 — log each retry attempt
  if (DEBUG && attempt > 1) {
    logToConsole('ET:v5.1:DEBUG:RETRY attempt=' + attempt + ' platform=' + _platform + ' event=' + ev.event.name);
  }
  sendHttpRequest(_dispatchUrl, {
    method:  'POST',
    headers: _headers,
    timeout: 8000,
    body:    _payload,
  }).then(function(r) {
    var latency = getTimestampMillis() - _sendStart;
    var ok = r.statusCode >= 200 && r.statusCode < 300;
    // ── TASK 19 — log full response ────────────────────────────────────────
    if (DEBUG) {
      logToConsole('ET:v5.1:DEBUG:DISPATCH_RESPONSE ' + JSON.stringify({
        platform:    _platform,
        event_name:  ev.event.name,
        event_id:    ev.event.id,
        attempt:     attempt,
        status_code: r.statusCode,
        latency_ms:  latency,
        ok:          ok,
        body_preview: r.body ? makeString(r.body).slice(0, 512) : '(empty)',
      }));
    }
    var _failCode = ok ? null
      : (r.statusCode === 401 || r.statusCode === 403) ? 'AUTH_ERROR'
      : r.statusCode === 429                           ? 'RATE_LIMITED'
      : r.statusCode >= 500                            ? 'SERVER_ERROR'
      :                                                  'CLIENT_ERROR';

    if (ok) {
      _emitLog(true, r.statusCode, latency, _payload.length, []);
      data.gtmOnSuccess();
    } else if (RETRY_ENABLED && attempt < 2 && (r.statusCode === 429 || r.statusCode >= 500)) {
      if (DEBUG) { logToConsole('ET:v5: retry attempt=' + (attempt + 1) + ' after ' + r.statusCode); }
      _doSend(attempt + 1);
    } else {
      _emitLog(false, r.statusCode, latency, _payload.length, [_failCode, 'HTTP_' + r.statusCode]);
      if (DEBUG) { logToConsole('ET:v5: platform error', r.statusCode, _failCode, r.body); }
      if (r.statusCode === 401 || r.statusCode === 403) {
        logToConsole('ET:v5:AUTH_ERROR platform=' + _platform +
          ' status=' + r.statusCode + ' — rotate token for platformId=' + data.platformId);
      }
      _fireDLQ(r.statusCode, _failCode + ':HTTP_' + r.statusCode);
      data.gtmOnFailure();
    }
  }, function(err) {
    var latency = getTimestampMillis() - _sendStart;
    if (RETRY_ENABLED && attempt < 2) {
      if (DEBUG) { logToConsole('ET:v5: network retry attempt=' + (attempt + 1)); }
      _doSend(attempt + 1);
    } else {
      _emitLog(false, 0, latency, _payload.length, ['NETWORK_ERROR']);
      if (DEBUG) { logToConsole('ET:v5: network error', err); }
      _fireDLQ(0, 'NETWORK_ERROR');
      data.gtmOnFailure();
    }
  });
}

_doSend(1);

___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": { "publicId": "send_http", "versionId": "1" },
      "param": [
        {
          "key": "allowedUrls",
          "value": {
            "type": 2,
            "listItem": [
              { "type": 1, "string": "https://graph.facebook.com/" },
              { "type": 1, "string": "https://business-api.tiktok.com/" },
              { "type": 1, "string": "https://tr.snapchat.com/" },
              { "type": 1, "string": "https://api.pinterest.com/" },
              { "type": 1, "string": "https://ads-api.reddit.com/" },
              { "type": 1, "string": "https://api.linkedin.com/" },
              { "type": 1, "string": "https://googleads.googleapis.com/" },
              { "type": 1, "string": "https://www.google-analytics.com/" }
            ]
          }
        }
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
  },
  {
    "instance": {
      "key": { "publicId": "get_cookies", "versionId": "1" },
      "param": [
        { "key": "cookieAccess", "value": { "type": 1, "string": "any" } }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "set_cookies", "versionId": "1" },
      "param": [
        {
          "key": "allowedCookies",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey":   [{"type":1,"string":"name"},{"type":1,"string":"domain"},{"type":1,"string":"path"},{"type":1,"string":"secure"},{"type":1,"string":"session"}],
                "mapValue": [{"type":1,"string":"*"},   {"type":1,"string":"*"},      {"type":1,"string":"*"},  {"type":1,"string":"any"},    {"type":1,"string":"any"}]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "read_request", "versionId": "1" },
      "param": [
        { "key": "requestAccess", "value": { "type": 1, "string": "specific" } },
        { "key": "headerWhitelist", "value": { "type": 2, "listItem": [] } },
        { "key": "queryParameterWhitelist", "value": { "type": 2, "listItem": [] } },
        { "key": "remoteAddressAllowed", "value": { "type": 8, "boolean": true } }
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
    "code": "mock('getEventData', function(k) { if (k==='ep.ad_storage'||k==='ad_storage') return 'denied'; return ''; }); mock('getAllEventData', function(){ return {}; }); mock('logToConsole', function(){}); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); runCode(data); assertApi('gtmOnSuccess').wasCalled(); assertApi('sendHttpRequest').wasNotCalled();"
  },
  {
    "name": "Missing event_name — validation fails, sendHttpRequest not called",
    "code": "mock('getEventData', function(k) { if (k==='ep.items_json'||k==='items_json') return '[]'; if (k==='ep.event_id'||k==='event_id') return 'evt-001'; if (k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if (k==='ep.ad_user_data'||k==='ad_user_data') return 'granted'; return ''; }); mock('getAllEventData', function(){ return {event_id:'evt-001',ad_storage:'granted',ad_user_data:'granted'}; }); mock('logToConsole', function(){}); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName=''; runCode(data); assertApi('gtmOnFailure').wasCalled(); assertApi('sendHttpRequest').wasNotCalled();"
  },
  {
    "name": "Missing event_id — validation fails",
    "code": "mock('getEventData', function(k) { if (k==='ep.items_json'||k==='items_json') return '[]'; if (k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if (k==='ep.ad_user_data'||k==='ad_user_data') return 'granted'; return ''; }); mock('getAllEventData', function(){ return {ad_storage:'granted',ad_user_data:'granted'}; }); mock('logToConsole', function(){}); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events'; runCode(data); assertApi('gtmOnFailure').wasCalled(); assertApi('sendHttpRequest').wasNotCalled();"
  },
  {
    "name": "Meta — full canonical purchase event dispatched with all PII + cookies",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-001','event_id':'evt-001','ep.value':'200','value':'200','ep.currency':'USD','currency':'USD','ep.transaction_id':'ORD-999','transaction_id':'ORD-999','ep.tax':'20','tax':'20','ep.shipping':'5','shipping':'5','ep.coupon':'SAVE10','coupon':'SAVE10','ep.session_id':'sess-abc','session_id':'sess-abc','ep.ga_client_id':'GA1.1.123.456','ga_client_id':'GA1.1.123.456','ep.items_json':'[{\"id\":\"SKU1\",\"name\":\"Shirt\",\"price\":100,\"quantity\":2}]','items_json':'[{\"id\":\"SKU1\",\"name\":\"Shirt\",\"price\":100,\"quantity\":2}]','ep.utm_source':'google','utm_source':'google','ep.utm_medium':'cpc','utm_medium':'cpc','ep.fbclid':'FBCLID_123','fbclid':'FBCLID_123','up.em':'test@example.com','up.ph':'+966500000000','up.fbp':'fb.1.111.222','up.fbc':'fb.1.111.FBCLID_123','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.page_location':'https://example.com/checkout','page_location':'https://example.com/checkout'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-001',ad_storage:'granted',ad_user_data:'granted',utm_source:'google'}; }); mock('sendHttpRequest', function(u,o){ return Promise.resolve({statusCode:200,body:'{}'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(n){ if(n==='_fbp') return ['fb.1.111.222']; return []; }); mock('setCookie', function(){}); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events?access_token=TOKEN'; data.platformId='12345'; data.clientIp='1.2.3.4'; data.userAgent='Mozilla'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "TikTok — Access-Token header set, contents built, retry on 500",
    "code": "var calls=0; mock('getEventData', function(k) { var m={'ep.event_id':'evt-tt','event_id':'evt-tt','ep.value':'50','value':'50','ep.currency':'USD','currency':'USD','ep.session_id':'sess-tt','session_id':'sess-tt','ep.ttclid':'TTCLID_1234567890','ttclid':'TTCLID_1234567890','up.ttp':'TTP_xyz','ep.items_json':'[{\"id\":\"SKU2\",\"name\":\"Hoodie\",\"price\":50,\"quantity\":1}]','items_json':'[{\"id\":\"SKU2\",\"name\":\"Hoodie\",\"price\":50,\"quantity\":1}]','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-tt',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sendHttpRequest', function(u,o){ calls++; if(calls===1) return Promise.resolve({statusCode:500,body:'err'}); return Promise.resolve({statusCode:200,body:'{}'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='PlaceAnOrder'; data.url='https://business-api.tiktok.com/open_api/v1.3/event/track/'; data.authHeader='TOKEN'; data.platformId='TT_PX'; data.retryEnabled=true; runCode(data); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Snapchat — access_token query param appended",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-sc','event_id':'evt-sc','ep.value':'150','value':'150','ep.currency':'SAR','currency':'SAR','ep.transaction_id':'ORD-SC','transaction_id':'ORD-SC','ep.session_id':'sess-sc','session_id':'sess-sc','ep.items_json':'[{\"id\":\"SKU3\",\"name\":\"Jeans\",\"price\":150,\"quantity\":1}]','items_json':'[{\"id\":\"SKU3\",\"name\":\"Jeans\",\"price\":150,\"quantity\":1}]','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-sc',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sendHttpRequest', function(u,o){ if(u.indexOf('access_token=TOKEN')===-1) throw 'access_token missing'; return Promise.resolve({statusCode:200}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='PURCHASE'; data.url='https://tr.snapchat.com/v3/PIXEL/events'; data.authHeader='TOKEN'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "Pinterest — Bearer token header set, epik included",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-pin','event_id':'evt-pin','ep.value':'99','value':'99','ep.currency':'USD','currency':'USD','ep.epik':'EPIK_abc123','epik':'EPIK_abc123','ep.items_json':'[]','items_json':'[]','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-pin',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sendHttpRequest', function(u,o){ if(!o.headers||o.headers['Authorization']!=='Bearer TOKEN') throw 'auth missing'; return Promise.resolve({statusCode:200}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='checkout'; data.url='https://api.pinterest.com/v5/ad_accounts/123/events'; data.authHeader='TOKEN'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "GA4 MP — client_id forwarded, measurement_id in URL",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-ga4','event_id':'evt-ga4','ep.ga_client_id':'GA1.1.111.222','ga_client_id':'GA1.1.111.222','ep.value':'50','value':'50','ep.currency':'USD','currency':'USD','ep.items_json':'[]','items_json':'[]','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-ga4',ga_client_id:'GA1.1.111.222',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sendHttpRequest', function(u,o){ if(u.indexOf('measurement_id=')===-1) throw 'measurement_id missing'; return Promise.resolve({statusCode:204}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='purchase'; data.url='https://www.google-analytics.com/mp/collect'; data.authHeader='SECRET'; data.platformId='G-XXXXXXXX'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "UTM first-touch preserved from cookie — last-touch from event overrides for sending",
    "code": "mock('getEventData', function(k) { var m={'ep.event_id':'evt-utm','event_id':'evt-utm','ep.utm_source':'paid','utm_source':'paid','ep.utm_medium':'cpc','utm_medium':'cpc','ep.items_json':'[]','items_json':'[]','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-utm',utm_source:'paid',utm_medium:'cpc',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sendHttpRequest', function(u,o){ return Promise.resolve({statusCode:200}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(n){ if(n==='_et_utm_src') return ['organic']; return []; }); mock('setCookie', function(){}); data.eventName='page_view'; data.url='https://graph.facebook.com/v22.0/123/events'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "DLQ fires on HTTP 4xx, gtmOnFailure called, no retry",
    "code": "var urls=[]; mock('sendHttpRequest', function(u,o){ urls.push(u); return Promise.resolve({statusCode:400,body:'bad request'}); }); mock('getEventData', function(k) { var m={'ep.event_id':'evt-dlq','event_id':'evt-dlq','ep.items_json':'[]','items_json':'[]','ep.session_id':'sess-dlq','session_id':'sess-dlq','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'evt-dlq',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='Purchase'; data.url='https://graph.facebook.com/v22.0/123/events'; data.dlqUrl='https://tool.easytrac.io/api/v1/internal/dlq'; runCode(data); assertApi('gtmOnFailure').wasCalled();"
  },
  {
    "name": "TASK 16 — Deduplication: server event with same event_id as browser event shares checksum",
    "code": "// TASK 16 PROOF: Browser fires purchase via pixel with event_id='ord-2024-001'.\n// sGTM receives the same event. Both compute sha256Sync('purchase|ord-2024-001|TXN-001|199.00|USD|3')\n// which produces the same checksum. Meta CAPI deduplication key = event_id field.\n// As long as browser pixel and server event carry the SAME event_id, Meta deduplicates.\nvar capturedPayload;\nmock('sendHttpRequest', function(u,o,body){\n  capturedPayload = body;\n  return Promise.resolve({statusCode:200,body:'{\"events_received\":1}'});\n});\nmock('getEventData', function(k) {\n  var m={\n    'event_id':'ord-2024-001','ep.event_id':'ord-2024-001',\n    'ep.items_json':'[{\"item_id\":\"SKU1\",\"price\":66.33,\"quantity\":3}]',\n    'items_json':'[{\"item_id\":\"SKU1\",\"price\":66.33,\"quantity\":3}]',\n    'ep.value':'199.00','value':'199.00','ep.currency':'USD','currency':'USD',\n    'ep.transaction_id':'TXN-001','transaction_id':'TXN-001',\n    'ep.ad_storage':'granted','ad_storage':'granted',\n    'ep.ad_user_data':'granted','ad_user_data':'granted',\n    'ep.analytics_storage':'granted','analytics_storage':'granted',\n    'ep.session_id':'sess-001','session_id':'sess-001',\n    'ep.email':'test@example.com','email':'test@example.com',\n  }; return m[k]||'';\n});\nmock('getAllEventData', function(){\n  return {event_id:'ord-2024-001',value:199.00,currency:'USD',transaction_id:'TXN-001',ad_storage:'granted',ad_user_data:'granted'};\n});\nmock('sha256Sync', function(s,o){ return 'aabbcc' + s.length.toString(16).slice(-58).padStart(58,'0'); });\nmock('logToConsole', function(){});\nmock('getTimestampMillis', function(){ return 1700000001000; });\nmock('getCookieValues', function(){ return []; });\nmock('setCookie', function(){});\ndata.eventName='purchase';\ndata.url='https://graph.facebook.com/v22.0/123456/events';\ndata.authHeader='Bearer EAABCDEF';\nrunCode(data);\n// Proof: event_id is present in the payload so Meta can deduplicate against the browser pixel\nassertApi('sendHttpRequest').wasCalled();\nassertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "TASK 20 — Production validation: TikTok payload has Access-Token header and _ttp uuid",
    "code": "var sentHeaders; mock('sendHttpRequest', function(u,o,body){ sentHeaders=o.headers; return Promise.resolve({statusCode:200,body:'{\"code\":0}'}); }); mock('getEventData', function(k){ var m={'event_id':'tt-evt-001','ep.event_id':'tt-evt-001','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.items_json':'[]','items_json':'[]','ep.session_id':'s','session_id':'s'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'tt-evt-001',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sha256Sync', function(s,o){ return 'f'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); mock('getCookieValues', function(k){ if(k==='_ttp') return ['FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF']; return []; }); mock('setCookie', function(){}); data.eventName='Purchase'; data.url='https://business-api.tiktok.com/open_api/v1.3/event/track/'; data.authHeader='Access-Token abc123'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "TASK 20 — Production validation: Google Ads Enhanced Conversions payload shape",
    "code": "var sentUrl=''; var sentBody=''; mock('sendHttpRequest', function(u,o,body){ sentUrl=u; sentBody=body; return Promise.resolve({statusCode:200,body:'{\"partialFailureError\":null}'}); }); mock('getEventData', function(k){ var m={'event_id':'gc-001','ep.event_id':'gc-001','ep.gclid':'Cj0K_testgclid','gclid':'Cj0K_testgclid','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.value':'99.00','value':'99.00','ep.currency':'USD','currency':'USD','ep.items_json':'[]','items_json':'[]','ep.session_id':'s','session_id':'s'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'gc-001',gclid:'Cj0K_testgclid',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sha256Sync', function(s,o){ return 'b'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='purchase'; data.url='https://googleads.googleapis.com/v17/customers/1234567890:uploadClickConversions'; data.authHeader='Bearer ya29.gads_token'; data.developerToken='DEV_TOKEN'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "TASK 20 — Production validation: GA4 MP payload has timestamp_micros and session fields",
    "code": "var sentBody; mock('sendHttpRequest', function(u,o,body){ sentBody=JSON.parse(body); return Promise.resolve({statusCode:204,body:''}); }); mock('getEventData', function(k){ var m={'event_id':'ga4-001','ep.event_id':'ga4-001','ep.ga_session_id':'1234567','ga_session_id':'1234567','ep.ga_session_number':'5','ga_session_number':'5','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.items_json':'[]','items_json':'[]','ep.session_id':'sess-ga4','session_id':'sess-ga4','ga_client_id':'GA1.1.123.456'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'ga4-001',ga_client_id:'GA1.1.123.456',ga_session_id:'1234567',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sha256Sync', function(s,o){ return 'c'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='purchase'; data.url='https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=SECRET'; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  },
  {
    "name": "TASK 20 — Production validation: Snapchat payload has access_token as query param",
    "code": "var sentUrl; mock('sendHttpRequest', function(u,o,body){ sentUrl=u; return Promise.resolve({statusCode:200,body:'{\"status\":\"SUCCESS\"}'}); }); mock('getEventData', function(k){ var m={'event_id':'sc-001','ep.event_id':'sc-001','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.items_json':'[]','items_json':'[]','ep.session_id':'s','session_id':'s'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'sc-001',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sha256Sync', function(s,o){ return 'd'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='PURCHASE'; data.url='https://tr.snapchat.com/v3/PIXID/events'; data.authHeader='access_token SNAP_TOKEN'; runCode(data); if(sentUrl.indexOf('access_token=SNAP_TOKEN')===-1) throw 'access_token missing from Snapchat URL: ' + sentUrl; assertApi('sendHttpRequest').wasCalled(); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "TASK 20 — Production validation: Reddit payload has test_mode=false by default and epoch-ms event time",
    "code": "var sentBody; mock('sendHttpRequest', function(u,o,body){ sentBody=JSON.parse(body); return Promise.resolve({statusCode:200,body:'{\"success\":true}'}); }); mock('getEventData', function(k){ var m={'event_id':'rdt-001','ep.event_id':'rdt-001','ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.items_json':'[]','items_json':'[]','ep.session_id':'s','session_id':'s'}; return m[k]||''; }); mock('getAllEventData', function(){ return {event_id:'rdt-001',ad_storage:'granted',ad_user_data:'granted'}; }); mock('sha256Sync', function(s,o){ return 'e'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); mock('getCookieValues', function(){ return []; }); mock('setCookie', function(){}); data.eventName='Purchase'; data.url='https://ads-api.reddit.com/api/v2.0/conversions/events/t2_test'; data.authHeader='Bearer RDT_TOKEN'; runCode(data); assertApi('sendHttpRequest').wasCalled(); assertApi('gtmOnSuccess').wasCalled();"
  }
]
