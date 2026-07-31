___INFO___

{
  "type": "TAG",
  "id": "et_debug_inspector",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Debug Inspector",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Standalone debug tag for TASK 12/19. Logs the full enriched Server Event Data object as structured JSON to the sGTM preview/debug console. Shows: all event parameters, identity, attribution (first/last/current touch), consent state, cookies present, PII signals (truncated), custom parameters, enrichment metadata. Fire on ALL events in debug mode only — never in production.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "CHECKBOX",
    "name": "logAllEventData",
    "displayName": "Log getAllEventData() dump",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "Logs the raw getAllEventData() object showing every key sent from the browser."
  },
  {
    "type": "CHECKBOX",
    "name": "logCookies",
    "displayName": "Log incoming cookies",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "Logs all EasyTrac, Meta, TikTok, Google Ads, Pinterest, Reddit, LinkedIn cookies."
  },
  {
    "type": "CHECKBOX",
    "name": "logIdentity",
    "displayName": "Log identity resolution",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "Logs client_id, session_id, external_id, ga_session_id, click IDs."
  },
  {
    "type": "CHECKBOX",
    "name": "logAttribution",
    "displayName": "Log attribution (all 3 tiers)",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "Logs first_touch, last_touch, and current_touch attribution objects."
  },
  {
    "type": "CHECKBOX",
    "name": "logConsent",
    "displayName": "Log consent state",
    "simpleValueType": true,
    "defaultValue": true
  },
  {
    "type": "CHECKBOX",
    "name": "logEcommerce",
    "displayName": "Log ecommerce (items, value, currency)",
    "simpleValueType": true,
    "defaultValue": true
  },
  {
    "type": "CHECKBOX",
    "name": "logCustomParams",
    "displayName": "Log custom parameters (ep.* / up.*)",
    "simpleValueType": true,
    "defaultValue": true
  },
  {
    "type": "CHECKBOX",
    "name": "logEnrichment",
    "displayName": "Log enrichment metadata",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "Server IP, client IP, user agent, geo, page URL, referrer."
  }
]

___SANDBOXED_JS_FOR_SERVER___

// =============================================================================
// ET - Debug Inspector — TASK 12 + TASK 19 standalone implementation
// Logs the full enriched Server Event Data object as structured JSON.
// Use in sGTM preview mode ONLY. Block with a tag firing condition in production.
// =============================================================================

var getAllEventData     = require('getAllEventData');
var getEventData       = require('getEventData');
var getCookieValues    = require('getCookieValues');
var getRemoteAddress   = require('getRemoteAddress');
var getTimestampMillis = require('getTimestampMillis');
var logToConsole       = require('logToConsole');
var JSON               = require('JSON');
var makeString         = require('makeString');
var makeNumber         = require('makeNumber');
var Object             = require('Object');

var now = getTimestampMillis();

// ── Safe read cookie ──────────────────────────────────────────────────────────
function _ck(name) {
  var v = getCookieValues(name);
  return (v && v.length > 0) ? v[0] : null;
}

// ── Safe event data read ──────────────────────────────────────────────────────
function _ed(key, fallback) {
  var v = getEventData('ep.' + key) || getEventData(key);
  return (v !== undefined && v !== null && v !== '') ? v : (fallback || null);
}

// ── Truncate sensitive values for logging ────────────────────────────────────
function _trunc(v, len) {
  if (!v) return '(absent)';
  var s = makeString(v);
  return s.length > (len || 20) ? s.slice(0, len || 20) + '...' : s;
}

// ── 1. Raw getAllEventData dump ────────────────────────────────────────────────
if (data.logAllEventData !== false) {
  var allData = getAllEventData();
  var keys    = Object.keys(allData);
  var safeObj = {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = allData[k];
    // Truncate anything that looks like PII (email, phone patterns)
    if (k.indexOf('email') !== -1 || k.indexOf('phone') !== -1 ||
        k.indexOf('address') !== -1 || k.indexOf('_ip') !== -1) {
      safeObj[k] = _trunc(makeString(v), 8) + '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 200) {
      safeObj[k] = v.slice(0, 200) + '...[truncated]';
    } else {
      safeObj[k] = v;
    }
  }
  logToConsole('ET:DebugInspector:ALL_EVENT_DATA (' + keys.length + ' keys) ' + JSON.stringify(safeObj));
}

// ── 2. Incoming cookie jar ────────────────────────────────────────────────────
if (data.logCookies !== false) {
  logToConsole('ET:DebugInspector:COOKIES_PRESENT ' + JSON.stringify({
    // Meta
    _fbp:          _ck('_fbp')          ? _trunc(_ck('_fbp'), 20)     : '(absent)',
    _fbc:          _ck('_fbc')          ? _trunc(_ck('_fbc'), 20)     : '(absent)',
    // TikTok
    _ttp:          _ck('_ttp')          ? _trunc(_ck('_ttp'), 20)     : '(absent)',
    // Snapchat
    _scid:         _ck('_scid')         ? _trunc(_ck('_scid'), 20)    : '(absent)',
    // Pinterest
    _epik:         _ck('_epik')         ? _trunc(_ck('_epik'), 20)    : '(absent)',
    // Reddit
    _rdt_uuid:     _ck('_rdt_uuid')     ? _trunc(_ck('_rdt_uuid'), 20): '(absent)',
    // LinkedIn
    _li_fat_id:    _ck('_li_fat_id')    ? _trunc(_ck('_li_fat_id'), 20): '(absent)',
    // Google Ads Conversion Linker
    _gcl_aw:       _ck('_gcl_aw')       ? _trunc(_ck('_gcl_aw'), 30)  : '(absent)',
    _gcl_gb:       _ck('_gcl_gb')       ? _trunc(_ck('_gcl_gb'), 30)  : '(absent)',
    _gcl_dc:       _ck('_gcl_dc')       ? _trunc(_ck('_gcl_dc'), 30)  : '(absent)',
    // EasyTrac first-party
    _fpid:         _ck('_fpid')         ? _trunc(_ck('_fpid'), 20)    : '(absent)',
    _et_cid:       _ck('_et_cid')       ? _trunc(_ck('_et_cid'), 20)  : '(absent)',
    _et_sid:       _ck('_et_sid')       ? _trunc(_ck('_et_sid'), 20)  : '(absent)',
    _et_ext:       _ck('_et_ext')       ? '[present]'                 : '(absent)',
    // GA4 session
    _et_ga4_cid:   _ck('_et_ga4_cid')  ? _trunc(_ck('_et_ga4_cid'), 20) : '(absent)',
    _et_ga4_sid:   _ck('_et_ga4_sid')  ? _ck('_et_ga4_sid')           : '(absent)',
    _et_ga4_snum:  _ck('_et_ga4_snum') ? _ck('_et_ga4_snum')          : '(absent)',
    // UTM first-touch
    _et_utm_src:   _ck('_et_utm_src')  || '(absent)',
    _et_utm_med:   _ck('_et_utm_med')  || '(absent)',
    _et_utm_cmp:   _ck('_et_utm_cmp')  || '(absent)',
  }));
}

// ── 3. Identity resolution ────────────────────────────────────────────────────
if (data.logIdentity !== false) {
  logToConsole('ET:DebugInspector:IDENTITY ' + JSON.stringify({
    client_id:        _ed('ga_client_id') || _ck('_et_cid') || '(absent)',
    session_id:       _ed('session_id')   || _ck('_et_sid') || '(absent)',
    external_id:      _ck('_et_ext')      ? '[present]'      : '(absent)',
    user_id:          _ed('user_id')      || '(absent)',
    // Meta
    fbp:              _ck('_fbp')         ? _trunc(_ck('_fbp'), 20) : '(absent)',
    fbc:              _ck('_fbc')         ? _trunc(_ck('_fbc'), 20) : '(absent)',
    fbclid_in_event:  _ed('fbclid')       ? '[present]'      : '(absent)',
    // Google Ads
    gclid:            _ed('gclid')        ? _trunc(_ed('gclid'), 20) : '(absent)',
    gbraid:           _ed('gbraid')       || '(absent)',
    wbraid:           _ed('wbraid')       || '(absent)',
    gcl_aw_cookie:    _ck('_gcl_aw')      ? _trunc(_ck('_gcl_aw'), 30) : '(absent)',
    // GA4
    ga_session_id:    _ed('ga_session_id')  || _ck('_et_ga4_sid')  || '(absent)',
    ga_session_num:   _ed('ga_session_number') || _ck('_et_ga4_snum') || '(absent)',
    ga_client_id:     _ed('ga_client_id')  || _ck('_et_ga4_cid')  || '(absent)',
    // TikTok
    ttclid:           _ed('ttclid')        ? '[present]'      : '(absent)',
    ttp:              _ck('_ttp')           ? _trunc(_ck('_ttp'), 20) : '(absent)',
    // Snapchat
    sc_click_id:      _ed('sc_click_id')   || '(absent)',
    scid:             _ck('_scid')          ? _trunc(_ck('_scid'), 20) : '(absent)',
    // Pinterest
    epik:             _ck('_epik')          ? _trunc(_ck('_epik'), 20) : '(absent)',
    // Reddit
    rdt_cid:          _ed('rdt_cid')        || '(absent)',
    rdt_uuid:         _ck('_rdt_uuid')      ? _trunc(_ck('_rdt_uuid'), 20) : '(absent)',
    // LinkedIn
    li_fat_id:        _ed('li_fat_id')      || _ck('_li_fat_id') || '(absent)',
    // Network
    server_ip:        getRemoteAddress()    || '(absent)',
  }));
}

// ── 4. Attribution (3 tiers) ──────────────────────────────────────────────────
if (data.logAttribution !== false) {
  logToConsole('ET:DebugInspector:ATTRIBUTION ' + JSON.stringify({
    current_touch: {
      utm_source:   _ed('utm_source')   || '(absent — organic/direct)',
      utm_medium:   _ed('utm_medium')   || '(absent)',
      utm_campaign: _ed('utm_campaign') || '(absent)',
      utm_content:  _ed('utm_content')  || '(absent)',
      utm_term:     _ed('utm_term')     || '(absent)',
      fbclid:       _ed('fbclid')       ? '[present]' : '(absent)',
      gclid:        _ed('gclid')        ? '[present]' : '(absent)',
      ttclid:       _ed('ttclid')       ? '[present]' : '(absent)',
    },
    last_touch: {
      utm_source:   _ed('utm_source')   || _ck('_et_utm_src') || '(absent)',
      utm_medium:   _ed('utm_medium')   || _ck('_et_utm_med') || '(absent)',
      utm_campaign: _ed('utm_campaign') || _ck('_et_utm_cmp') || '(absent)',
    },
    first_touch: {
      utm_source:   _ck('_et_utm_src') || '(absent — no first-touch cookie)',
      utm_medium:   _ck('_et_utm_med') || '(absent)',
      utm_campaign: _ck('_et_utm_cmp') || '(absent)',
    },
    first_touch_cookie_present: !!_ck('_et_utm_src'),
  }));
}

// ── 5. Consent state ─────────────────────────────────────────────────────────
if (data.logConsent !== false) {
  logToConsole('ET:DebugInspector:CONSENT ' + JSON.stringify({
    ad_storage:           _ed('ad_storage')           || '(absent — defaulting to denied)',
    analytics_storage:    _ed('analytics_storage')    || '(absent — defaulting to denied)',
    ad_user_data:         _ed('ad_user_data')         || '(absent — defaulting to denied)',
    ad_personalization:   _ed('ad_personalization')   || '(absent — defaulting to denied)',
    will_fire_capi:       (_ed('ad_storage') === 'granted' && _ed('ad_user_data') === 'granted') ? 'YES' : 'NO — consent blocked',
  }));
}

// ── 6. Ecommerce ─────────────────────────────────────────────────────────────
if (data.logEcommerce !== false) {
  logToConsole('ET:DebugInspector:ECOMMERCE ' + JSON.stringify({
    event_name:    _ed('event_name')    || '(absent)',
    event_id:      _ed('event_id')      || '(absent — deduplication will not work)',
    transaction_id: _ed('transaction_id') || '(absent)',
    value:         _ed('value')         || '(absent)',
    currency:      _ed('currency')      || '(absent)',
    items_json:    _ed('items_json')    ? '[present — ' + makeString(_ed('items_json')).length + ' bytes]' : '(absent)',
    search_term:   _ed('search_term')   || '(absent)',
    content_type:  _ed('content_type')  || '(absent)',
    content_category: _ed('content_category') || '(absent)',
  }));
}

// ── 7. Custom params (ep.* and up.*) ─────────────────────────────────────────
if (data.logCustomParams !== false) {
  var allDataForParams = getAllEventData();
  var paramKeys        = Object.keys(allDataForParams);
  var epParams         = {};
  var upParams         = {};
  for (var pi = 0; pi < paramKeys.length; pi++) {
    var pk = paramKeys[pi];
    if (pk.indexOf('ep.') === 0) {
      epParams[pk.slice(3)] = allDataForParams[pk];
    } else if (pk.indexOf('up.') === 0) {
      upParams[pk.slice(3)] = allDataForParams[pk];
    }
  }
  logToConsole('ET:DebugInspector:CUSTOM_PARAMS ep(' + Object.keys(epParams).length + ') ' + JSON.stringify(epParams));
  if (Object.keys(upParams).length > 0) {
    logToConsole('ET:DebugInspector:USER_PROPERTIES up(' + Object.keys(upParams).length + ') ' + JSON.stringify(upParams));
  }
}

// ── 8. Enrichment / server-side metadata ─────────────────────────────────────
if (data.logEnrichment !== false) {
  logToConsole('ET:DebugInspector:ENRICHMENT ' + JSON.stringify({
    server_timestamp:  now,
    server_ip:         getRemoteAddress() || '(absent)',
    client_ip:         _ed('client_ip')   || '(absent)',
    user_agent:        _trunc(_ed('user_agent') || '', 60),
    page_url:          _ed('page_location') || _ed('page_url') || '(absent)',
    page_referrer:     _ed('page_referrer') || '(absent)',
    page_title:        _ed('page_title')    || '(absent)',
    language:          _ed('language')      || '(absent)',
    event_count:       getAllEventData()    ? Object.keys(getAllEventData()).length : 0,
  }));
}

logToConsole('ET:DebugInspector: inspection complete at ' + now);
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
    "name": "Debug inspector — logs all sections and calls gtmOnSuccess",
    "code": "var logged=[]; mock('logToConsole', function(msg){ logged.push(msg); }); mock('getAllEventData', function(){ return {event_id:'evt-debug-001',event_name:'purchase',value:99,'ep.utm_source':'google','ep.ga_session_id':'1234567',ad_storage:'granted',ad_user_data:'granted'}; }); mock('getEventData', function(k){ var m={'ep.ad_storage':'granted','ad_storage':'granted','ep.ad_user_data':'granted','ad_user_data':'granted','ep.analytics_storage':'granted','analytics_storage':'granted','ep.event_id':'evt-debug-001','event_id':'evt-debug-001','ep.value':'99','value':'99','ep.currency':'USD','currency':'USD'}; return m[k]||''; }); mock('getCookieValues', function(name){ if(name==='_fbp') return ['fb.1.1700000000.123']; if(name==='_et_utm_src') return ['google']; return []; }); mock('getRemoteAddress', function(){ return '1.2.3.4'; }); mock('getTimestampMillis', function(){ return 1700000001000; }); data.logAllEventData=true; data.logCookies=true; data.logIdentity=true; data.logAttribution=true; data.logConsent=true; data.logEcommerce=true; data.logCustomParams=true; data.logEnrichment=true; runCode(data); var hasAllData = logged.filter(function(m){ return m.indexOf('ALL_EVENT_DATA')!==-1; }).length > 0; var hasCookies = logged.filter(function(m){ return m.indexOf('COOKIES_PRESENT')!==-1; }).length > 0; var hasConsent = logged.filter(function(m){ return m.indexOf('CONSENT')!==-1; }).length > 0; if(!hasAllData) throw 'ALL_EVENT_DATA section missing'; if(!hasCookies) throw 'COOKIES_PRESENT section missing'; if(!hasConsent) throw 'CONSENT section missing'; assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Debug inspector — first-touch cookie present in attribution",
    "code": "var logged=[]; mock('logToConsole', function(msg){ logged.push(msg); }); mock('getAllEventData', function(){ return {ad_storage:'granted',ad_user_data:'granted'}; }); mock('getEventData', function(k){ if(k==='ep.ad_storage'||k==='ad_storage') return 'granted'; if(k==='ep.analytics_storage'||k==='analytics_storage') return 'granted'; return ''; }); mock('getCookieValues', function(name){ if(name==='_et_utm_src') return ['cpc_google']; if(name==='_et_utm_med') return ['cpc']; if(name==='_et_utm_cmp') return ['brand_campaign']; return []; }); mock('getRemoteAddress', function(){ return '5.6.7.8'; }); mock('getTimestampMillis', function(){ return 1700000001000; }); data.logAttribution=true; runCode(data); var attLog = logged.filter(function(m){ return m.indexOf('ATTRIBUTION')!==-1; }); if(attLog.length===0) throw 'ATTRIBUTION section missing'; if(attLog[0].indexOf('cpc_google')===-1) throw 'first-touch utm_source missing from attribution log'; assertApi('gtmOnSuccess').wasCalled();"
  }
]
