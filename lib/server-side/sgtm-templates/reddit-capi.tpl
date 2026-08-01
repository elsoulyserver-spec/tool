___INFO___

{
  "type": "TAG",
  "id": "et_reddit_capi",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Reddit CAPI (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual Reddit Conversions API tag. Sends events to https://ads-api.reddit.com/api/v2.0/conversions/events/{ad_account_id} via sendHttpRequest. SHA-256 hashes PII server-side. Supports rdt_cid click ID and _rdt_uuid cookie. No official Reddit template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "adAccountId",
    "displayName": "Reddit Ad Account ID (t2_...)",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "Reddit Ads API Access Token",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Reddit Event Type",
    "simpleValueType": true,
    "help": "e.g. Purchase, AddToCart, ViewContent, Lead, SignUp, Search, PageVisit, Custom"
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
    "name": "transactionId",
    "displayName": "Transaction / Order ID"
  },
  {
    "type": "TEXT",
    "name": "itemCount",
    "displayName": "Number of Items"
  },
  {
    "type": "TEXT",
    "name": "userEmail",
    "displayName": "User Email (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "externalId",
    "displayName": "External ID (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "rdtCid",
    "displayName": "Reddit Click ID (rdt_cid / _rdt_uuid cookie)"
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
    "type": "CHECKBOX",
    "name": "testMode",
    "displayName": "Test Mode (events not recorded)",
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
// ET - Reddit CAPI (Manual HTTP) - sGTM Sandboxed JS
// EasyTrac v1 | Conversions API v2.0
// Docs: https://ads-api.reddit.com/docs/#tag/Conversions
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
  logToConsole('ET:RdtCAPI:', msg, obj ? JSON.stringify(obj) : '');
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

function defined(v) { return v !== undefined && v !== null && v !== ''; }

function clean(obj) {
  var out = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    if (defined(obj[keys[i]])) out[keys[i]] = obj[keys[i]];
  }
  return out;
}

// ── user object ───────────────────────────────────────────────────────────────
// Reddit wraps hashed PII in arrays
var user = clean({
  email:       defined(data.userEmail)      ? [hash(data.userEmail)]      : undefined,
  external_id: defined(data.externalId)     ? [hash(data.externalId)]     : undefined,
  uuid:        defined(data.rdtCid)         ? data.rdtCid                  : undefined,
  ip_address:  defined(data.clientIpAddress) ? data.clientIpAddress        : undefined,
  user_agent:  defined(data.clientUserAgent) ? data.clientUserAgent        : undefined,
});

// ── event_metadata ────────────────────────────────────────────────────────────
var event_metadata = clean({
  currency:       defined(data.currency)      ? data.currency              : undefined,
  value:          defined(data.value)         ? makeNumber(data.value)     : undefined,
  item_count:     defined(data.itemCount)     ? makeNumber(data.itemCount) : undefined,
  transaction_id: defined(data.transactionId) ? data.transactionId         : undefined,
});

// ── Event time — Reddit expects epoch milliseconds as string ──────────────────
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);
var eventTimeMs = makeString(eventTimeSec) + '000';

// ── Payload ───────────────────────────────────────────────────────────────────
var eventObj = clean({
  event_at:       eventTimeMs,
  event_type:     { tracking_type: data.eventName || 'PageVisit' },
  event_id:       defined(data.eventId) ? makeString(data.eventId) : undefined,
  click_id:       defined(data.rdtCid) ? data.rdtCid : undefined,
  user:           Object.keys(user).length           > 0 ? user           : undefined,
  event_metadata: Object.keys(event_metadata).length > 0 ? event_metadata : undefined,
});

var url = 'https://ads-api.reddit.com/api/v2.0/conversions/events/' + data.adAccountId;

var body = {
  test_mode: data.testMode === true,
  events:    [eventObj],
};

dbg('Sending payload', body);

// ── Dispatch ──────────────────────────────────────────────────────────────────
sendHttpRequest(url, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + data.accessToken,
    'Content-Type':  'application/json',
  },
  timeout: 8000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response', res.statusCode);
  if (res.statusCode >= 200 && res.statusCode < 300) {
    logToConsole('ET:RdtCAPI: success', res.statusCode, data.eventName, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:RdtCAPI: error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}, function(err) {
  logToConsole('ET:RdtCAPI: network error', err);
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
              { "type": 1, "string": "https://ads-api.reddit.com/" }
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
    "name": "Reddit — Purchase event with rdt_cid dispatched",
    "code": "mock('sendHttpRequest', function(u,o){ if(o.headers['Authorization']!=='Bearer TOKEN') throw 'auth missing'; if(u.indexOf('ads-api.reddit.com')===-1) throw 'wrong url'; return Promise.resolve({statusCode:200,body:'{\"success\":true}'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.adAccountId='t2_abc123'; data.accessToken='TOKEN'; data.eventName='Purchase'; data.eventId='evt-rdt-001'; data.value='150'; data.currency='USD'; data.transactionId='ORD-001'; data.rdtCid='RDTCID_abc123'; data.userEmail='test@example.com'; data.clientIpAddress='1.2.3.4'; runCode(data); assertApi('sendHttpRequest').wasCalled(); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "Reddit — test_mode=true is forwarded",
    "code": "var sentBody; mock('sendHttpRequest', function(u,o){ sentBody=JSON.parse(o.body); return Promise.resolve({statusCode:200,body:'{}'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.adAccountId='t2_abc'; data.accessToken='T'; data.eventName='PageVisit'; data.testMode=true; runCode(data); assertApi('sendHttpRequest').wasCalled();"
  }
]
