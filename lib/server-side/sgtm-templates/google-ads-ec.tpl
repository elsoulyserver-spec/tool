___INFO___

{
  "type": "TAG",
  "id": "et_gads_ec_manual",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Google Ads Enhanced Conversions (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual Google Ads Enhanced Conversions tag. Sends click conversion uploads to the Google Ads API via sendHttpRequest. SHA-256 hashes user PII. Requires gclid/wbraid/gbraid from ep.*. No official template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "conversionActionId",
    "displayName": "Conversion Action (AW-XXXXX/label or full resource name)",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "customerId",
    "displayName": "Google Ads Customer ID (digits only, no dashes)",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "developerToken",
    "displayName": "Developer Token",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "OAuth2 Access Token",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "Event ID"
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp)"
  },
  {
    "type": "TEXT",
    "name": "value",
    "displayName": "Conversion Value"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency Code"
  },
  {
    "type": "TEXT",
    "name": "orderId",
    "displayName": "Order ID"
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
    "displayName": "City"
  },
  {
    "type": "TEXT",
    "name": "userState",
    "displayName": "State (ISO abbreviation)"
  },
  {
    "type": "TEXT",
    "name": "userZip",
    "displayName": "Postal Code"
  },
  {
    "type": "TEXT",
    "name": "userCountry",
    "displayName": "Country (ISO 3166-1 alpha-2)"
  },
  {
    "type": "TEXT",
    "name": "gclid",
    "displayName": "gclid (Google click ID)"
  },
  {
    "type": "TEXT",
    "name": "wbraid",
    "displayName": "wbraid (iOS App campaign)"
  },
  {
    "type": "TEXT",
    "name": "gbraid",
    "displayName": "gbraid (Cross-channel)"
  },
  {
    "type": "CHECKBOX",
    "name": "validateOnly",
    "displayName": "Validate Only (dry run)",
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

// ─────────────────────────────────────────────────────────────────────────────
// ET - Google Ads Enhanced Conversions (Manual HTTP) — sGTM Sandboxed JS
// EasyTrac v3 | No official template | sendHttpRequest + sha256Sync
// API: https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
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
  logToConsole('ET:GAdsEC:', msg, obj ? JSON.stringify(obj) : '');
}

// ── Must have at least one click ID ──────────────────────────────────────
if (!data.gclid && !data.wbraid && !data.gbraid) {
  logToConsole('ET:GAdsEC: ⚠️ no click ID (gclid/wbraid/gbraid) — skipping');
  data.gtmOnSuccess(); // not a failure — just no click to attribute
  return;
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

// ── Convert Unix seconds to Google Ads timestamp format ────────────────────
// Required: "yyyy-MM-dd HH:mm:ss+00:00"
function toGadsTs(unixSec) {
  var d = new Date(makeNumber(unixSec) * 1000);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
         ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) +
         '+00:00';
}

// ── Build user_identifiers (Enhanced Conversions) ──────────────────────────
var user_identifiers = [];

if (defined(data.userEmail)) {
  user_identifiers.push({ hashedEmail: hash(data.userEmail) });
}
if (defined(data.userPhone)) {
  user_identifiers.push({ hashedPhoneNumber: hashPhone(data.userPhone) });
}

var addressInfo = clean({
  hashedFirstName: defined(data.userFirstName) ? hash(data.userFirstName) : undefined,
  hashedLastName:  defined(data.userLastName)  ? hash(data.userLastName)  : undefined,
  hashedCity:      defined(data.userCity)      ? hash(data.userCity)      : undefined,
  hashedState:     defined(data.userState)     ? hash(data.userState)     : undefined,
  postalCode:      defined(data.userZip)       ? data.userZip             : undefined,
  countryCode:     defined(data.userCountry)   ? data.userCountry         : undefined,
});
if (Object.keys(addressInfo).length > 0) {
  user_identifiers.push({ addressInfo: addressInfo });
}

// ── Event time ─────────────────────────────────────────────────────────────
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);

// ── Build ClickConversion ──────────────────────────────────────────────────
var clickConversion = clean({
  gclid:                 defined(data.gclid)    ? data.gclid    : undefined,
  wbraid:                defined(data.wbraid)   ? data.wbraid   : undefined,
  gbraid:                defined(data.gbraid)   ? data.gbraid   : undefined,
  conversion_action:     data.conversionActionId ? data.conversionActionId : undefined,
  conversion_date_time:  toGadsTs(eventTimeSec),
  conversion_value:      defined(data.value) && makeNumber(data.value) > 0
                           ? makeNumber(data.value) : undefined,
  currency_code:         defined(data.currency)  ? data.currency : undefined,
  order_id:              defined(data.orderId)   ? data.orderId  : undefined,
  user_identifiers:      user_identifiers.length > 0 ? user_identifiers : undefined,
});

var cid = makeString(data.customerId).split('-').join('');
var url = 'https://googleads.googleapis.com/v17/customers/' + cid + ':uploadClickConversions';

var body = {
  conversions: [clickConversion],
  partial_failure: true,
  validate_only: data.validateOnly === true,
};

dbg('Sending payload', body);

// ── Send HTTP request ──────────────────────────────────────────────────────
var headers = clean({
  Authorization:    'Bearer ' + data.accessToken,
  'developer-token': defined(data.developerToken) ? data.developerToken : undefined,
  'Content-Type':   'application/json',
});

sendHttpRequest(url, {
  method: 'POST',
  headers: headers,
  timeout: 10000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response status', res.statusCode);
  dbg('Response body',   res.body);

  var parsed;
  try { parsed = JSON.parse(res.body); } catch(e) { parsed = {}; }

  if (res.statusCode >= 200 && res.statusCode < 300 && !parsed.partialFailureError) {
    logToConsole('ET:GAdsEC: ✅ success', res.statusCode, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:GAdsEC: ❌ error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}).catch(function(err) {
  logToConsole('ET:GAdsEC: ❌ network error', err);
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
                  {"type": 1, "string": "https://googleads.googleapis.com/"},
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
                                                                                                                                                                                                                                                                                                                                                                                                     