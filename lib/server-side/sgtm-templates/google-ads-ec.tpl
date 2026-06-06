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

// -----------------------------------------------------------------------------
// ET - Google Ads Enhanced Conversions (Manual HTTP) - sGTM Sandboxed JS
// EasyTrac v3 | No official template | sendHttpRequest + sha256Sync
// API: https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
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
  logToConsole('ET:GAdsEC:', msg, obj ? JSON.stringify(obj) : '');
}

// -- Must have at least one click ID --------------------------------------
if (!data.gclid && !data.wbraid && !data.gbraid) {
  logToConsole('ET:GAdsEC: no click ID (gclid/wbraid/gbraid) - skipping');
  data.gtmOnSuccess(); // not a failure - just no click to attribute
  return;
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

// -- Convert Unix seconds to Google Ads timestamp format --------------------
// Required: "yyyy-MM-dd HH:mm:ss+00:00"
// Pure math - no Date object (unavailable in sGTM sandboxed JS)
function toGadsTs(unixSec) {
  var ts = makeNumber(unixSec);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };

  var rem = ts % 86400;
  if (rem < 0) rem = rem + 86400;
  var hh = Math.floor(rem / 3600);
  rem = rem % 3600;
  var mm = Math.floor(rem / 60);
  var ss = rem % 60;

  var totalDays = Math.floor(ts / 86400);
  var y = 1970;
  while (true) {
    var diy = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365;
    if (totalDays < diy) break;
    totalDays = totalDays - diy;
    y = y + 1;
  }
  var leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
  var mDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var mo = 0;
  while (totalDays >= mDays[mo]) {
    totalDays = totalDays - mDays[mo];
    mo = mo + 1;
  }
  var dd = totalDays + 1;
  mo = mo + 1;

  return y + '-' + pad(mo) + '-' + pad(dd) + ' ' + pad(hh) + ':' + pad(mm) + ':' + pad(ss) + '+00:00';
}

// -- Build user_identifiers (Enhanced Conversions) --------------------------
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

// -- Event time -------------------------------------------------------------
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);

// -- Build ClickConversion --------------------------------------------------
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

// -- Send HTTP request ------------------------------------------------------
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

  var parsed = JSON.parse(res.body) || {};

  if (res.statusCode >= 200 && res.statusCode < 300 && !parsed.partialFailureError) {
    logToConsole('ET:GAdsEC: success', res.statusCode, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:GAdsEC: error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}, function(err) {
  logToConsole('ET:GAdsEC: network error', err);
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

