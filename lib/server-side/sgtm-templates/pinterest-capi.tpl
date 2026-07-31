___INFO___

{
  "type": "TAG",
  "id": "et_pinterest_capi",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Pinterest CAPI (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual Pinterest Conversions API tag. Sends events to https://api.pinterest.com/v5/ad_accounts/{ad_account_id}/events via sendHttpRequest. SHA-256 hashes PII server-side. Supports epik click ID and _epik cookie. No official Pinterest template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "adAccountId",
    "displayName": "Pinterest Ad Account ID",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "Pinterest Access Token",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Pinterest Event Name",
    "simpleValueType": true,
    "help": "e.g. checkout, add_to_cart, page_visit, view_category, search, lead, signup, watch_video, custom"
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "Event ID (deduplication)"
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp seconds)"
  },
  {
    "type": "TEXT",
    "name": "value",
    "displayName": "Order Value"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency (ISO 4217)"
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
    "name": "contentCategory",
    "displayName": "Content Category"
  },
  {
    "type": "TEXT",
    "name": "numItems",
    "displayName": "Number of Items"
  },
  {
    "type": "TEXT",
    "name": "searchString",
    "displayName": "Search Query"
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
    "name": "epik",
    "displayName": "_epik click ID / cookie value"
  },
  {
    "type": "TEXT",
    "name": "fpid",
    "displayName": "First-Party ID (FPID / partner_id)"
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
    "name": "pageUrl",
    "displayName": "Page URL (event_source_url)"
  },
  {
    "type": "TEXT",
    "name": "language",
    "displayName": "Browser Language (e.g. en-US)"
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
// ET - Pinterest CAPI (Manual HTTP) - sGTM Sandboxed JS
// EasyTrac v1 | Conversions API v5
// Docs: https://developers.pinterest.com/docs/api/v5/#tag/conversion_events
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
  logToConsole('ET:PinCAPI:', msg, obj ? JSON.stringify(obj) : '');
}

// ── SHA-256 helpers (sandbox-safe: no regex) ─────────────────────────────────
function isHex64(s) {
  if (!s || s.length !== 64) return false;
  var hex = '0123456789abcdef';
  for (var i = 0; i < 64; i++) {
    if (hex.indexOf(s.charAt(i)) === -1) return false;
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
  var s = makeString(raw).trim()
    .split(' ').join('').split('-').join('')
    .split('(').join('').split(')').join('').split('.').join('');
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

// ── user_data ────────────────────────────────────────────────────────────────
// Pinterest wraps hashed fields in arrays
var user_data = clean({
  em:               defined(data.userEmail)      ? [hash(data.userEmail)]        : undefined,
  ph:               defined(data.userPhone)      ? [hashPhone(data.userPhone)]   : undefined,
  external_id:      defined(data.externalId)     ? [hash(data.externalId)]       : undefined,
  click_id:         defined(data.epik)           ? data.epik                     : undefined,
  partner_id:       defined(data.fpid)           ? data.fpid                     : undefined,
  client_ip_address: defined(data.clientIpAddress) ? data.clientIpAddress        : undefined,
  client_user_agent: defined(data.clientUserAgent)  ? data.clientUserAgent       : undefined,
});

// ── custom_data ───────────────────────────────────────────────────────────────
var contentIds = toArray(data.contentIds);

var contents;
if (contentIds) {
  contents = [];
  for (var ci = 0; ci < contentIds.length; ci++) {
    contents.push(clean({
      item_id:   contentIds[ci],
      item_name: defined(data.contentName) ? data.contentName : undefined,
      quantity:  defined(data.numItems)    ? makeNumber(data.numItems) : 1,
      price:     defined(data.value)       ? makeNumber(data.value)    : undefined,
    }));
  }
}

var custom_data = clean({
  currency:        defined(data.currency)    ? data.currency            : undefined,
  value:           defined(data.value)       ? makeNumber(data.value)   : undefined,
  order_id:        defined(data.orderId)     ? data.orderId             : undefined,
  content_ids:     contentIds,
  contents:        contents,
  content_name:    defined(data.contentName)    ? data.contentName     : undefined,
  content_category: defined(data.contentCategory) ? data.contentCategory : undefined,
  num_items:       defined(data.numItems)    ? makeNumber(data.numItems) : undefined,
  search_string:   defined(data.searchString) ? data.searchString       : undefined,
});

// ── Event time ───────────────────────────────────────────────────────────────
var eventTime = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);

// ── Payload ───────────────────────────────────────────────────────────────────
var eventObj = clean({
  event_name:       data.eventName || 'page_visit',
  action_source:    'web',
  event_time:       eventTime,
  event_id:         defined(data.eventId) ? makeString(data.eventId) : undefined,
  event_source_url: defined(data.pageUrl) ? data.pageUrl : undefined,
  partner_name:     'easytrac',
  language:         defined(data.language) ? data.language : undefined,
  user_data:        Object.keys(user_data).length  > 0 ? user_data  : undefined,
  custom_data:      Object.keys(custom_data).length > 0 ? custom_data : undefined,
  app_id:           data.adAccountId || undefined,
});

var url = 'https://api.pinterest.com/v5/ad_accounts/' + data.adAccountId + '/events';

dbg('Sending payload', { data: [eventObj] });

// ── Dispatch ──────────────────────────────────────────────────────────────────
sendHttpRequest(url, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + data.accessToken,
    'Content-Type': 'application/json',
  },
  timeout: 8000,
}, JSON.stringify({ data: [eventObj] })).then(function(res) {
  dbg('Response', res.statusCode);
  if (res.statusCode >= 200 && res.statusCode < 300) {
    logToConsole('ET:PinCAPI: success', res.statusCode, data.eventName, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:PinCAPI: error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}, function(err) {
  logToConsole('ET:PinCAPI: network error', err);
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
              { "type": 1, "string": "https://api.pinterest.com/" }
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
    "name": "Pinterest — checkout event with epik dispatched",
    "code": "mock('sendHttpRequest', function(u,o){ if(o.headers['Authorization']!=='Bearer TOKEN') throw 'auth missing'; if(u.indexOf('api.pinterest.com')===-1) throw 'wrong url'; return Promise.resolve({statusCode:200,body:'{\"num_events_received\":1}'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.adAccountId='123456'; data.accessToken='TOKEN'; data.eventName='checkout'; data.eventId='evt-pin-001'; data.value='199'; data.currency='USD'; data.orderId='ORD-001'; data.contentIds='SKU1,SKU2'; data.userEmail='test@example.com'; data.epik='EPIK_abc123'; data.clientIpAddress='1.2.3.4'; runCode(data); assertApi('sendHttpRequest').wasCalled(); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Pinterest — HTTP error calls gtmOnFailure",
    "code": "mock('sendHttpRequest', function(u,o){ return Promise.resolve({statusCode:401,body:'Unauthorized'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.adAccountId='123456'; data.accessToken='BADTOKEN'; data.eventName='page_visit'; data.eventId='evt-pin-002'; runCode(data); assertApi('gtmOnFailure').wasCalled();"
  }
]
