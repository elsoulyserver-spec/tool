___INFO___

{
  "type": "MACRO",
  "id": "et_server_sanitizer",
  "version": 1,
  "securityGroups": [],
  "displayName": "ET - Server Sanitizer",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Sandboxed-JS translation of lib/server-sanitizer.js (commit de52af8). Parses and whitelists items_json, normalizes and SHA-256-hashes PII fields, and fails closed on malformed input. Performs NO network calls, NO HTTP forwarding, NO cookie access, and NO route/provisioning logic — read-only computation only. Not yet integrated into any generated container; see docs/... design notes.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "itemsJsonRaw",
    "displayName": "Raw items_json",
    "simpleValueType": true,
    "help": "Wire to the existing raw source, e.g. {{ET - ep items_json}}. Left empty is a valid, legitimately-empty cart."
  },
  {
    "type": "TEXT",
    "name": "emRaw",
    "displayName": "Raw email",
    "simpleValueType": true,
    "help": "Wire to {{ET - up em}} or equivalent. Plaintext, an already-hashed 64-hex digest, or empty are all accepted."
  },
  {
    "type": "TEXT",
    "name": "phRaw",
    "displayName": "Raw phone",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "fnRaw",
    "displayName": "Raw first name",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "lnRaw",
    "displayName": "Raw last name",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "ctRaw",
    "displayName": "Raw city",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "stRaw",
    "displayName": "Raw state",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "zpRaw",
    "displayName": "Raw zip",
    "simpleValueType": true
  },
  {
    "type": "TEXT",
    "name": "countryRaw",
    "displayName": "Raw country",
    "simpleValueType": true
  }
]

___SANDBOXED_JS_FOR_SERVER___

// -----------------------------------------------------------------------------
// ET - Server Sanitizer - sGTM Sandboxed JS (Variable template)
// EasyTrac Blocker A "Option C" - Step 2 sandboxed translation
//
// Reference implementation and behavioral source of truth:
//   lib/server-sanitizer.js @ commit de52af8
//   tests/server-sanitizer.test.js (56 tests)
//
// SCOPE (deliberately narrow - do not extend without updating both this file
// and the reference implementation together):
//   - parse and whitelist items_json
//   - normalize + SHA-256-hash PII fields
//   - fail closed on malformed items_json (forwardable:false, both
//     sanitizedItemsJson and pii are null - never a plausible-looking
//     empty-cart substitute)
// This template performs NO network calls, NO HTTP forwarding, NO cookie
// access, and NO logging of any kind (raw or hashed) - see the Security
// review in the accompanying Step 2 deliverable for why logging was omitted
// entirely rather than restricted to a "safe summary" as the Node reference
// module optionally supports via safeLogSummary().
//
// UNVERIFIED AGAINST A LIVE SANDBOX (flagged, not guessed past):
//   - isArrayLike(): no confirmed Array.isArray equivalent exists in any
//     template already audited in this codebase (see docs/GTM_SANDBOX_FIX_REPORT.md,
//     which never needed to check "is this an array" in any of the 4 templates
//     it validated). The implementation below is logically sound (real arrays
//     do not list "length" among Object.keys() output; a spoofed
//     length-carrying plain object would) but has not been run against a
//     real or emulated sGTM sandbox.
//   - isFiniteNum(): avoids Number.isFinite and the bare Infinity identifier,
//     neither of which appears in any audited template in this codebase,
//     using only the self-equality NaN check and the n+1===n IEEE-754
//     infinity check instead. Logically sound, not sandbox-verified.
//   - .slice() on strings: used for MAX_STRING_LEN truncation. The sandbox
//     compatibility audit in this codebase explicitly confirmed .trim/.charAt/
//     .indexOf/.split/.toLowerCase, but never exercised .slice or .pop.
//     Standard ES5 methods, expected to work, not independently confirmed.
// -----------------------------------------------------------------------------

var JSON       = require('JSON');
var sha256Sync = require('sha256Sync');
var makeString = require('makeString');
var makeNumber = require('makeNumber');
var Object     = require('Object');

var MAX_ITEMS = 100;
var MAX_STRING_LEN = 500;
var MAX_QUANTITY = 100000;
var MAX_PRICE = 10000000;
var MAX_OUTPUT_BYTES = 32768;

var ALLOWED_ITEM_KEYS = ['id', 'name', 'price', 'quantity', 'brand', 'category', 'variant'];

// -- Sandbox-safe hex check ---------------------------------------------------
// No regex literal (unsupported in the sandbox). Verbatim reuse of the
// pattern already proven working in this codebase's audited templates
// (meta-capi.tpl / tiktok-events.tpl / snapchat-capi.tpl / google-ads-ec.tpl).
// Expects an already-lowercased input.
function isHex64Lower(s) {
  if (!s || s.length !== 64) return false;
  var hexChars = '0123456789abcdef';
  var i;
  for (i = 0; i < 64; i++) {
    if (hexChars.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}

// -- Sandbox-safe digit-only filter ------------------------------------------
// No regex literal. Character-by-character allowlist filter.
function digitsOnly(s) {
  var out = '';
  var digits = '0123456789';
  var i;
  for (i = 0; i < s.length; i++) {
    if (digits.indexOf(s.charAt(i)) !== -1) out += s.charAt(i);
  }
  return out;
}

// -- Sandbox-safe finiteness check -------------------------------------------
// See the UNVERIFIED note above: avoids Number.isFinite and the Infinity
// identifier, neither confirmed available.
function isFiniteNum(n) {
  if (n !== n) return false;      // only NaN fails self-equality
  if (n + 1 === n) return false;  // true only for +Infinity/-Infinity in IEEE-754
  return true;
}

// -- Sandbox-safe "is this an array" check -----------------------------------
// See the UNVERIFIED note above.
function isArrayLike(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.length !== 'number') return false;
  var keys = Object.keys(v);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (keys[i] === 'length') return false;
  }
  return true;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !isArrayLike(v);
}

function boundStr(v) {
  var s = makeString(v);
  return s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) : s;
}

// quantity: NaN/Infinity/non-numeric/non-positive -> default (1). Absurdly
// large values are clamped, not rejected.
function normalizeQuantity(v) {
  var n = makeNumber(v);
  if (!isFiniteNum(n) || n < 1) return 1;
  return n < MAX_QUANTITY ? n : MAX_QUANTITY;
}

// price: NaN/Infinity/non-numeric -> default (0). Negative allowed
// (refunds/discounts) but magnitude-bounded either direction.
function normalizePrice(v) {
  var n = makeNumber(v);
  if (!isFiniteNum(n)) return 0;
  if (n < 0) return n > (0 - MAX_PRICE) ? n : (0 - MAX_PRICE);
  return n < MAX_PRICE ? n : MAX_PRICE;
}

// -- items[] ------------------------------------------------------------------
//
// Fail-closed contract, identical to lib/server-sanitizer.js:
//   - absent input                -> forwardableItems:true,  sanitizedItemsJson:'[]'
//   - unparseable / non-array     -> forwardableItems:false, sanitizedItemsJson:null, errorCode set
//   - individual bad entries      -> dropped individually, forwardableItems stays true
//
// JSON.parse in this sandbox returns undefined on malformed input rather
// than throwing (confirmed: docs/GTM_SANDBOX_FIX_REPORT.md; already relied
// on elsewhere in this codebase's audited templates as
// `var parsed = JSON.parse(res.body) || {};`). Since valid JSON has no way
// to represent the value `undefined`, JSON.parse(...) === undefined is an
// unambiguous "parse failed" signal here - never a false positive against a
// legitimately-parsed value.
function sanitizeItemsJson(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { forwardableItems: true, sanitizedItemsJson: '[]', itemCount: 0, droppedEntries: 0, errorCode: null };
  }

  var parsed = JSON.parse(makeString(raw));
  if (parsed === undefined) {
    return { forwardableItems: false, sanitizedItemsJson: null, itemCount: 0, droppedEntries: 0, errorCode: 'ITEMS_INVALID_JSON' };
  }
  if (!isArrayLike(parsed)) {
    return { forwardableItems: false, sanitizedItemsJson: null, itemCount: 0, droppedEntries: 0, errorCode: 'ITEMS_NOT_ARRAY' };
  }

  var out = [];
  var droppedEntries = 0;
  var i, j, key, val, item, clean, ownKeys;

  for (i = 0; i < parsed.length; i++) {
    if (out.length >= MAX_ITEMS) {
      droppedEntries = droppedEntries + (parsed.length - i);
      break;
    }
    item = parsed[i];
    if (!isPlainObject(item)) { droppedEntries = droppedEntries + 1; continue; }

    ownKeys = Object.keys(item);
    clean = {};
    for (j = 0; j < ALLOWED_ITEM_KEYS.length; j++) {
      key = ALLOWED_ITEM_KEYS[j];
      if (ownKeys.indexOf(key) === -1) continue;   // own-properties only
      val = item[key];
      if (val === undefined || val === null) continue;
      if (key === 'quantity') {
        clean.quantity = normalizeQuantity(val);
      } else if (key === 'price') {
        clean.price = normalizePrice(val);
      } else {
        if (typeof val === 'object') continue;      // nested object/array in a scalar slot -> drop this key only
        clean[key] = boundStr(val);
      }
    }
    out.push(clean);
  }

  // Aggregate output-size ceiling - drop trailing items until it fits.
  var serialized = JSON.stringify(out);
  while (serialized.length > MAX_OUTPUT_BYTES && out.length > 0) {
    out.pop();
    droppedEntries = droppedEntries + 1;
    serialized = JSON.stringify(out);
  }

  return { forwardableItems: true, sanitizedItemsJson: serialized, itemCount: out.length, droppedEntries: droppedEntries, errorCode: null };
}

// -- PII ----------------------------------------------------------------------

function normalizeEmail(s)   { return s.trim().toLowerCase(); }
function normalizePhoneStr(s){ return digitsOnly(s); }
function normalizeGeneric(s) { return s.trim().toLowerCase(); }

function sanitizePiiField(field, raw) {
  if (raw === null || raw === undefined) return { value: '', dropped: false };
  var s = makeString(raw).trim();
  if (s === '') return { value: '', dropped: false };

  var sLower = s.toLowerCase();
  if (isHex64Lower(sLower)) return { value: sLower, dropped: false };

  var normalized;
  if (field === 'em') normalized = normalizeEmail(s);
  else if (field === 'ph') normalized = normalizePhoneStr(s);
  else normalized = normalizeGeneric(s);

  if (normalized === '') return { value: '', dropped: true };
  return { value: sha256Sync(normalized, { outputEncoding: 'hex' }), dropped: false };
}

// -- Combined entry point ------------------------------------------------------
//
// forwardable:false blocks the WHOLE event - sanitizedItemsJson and pii are
// BOTH null, never a plausible-looking empty cart / empty PII substitute.
function sanitize(itemsJsonRaw, emRaw, phRaw, fnRaw, lnRaw, ctRaw, stRaw, zpRaw, countryRaw) {
  var itemsResult = sanitizeItemsJson(itemsJsonRaw);

  if (!itemsResult.forwardableItems) {
    return {
      forwardable: false,
      sanitizedItemsJson: null,
      pii: null,
      droppedFields: [],
      errorCode: itemsResult.errorCode
    };
  }

  var fields = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country'];
  var raws = [emRaw, phRaw, fnRaw, lnRaw, ctRaw, stRaw, zpRaw, countryRaw];
  var pii = {};
  var droppedFields = [];
  var i, r;
  for (i = 0; i < fields.length; i++) {
    r = sanitizePiiField(fields[i], raws[i]);
    pii[fields[i]] = r.value;
    if (r.dropped) droppedFields.push(fields[i]);
  }
  if (itemsResult.droppedEntries > 0) droppedFields.push('items_entries:' + itemsResult.droppedEntries);

  return {
    forwardable: true,
    sanitizedItemsJson: itemsResult.sanitizedItemsJson,
    pii: pii,
    droppedFields: droppedFields,
    errorCode: null
  };
}

return sanitize(
  data.itemsJsonRaw, data.emRaw, data.phRaw, data.fnRaw, data.lnRaw,
  data.ctRaw, data.stRaw, data.zpRaw, data.countryRaw
);

___SERVER_PERMISSIONS___

[]

___TESTS___

[
  {
    "name": "valid cart + plaintext email -> forwardable, correct hash, no drops",
    "code": "mock('sha256Sync', function(s, opts){ return 'HASH_OF_' + s; }); data.itemsJsonRaw = '[{\"id\":\"1\",\"name\":\"Widget\",\"price\":9.99,\"quantity\":2}]'; data.emRaw = 'Buyer@Shop.SA'; var result = runCode(data); assertThat(result.forwardable).isEqualTo(true); assertThat(result.pii.em).isEqualTo('HASH_OF_buyer@shop.sa'); assertThat(result.errorCode).isEqualTo(null);"
  },
  {
    "name": "malformed items_json -> forwardable:false, sanitizedItemsJson and pii both null, PII never computed",
    "code": "mock('sha256Sync', function(s, opts){ return 'HASH_OF_' + s; }); data.itemsJsonRaw = '{not valid json'; data.emRaw = 'buyer@shop.sa'; var result = runCode(data); assertThat(result.forwardable).isEqualTo(false); assertThat(result.sanitizedItemsJson).isEqualTo(null); assertThat(result.pii).isEqualTo(null); assertThat(result.errorCode).isEqualTo('ITEMS_INVALID_JSON');"
  },
  {
    "name": "already-hashed uppercase email passes through lowercased, never re-hashed",
    "code": "var hashCalls = 0; mock('sha256Sync', function(s, opts){ hashCalls++; return 'SHOULD_NOT_BE_CALLED'; }); var digest = ''; for (var i = 0; i < 64; i++) digest += 'A'; data.itemsJsonRaw = '[]'; data.emRaw = digest; var result = runCode(data); assertThat(hashCalls).isEqualTo(0); assertThat(result.pii.em.length).isEqualTo(64);"
  },
  {
    "name": "extra/prototype-pollution-flavored keys never survive into sanitized items",
    "code": "mock('sha256Sync', function(s, opts){ return 'H'; }); data.itemsJsonRaw = '[{\"id\":\"1\",\"name\":\"X\",\"price\":1,\"quantity\":1,\"accessToken\":\"leak\",\"__proto__\":{\"polluted\":true}}]'; var result = runCode(data); var parsedOut = JSON.parse(result.sanitizedItemsJson); assertThat(JSON.stringify(parsedOut[0])).doesNotContain('accessToken'); assertThat(JSON.stringify(parsedOut[0])).doesNotContain('polluted');"
  },
  {
    "name": "more than 100 items is capped, remainder reported as dropped",
    "code": "mock('sha256Sync', function(s, opts){ return 'H'; }); var items = []; for (var i = 0; i < 150; i++) { items.push({id:'SKU-'+i, name:'Item', price:1, quantity:1}); } data.itemsJsonRaw = JSON.stringify(items); var result = runCode(data); var parsedOut = JSON.parse(result.sanitizedItemsJson); assertThat(parsedOut.length).isEqualTo(100); assertThat(result.droppedFields.length).isGreaterThan(0);"
  }
]
