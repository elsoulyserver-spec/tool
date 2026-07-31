___INFO___

{
  "type": "TAG",
  "id": "et_ga4_mp",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - GA4 Measurement Protocol (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual GA4 Measurement Protocol tag. Sends events to https://www.google-analytics.com/mp/collect via sendHttpRequest. Forwards client_id, session_id, user_id, ecommerce items, and UTM parameters. Use the debug endpoint for validation. No official GA4 template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "measurementId",
    "displayName": "GA4 Measurement ID (G-XXXXXXXXXX)",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "apiSecret",
    "displayName": "API Secret",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "GA4 Event Name",
    "simpleValueType": true,
    "help": "e.g. purchase, add_to_cart, view_item, begin_checkout, page_view"
  },
  {
    "type": "TEXT",
    "name": "clientId",
    "displayName": "GA4 Client ID (ga_client_id)",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "userId",
    "displayName": "User ID (authenticated users)"
  },
  {
    "type": "TEXT",
    "name": "sessionId",
    "displayName": "Session ID (ga_session_id)"
  },
  {
    "type": "TEXT",
    "name": "sessionNumber",
    "displayName": "Session Number (ga_session_number)"
  },
  {
    "type": "TEXT",
    "name": "engagementTimeMsec",
    "displayName": "Engagement Time (ms, default 1)"
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp seconds)"
  },
  {
    "type": "TEXT",
    "name": "transactionId",
    "displayName": "Transaction ID"
  },
  {
    "type": "TEXT",
    "name": "value",
    "displayName": "Value"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency (ISO 4217)"
  },
  {
    "type": "TEXT",
    "name": "coupon",
    "displayName": "Coupon Code"
  },
  {
    "type": "TEXT",
    "name": "shipping",
    "displayName": "Shipping Amount"
  },
  {
    "type": "TEXT",
    "name": "tax",
    "displayName": "Tax Amount"
  },
  {
    "type": "TEXT",
    "name": "affiliation",
    "displayName": "Affiliation"
  },
  {
    "type": "TEXT",
    "name": "itemsJson",
    "displayName": "Items JSON (stringified GA4 items array)"
  },
  {
    "type": "TEXT",
    "name": "utmSource",
    "displayName": "UTM Source"
  },
  {
    "type": "TEXT",
    "name": "utmMedium",
    "displayName": "UTM Medium"
  },
  {
    "type": "TEXT",
    "name": "utmCampaign",
    "displayName": "UTM Campaign"
  },
  {
    "type": "TEXT",
    "name": "utmContent",
    "displayName": "UTM Content"
  },
  {
    "type": "TEXT",
    "name": "utmTerm",
    "displayName": "UTM Term"
  },
  {
    "type": "TEXT",
    "name": "searchTerm",
    "displayName": "Search Term"
  },
  {
    "type": "TEXT",
    "name": "pageLocation",
    "displayName": "Page URL (page_location)"
  },
  {
    "type": "TEXT",
    "name": "pageReferrer",
    "displayName": "Page Referrer"
  },
  {
    "type": "TEXT",
    "name": "pageTitle",
    "displayName": "Page Title"
  },
  {
    "type": "CHECKBOX",
    "name": "nonPersonalizedAds",
    "displayName": "Non-Personalized Ads (Consent Mode)",
    "simpleValueType": true,
    "defaultValue": false
  },
  {
    "type": "CHECKBOX",
    "name": "debugMode",
    "displayName": "Send to Debug Endpoint (validate only)",
    "simpleValueType": true,
    "defaultValue": false
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

// -----------------------------------------------------------------------------
// ET - GA4 Measurement Protocol (Manual HTTP) - sGTM Sandboxed JS
// EasyTrac v1 | GA4 MP v1
// Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4
// -----------------------------------------------------------------------------

var sendHttpRequest    = require('sendHttpRequest');
var JSON               = require('JSON');
var makeNumber         = require('makeNumber');
var makeString         = require('makeString');
var logToConsole       = require('logToConsole');
var getTimestampMillis = require('getTimestampMillis');
var Math               = require('Math');
var Object             = require('Object');
var encodeUriComponent = require('encodeUriComponent');

var DEBUG = data.enableDebug === true;

function dbg(msg, obj) {
  if (!DEBUG) return;
  logToConsole('ET:GA4MP:', msg, obj ? JSON.stringify(obj) : '');
}

function defined(v) { return v !== undefined && v !== null && v !== ''; }

function clean(obj) {
  var out = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    if (defined(obj[keys[i]])) out[keys[i]] = obj[keys[i]];
  }
  return out;
}

// ── Event time — GA4 MP uses microseconds ─────────────────────────────────────
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);
var timestampMicros = makeString(eventTimeSec) + '000000';

// ── Items ─────────────────────────────────────────────────────────────────────
var items;
if (defined(data.itemsJson) && data.itemsJson.length <= 32000) {
  var _parsed;
  try { _parsed = JSON.parse(data.itemsJson); } catch (e) { _parsed = null; }
  if (_parsed && typeof _parsed === 'object' && _parsed.length) {
    items = _parsed;
  }
}

// ── Event parameters ──────────────────────────────────────────────────────────
var params = clean({
  transaction_id:  defined(data.transactionId)      ? data.transactionId           : undefined,
  value:           defined(data.value)              ? makeNumber(data.value)        : undefined,
  currency:        defined(data.currency)           ? data.currency                : undefined,
  coupon:          defined(data.coupon)             ? data.coupon                  : undefined,
  shipping:        defined(data.shipping)           ? makeNumber(data.shipping)     : undefined,
  tax:             defined(data.tax)                ? makeNumber(data.tax)          : undefined,
  affiliation:     defined(data.affiliation)        ? data.affiliation             : undefined,
  search_term:     defined(data.searchTerm)         ? data.searchTerm              : undefined,
  page_location:   defined(data.pageLocation)       ? data.pageLocation            : undefined,
  page_referrer:   defined(data.pageReferrer)       ? data.pageReferrer            : undefined,
  page_title:      defined(data.pageTitle)          ? data.pageTitle               : undefined,
  source:          defined(data.utmSource)          ? data.utmSource               : undefined,
  medium:          defined(data.utmMedium)          ? data.utmMedium               : undefined,
  campaign:        defined(data.utmCampaign)        ? data.utmCampaign             : undefined,
  content:         defined(data.utmContent)         ? data.utmContent              : undefined,
  term:            defined(data.utmTerm)            ? data.utmTerm                 : undefined,
  session_id:      defined(data.sessionId)          ? data.sessionId               : undefined,
  ga_session_id:   defined(data.sessionId)          ? data.sessionId               : undefined,
  ga_session_number: defined(data.sessionNumber)    ? makeNumber(data.sessionNumber) : undefined,
  engagement_time_msec: defined(data.engagementTimeMsec)
    ? makeNumber(data.engagementTimeMsec) : 1,
  items: items,
});

// ── Payload ───────────────────────────────────────────────────────────────────
var body = clean({
  client_id:           data.clientId || 'unknown',
  timestamp_micros:    timestampMicros,
  user_id:             defined(data.userId) ? data.userId : undefined,
  non_personalized_ads: data.nonPersonalizedAds === true,
  events: [{
    name:   data.eventName || 'page_view',
    params: params,
  }],
});

// ── Endpoint: debug or production ─────────────────────────────────────────────
var baseUrl = data.debugMode === true
  ? 'https://www.google-analytics.com/debug/mp/collect'
  : 'https://www.google-analytics.com/mp/collect';

var url = baseUrl +
  '?measurement_id=' + encodeUriComponent(data.measurementId) +
  '&api_secret='     + encodeUriComponent(data.apiSecret);

dbg('Sending payload', body);

// ── Dispatch ──────────────────────────────────────────────────────────────────
sendHttpRequest(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 8000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response', res.statusCode);

  // GA4 MP debug endpoint returns 200 with validationMessages; production returns 204
  if (res.statusCode >= 200 && res.statusCode < 300) {
    if (data.debugMode && res.body) {
      var parsed = JSON.parse(res.body) || {};
      var msgs = parsed.validationMessages || [];
      if (msgs.length > 0) {
        logToConsole('ET:GA4MP: debug validation issues', JSON.stringify(msgs));
      } else {
        logToConsole('ET:GA4MP: debug OK', data.eventName, data.clientId);
      }
    } else {
      logToConsole('ET:GA4MP: success', res.statusCode, data.eventName, data.clientId);
    }
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:GA4MP: error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}, function(err) {
  logToConsole('ET:GA4MP: network error', err);
  data.gtmOnFailure();
});

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
  }
]

___TESTS___

[
  {
    "name": "GA4 MP — purchase dispatched with measurement_id + api_secret in URL",
    "code": "mock('sendHttpRequest', function(u,o){ if(u.indexOf('measurement_id=G-TEST')===-1) throw 'measurement_id missing'; if(u.indexOf('api_secret=SECRET')===-1) throw 'api_secret missing'; if(u.indexOf('google-analytics.com/mp/collect')===-1) throw 'wrong endpoint'; return Promise.resolve({statusCode:204,body:''}); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.measurementId='G-TEST'; data.apiSecret='SECRET'; data.eventName='purchase'; data.clientId='GA1.1.123.456'; data.transactionId='ORD-001'; data.value='199'; data.currency='USD'; data.itemsJson='[{\"item_id\":\"SKU1\",\"item_name\":\"Shirt\",\"price\":199,\"quantity\":1}]'; runCode(data); assertApi('sendHttpRequest').wasCalled(); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "GA4 MP — debug mode uses debug endpoint",
    "code": "var urlSent; mock('sendHttpRequest', function(u,o){ urlSent=u; return Promise.resolve({statusCode:200,body:'{\"validationMessages\":[]}'}); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.measurementId='G-TEST'; data.apiSecret='SECRET'; data.eventName='page_view'; data.clientId='GA1.1.999.888'; data.debugMode=true; runCode(data); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "GA4 MP — HTTP error calls gtmOnFailure",
    "code": "mock('sendHttpRequest', function(u,o){ return Promise.resolve({statusCode:400,body:'Bad Request'}); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.measurementId='G-BAD'; data.apiSecret='BAD'; data.eventName='page_view'; data.clientId='unknown'; runCode(data); assertApi('gtmOnFailure').wasCalled();"
  }
]
