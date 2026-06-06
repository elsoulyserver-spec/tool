___INFO___

{
  "type": "TAG",
  "id": "et_snapchat_capi_manual",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Snapchat CAPI (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual Snapchat Conversions API tag. Sends events directly to https://tr.snapchat.com/v3/{pixel_id}/events (Conversions API v3) via sendHttpRequest. SHA-256 hashes PII server-side. No official Snapchat template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "pixelId",
    "displayName": "Snapchat Pixel ID",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "CAPI Access Token",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventType",
    "displayName": "Event Type (Snapchat)",
    "simpleValueType": true,
    "help": "e.g. PURCHASE, VIEW_CONTENT, ADD_CART"
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "Event ID (client_dedup_id)"
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp seconds)"
  },
  {
    "type": "TEXT",
    "name": "price",
    "displayName": "Price / Value"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency"
  },
  {
    "type": "TEXT",
    "name": "transactionId",
    "displayName": "Transaction ID / Order ID"
  },
  {
    "type": "TEXT",
    "name": "itemIds",
    "displayName": "Item IDs (comma-separated)"
  },
  {
    "type": "TEXT",
    "name": "userEmail",
    "displayName": "User Email (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userPhone",
    "displayName": "User Phone (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "externalId",
    "displayName": "External ID (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "scid",
    "displayName": "_scid cookie (Snapchat browser ID)"
  },
  {
    "type": "TEXT",
    "name": "ScCid",
    "displayName": "ScCid URL parameter (Snapchat click ID)"
  },
  {
    "type": "TEXT",
    "name": "ipAddress",
    "displayName": "Client IP Address"
  },
  {
    "type": "TEXT",
    "name": "userAgent",
    "displayName": "Client User Agent"
  },
  {
    "type": "TEXT",
    "name": "pageUrl",
    "displayName": "Page URL"
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
// ET - Snapchat CAPI (Manual HTTP) - sGTM Sandboxed JS
// EasyTrac v3 | No official template | sendHttpRequest + sha256Sync
// Docs: https://marketingapi.snapchat.com/docs/conversion.html
// -----------------------------------------------------------------------------

var sendHttpRequest    = require('sendHttpRequest');
var JSON               = require('JSON');
var sha256Sync         = require('sha256Sync');
var makeNumber         = require('makeNumber');
var makeString         = require('makeString');
var logToConsole       = require('logToConsole');
var getTimestampMillis = require('getTimestampMillis');
var Math               = require('Math');
var Object             = require('Object');

var DEBUG = data.enableDebug === true;

function dbg(msg, obj) {
  if (!DEBUG) return;
  logToConsole('ET:SnapCAPI:', msg, obj ? JSON.stringify(obj) : '');
}

// -- SHA-256 helpers --------------------------------------------------------
// Sandbox-safe hex check (GTM sandboxed JS does NOT support regex literals)
function isHex64(s) {
  if (!s || s.length !== 64) return false;
  var hexChars = '0123456789abcdef';
  var i;
  for (i = 0; i < 64; i++) {
    if (hexChars.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}

function hash(raw) {
  if (!raw) return undefined;
  var s = makeString(raw).toLowerCase().trim();
  if (!s) return undefined;
  if (isHex64(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

function hashPhone(raw) {
  if (!raw) return undefined;
  var s = makeString(raw).trim().split(' ').join('').split('-').join('').split('(').join('').split(')').join('').split('.').join('');
  if (!s) return undefined;
  if (isHex64(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
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

function toArray(val) {
  if (!val) return undefined;
  var s = makeString(val).trim();
  if (!s) return undefined;
  return s.indexOf(',') !== -1 ? s.split(',').map(function(x) { return x.trim(); }) : [s];
}

// -- Build user_data ---------------------------------------------------------
// Snapchat wraps each hashed field in an array
var user_data = clean({
  em:                defined(data.userEmail)  ? [hash(data.userEmail)]      : undefined,
  ph:                defined(data.userPhone)  ? [hashPhone(data.userPhone)] : undefined,
  external_id:       defined(data.externalId) ? hash(data.externalId)       : undefined,
  sc_click_id:       defined(data.ScCid)      ? data.ScCid                  : undefined,
  sc_cookie1:        defined(data.scid)       ? data.scid                   : undefined,
  client_ip_address: defined(data.ipAddress)  ? data.ipAddress             : undefined,
  client_user_agent: defined(data.userAgent)  ? data.userAgent             : undefined,
});

// -- Build custom_data ------------------------------------------------------
var itemIds = toArray(data.itemIds);
var custom_data = clean({
  currency:    defined(data.currency)      ? data.currency          : undefined,
  value:       defined(data.price)         ? makeNumber(data.price) : undefined,
  order_id:    defined(data.transactionId) ? data.transactionId     : undefined,
  content_ids: itemIds ? itemIds : undefined,
});

// -- Event time - Snapchat requires milliseconds ----------------------------
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);
var eventTimeMs = eventTimeSec * 1000;

// -- Assemble body ----------------------------------------------------------
// Snapchat CAPI v3 - single event inside the data[] array
var eventObj = clean({
  event_name:       data.eventType || 'PAGE_VIEW',
  event_time:       eventTimeMs,
  event_source_url: defined(data.pageUrl) ? data.pageUrl : undefined,
  event_id:         defined(data.eventId) ? makeString(data.eventId) : undefined,
  action_source:    'WEB',
  user_data:        Object.keys(user_data).length  > 0 ? user_data  : undefined,
  custom_data:      Object.keys(custom_data).length > 0 ? custom_data : undefined,
});

var body = { data: [eventObj] };

// v3 endpoint: pixel id in the path, access token in the query string
var url = 'https://tr.snapchat.com/v3/' + data.pixelId + '/events?access_token=' + data.accessToken;

dbg('Sending payload', body);

// -- Send HTTP request ------------------------------------------------------
sendHttpRequest(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 8000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response status', res.statusCode);
  dbg('Response body',   res.body);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    logToConsole('ET:SnapCAPI: success', res.statusCode, data.eventType, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:SnapCAPI: HTTP error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}, function(err) {
  logToConsole('ET:SnapCAPI: network error', err);
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

