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
  }
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

var ts      = Math.floor(getTimestampMillis() / 1000);
var eventId = getEventData('event_id')        || ('ET-' + getTimestampMillis());
var value   = getEventData('value')           || 0;
var currency= getEventData('currency')        || 'SAR';
var orderId = getEventData('transaction_id')  || '';
var cIds    = getEventData('content_ids')     || '';
var em      = getEventData('up.em')           || getEventData('user_data.em')           || '';
var ph      = getEventData('up.ph')           || getEventData('user_data.ph')           || '';
var fn      = getEventData('up.fn')           || getEventData('user_data.fn')           || '';
var ln      = getEventData('up.ln')           || getEventData('user_data.ln')           || '';
var extId   = getEventData('up.external_id')  || getEventData('user_data.external_id') || '';
var fbp     = getEventData('up.fbp')          || '';
var fbc     = getEventData('up.fbc')          || '';
var pageUrl = getEventData('page_location')   || '';
var pageRef = getEventData('page_referrer')   || '';
var ttclid  = getEventData('ep.ttclid')       || '';
var ttp     = getEventData('up.ttp')          || '';
var scid    = getEventData('up.scid')         || '';
var sccid   = getEventData('ep.ScCid')        || '';

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
