___INFO___

{
  "type": "TAG",
  "id": "et_meta_capi_manual",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Meta CAPI (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual Meta Conversions API tag. Sends events directly to https://graph.facebook.com/v22.0/{PIXEL_ID}/events via sendHttpRequest. SHA-256 hashes all PII server-side. No official Meta template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "pixelId",
    "displayName": "Meta Pixel ID",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "CAPI Access Token",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Event Name (Meta)",
    "simpleValueType": true,
    "help": "e.g. Purchase, ViewContent, AddToCart"
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "Event ID (deduplication)",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp)",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "actionSource",
    "displayName": "Action Source",
    "simpleValueType": true,
    "defaultValue": "website"
  },
  {
    "type": "TEXT",
    "name": "sourceUrl",
    "displayName": "Source URL (page_location)"
  },
  {
    "type": "TEXT",
    "name": "value",
    "displayName": "Value (revenue)"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency"
  },
  {
    "type": "TEXT",
    "name": "orderId",
    "displayName": "Order ID / Transaction ID"
  },
  {
    "type": "TEXT",
    "name": "contentIds",
    "displayName": "Content IDs (comma-separated)"
  },
  {
    "type": "TEXT",
    "name": "contentName",
    "displayName": "Content Name"
  },
  {
    "type": "TEXT",
    "name": "contentType",
    "displayName": "Content Type",
    "defaultValue": "product"
  },
  {
    "type": "TEXT",
    "name": "numItems",
    "displayName": "Number of Items"
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
    "name": "userFirstName",
    "displayName": "First Name (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userLastName",
    "displayName": "Last Name (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userCity",
    "displayName": "City (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userState",
    "displayName": "State (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userZip",
    "displayName": "Zip (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userCountry",
    "displayName": "Country (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "externalId",
    "displayName": "External ID (will be SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "fbp",
    "displayName": "_fbp cookie value"
  },
  {
    "type": "TEXT",
    "name": "fbc",
    "displayName": "_fbc / built fbc value"
  },
  {
    "type": "TEXT",
    "name": "clientIpAddress",
    "displayName": "Client IP Address"
  },
  {
    "type": "TEXT",
    "name": "clientUserAgent",
    "displayName": "Client User Agent"
  },
  {
    "type": "TEXT",
    "name": "testEventCode",
    "displayName": "Test Event Code (optional)",
    "help": "e.g. TEST12345 — only set during testing"
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

// ─────────────────────────────────────────────────────────────────────────────
// ET - Meta CAPI (Manual HTTP) — sGTM Sandboxed JS
// EasyTrac v3 | No official template | sendHttpRequest + sha256Sync
// ─────────────────────────────────────────────────────────────────────────────

const sendHttpRequest  = require('sendHttpRequest');
const JSON             = require('JSON');
const sha256Sync       = require('sha256Sync');
const makeNumber       = require('makeNumber');
const makeString       = require('makeString');
const logToConsole     = require('logToConsole');
const getTimestampMillis = require('getTimestampMillis');
const Math               = require('Math');

const DEBUG = data.enableDebug === true;

function dbg(msg, obj) {
  if (!DEBUG) return;
  logToConsole('ET:MetaCAPI:', msg, obj ? JSON.stringify(obj) : '');
}

// ── SHA-256 hash helper ────────────────────────────────────────────────────
function hash(raw) {
  if (!raw) return undefined;
  var s = makeString(raw).toLowerCase().trim();
  if (!s) return undefined;
  // Already a 64-char hex string — pass through (pre-hashed)
  if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

// Phone: strip non-digits except leading +
function hashPhone(raw) {
  if (!raw) return undefined;
  var s = makeString(raw).trim().split(' ').join('').split('-').join('').split('(').join('').split(')').join('').split('.').join('');
  if (!s) return undefined;
  if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

// ── Empty-value cleanup ────────────────────────────────────────────────────
function defined(v) {
  return v !== undefined && v !== null && v !== '';
}

function clean(obj) {
  var out = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = obj[k];
    if (defined(v)) out[k] = v;
  }
  return out;
}

// ── Content IDs → array ────────────────────────────────────────────────────
function toArray(val) {
  if (!val) return undefined;
  var s = makeString(val).trim();
  if (!s) return undefined;
  if (s.indexOf(',') !== -1) {
    return s.split(',').map(function(x) { return x.trim(); });
  }
  return [s];
}

// ── Build user_data ────────────────────────────────────────────────────────
var user_data = clean({
  em:                defined(data.userEmail)       ? hash(data.userEmail)       : undefined,
  ph:                defined(data.userPhone)       ? hashPhone(data.userPhone)  : undefined,
  fn:                defined(data.userFirstName)   ? hash(data.userFirstName)   : undefined,
  ln:                defined(data.userLastName)    ? hash(data.userLastName)    : undefined,
  ct:                defined(data.userCity)        ? hash(data.userCity)        : undefined,
  st:                defined(data.userState)       ? hash(data.userState)       : undefined,
  zp:                defined(data.userZip)         ? hash(data.userZip)         : undefined,
  country:           defined(data.userCountry)     ? hash(data.userCountry)     : undefined,
  external_id:       defined(data.externalId)      ? hash(data.externalId)      : undefined,
  fbp:               defined(data.fbp)             ? data.fbp                   : undefined,
  fbc:               defined(data.fbc)             ? data.fbc                   : undefined,
  client_ip_address: defined(data.clientIpAddress) ? data.clientIpAddress       : undefined,
  client_user_agent: defined(data.clientUserAgent) ? data.clientUserAgent       : undefined,
});

// ── Build custom_data ──────────────────────────────────────────────────────
var contentIds = toArray(data.contentIds);
var custom_data = clean({
  value:        defined(data.value)    ? makeNumber(data.value) : undefined,
  currency:     defined(data.currency) ? data.currency          : undefined,
  order_id:     defined(data.orderId)  ? data.orderId           : undefined,
  content_ids:  contentIds,
  content_name: defined(data.contentName) ? data.contentName    : undefined,
  content_type: defined(data.contentType) ? data.contentType    : 'product',
  num_items:    defined(data.numItems) ? makeNumber(data.numItems) : undefined,
});

if (defined(contentIds)) {
  var contents = [];
  for (var ci = 0; ci < contentIds.length; ci++) {
    contents.push(clean({
      id:       contentIds[ci],
      quantity: defined(data.numItems) ? makeNumber(data.numItems) : 1,
      price:    defined(data.value)    ? makeNumber(data.value)    : undefined,
    }));
  }
  if (contents.length > 0) custom_data.contents = contents;
}

// ── Build event time ───────────────────────────────────────────────────────
var eventTime = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);

// ── Assemble payload ───────────────────────────────────────────────────────
var eventObj = clean({
  event_name:       data.eventName || 'PageView',
  event_time:       eventTime,
  event_id:         defined(data.eventId)    ? makeString(data.eventId)    : undefined,
  action_source:    data.actionSource        ? data.actionSource           : 'website',
  event_source_url: defined(data.sourceUrl)  ? data.sourceUrl              : undefined,
  user_data:        Object.keys(user_data).length  > 0 ? user_data  : undefined,
  custom_data:      Object.keys(custom_data).length > 0 ? custom_data : undefined,
});

var requestBody = { data: [eventObj] };
if (defined(data.testEventCode)) {
  requestBody.test_event_code = data.testEventCode;
}

var url = 'https://graph.facebook.com/v22.0/' + data.pixelId + '/events?access_token=' + data.accessToken;

dbg('Sending payload', requestBody);

// ── Send HTTP request ──────────────────────────────────────────────────────
sendHttpRequest(url, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 8000,
}, JSON.stringify(requestBody)).then(function(res) {
  dbg('Response status', res.statusCode);
  dbg('Response body',   res.body);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    logToConsole('ET:MetaCAPI: ✅ success', res.statusCode, data.eventName, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:MetaCAPI: ❌ HTTP error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}).catch(function(err) {
  logToConsole('ET:MetaCAPI: ❌ network error', err);
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

