___INFO___

{
  "type": "TAG",
  "id": "et_linkedin_capi",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - LinkedIn CAPI (Manual HTTP)",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Manual LinkedIn Conversions API tag. Sends conversion events to https://api.linkedin.com/rest/conversionEvents via sendHttpRequest. SHA-256 hashes email. Supports li_fat_id click ID. Requires LinkedIn API version 202405. No official LinkedIn template used.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "conversionId",
    "displayName": "LinkedIn Conversion ID (urn:lla:llaPartnerConversion:...)",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}],
    "help": "Full URN: urn:lla:llaPartnerConversion:12345678"
  },
  {
    "type": "TEXT",
    "name": "accessToken",
    "displayName": "OAuth 2.0 Access Token",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "eventId",
    "displayName": "Event ID (idempotency key)"
  },
  {
    "type": "TEXT",
    "name": "eventTime",
    "displayName": "Event Time (Unix timestamp seconds)"
  },
  {
    "type": "TEXT",
    "name": "value",
    "displayName": "Conversion Value"
  },
  {
    "type": "TEXT",
    "name": "currency",
    "displayName": "Currency (ISO 4217)"
  },
  {
    "type": "TEXT",
    "name": "userEmail",
    "displayName": "User Email (SHA-256 hashed — SHA256_EMAIL type)"
  },
  {
    "type": "TEXT",
    "name": "userFirstName",
    "displayName": "First Name (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "userLastName",
    "displayName": "Last Name (SHA-256 hashed)"
  },
  {
    "type": "TEXT",
    "name": "liClickId",
    "displayName": "LinkedIn Click ID (li_fat_id)"
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
// ET - LinkedIn CAPI (Manual HTTP) - sGTM Sandboxed JS
// EasyTrac v1 | LinkedIn Conversions API v202405
// Docs: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api
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
  logToConsole('ET:LiCAPI:', msg, obj ? JSON.stringify(obj) : '');
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

// ── User identifiers ──────────────────────────────────────────────────────────
// LinkedIn userIds: array of { idType, idValue } objects
var userIds = [];
if (defined(data.userEmail)) {
  userIds.push({ idType: 'SHA256_EMAIL', idValue: hash(data.userEmail) });
}
if (defined(data.liClickId)) {
  userIds.push({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: data.liClickId });
}

var userInfo = clean({
  firstName: defined(data.userFirstName) ? hash(data.userFirstName) : undefined,
  lastName:  defined(data.userLastName)  ? hash(data.userLastName)  : undefined,
});

// ── Event time — LinkedIn requires milliseconds ───────────────────────────────
var eventTimeSec = defined(data.eventTime)
  ? makeNumber(data.eventTime)
  : Math.floor(getTimestampMillis() / 1000);
var eventTimeMs = eventTimeSec * 1000;

// ── conversionValue ───────────────────────────────────────────────────────────
var conversionValue = (defined(data.value) && defined(data.currency))
  ? { currencyCode: data.currency, amount: makeString(makeNumber(data.value)) }
  : undefined;

// ── Payload ───────────────────────────────────────────────────────────────────
// LinkedIn CAPI v202405 format
var body = clean({
  conversion:           data.conversionId || '',
  conversionHappenedAt: eventTimeMs,
  conversionValue:      conversionValue,
  eventId:              defined(data.eventId) ? makeString(data.eventId) : undefined,
  user: _buildUser(userIds, userInfo),
});

function _buildUser(ids, info) {
  var u = {};
  if (ids.length > 0) { u.userIds = ids; }
  if (Object.keys(info).length > 0) { u.userInfo = info; }
  return Object.keys(u).length > 0 ? u : undefined;
}

var url = 'https://api.linkedin.com/rest/conversionEvents';

dbg('Sending payload', body);

// ── Dispatch ──────────────────────────────────────────────────────────────────
sendHttpRequest(url, {
  method: 'POST',
  headers: {
    'Authorization':              'Bearer ' + data.accessToken,
    'Content-Type':               'application/json',
    'LinkedIn-Version':           '202405',
    'X-Restli-Protocol-Version':  '2.0.0',
  },
  timeout: 8000,
}, JSON.stringify(body)).then(function(res) {
  dbg('Response', res.statusCode);
  // LinkedIn returns 201 Created on success
  if (res.statusCode >= 200 && res.statusCode < 300) {
    logToConsole('ET:LiCAPI: success', res.statusCode, data.conversionId, data.eventId);
    data.gtmOnSuccess();
  } else {
    logToConsole('ET:LiCAPI: error', res.statusCode, res.body);
    data.gtmOnFailure();
  }
}, function(err) {
  logToConsole('ET:LiCAPI: network error', err);
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
              { "type": 1, "string": "https://api.linkedin.com/" }
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
    "name": "LinkedIn — conversion dispatched with SHA256_EMAIL and li_fat_id",
    "code": "mock('sendHttpRequest', function(u,o){ if(o.headers['Authorization']!=='Bearer TOKEN') throw 'auth missing'; if(o.headers['LinkedIn-Version']!=='202405') throw 'version missing'; if(u.indexOf('api.linkedin.com')===-1) throw 'wrong url'; return Promise.resolve({statusCode:201,body:''}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.conversionId='urn:lla:llaPartnerConversion:12345'; data.accessToken='TOKEN'; data.eventId='evt-li-001'; data.value='299'; data.currency='USD'; data.userEmail='test@example.com'; data.liClickId='AQHaBcDeFg'; runCode(data); assertApi('sendHttpRequest').wasCalled(); assertApi('gtmOnSuccess').wasCalled();"
  },
  {
    "name": "LinkedIn — HTTP 401 calls gtmOnFailure",
    "code": "mock('sendHttpRequest', function(u,o){ return Promise.resolve({statusCode:401,body:'Unauthorized'}); }); mock('sha256Sync', function(s,o){ return 'a'.repeat(64); }); mock('logToConsole', function(){}); mock('getTimestampMillis', function(){ return 1700000000000; }); data.conversionId='urn:lla:llaPartnerConversion:99999'; data.accessToken='BAD'; runCode(data); assertApi('gtmOnFailure').wasCalled();"
  }
]
