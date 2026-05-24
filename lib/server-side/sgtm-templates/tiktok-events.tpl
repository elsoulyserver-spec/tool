___INFO___

{
  "type": "TAG",
  "id": "et_tiktok_events_manual",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - TikTok Events API (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual TikTok Events API v1.3 tag. Sends events directly to https://business-api.tiktok.com/open_api/v1.3/event/track/ via sendHttpRequest. SHA-256 hashes PII server-side. No official TikTok template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "pixelCode",
    "displayName": "TikTok Pixel ID",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "Events API Access Token",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Event Name (TikTok)",
    "simpleValueType": true,
    "help": "e.g. PlaceAnOrder, ViewContent, AddToCart"
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "Event ID (deduplication)"
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp)"
  },
  {
    "type": "TEXT",
    "name": "value",
    "displayName": "Order Value"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency"
  },
  {
    "type": "TEXT",
    "name": "orderId",
    "displayName": "Order ID"
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
    "name": "quantity",
    "displayName": "Quantity"
  },
  {
    "type": "TEXT",
    "name": "userEmail",
    "displayName": "User Email (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userPhone",
    "displayName": "User Phone (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "externalId",
    "displayName": "External ID (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "ttclid",
    "displayName": "TikTok Click ID (ttclid)"
  },
  {
    "type": "TEXT",
    "name": "ttp",
    "displayName": "_ttp Cookie Value"
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
    "type": "TEXT",
    "name": "referrer",
    "displayName": "Page Referrer"
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
// ET - TikTok Events API (Manual HTTP) — sGTM Sandboxed JS
// EasyTrac v3 | No official template | sendHttpRequest + sha256Sync
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
  logToConsole('ET:TikTok:', msg, obj ? JSON.stringify(obj) : '');
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

// ── Utils ──────────────────────────────────────────────────────────────────
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

// ── Build user object ──────────────────────────────────────────────────────
var user = clean({
  email:        defined(data.userEmail)   ? hash(data.userEmail)      : undefined,
  phone_number: defined(data.userPhone)   ? hashPhone(data.userPhone)  : undefined,
  external_id:  defined(data.externalId)  ? hash(data.externalId)      : undefined,
  ttclid:       defined(data.ttclid)      ? data.ttclid               : undefined,
  ttp:          defined(data.ttp)         ? data.ttp                  : undefined,
  ip:           defined(data.ipAddress)   ? data.ipAddress            : undefined,
  user_agent:   defined(data.userAgent)   ? data.userAgent            : undefined,
});

// ── Build contents ─────────────────────────────────────────────────────────
var contentIds = toArray(data.contentIds);
var contents;
if (contentIds) {
  contents = [];
  for (var ci = 0; ci < contentIds.length; ci++) {
    contents.push(clean({
      content_id:   contentIds[ci],
      content_name: defined(data.contentName) ? data.contentName : undefined,
      content_type: 'product',
      quantity:     defined(data.quantity) ? makeNumber(data.quantity) : 1,
      price:        defined(data.value)    ? makeNumber(data.value)    : undefined,
    }));
  }
}

// ── Build properties ───────────────────────────────────────────────────────
var properties = clean({
  value:        defined(data.value)    ? makeNumber(data.value)    : undefined,
  currency:     defined(data.currency) ? data.currency             : undefined,
  order_id:     defined(data.orderId)  ? data.orderId             : undefined,
  contents:     contents               ? contents                 : undefined,
  search_string:undefined,
});

// ── Build page ─────────────────────────────────────────────────────────────
var page = clean({
  url:      defined(data.pageUrl)   ? data.pageUrl  : undefined,
  referrer: defined(data.referrer)  ? data.referrer : undefined,
});

// ── Event time ─────────────────────────────────────────────────────────────
var eventTime = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);

// ── Assemble body ──────────────────────────────────────────────────────────
var body = clean({
  pixel_code:  data.pixelCode,
  event:       data.eventName || 'Pageview',
  event_time:  eventTime,
  event_id:    defined(data.eventId) ? makeString(data.eventId) : undefined,
  user:        Object.keys(user).length       > 0 ? user       : undefined,
  properties:  Object.keys(properties).length > 0 ? properties : undefined,
  page:        Object.keys(page).length       > 0 ? page       : undefined,
});

var url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

dbg('Sending payload', body);

// ── Send HTTP request ──────────────────────────────────────────────────────
sendHttpRequest(url, {
  method: 'POST',
  headers: {
    'Access-Token': data.accessToken,
    'Content-Type': 'application/json',
  },
  timeout: 8000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response status', res.statusCode);
  dbg('Response body',   res.body);

  var parsed;
  try { parsed = JSON.parse(res.body); } catch(e) { parsed = {}; }

  // TikTok returns code:0 for success
  if (res.statusCode >= 200 && res.statusCode < 300 && parsed.code === 0) {
    logToConsole('ET:TikTok: ✅ success', res.statusCode, data.eventName, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:TikTok: ❌ error', res.statusCode, parsed.code, parsed.message, res.body);
    data.gtmOnFailure();
  }
}).catch(function(err) {
  logToConsole('ET:TikTok: ❌ network error', err);
  data.gtmOnFailure();
});

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      