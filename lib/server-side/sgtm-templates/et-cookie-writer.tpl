___INFO___

{
  "type": "TAG",
  "id": "et_cookie_writer",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Server-Side Cookie Writer",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Standalone first-party cookie writer. Writes all EasyTrac, Meta, TikTok, Snapchat, Pinterest, Reddit, LinkedIn, and Google Ads Conversion Linker cookies via server-side Set-Cookie headers. Bypasses Safari ITP 7-day cap. Requires consent signals to be available in event data.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "CHECKBOX",
    "name": "enableCookies",
    "displayName": "Enable Cookie Writing",
    "simpleValueType": true,
    "defaultValue": true
  },
  {
    "type": "TEXT",
    "name": "cookieDomain",
    "displayName": "Cookie Domain (blank = request hostname)",
    "simpleValueType": true,
    "help": "e.g. .yourdomain.com — leave blank for automatic detection from Forwarded header"
  },
  {
    "type": "TEXT",
    "name": "retentionDays",
    "displayName": "Default Retention (days, default 90)",
    "simpleValueType": true,
    "defaultValue": "90"
  },
  {
    "type": "GROUP",
    "name": "metaGroup",
    "displayName": "Meta",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "fbp",    "displayName": "_fbp value",    "simpleValueType": true },
      { "type": "TEXT", "name": "fbc",    "displayName": "_fbc value",    "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "tiktokGroup",
    "displayName": "TikTok",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "ttp", "displayName": "_ttp value", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "snapchatGroup",
    "displayName": "Snapchat",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "scid", "displayName": "_scid value", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "pinterestGroup",
    "displayName": "Pinterest",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "epik", "displayName": "_epik value", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "redditGroup",
    "displayName": "Reddit",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "rdtUuid", "displayName": "_rdt_uuid value", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "linkedinGroup",
    "displayName": "LinkedIn",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "liFatId", "displayName": "_li_fat_id value", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "googleAdsGroup",
    "displayName": "Google Ads Conversion Linker",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "gclid",  "displayName": "gclid  → _gcl_aw", "simpleValueType": true },
      { "type": "TEXT", "name": "gbraid", "displayName": "gbraid → _gcl_gb", "simpleValueType": true },
      { "type": "TEXT", "name": "wbraid", "displayName": "wbraid → _gcl_dc", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "ga4Group",
    "displayName": "GA4 Session",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "ga4ClientId",     "displayName": "GA4 Client ID (→ _et_ga4_cid)", "simpleValueType": true },
      { "type": "TEXT", "name": "ga4SessionId",    "displayName": "GA4 Session ID (→ _et_ga4_sid)", "simpleValueType": true },
      { "type": "TEXT", "name": "ga4SessionNum",   "displayName": "GA4 Session Number (→ _et_ga4_snum)", "simpleValueType": true }
    ]
  },
  {
    "type": "GROUP",
    "name": "utmGroup",
    "displayName": "UTM First-Touch",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      { "type": "TEXT", "name": "utmSource",   "displayName": "utm_source",   "simpleValueType": true },
      { "type": "TEXT", "name": "utmMedium",   "displayName": "utm_medium",   "simpleValueType": true },
      { "type": "TEXT", "name": "utmCampaign", "displayName": "utm_campaign", "simpleValueType": true },
      { "type": "TEXT", "name": "utmContent",  "displayName": "utm_content",  "simpleValueType": true },
      { "type": "TEXT", "name": "utmTerm",     "displayName": "utm_term",     "simpleValueType": true }
    ]
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
// ET - Server-Side Cookie Writer
// EasyTrac v1 | TASK 11 standalone cookie tag
// Writes all first-party tracking cookies via server-side Set-Cookie headers.
// Server-side cookies bypass Safari ITP 7-day cap on JavaScript-set cookies.
// =============================================================================

var setCookie          = require('setCookie');
var getCookieValues    = require('getCookieValues');
var getEventData       = require('getEventData');
var getTimestampMillis = require('getTimestampMillis');
var makeNumber         = require('makeNumber');
var makeString         = require('makeString');
var logToConsole       = require('logToConsole');
var Math               = require('Math');

var DEBUG         = data.enableDebug === true;
var ENABLE        = data.enableCookies !== false;
var COOKIE_DOMAIN = data.cookieDomain  || '';
var RETENTION     = makeNumber(data.retentionDays || '90') || 90;

var now = Math.floor(getTimestampMillis() / 1000);

function defined(v) { return v !== undefined && v !== null && v !== ''; }

// ── Write helper ─────────────────────────────────────────────────────────────
// Always writes (refreshes TTL) — Safari ITP mitigation.
// httpOnly=true prevents JavaScript access (server-only enrichment cookies).
function _write(name, value, days, httpOnly) {
  if (!ENABLE || !defined(value)) return;
  var opts = {
    path:          '/',
    secure:        true,
    sameSite:      'Lax',
    expiresInDays: days || RETENTION,
  };
  if (COOKIE_DOMAIN) { opts.domain = COOKIE_DOMAIN; }
  if (httpOnly)      { opts.httpOnly = true; }
  setCookie(name, value, opts, false);
  if (DEBUG) { logToConsole('ET:CookieWriter: SET ' + name + '=' + value.slice(0,20) + '... domain=' + (COOKIE_DOMAIN || 'auto') + ' days=' + (days || RETENTION)); }
}

// ── Read existing cookies (create-if-absent pattern) ─────────────────────────
function _read(name) {
  var vals = getCookieValues(name);
  return (vals && vals.length > 0) ? vals[0] : null;
}

// ── Consent gates ─────────────────────────────────────────────────────────────
var adStorage        = getEventData('ep.ad_storage')        || getEventData('ad_storage')        || 'denied';
var analyticsStorage = getEventData('ep.analytics_storage') || getEventData('analytics_storage') || 'denied';
var adGranted        = adStorage        === 'granted';
var analyticsGranted = analyticsStorage === 'granted';

// =============================================================================
// META — _fbp and _fbc
// =============================================================================
if (adGranted) {
  if (defined(data.fbp)) {
    _write('_fbp', data.fbp, 90, false);
  }
  if (defined(data.fbc)) {
    _write('_fbc', data.fbc, 90, false);
  }
}

// =============================================================================
// TIKTOK — _ttp (395 days, aligns with TikTok's own cookie duration)
// =============================================================================
if (adGranted && defined(data.ttp)) {
  _write('_ttp', data.ttp, 395, false);
}

// =============================================================================
// SNAPCHAT — _scid
// =============================================================================
if (adGranted && defined(data.scid)) {
  _write('_scid', data.scid, 395, false);
}

// =============================================================================
// PINTEREST — _epik
// =============================================================================
if (adGranted && defined(data.epik)) {
  _write('_epik', data.epik, 180, false);
}

// =============================================================================
// REDDIT — _rdt_uuid
// =============================================================================
if (adGranted && defined(data.rdtUuid)) {
  _write('_rdt_uuid', data.rdtUuid, 90, false);
}

// =============================================================================
// LINKEDIN — _li_fat_id (30 days)
// =============================================================================
if (adGranted && defined(data.liFatId)) {
  _write('_li_fat_id', data.liFatId, 30, false);
}

// =============================================================================
// GOOGLE ADS CONVERSION LINKER — _gcl_aw / _gcl_gb / _gcl_dc
// Format: GCL.{original_click_timestamp}.{click_id}
// FIX 3: preserve the ORIGINAL click timestamp from the cookie value.
// Only Max-Age is refreshed. The internal GCL timestamp is never regenerated.
// Rule: existing cookie → write it back unchanged; no cookie → write GCL.{now}.{id}
// Consent Mode v2: write only when ad_storage = granted.
// =============================================================================
if (adGranted) {
  if (defined(data.gclid)) {
    var _existGclAw = _read('_gcl_aw');
    _write('_gcl_aw', _existGclAw ? _existGclAw : 'GCL.' + now + '.' + data.gclid,  90, false);
  }
  if (defined(data.gbraid)) {
    var _existGclGb = _read('_gcl_gb');
    _write('_gcl_gb', _existGclGb ? _existGclGb : 'GCL.' + now + '.' + data.gbraid, 90, false);
  }
  if (defined(data.wbraid)) {
    var _existGclDc = _read('_gcl_dc');
    _write('_gcl_dc', _existGclDc ? _existGclDc : 'GCL.' + now + '.' + data.wbraid, 90, false);
  }
}

// =============================================================================
// GA4 SESSION — _et_ga4_cid / _et_ga4_sid / _et_ga4_snum
// HttpOnly: these are read exclusively server-side for GA4 MP enrichment
// =============================================================================
if (analyticsGranted) {
  if (defined(data.ga4ClientId)) {
    _write('_et_ga4_cid',  data.ga4ClientId,  RETENTION, true);
  }
  if (defined(data.ga4SessionId)) {
    _write('_et_ga4_sid',  data.ga4SessionId, 1,         true);
  }
  if (defined(data.ga4SessionNum)) {
    _write('_et_ga4_snum', data.ga4SessionNum, RETENTION, true);
  }
}

// =============================================================================
// UTM FIRST-TOUCH — written once, never overwritten
// If the cookie already exists the current visit is NOT the first touch.
// =============================================================================
if (analyticsGranted) {
  if (!_read('_et_utm_src') && defined(data.utmSource))   { _write('_et_utm_src', data.utmSource,   RETENTION, false); }
  if (!_read('_et_utm_med') && defined(data.utmMedium))   { _write('_et_utm_med', data.utmMedium,   RETENTION, false); }
  if (!_read('_et_utm_cmp') && defined(data.utmCampaign)) { _write('_et_utm_cmp', data.utmCampaign, RETENTION, false); }
  if (!_read('_et_utm_con') && defined(data.utmContent))  { _write('_et_utm_con', data.utmContent,  RETENTION, false); }
  if (!_read('_et_utm_trm') && defined(data.utmTerm))     { _write('_et_utm_trm', data.utmTerm,     RETENTION, false); }
}

if (DEBUG) {
  logToConsole('ET:CookieWriter: done. ad_storage=' + adStorage + ' analytics_storage=' + analyticsStorage + ' domain=' + (COOKIE_DOMAIN || 'auto'));
}

data.gtmOnSuccess();

___SERVER_PERMISSIONS___

[
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
  }
]

___TESTS___

[
  {
    "name": "Cookie writer — Meta _fbp written when ad_storage=granted",
    "code": "var written={}; mock('setCookie', function(name,val,opts){ written[name]=val; }); mock('getCookieValues', function(){ return []; }); mock('getEventData', function(k){ if(k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if(k==='ep.analytics_storage'||k==='analytics_storage') return 'granted'; return ''; }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); data.enableCookies=true; data.fbp='fb.1.1700000001000.123456789'; data.fbc='fb.1.1700000001000.FB_gclid'; data.ttp='FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'; runCode(data); if(!written['_fbp']) throw '_fbp not written'; if(!written['_fbc']) throw '_fbc not written'; if(!written['_ttp']) throw '_ttp not written'; assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Cookie writer — Google Ads _gcl_aw written with GCL.{ts}.{gclid} format",
    "code": "var written={}; mock('setCookie', function(name,val,opts){ written[name]=val; }); mock('getCookieValues', function(){ return []; }); mock('getEventData', function(k){ if(k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if(k==='ep.analytics_storage'||k==='analytics_storage') return 'granted'; return ''; }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); data.enableCookies=true; data.gclid='Cj0KCQiA1rSsBhDHARIsANB4EJaTestGCLID'; runCode(data); if(!written['_gcl_aw']) throw '_gcl_aw not written'; if(written['_gcl_aw'].indexOf('GCL.')!==0) throw '_gcl_aw format wrong: ' + written['_gcl_aw']; assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Cookie writer — UTM first-touch skipped when cookie already exists",
    "code": "var written={}; mock('setCookie', function(name,val,opts){ written[name]=val; }); mock('getCookieValues', function(name){ if(name==='_et_utm_src') return ['google']; return []; }); mock('getEventData', function(k){ if(k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if(k==='ep.analytics_storage'||k==='analytics_storage') return 'granted'; return ''; }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); data.enableCookies=true; data.utmSource='facebook'; runCode(data); if(written['_et_utm_src']) throw '_et_utm_src was overwritten (should preserve first-touch)'; assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Cookie writer — no cookies written when enableCookies=false",
    "code": "var written={}; mock('setCookie', function(name,val,opts){ written[name]=val; }); mock('getCookieValues', function(){ return []; }); mock('getEventData', function(k){ if(k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if(k==='ep.analytics_storage'||k==='analytics_storage') return 'granted'; return ''; }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000001000; }); data.enableCookies=false; data.fbp='fb.1.1700000001.123'; data.gclid='test-gclid'; runCode(data); if(Object.keys(written).length>0) throw 'cookies written despite enableCookies=false: ' + JSON.stringify(Object.keys(written)); assertApi('gtmOnSuccess').wasCalled();"
  }
]
