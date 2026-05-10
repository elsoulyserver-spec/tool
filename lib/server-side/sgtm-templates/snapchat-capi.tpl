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
  "description": "Manual Snapchat Conversions API tag. Sends events directly to https://tr.snapchat.com/v2/conversion via sendHttpRequest. SHA-256 hashes PII server-side. No official Snapchat template used.",
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

// ─────────────────────────────────────────────────────────────────────────────
// ET - Snapchat CAPI (Manual HTTP) — sGTM Sandboxed JS
// EasyTrac v3 | No official template | sendHttpRequest + sha256Sync
// Docs: https://marketingapi.snapchat.com/docs/conversion.html
// ─────────────────────────────────────────────────────────────────────────────

const sendHttpRequest    = require('sendHttpRequest');
const JSON               = require('JSON');
const sha256Sync         = require('sha256Sync');
const makeNumber         = require('makeNumber');
const makeString         = require('makeString');
const logToConsole       = require('logToConsole');
const getTimestampMillis = require('getTimestampMillis');

const DEBUG = data.enableDebug === true;

function dbg(msg, obj) {
  if (!DEBUG) return;
  logToConsole('ET:SnapCAPI:', msg, obj ? JSON.stringify(obj) : '');
}

// ── SHA-256 helpers ────────────────────────────────────────────────────────
function hash(raw) {
  if (!raw) return undefined;
  var s = makeString(raw).toLowerCase().trim();
  if (!s) return undefined;
  if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;
  return sha256Sync(s, { outputEncoding: 'hex' });
}

function hashPhone(raw) {
  if (!raw) return undefined;
  var s = makeString(raw).trim().split(' ').join('').split('-').join('').split('(').join('').split(')').join('').split('.').join('');
  if (!s) return undefined;
  if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;
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

// ── Build user_data ─────────────────────────────────────────────────────────
// Snapchat wraps each hashed field in an array
var user_data = clean({
  em:          defined(data.userEmail)   ? [hash(data.userEmail)]      : undefined,
  ph:          defined(data.userPhone)   ? [hashPhone(data.userPhone)]  : undefined,
  external_id: defined(data.externalId)  ? [hash(data.externalId)]      : undefined,
  sc_click_id: defined(data.ScCid)       ? data.ScCid                  : undefined,
  sc_cookie1:  defined(data.scid)        ? data.scid                   : undefined,
  ip_address:  defined(data.ipAddress)   ? data.ipAddress              : undefined,
  user_agent:  defined(data.userAgent)   ? data.userAgent              : undefined,
});

// ── Build custom_data ──────────────────────────────────────────────────────
var itemIds = toArray(data.itemIds);
var custom_data = clean({
  currency:       defined(data.currency)      ? data.currency                 : undefined,
  price:          defined(data.price)         ? makeNumber(data.price)        : undefined,
  transaction_id: defined(data.transactionId) ? data.transactionId            : undefined,
  item_ids:       itemIds                                                      ? itemIds : undefined,
});

// ── Event time — Snapchat requires milliseconds ────────────────────────────
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);
var eventTimeMs = eventTimeSec * 1000;

// ── Assemble body ──────────────────────────────────────────────────────────
var body = clean({
  pixel_id:         data.pixelId,
  event_type:       data.eventType || 'PAGE_VIEW',
  event_time:       eventTimeMs,
  event_source_url: defined(data.pageUrl) ? data.pageUrl : undefined,
  client_dedup_id:  defined(data.eventId) ? makeString(data.eventId) : undefined,
  user_data:        Object.keys(user_data).length  > 0 ? user_data  : undefined,
  custom_data:      Object.keys(custom_data).length > 0 ? custom_data : undefined,
});

var url = 'https://tr.snapchat.com/v2/conversion';

dbg('Sending payload', body);

// ── Send HTTP request ──────────────────────────────────────────────────────
sendHttpRequest(url, {
  method: 'POST',
  headers: {
    Authorization:  'Bearer ' + data.accessToken,
    'Content-Type': 'application/json',
  },
  timeout: 8000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response status', res.statusCode);
  dbg('Response body',   res.body);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    logToConsole('ET:SnapCAPI: ✅ success', res.statusCode, data.eventType, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:SnapCAPI: ❌ HTTP error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}).catch(function(err) {
  logToConsole('ET:SnapCAPI: ❌ network error', err);
  data.gtmOnFailure();
});

___PERMISSIONS___

[
  {
    "instance": {
      "key": { "publicId": "send_http", "versionId": "1" },
      "param": [
        {
          "key": "allowedUrls",
          "value": {
            "type": 1,
            "listItem": [
              {
                "type": 2,
                "mapKey": [{"type": 1, "string": "url"}, {"type": 1, "string": "queryParameterNames"}],
                "mapValue": [
                  {"type": 1, "string": "https://tr.snapchat.com/"},
                  {"type": 1, "string": "any"}
                ]
              }
            ]
          }
        }
      ]
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "logging", "versionId": "1" },
      "param": [{"key": "environments", "value": {"type": 1, "string": "all"}}]
    },
    "isRequired": true
  }
]

___NOTES___

Import via sGTM workspace: Admin → Templates → New → Import
Template type referenced by tags: et_snapchat_capi_manual
Note: Snapchat CAPI requires event_time in milliseconds — this template converts automatically.
No official Snapchat template is used — all HTTP is manual.
