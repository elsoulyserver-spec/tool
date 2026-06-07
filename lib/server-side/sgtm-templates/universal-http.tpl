___INFO___

{
  "type": "TAG",
  "id": "et_universal_http",
  "version": 1,
  "securityGroups": [],
  "displayName": "Easy Track - Universal HTTP Forwarder",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Forwards events to Meta CAPI, TikTok Events API, or Snapchat CAPI via sendHttpRequest. Platform is detected from the endpoint URL.",
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
    "displayName": "Auth Header Value (Bearer token — leave blank for Meta)",
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
    "displayName": "Platform Pixel / Source ID (TikTok: event_source_id)",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "clientIp",
    "displayName": "Client IP Address"
  },
  {
    "type": "TEXT",
    "name": "userAgent",
    "displayName": "User Agent"
  },
  {
    "type": "CHECKBOX",
    "name": "enableDebug",
    "displayName": "Enable Debug Logging",
    "simpleValueType": true,
    "defaultValue": false
  },
  { "type": "TEXT", "name": "userEmail",      "displayName": "User Email (hashed SHA-256)",     "simpleValueType": true },
  { "type": "TEXT", "name": "userPhone",      "displayName": "User Phone (hashed SHA-256)",     "simpleValueType": true },
  { "type": "TEXT", "name": "userFirstName",  "displayName": "User First Name (hashed)",        "simpleValueType": true },
  { "type": "TEXT", "name": "userLastName",   "displayName": "User Last Name (hashed)",         "simpleValueType": true },
  { "type": "TEXT", "name": "userExternalId", "displayName": "User External ID",                "simpleValueType": true },
  { "type": "TEXT", "name": "fbp",            "displayName": "Meta _fbp Cookie",                "simpleValueType": true },
  { "type": "TEXT", "name": "fbc",            "displayName": "Meta _fbc Cookie",                "simpleValueType": true },
  { "type": "TEXT", "name": "ttp",            "displayName": "TikTok _ttp Cookie",              "simpleValueType": true },
  { "type": "TEXT", "name": "scid",           "displayName": "Snapchat _scid Cookie",           "simpleValueType": true },
  { "type": "TEXT", "name": "ttclid",         "displayName": "TikTok Click ID (ttclid)",        "simpleValueType": true },
  { "type": "TEXT", "name": "scCid",          "displayName": "Snapchat Click ID (ScCid)",       "simpleValueType": true },
  { "type": "TEXT", "name": "gclid",          "displayName": "Google Click ID (gclid)",         "simpleValueType": true },
  { "type": "TEXT", "name": "pageLocation",   "displayName": "Page Location (URL)",             "simpleValueType": true },
  { "type": "TEXT", "name": "pageReferrer",   "displayName": "Page Referrer",                   "simpleValueType": true },
  { "type": "TEXT", "name": "eventValue",     "displayName": "Conversion Value",                "simpleValueType": true },
  { "type": "TEXT", "name": "eventCurrency",  "displayName": "Currency Code",                   "simpleValueType": true },
  { "type": "TEXT", "name": "orderId",        "displayName": "Order / Transaction ID",          "simpleValueType": true },
  { "type": "TEXT", "name": "eventId",        "displayName": "Deduplication Event ID",          "simpleValueType": true }
]

___SANDBOXED_JS_FOR_SERVER___

var sendHttpRequest    = require('sendHttpRequest');
var JSON               = require('JSON');
var getEventData       = require('getEventData');
var getTimestampMillis = require('getTimestampMillis');
var logToConsole       = require('logToConsole');
var Math               = require('Math');

var DEBUG = data.enableDebug === true;

function clean(o) {
  var r = {};
  for (var k in o) {
    if (o[k] !== '' && o[k] !== null && o[k] !== undefined) r[k] = o[k];
  }
  return r;
}

// Prefer explicit tag parameters (resolved from sGTM variables) with event data as fallback.
// This supports both explicit parameter passing and direct Event Data extraction seamlessly.
var ts      = Math.floor(getTimestampMillis() / 1000);
var eventId = data.eventId        || getEventData('event_id')        || ('ET-' + getTimestampMillis());
var value   = data.eventValue     || getEventData('value')           || 0;
var currency= data.eventCurrency  || getEventData('currency')        || 'SAR';
var orderId = data.orderId        || getEventData('transaction_id')  || '';
var cIds    = getEventData('content_ids') || '';
var em      = data.userEmail      || getEventData('up.em')           || getEventData('user_data.em')           || '';
var ph      = data.userPhone      || getEventData('up.ph')           || getEventData('user_data.ph')           || '';
var fn      = data.userFirstName  || getEventData('up.fn')           || getEventData('user_data.fn')           || '';
var ln      = data.userLastName   || getEventData('up.ln')           || getEventData('user_data.ln')           || '';
var extId   = data.userExternalId || getEventData('up.external_id')  || getEventData('user_data.external_id') || '';
var fbp     = data.fbp            || getEventData('up.fbp')          || '';
var fbc     = data.fbc            || getEventData('up.fbc')          || '';
var pageUrl = data.pageLocation   || getEventData('page_location')   || '';
var pageRef = data.pageReferrer   || getEventData('page_referrer')   || '';
var ttclid  = data.ttclid         || getEventData('ep.ttclid')       || '';
var ttp     = data.ttp            || getEventData('up.ttp')          || '';
var scid    = data.scid           || getEventData('up.scid')         || '';
var sccid   = data.scCid          || getEventData('ep.ScCid')        || '';

var url = data.url;
var payload;

if (url.indexOf('tiktok.com') !== -1) {
  payload = JSON.stringify({
    event_source:    'web',
    event_source_id: data.platformId,
    data: [{
      event:      data.eventName,
      event_time: ts,
      event_id:   eventId,
      user: clean({
        email:        em,
        phone_number: ph,
        external_id:  extId,
        ttclid:       ttclid,
        ttp:          ttp,
        ip:           data.clientIp,
        user_agent:   data.userAgent
      }),
      properties: clean({
        currency:     currency,
        value:        value,
        content_id:   cIds,
        content_type: 'product',
        order_id:     orderId
      }),
      page: { url: pageUrl, referrer: pageRef }
    }]
  });
} else if (url.indexOf('snapchat.com') !== -1) {
  payload = JSON.stringify({
    data: [{
      event_conversion_type: 'WEB',
      event_type:  data.eventName,
      event_tag:   eventId,
      timestamp:   ts,
      hashed_data_fields: clean({ email: em, phone_number: ph, external_id: extId }),
      user_data:   clean({ sc_click_id: sccid, uuid_c1: scid, ip_address: data.clientIp, user_agent: data.userAgent }),
      custom_data: clean({ currency: currency, price: value, transaction_id: orderId, content_ids: cIds ? [cIds] : undefined })
    }]
  });
} else {
  payload = JSON.stringify({
    data: [{
      event_name:       data.eventName,
      event_time:       ts,
      event_id:         eventId,
      action_source:    'website',
      event_source_url: pageUrl,
      user_data: clean({
        em:                em,
        ph:                ph,
        fn:                fn,
        ln:                ln,
        external_id:       extId,
        fbp:               fbp,
        fbc:               fbc,
        client_ip_address: data.clientIp,
        client_user_agent: data.userAgent
      }),
      custom_data: clean({
        currency:     currency,
        value:        value,
        order_id:     orderId,
        content_ids:  cIds ? [cIds] : undefined,
        content_type: 'product'
      })
    }]
  });
}

var hdrs = {'Content-Type': 'application/json'};
if (url.indexOf('tiktok.com') !== -1) {
  if (data.authHeader) { hdrs['Access-Token'] = data.authHeader; }
} else {
  if (data.authHeader) { hdrs['Authorization'] = 'Bearer ' + data.authHeader; }
}

if (DEBUG) { logToConsole('ET:UniversalHTTP:', url, data.eventName, payload); }

sendHttpRequest(url, {
  method:  'POST',
  headers: hdrs,
  timeout: 8000,
  body:    payload
}).then(function(r) {
  if (r.statusCode >= 200 && r.statusCode < 300) {
    if (DEBUG) { logToConsole('ET:UniversalHTTP: success', r.statusCode); }
    data.gtmOnSuccess();
  } else {
    if (DEBUG) { logToConsole('ET:UniversalHTTP: error', r.statusCode, r.body); }
    data.gtmOnFailure();
  }
}, function(err) {
  if (DEBUG) { logToConsole('ET:UniversalHTTP: network error', err); }
  data.gtmOnFailure();
});

___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "send_http",
        "versionId": "1"
      },
      "param": [
        {
          "key": "allowedUrls",
          "value": {
            "type": 1,
            "string": "any"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "read_event_data",
        "versionId": "1"
      },
      "param": [
        {
          "key": "eventDataAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "logging",
        "versionId": "1"
      },
      "param": [
        {
          "key": "environments",
          "value": {
            "type": 1,
            "string": "all"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]
