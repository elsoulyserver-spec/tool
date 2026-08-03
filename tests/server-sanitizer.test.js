// tests/server-sanitizer.test.js
//
// Step 1 of the Blocker A "Option C" design — exhaustive tests for the pure,
// isolated sanitizer logic in lib/server-sanitizer.js. This module is a
// REFERENCE IMPLEMENTATION / TEST ORACLE only (see the header comment in
// lib/server-sanitizer.js) — it is NOT wired into lib/gtm-config-builder.js
// or any generated GTM container, and it cannot run inside sGTM's sandbox
// as-is. These tests exercise the pure Node logic only.
//
// Run: node --test tests/server-sanitizer.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  sanitize, sanitizeItemsJson, sanitizePiiField, safeLogSummary,
  normalizeEmail, normalizePhone, normalizeGeneric,
  normalizeQuantity, normalizePrice,
  MAX_ITEMS, MAX_STRING_LEN, MAX_QUANTITY, MAX_PRICE, MAX_OUTPUT_BYTES, ALLOWED_ITEM_KEYS,
} = require('../lib/server-sanitizer');

const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64_RE = /^[a-f0-9]{64}$/;

function baseInput(overrides = {}) {
  return {
    itemsJsonRaw: '[]',
    emRaw: '', phRaw: '', fnRaw: '', lnRaw: '',
    ctRaw: '', stRaw: '', zpRaw: '', countryRaw: '',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// items[] — valid commerce data
// ═════════════════════════════════════════════════════════════════════════════

test('valid normal commerce items round-trip intact', () => {
  const items = [
    { id: 'SKU-1', name: 'Wireless Mouse', price: 49.99, quantity: 2, brand: 'Acme', category: 'Electronics', variant: 'Black' },
    { id: 'SKU-2', name: 'USB-C Cable',    price: 9.5,   quantity: 1 },
  ];
  const r = sanitizeItemsJson(JSON.stringify(items));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errorCode, null);
  assert.strictEqual(r.itemCount, 2);
  assert.strictEqual(r.droppedEntries, 0);
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.deepStrictEqual(parsed, items);
});

test('empty/absent items_json produces a safe empty array, ok:true — distinct from a malformed-payload failure', () => {
  for (const raw of [null, undefined, '']) {
    const r = sanitizeItemsJson(raw);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sanitizedItemsJson, '[]');
    assert.strictEqual(r.errorCode, null);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — Arabic, Unicode, emoji
// ═════════════════════════════════════════════════════════════════════════════

test('Arabic, Unicode and emoji in item fields survive unchanged', () => {
  const items = [
    { id: 'SKU-3', name: 'تلفزيون سامسونج ٥٥ بوصة', price: 1999, quantity: 1, brand: 'سامسونج' },
    { id: 'SKU-4', name: 'Gift 🎁 Box — Édition Spéciale™', price: 25, quantity: 3 },
  ];
  const r = sanitizeItemsJson(JSON.stringify(items));
  assert.strictEqual(r.ok, true);
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.strictEqual(parsed[0].name, 'تلفزيون سامسونج ٥٥ بوصة');
  assert.strictEqual(parsed[0].brand, 'سامسونج');
  assert.strictEqual(parsed[1].name, 'Gift 🎁 Box — Édition Spéciale™');
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — quotes, backslashes, CR/LF/tab
// ═════════════════════════════════════════════════════════════════════════════

test('quotes, backslashes, and control characters in item fields are preserved as inert data', () => {
  const hostileNames = [
    'Samsung 55" TV',
    'Cable A\\B',
    'Line one\nLine two',
    'Tab\there',
    'CR\rReturn',
    '"""quote storm"""',
    'a\\",\\"b',
  ];
  for (const name of hostileNames) {
    const r = sanitizeItemsJson(JSON.stringify([{ id: '1', name, price: 1, quantity: 1 }]));
    assert.strictEqual(r.ok, true, `should parse fine for: ${JSON.stringify(name)}`);
    const parsed = JSON.parse(r.sanitizedItemsJson);
    assert.strictEqual(parsed[0].name, name, `value must survive unchanged for: ${JSON.stringify(name)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — hostile JSON-looking strings (the bracket-wrapped breakout class
// that defeated regex-only gating in the prior design round)
// ═════════════════════════════════════════════════════════════════════════════

test('hostile JSON-looking string values never inject a sibling key', () => {
  const hostilePayloads = [
    'x","injected_field":"OWNED',
    'x"},"injected":{"a":"b',
    '{"a":1}',
    '[1,2,3]',
    '"}],"evil":[{"x":"y',
  ];
  for (const name of hostilePayloads) {
    const r = sanitizeItemsJson(JSON.stringify([{ id: '1', name, price: 1, quantity: 1 }]));
    assert.strictEqual(r.ok, true);
    const parsed = JSON.parse(r.sanitizedItemsJson); // must still be valid, single-purpose JSON
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(Object.keys(parsed[0]).sort().join(','), 'id,name,price,quantity');
    assert.strictEqual(parsed[0].name, name, 'the hostile string must survive as inert text, not be interpreted');
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed[0], 'injected_field'));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed[0], 'injected'));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed[0], 'evil'));
  }
});

test('THE EXACT PRIOR-ROUND PROOF: a bracket-wrapped breakout that defeated regex heuristics fails CLOSED, not open', () => {
  // From the regex-gate proof: a naive "^\[.*\]$" heuristic was defeated by
  // wrapping the breakout in its own brackets. This is not valid JSON at all,
  // so it must be a HARD failure: forwardable:false, sanitizedItemsJson:null
  // — not a silently-empty '[]' that could pass for a legitimate empty cart.
  const breakout = '[{"id":"1"}],"injected_field":["OWNED"]';
  const r = sanitizeItemsJson(breakout);
  assert.strictEqual(r.ok, false, 'this is not valid JSON at all and must fail closed');
  assert.strictEqual(r.sanitizedItemsJson, null, 'must be null, not "[]" — never mistakable for a valid empty cart');
  assert.strictEqual(r.errorCode, 'ITEMS_INVALID_JSON');
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — nested unexpected objects
// ═════════════════════════════════════════════════════════════════════════════

test('a nested object in a scalar item field is dropped for that key, not stringified', () => {
  const items = [{ id: '1', name: { evil: true }, price: 10, quantity: 1 }];
  const r = sanitizeItemsJson(JSON.stringify(items));
  assert.strictEqual(r.ok, true);
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.strictEqual(parsed.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed[0], 'name'), 'name key must be entirely absent, not "[object Object]"');
  assert.strictEqual(parsed[0].price, 10);
});

test('an array value in a scalar item field is dropped for that key', () => {
  const items = [{ id: '1', name: ['a', 'b'], price: 10, quantity: 1 }];
  const r = sanitizeItemsJson(JSON.stringify(items));
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed[0], 'name'));
});

test('non-object entries in the items array (string/number/null/array) are dropped, not crashed on', () => {
  const raw = JSON.stringify([
    { id: '1', name: 'Real Item', price: 5, quantity: 1 },
    'just a string',
    42,
    null,
    ['nested', 'array'],
    { id: '2', name: 'Another Real Item', price: 8, quantity: 2 },
  ]);
  const r = sanitizeItemsJson(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.itemCount, 2);
  assert.strictEqual(r.droppedEntries, 4);
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.deepStrictEqual(parsed.map(i => i.id), ['1', '2']);
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — extra / unexpected keys, prototype-pollution proof
// ═════════════════════════════════════════════════════════════════════════════

test('extra keys not on the allowlist never survive into the output', () => {
  const items = [{
    id: '1', name: 'X', price: 1, quantity: 1,
    secretInternalField: 'should not appear',
    accessToken: 'should-not-leak',
  }];
  const r = sanitizeItemsJson(JSON.stringify(items));
  const parsed = JSON.parse(r.sanitizedItemsJson);
  const keys = Object.keys(parsed[0]).sort();
  assert.deepStrictEqual(keys, ['id', 'name', 'price', 'quantity']);
  assert.strictEqual(JSON.stringify(parsed[0]).includes('secretInternalField'), false);
  assert.strictEqual(JSON.stringify(parsed[0]).includes('accessToken'), false);
});

test('every output key is drawn only from ALLOWED_ITEM_KEYS, for any input shape', () => {
  const items = [{ id: '1', a: 1, b: 2, c: 3, name: 'X', price: 1, quantity: 1, z: 'zzz' }];
  const r = sanitizeItemsJson(JSON.stringify(items));
  const parsed = JSON.parse(r.sanitizedItemsJson);
  for (const k of Object.keys(parsed[0])) {
    assert.ok(ALLOWED_ITEM_KEYS.includes(k), `unexpected key survived: ${k}`);
  }
});

test('PROOF: a "__proto__" key on the input item cannot pollute Object.prototype nor survive to output', () => {
  // Empirically verified separately: JSON.parse creates "__proto__" as a
  // normal OWN enumerable property, not a prototype-setter — confirmed via
  // Object.getOwnPropertyNames / hasOwnProperty / getPrototypeOf before this
  // test was written. This test proves the sanitizer's behavior on top of
  // that fact: the key is simply not on ALLOWED_ITEM_KEYS, so it never
  // reaches the output, and no global prototype is touched.
  const raw = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"id":"1","name":"X","price":1,"quantity":1}';
  const parsedInput = JSON.parse(raw);
  assert.strictEqual(Object.getPrototypeOf(parsedInput), Object.prototype, 'sanity: JSON.parse does not repoint the prototype');

  const r = sanitizeItemsJson(JSON.stringify([JSON.parse(raw)]));
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.deepStrictEqual(Object.keys(parsed[0]).sort(), ['id', 'name', 'price', 'quantity']);
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype must be untouched after sanitizing');
  assert.strictEqual(({}).polluted2, undefined, 'Object.prototype must be untouched after sanitizing');
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — count and length bounds
// ═════════════════════════════════════════════════════════════════════════════

test('more than 100 items is capped at MAX_ITEMS, remainder counted as dropped', () => {
  const items = Array.from({ length: 150 }, (_, i) => ({ id: 'SKU-' + i, name: 'Item ' + i, price: 1, quantity: 1 }));
  const r = sanitizeItemsJson(JSON.stringify(items));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.itemCount, MAX_ITEMS);
  assert.strictEqual(r.droppedEntries, 50);
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.strictEqual(parsed.length, 100);
  assert.strictEqual(parsed[0].id, 'SKU-0');
  assert.strictEqual(parsed[99].id, 'SKU-99');
});

test('exactly 100 items: none dropped', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: 'SKU-' + i, name: 'Item', price: 1, quantity: 1 }));
  const r = sanitizeItemsJson(JSON.stringify(items));
  assert.strictEqual(r.itemCount, 100);
  assert.strictEqual(r.droppedEntries, 0);
});

test('strings longer than 500 characters are truncated to MAX_STRING_LEN', () => {
  const longName = 'x'.repeat(2000);
  const r = sanitizeItemsJson(JSON.stringify([{ id: '1', name: longName, price: 1, quantity: 1 }]));
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.strictEqual(parsed[0].name.length, MAX_STRING_LEN);
  assert.strictEqual(parsed[0].name, longName.slice(0, MAX_STRING_LEN));
});

test('a string exactly at the 500-char boundary is not truncated', () => {
  const exactName = 'y'.repeat(MAX_STRING_LEN);
  const r = sanitizeItemsJson(JSON.stringify([{ id: '1', name: exactName, price: 1, quantity: 1 }]));
  const parsed = JSON.parse(r.sanitizedItemsJson);
  assert.strictEqual(parsed[0].name, exactName);
});

test('output size is bounded in aggregate: 100 max-length items are trimmed to fit MAX_OUTPUT_BYTES', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: 'SKU-' + i, name: 'n'.repeat(MAX_STRING_LEN), price: 1, quantity: 1,
    brand: 'b'.repeat(MAX_STRING_LEN), category: 'c'.repeat(MAX_STRING_LEN), variant: 'v'.repeat(MAX_STRING_LEN),
  }));
  const r = sanitizeItemsJson(JSON.stringify(items));
  assert.strictEqual(r.ok, true);
  assert.ok(r.sanitizedItemsJson.length <= MAX_OUTPUT_BYTES, `output was ${r.sanitizedItemsJson.length} bytes, expected <= ${MAX_OUTPUT_BYTES}`);
  assert.ok(r.itemCount < 100, 'some items must have been trimmed to fit the aggregate bound');
  assert.ok(r.droppedEntries > 0);
  assert.doesNotThrow(() => JSON.parse(r.sanitizedItemsJson), 'trimmed output must still be valid JSON');
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — numeric normalization: NaN, Infinity, negative quantity, absurd values
// ═════════════════════════════════════════════════════════════════════════════

test('quantity rejects NaN/Infinity/non-numeric, falling back to 1', () => {
  for (const v of ['not-a-number', NaN, Infinity, -Infinity, {}, [1, 2], undefined]) {
    if (v === undefined) continue; // undefined is handled as "absent key", tested separately
    assert.strictEqual(normalizeQuantity(v), 1, `quantity(${JSON.stringify(v)})`);
  }
});

test('quantity rejects zero and negative values, falling back to 1', () => {
  assert.strictEqual(normalizeQuantity(0), 1);
  assert.strictEqual(normalizeQuantity(-1), 1);
  assert.strictEqual(normalizeQuantity(-999), 1);
});

test('quantity clamps absurdly large values to MAX_QUANTITY rather than passing them through', () => {
  assert.strictEqual(normalizeQuantity(1e9), MAX_QUANTITY);
  assert.strictEqual(normalizeQuantity(MAX_QUANTITY), MAX_QUANTITY);
  assert.strictEqual(normalizeQuantity(MAX_QUANTITY - 1), MAX_QUANTITY - 1);
});

test('price rejects NaN/Infinity/non-numeric-objects, falling back to 0', () => {
  // Note: parseFloat([1,2]) legitimately coerces the array to the string
  // "1,2" and reads the leading "1" — that's a harmless, plausible-looking
  // number (not 0), so it's excluded from this "must become 0" list; it's
  // covered separately as a benign quirk, not a rejection case.
  for (const v of ['garbage', NaN, Infinity, -Infinity, {}]) {
    assert.strictEqual(normalizePrice(v), 0, `price(${JSON.stringify(v)})`);
  }
});

test('price on an array value: parseFloat string-coerces it rather than treating it as unsafe (documented, benign)', () => {
  assert.strictEqual(normalizePrice([1, 2]), 1, 'array coerces to "1,2" -> parseFloat reads the leading 1 — harmless');
  assert.strictEqual(normalizePrice([]), 0, 'empty array coerces to "" -> NaN -> falls back to 0');
});

test('price allows negative values (refunds/discounts) but bounds the magnitude', () => {
  assert.strictEqual(normalizePrice(-50), -50);
  assert.strictEqual(normalizePrice(-1e9), -MAX_PRICE);
});

test('price clamps absurdly large positive values to MAX_PRICE', () => {
  assert.strictEqual(normalizePrice(1e9), MAX_PRICE);
  assert.strictEqual(normalizePrice(MAX_PRICE), MAX_PRICE);
});

test('numeric fields end to end: strings, hostile values, and missing values via sanitizeItemsJson', () => {
  // Note: JSON has no way to encode a live Infinity/NaN value — JSON.stringify
  // silently converts them to `null` before serialization (verified:
  // JSON.stringify({price:Infinity}) === '{"price":null}'), and a RAW string
  // containing the literal unquoted token `Infinity` is not valid JSON at all
  // (JSON.parse throws SyntaxError on it) — covered separately below as a
  // whole-event-failure case, since that is the actual, stronger outcome.
  const cases = [
    [{ id: '1', price: '49.99', quantity: '3' }, { price: 49.99, quantity: 3 }],
    [{ id: '1', price: 'not-a-number', quantity: 'also-not' }, { price: 0, quantity: 1 }],
    [{ id: '1', price: null, quantity: undefined }, { price: undefined, quantity: undefined }], // both absent -> keys absent
    [{ id: '1', price: { evil: true }, quantity: [1, 2] }, { price: 0, quantity: 1 }],
    [{ id: '1', price: -5, quantity: -3 }, { price: -5, quantity: 1 }],
  ];
  for (const [input, expected] of cases) {
    const r = sanitizeItemsJson(JSON.stringify([input]));
    const item = JSON.parse(r.sanitizedItemsJson)[0];
    if (expected.price === undefined) assert.ok(!('price' in item), JSON.stringify(input));
    else assert.strictEqual(item.price, expected.price, JSON.stringify(input));
    if (expected.quantity === undefined) assert.ok(!('quantity' in item), JSON.stringify(input));
    else assert.strictEqual(item.quantity, expected.quantity, JSON.stringify(input));
  }
});

test('a raw items_json string containing a literal unquoted Infinity/NaN token is not valid JSON and fails the WHOLE event closed', () => {
  for (const raw of ['[{"id":"1","price":Infinity,"quantity":1}]', '[{"id":"1","price":NaN,"quantity":1}]']) {
    const r = sanitizeItemsJson(raw);
    assert.strictEqual(r.ok, false, `expected failure for: ${raw}`);
    assert.strictEqual(r.sanitizedItemsJson, null);
    assert.strictEqual(r.errorCode, 'ITEMS_INVALID_JSON');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// items[] — malformed JSON must fail closed (EXPLICIT, not a silent empty cart)
// ═════════════════════════════════════════════════════════════════════════════

test('malformed JSON fails closed: ok:false, sanitizedItemsJson IS NULL (not "[]"), explicit error code', () => {
  const malformed = [
    '{not valid json',
    '[{"id":1,}]',        // trailing comma
    'undefined',
    'function(){}',
  ];
  for (const raw of malformed) {
    const r = sanitizeItemsJson(raw);
    assert.strictEqual(r.ok, false, `expected failure for: ${raw}`);
    assert.strictEqual(r.sanitizedItemsJson, null, `must be null, not "[]", for: ${raw}`);
    assert.strictEqual(r.errorCode, 'ITEMS_INVALID_JSON');
  }
});

test('valid JSON that is not an array (object, string, number, boolean, null) fails closed with a distinct error code', () => {
  // Note: the "absent" fast path only matches the RAW STRING being null/undefined/''
  // (i.e. no items_json parameter was set at all). The literal JSON text "null"
  // still gets parsed (to the value null) and correctly rejected as not-an-array,
  // same as any other non-array JSON value — there is no special case for it.
  const nonArrays = ['{"a":1}', '"just a string"', '42', 'true', 'null'];
  for (const raw of nonArrays) {
    const r = sanitizeItemsJson(raw);
    assert.strictEqual(r.ok, false, `expected failure for: ${raw}`);
    assert.strictEqual(r.sanitizedItemsJson, null);
    assert.strictEqual(r.errorCode, 'ITEMS_NOT_ARRAY');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CRITICAL CONTRACT TEST: a caller cannot accidentally forward an invalid
// purchase as a successful empty-cart event
// ═════════════════════════════════════════════════════════════════════════════

test('CONTRACT: sanitize() distinguishes "legitimately empty cart" from "malformed purchase" unambiguously', () => {
  const legitEmptyCart = sanitize(baseInput({ itemsJsonRaw: '' }));
  const malformedPurchase = sanitize(baseInput({ itemsJsonRaw: 'this is not json at all' }));

  assert.strictEqual(legitEmptyCart.forwardable, true);
  assert.strictEqual(legitEmptyCart.sanitizedItemsJson, '[]');
  assert.notStrictEqual(legitEmptyCart.pii, null);

  assert.strictEqual(malformedPurchase.forwardable, false);
  assert.strictEqual(malformedPurchase.sanitizedItemsJson, null,
    'a malformed purchase must NEVER produce the same "[]" a legitimate empty cart produces');
  assert.strictEqual(malformedPurchase.pii, null,
    'no field of a blocked event may be exposed — not even successfully-hashed PII');
  assert.notStrictEqual(legitEmptyCart.sanitizedItemsJson, malformedPurchase.sanitizedItemsJson);
});

test('CONTRACT: forwardable:false blocks the WHOLE event, including PII that would otherwise have hashed fine', () => {
  const r = sanitize(baseInput({ itemsJsonRaw: '{not valid', emRaw: 'buyer@shop.sa' }));
  assert.strictEqual(r.forwardable, false);
  assert.strictEqual(r.pii, null, 'PII must not be computed/exposed when the event as a whole is blocked');
  assert.strictEqual(r.sanitizedItemsJson, null);
  assert.deepStrictEqual(r.droppedFields, []);
});

test('CONTRACT: a naive caller that skips the forwardable check gets null, never a plausible fallback', () => {
  // Simulates a careless integration that forgets to check `forwardable` and
  // tries to embed the result directly into a CAPI body slot the way the
  // real tag templates do: "contents":{{...}}. It must NOT produce anything
  // that resembles a valid, successful, empty-cart purchase.
  const r = sanitize(baseInput({ itemsJsonRaw: '[[[[malformed' }));
  const naiveEmbedding = '"contents":' + String(r.sanitizedItemsJson);
  assert.strictEqual(naiveEmbedding, '"contents":null');
  assert.notStrictEqual(naiveEmbedding, '"contents":[]', 'must not be indistinguishable from a real empty cart');
});

test('CONTRACT: field dropped safely vs item dropped safely vs whole event blocked are three distinct, non-overlapping states', () => {
  // 1) field dropped safely — event still forwardable
  const fieldDropped = sanitize(baseInput({ itemsJsonRaw: '[]', phRaw: '----' }));
  assert.strictEqual(fieldDropped.forwardable, true);
  assert.deepStrictEqual(fieldDropped.droppedFields, ['ph']);
  assert.strictEqual(fieldDropped.errorCode, null);

  // 2) item dropped safely — event still forwardable
  const itemDropped = sanitize(baseInput({ itemsJsonRaw: JSON.stringify(['not-an-object', { id: '1', name: 'X', price: 1, quantity: 1 }]) }));
  assert.strictEqual(itemDropped.forwardable, true);
  assert.ok(itemDropped.droppedFields.some(f => f.startsWith('items_entries:')));
  assert.strictEqual(itemDropped.errorCode, null);

  // 3) whole event blocked — nothing forwardable, nothing exposed
  const eventBlocked = sanitize(baseInput({ itemsJsonRaw: 'not json' }));
  assert.strictEqual(eventBlocked.forwardable, false);
  assert.strictEqual(eventBlocked.sanitizedItemsJson, null);
  assert.strictEqual(eventBlocked.pii, null);
  assert.strictEqual(eventBlocked.errorCode, 'ITEMS_INVALID_JSON');

  // All three are mutually distinguishable by (forwardable, sanitizedItemsJson, pii).
  const shapes = [fieldDropped, itemDropped, eventBlocked].map(r => JSON.stringify({ f: r.forwardable, s: r.sanitizedItemsJson, p: r.pii }));
  assert.strictEqual(new Set(shapes).size, 3, 'the three states must not be representable identically');
});

// ═════════════════════════════════════════════════════════════════════════════
// PII — SHA-256 detection and passthrough
// ═════════════════════════════════════════════════════════════════════════════

test('valid lowercase SHA-256 passes through unchanged', () => {
  const digest = sha256('buyer@shop.sa');
  const r = sanitizePiiField('em', digest);
  assert.strictEqual(r.value, digest);
  assert.strictEqual(r.dropped, false);
});

test('valid UPPERCASE SHA-256 passes through, lowercased, never re-hashed', () => {
  const digest = sha256('buyer@shop.sa');
  const r = sanitizePiiField('em', digest.toUpperCase());
  assert.strictEqual(r.value, digest, 'must equal the ORIGINAL digest, not a hash of the uppercase string');
  assert.notStrictEqual(r.value, sha256(digest.toUpperCase()), 'must not have been re-hashed');
});

test('mixed-case SHA-256 passes through, fully lowercased', () => {
  const digest = sha256('buyer@shop.sa');
  const mixed = digest.slice(0, 32) + digest.slice(32).toUpperCase();
  const r = sanitizePiiField('em', mixed);
  assert.strictEqual(r.value, digest);
  assert.match(r.value, HEX64_RE);
});

test('malformed 64-character non-hex values are treated as plaintext and hashed (not dropped, not forwarded raw)', () => {
  // Consistent with the already-shipped web-container behavior
  // (lib/gtm-config-builder.js's pii_hashed): a 64-char string that is NOT
  // valid hex normalizes and hashes like any other plaintext value.
  const notHex = 'g'.repeat(64); // 'g' is not a hex digit
  const r = sanitizePiiField('em', notHex);
  assert.strictEqual(r.value, sha256(notHex.toLowerCase()));
  assert.strictEqual(r.dropped, false);
  assert.notStrictEqual(r.value, notHex, 'must not be forwarded as-is');
});

test('63-char and 65-char near-miss hex strings are treated as plaintext, not as hashes', () => {
  const near63 = 'a'.repeat(63);
  const near65 = 'a'.repeat(65);
  const r63 = sanitizePiiField('em', near63);
  const r65 = sanitizePiiField('em', near65);
  assert.strictEqual(r63.value, sha256(near63.toLowerCase()));
  assert.strictEqual(r65.value, sha256(near65.toLowerCase()));
});

// ═════════════════════════════════════════════════════════════════════════════
// PII — normalization rules
// ═════════════════════════════════════════════════════════════════════════════

test('email normalization: trim + lowercase, documented exactly', () => {
  assert.strictEqual(normalizeEmail('  Buyer@Shop.SA  '), 'buyer@shop.sa');
  assert.strictEqual(normalizeEmail('ALLCAPS@EXAMPLE.COM'), 'allcaps@example.com');
});

test('phone normalization: digits only, deterministic', () => {
  assert.strictEqual(normalizePhone('+966 (50) 000-0000'), '966500000000');
  assert.strictEqual(normalizePhone('+966501234567'), '966501234567');
  assert.strictEqual(normalizePhone('(050) 123-4567'), '0501234567');
  assert.strictEqual(normalizePhone('050 123 4567 ext. 12'), '050123456712');
});

test('DOCUMENTED LIMITATION: local vs international phone formats normalize differently (by design, not a bug)', () => {
  assert.notStrictEqual(normalizePhone('0501234567'), normalizePhone('+966501234567'));
});

test('name/address fields normalize via trim + lowercase (documented canonical rule)', () => {
  assert.strictEqual(normalizeGeneric('  Ahmed  '), 'ahmed');
  assert.strictEqual(normalizeGeneric('AL-SAUD'), 'al-saud');
  assert.strictEqual(normalizeGeneric('Riyadh'), 'riyadh');
});

test('email/phone/name/address plaintext all hash correctly end-to-end', () => {
  const cases = [
    ['em', 'Buyer@Shop.SA', sha256('buyer@shop.sa')],
    ['ph', '+966 50 000 0000', sha256('966500000000')],
    ['fn', ' Ahmed ', sha256('ahmed')],
    ['ln', 'AL-SAUD', sha256('al-saud')],
    ['ct', 'Riyadh', sha256('riyadh')],
    ['st', 'Makkah', sha256('makkah')],
    ['zp', '12345', sha256('12345')],
    ['country', 'SA', sha256('sa')],
  ];
  for (const [field, raw, expected] of cases) {
    const r = sanitizePiiField(field, raw);
    assert.strictEqual(r.value, expected, field);
    assert.strictEqual(r.dropped, false, field);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PII — Arabic, Unicode, emoji in names
// ═════════════════════════════════════════════════════════════════════════════

test('Arabic and emoji names hash correctly (normalization is Unicode-safe)', () => {
  const r1 = sanitizePiiField('fn', 'محمد');
  assert.strictEqual(r1.value, sha256('محمد'));
  const r2 = sanitizePiiField('fn', 'José 🙂 Peña');
  assert.strictEqual(r2.value, sha256('josé 🙂 peña'));
});

// ═════════════════════════════════════════════════════════════════════════════
// PII — empty/missing values remain absent, never "dropped"
// ═════════════════════════════════════════════════════════════════════════════

test('empty/missing PII values resolve to empty string and are NOT reported as dropped', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const r = sanitizePiiField('em', raw);
    assert.strictEqual(r.value, '');
    assert.strictEqual(r.dropped, false, `absent input must not count as "dropped": ${JSON.stringify(raw)}`);
  }
});

test('a phone that normalizes to nothing usable (no digits at all) IS reported as dropped', () => {
  const r = sanitizePiiField('ph', '----');
  assert.strictEqual(r.value, '');
  assert.strictEqual(r.dropped, true, 'non-empty input that produced nothing usable must be flagged as dropped');
});

// ═════════════════════════════════════════════════════════════════════════════
// No double hashing
// ═════════════════════════════════════════════════════════════════════════════

test('no double hashing: sanitizing an already-sanitized (hashed) value is a no-op', () => {
  const first = sanitizePiiField('em', 'buyer@shop.sa');
  const second = sanitizePiiField('em', first.value); // feed the hash back in
  assert.strictEqual(second.value, first.value, 'hashing the digest again must return the SAME digest, not hash-of-hash');
});

test('no double hashing across a full sanitize() -> sanitize() round trip', () => {
  const input1 = baseInput({ emRaw: 'buyer@shop.sa', phRaw: '966500000000' });
  const result1 = sanitize(input1);
  const input2 = baseInput({ emRaw: result1.pii.em, phRaw: result1.pii.ph });
  const result2 = sanitize(input2);
  assert.strictEqual(result2.pii.em, result1.pii.em);
  assert.strictEqual(result2.pii.ph, result1.pii.ph);
});

// ═════════════════════════════════════════════════════════════════════════════
// Comparison with node:crypto — several diverse values
// ═════════════════════════════════════════════════════════════════════════════

test('sanitizePiiField hash output matches node:crypto.createHash("sha256") exactly, across many inputs', () => {
  const samples = [
    'test@example.com', 'ahmed.ali@example.com', 'محمد بن سلمان',
    'José Peña', '日本語テキスト', 'a'.repeat(1000), '',
  ].filter(Boolean);
  for (const s of samples) {
    const r = sanitizePiiField('fn', s);
    assert.strictEqual(r.value, sha256(s.trim().toLowerCase()), s.slice(0, 20));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Deterministic output
// ═════════════════════════════════════════════════════════════════════════════

test('deterministic output: identical input produces byte-identical output across repeated calls', () => {
  const input = baseInput({
    itemsJsonRaw: JSON.stringify([{ id: '1', name: 'Widget', price: 9.99, quantity: 2 }]),
    emRaw: 'buyer@shop.sa', phRaw: '+966500000000', fnRaw: 'Ahmed', lnRaw: 'Al-Saud',
  });
  const results = Array.from({ length: 5 }, () => sanitize(input));
  const serialized = results.map(r => JSON.stringify(r));
  for (let i = 1; i < serialized.length; i++) {
    assert.strictEqual(serialized[i], serialized[0], `run ${i} differs from run 0`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Combined sanitize() — output contract
// ═════════════════════════════════════════════════════════════════════════════

test('sanitize() returns the full documented output contract on success', () => {
  const r = sanitize(baseInput({
    itemsJsonRaw: JSON.stringify([{ id: '1', name: 'X', price: 1, quantity: 1 }]),
    emRaw: 'buyer@shop.sa',
  }));
  assert.strictEqual(typeof r.forwardable, 'boolean');
  assert.strictEqual(r.forwardable, true);
  assert.strictEqual(typeof r.sanitizedItemsJson, 'string');
  assert.doesNotThrow(() => JSON.parse(r.sanitizedItemsJson));
  assert.strictEqual(typeof r.pii, 'object');
  for (const f of ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country']) {
    assert.ok(f in r.pii, `pii.${f} must exist`);
  }
  assert.ok(Array.isArray(r.droppedFields));
  assert.strictEqual(r.errorCode, null);
});

test('sanitize() ok/forwardable:true even when individual PII fields are dropped', () => {
  const r2 = sanitize(baseInput({ itemsJsonRaw: '[]', phRaw: '----' }));
  assert.strictEqual(r2.forwardable, true, 'a dropped PII field alone must not block the whole event');
  assert.ok(r2.droppedFields.includes('ph'));
  assert.strictEqual(r2.errorCode, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// No raw PII in returned errors or logs
// ═════════════════════════════════════════════════════════════════════════════

test('no raw PII ever appears anywhere in the sanitize() output, including on failure paths', () => {
  const rawSecrets = ['very.real.customer@example.com', '+966500000001', 'RealFirstName', 'RealLastName'];
  // Success path — PII IS exposed, but only as hashes, never raw.
  const success = sanitize(baseInput({
    itemsJsonRaw: '[]',
    emRaw: rawSecrets[0], phRaw: rawSecrets[1], fnRaw: rawSecrets[2], lnRaw: rawSecrets[3],
  }));
  const successDump = JSON.stringify(success);
  for (const secret of rawSecrets) {
    assert.ok(!successDump.includes(secret), `raw secret leaked into success output: ${secret}`);
  }
  assert.strictEqual(success.pii.em, sha256(rawSecrets[0].toLowerCase()));

  // Failure path — nothing is exposed at all, raw or hashed.
  const failure = sanitize({
    itemsJsonRaw: '{not valid json',
    emRaw: rawSecrets[0], phRaw: rawSecrets[1], fnRaw: rawSecrets[2], lnRaw: rawSecrets[3],
  });
  const failureDump = JSON.stringify(failure);
  for (const secret of rawSecrets) {
    assert.ok(!failureDump.includes(secret), `raw secret leaked into failure output: ${secret}`);
  }
  assert.strictEqual(failure.pii, null, 'failure path must not expose even hashed PII');
});

test('droppedFields contains only field NAMES, never raw values', () => {
  const r = sanitize(baseInput({ itemsJsonRaw: '[]', phRaw: 'this-has-no-digits-at-all-xyz' }));
  assert.deepStrictEqual(r.droppedFields, ['ph']);
  assert.ok(!JSON.stringify(r.droppedFields).includes('this-has-no-digits-at-all-xyz'));
});

test('safeLogSummary never includes raw input, hashed digests, or item content', () => {
  const rawEmail = 'do.not.log.me@example.com';
  const items = [{ id: '1', name: 'Secret Product Name', price: 1, quantity: 1 }];
  const r = sanitize(baseInput({ itemsJsonRaw: JSON.stringify(items), emRaw: rawEmail }));
  const summary = safeLogSummary(r);
  const dump = JSON.stringify(summary);
  assert.ok(!dump.includes(rawEmail));
  assert.ok(!dump.includes(r.pii.em), 'the hash itself should not need to appear in a log summary either');
  assert.ok(!dump.includes('Secret Product Name'));
  // Only aggregate/boolean/count fields should be present.
  assert.deepStrictEqual(Object.keys(summary).sort(),
    ['droppedFieldCount', 'errorCode', 'forwardable', 'itemCount', 'piiFieldsPresent'].sort());
});

test('safeLogSummary on a blocked (forwardable:false) event stays safe and does not throw', () => {
  const r = sanitize(baseInput({ itemsJsonRaw: 'not json', emRaw: 'secret@example.com' }));
  const summary = safeLogSummary(r);
  assert.strictEqual(summary.forwardable, false);
  assert.strictEqual(summary.itemCount, 0);
  assert.strictEqual(summary.piiFieldsPresent, 0);
  assert.ok(!JSON.stringify(summary).includes('secret@example.com'));
});

test('error codes never embed the raw offending payload', () => {
  const hostileRaw = '{"secret_leak_marker_xyz": true, not valid json';
  const r = sanitizeItemsJson(hostileRaw);
  assert.strictEqual(r.errorCode, 'ITEMS_INVALID_JSON');
  assert.ok(!JSON.stringify(r).includes('secret_leak_marker_xyz'));
});
