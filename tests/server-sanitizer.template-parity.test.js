// tests/server-sanitizer.template-parity.test.js
//
// Step 2 parity suite — proves the sandboxed-JS translation in
// lib/server-side/sgtm-templates/server-sanitizer.tpl produces IDENTICAL
// output to the Node reference implementation (lib/server-sanitizer.js,
// commit de52af8) across the full required fixture matrix.
//
// METHOD: this file extracts the literal ___SANDBOXED_JS_FOR_SERVER___ block
// from the .tpl file (the same file that would be pasted into GTM's template
// editor) and executes it in Node with hand-built shims for the sandbox's
// require()-provided APIs (JSON, sha256Sync, makeString, makeNumber, Object).
// This is the SAME established pattern this codebase already uses for
// testing sGTM sandboxed logic outside of GTM — see tests/sgtm-simulator.js's
// own header: "Node.js faithful port of the universal-http.tpl v4 template
// logic. Replaces sGTM sandbox APIs with Node.js equivalents."
//
// This is NOT a substitute for a live-sandbox import test (see the Step 2
// deliverable's "unresolved manual GTM permission/import questions" — the
// shims here encode DOCUMENTED sandbox behavior, e.g. "JSON.parse returns
// undefined on bad input instead of throwing", not independently-verified
// live behavior for the specific helper functions this template invents
// (isArrayLike, isFiniteNum) that have no precedent in this codebase's
// already-audited templates.
//
// Run: node --test tests/server-sanitizer.template-parity.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const reference = require('../lib/server-sanitizer');

const TPL_PATH = path.join(__dirname, '..', 'lib', 'server-side', 'sgtm-templates', 'server-sanitizer.tpl');

// ─────────────────────────────────────────────────────────────────────────────
// Extract the sandboxed JS block from the .tpl file — the exact same text a
// human would paste into GTM's "Sandboxed JavaScript for Server" editor tab.
// ─────────────────────────────────────────────────────────────────────────────

function extractSandboxedJs(tplSource) {
  const startMarker = '___SANDBOXED_JS_FOR_SERVER___';
  const endMarker = '___SERVER_PERMISSIONS___';
  const start = tplSource.indexOf(startMarker);
  const end = tplSource.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate sandboxed JS block in .tpl file');
  return tplSource.slice(start + startMarker.length, end).trim();
}

const tplSource = fs.readFileSync(TPL_PATH, 'utf8');
const sandboxedJs = extractSandboxedJs(tplSource);

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox API shims — encode DOCUMENTED sGTM sandbox behavior, not Node
// behavior. Sources for each documented claim are cited inline.
// ─────────────────────────────────────────────────────────────────────────────

// "JSON.parse / JSON.stringify — Supported; parse returns undefined on bad
// input (never throws)" — docs/GTM_SANDBOX_FIX_REPORT.md, confirmed against
// official Google docs and already relied on in this codebase's own audited
// templates (`var parsed = JSON.parse(res.body) || {};`).
const sandboxJSON = {
  parse(s) {
    try { return JSON.parse(s); } catch (e) { return undefined; }
  },
  stringify(v) { return JSON.stringify(v); },
};

// sha256Sync(s, {outputEncoding:'hex'}) — confirmed supported, used
// extensively in this codebase's audited templates.
function sandboxSha256Sync(s, opts) {
  const encoding = (opts && opts.outputEncoding) || 'hex';
  return crypto.createHash('sha256').update(String(s), 'utf8').digest(encoding);
}

// makeString / makeNumber — confirmed supported (docs/GTM_SANDBOX_FIX_REPORT.md).
// Exact coercion semantics for edge cases (objects, arrays) are not
// independently documented in this repo; String()/parseFloat() are the
// closest faithful Node equivalents and are what this shim uses.
function sandboxMakeString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}
function sandboxMakeNumber(v) {
  const n = parseFloat(v);
  return n; // may be NaN — callers use their own finiteness check, matching the template's own isFiniteNum()
}

// Object.keys — confirmed supported via require('Object') in every audited
// template in this codebase.
const sandboxObject = { keys: Object.keys };

// NOTE: deliberately NOT using node:vm's createContext/runInContext here.
// A separate vm context is a genuinely different V8 realm, which gives
// objects created inside it a DIFFERENT Object/Array prototype chain than
// this test file's — assert.deepStrictEqual then fails on realm identity
// alone even when two objects are structurally byte-for-byte identical
// (confirmed while building this harness: JSON.stringify of "actual" and
// "expected" printed identically, yet deepStrictEqual still failed, purely
// because of cross-realm object identity). Since this test only needs
// OUTPUT COMPARISON, not sandbox isolation from this test process, a plain
// same-realm `Function` wrapper — with require() shimmed via closure — is
// both correct and simpler.
function runSandboxedTemplate(input) {
  function shimmedRequire(name) {
    switch (name) {
      case 'JSON': return sandboxJSON;
      case 'sha256Sync': return sandboxSha256Sync;
      case 'makeString': return sandboxMakeString;
      case 'makeNumber': return sandboxMakeNumber;
      case 'Object': return sandboxObject;
      default: throw new Error('unshimmed sandbox require(): ' + name);
    }
  }
  // The extracted source ends with `return sanitize(...)`; GTM wraps a
  // Variable template's sandboxed JS in an implicit function body, so we
  // reproduce that here with a real function wrapper.
  const fn = new Function('data', 'require', sandboxedJs);
  return fn(input, shimmedRequire);
}

function templateInput(overrides = {}) {
  return {
    itemsJsonRaw: '[]',
    emRaw: '', phRaw: '', fnRaw: '', lnRaw: '',
    ctRaw: '', stRaw: '', zpRaw: '', countryRaw: '',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: the extraction + shim harness itself works before trusting any
// parity comparison built on it.
// ─────────────────────────────────────────────────────────────────────────────

test('SANITY: sandboxed JS extracts and executes, returning the documented shape', () => {
  const result = runSandboxedTemplate(templateInput());
  assert.strictEqual(typeof result.forwardable, 'boolean');
  assert.ok('sanitizedItemsJson' in result);
  assert.ok('pii' in result);
  assert.ok('droppedFields' in result);
  assert.ok('errorCode' in result);
});

// ─────────────────────────────────────────────────────────────────────────────
// Parity fixture matrix — every case runs through BOTH implementations and
// asserts an identical result.
// ─────────────────────────────────────────────────────────────────────────────

function assertParity(label, input) {
  const nodeResult = reference.sanitize(input);
  const tplResult = runSandboxedTemplate(input);
  assert.deepStrictEqual(tplResult, nodeResult, `parity mismatch for: ${label}\nnode: ${JSON.stringify(nodeResult)}\ntpl:  ${JSON.stringify(tplResult)}`);
}

test('PARITY: valid normal commerce cart', () => {
  assertParity('valid cart', templateInput({
    itemsJsonRaw: JSON.stringify([
      { id: 'SKU-1', name: 'Wireless Mouse', price: 49.99, quantity: 2, brand: 'Acme', category: 'Electronics', variant: 'Black' },
      { id: 'SKU-2', name: 'USB-C Cable', price: 9.5, quantity: 1 },
    ]),
  }));
});

test('PARITY: empty/absent cart', () => {
  assertParity('absent items', templateInput({ itemsJsonRaw: '' }));
  assertParity('empty array', templateInput({ itemsJsonRaw: '[]' }));
});

test('PARITY: Arabic, Unicode, emoji in item fields', () => {
  assertParity('unicode items', templateInput({
    itemsJsonRaw: JSON.stringify([
      { id: 'SKU-3', name: 'تلفزيون سامسونج ٥٥ بوصة', price: 1999, quantity: 1, brand: 'سامسونج' },
      { id: 'SKU-4', name: 'Gift 🎁 Box — Édition Spéciale™', price: 25, quantity: 3 },
    ]),
  }));
});

test('PARITY: quotes, backslashes, CR/LF/tab in item fields', () => {
  const hostileNames = [
    'Samsung 55" TV', 'Cable A\\B', 'Line one\nLine two', 'Tab\there', 'CR\rReturn',
    '"""quote storm"""', 'a\\",\\"b',
  ];
  for (const name of hostileNames) {
    assertParity('hostile char: ' + JSON.stringify(name),
      templateInput({ itemsJsonRaw: JSON.stringify([{ id: '1', name, price: 1, quantity: 1 }]) }));
  }
});

test('PARITY: hostile JSON-looking strings never injected as sibling keys', () => {
  const hostilePayloads = [
    'x","injected_field":"OWNED', 'x"},"injected":{"a":"b',
    '{"a":1}', '[1,2,3]', '"}],"evil":[{"x":"y',
  ];
  for (const name of hostilePayloads) {
    assertParity('hostile JSON-looking: ' + name,
      templateInput({ itemsJsonRaw: JSON.stringify([{ id: '1', name, price: 1, quantity: 1 }]) }));
  }
});

test('PARITY: the exact bracket-wrapped breakout that defeated regex-only gating', () => {
  assertParity('bracket breakout', templateInput({ itemsJsonRaw: '[{"id":"1"}],"injected_field":["OWNED"]' }));
});

test('PARITY: malformed JSON fails closed identically on both implementations', () => {
  const malformed = ['{not valid json', '[{"id":1,}]', 'undefined', 'function(){}', 'not json at all'];
  for (const raw of malformed) {
    assertParity('malformed: ' + raw, templateInput({ itemsJsonRaw: raw }));
  }
});

test('PARITY: valid JSON that is not an array', () => {
  for (const raw of ['{"a":1}', '"just a string"', '42', 'true', 'null']) {
    assertParity('not array: ' + raw, templateInput({ itemsJsonRaw: raw }));
  }
});

test('PARITY: nested unexpected objects/arrays in scalar item fields', () => {
  assertParity('nested object', templateInput({
    itemsJsonRaw: JSON.stringify([{ id: '1', name: { evil: true }, price: 10, quantity: 1 }]),
  }));
  assertParity('nested array', templateInput({
    itemsJsonRaw: JSON.stringify([{ id: '1', name: ['a', 'b'], price: 10, quantity: 1 }]),
  }));
  assertParity('non-object entries', templateInput({
    itemsJsonRaw: JSON.stringify([
      { id: '1', name: 'Real', price: 5, quantity: 1 }, 'string', 42, null, ['x'],
      { id: '2', name: 'Real2', price: 8, quantity: 2 },
    ]),
  }));
});

test('PARITY: extra keys, including prototype-pollution-flavored ones', () => {
  assertParity('extra keys', templateInput({
    itemsJsonRaw: JSON.stringify([{
      id: '1', name: 'X', price: 1, quantity: 1,
      secretInternalField: 'nope', accessToken: 'leak',
    }]),
  }));
  const raw = '[{"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":true}},"id":"1","name":"X","price":1,"quantity":1}]';
  assertParity('proto-pollution-flavored', templateInput({ itemsJsonRaw: raw }));
});

test('PARITY: more than 100 items capped identically', () => {
  const items = Array.from({ length: 150 }, (_, i) => ({ id: 'SKU-' + i, name: 'Item ' + i, price: 1, quantity: 1 }));
  assertParity('150 items', templateInput({ itemsJsonRaw: JSON.stringify(items) }));
});

test('PARITY: strings longer than 500 characters truncated identically', () => {
  assertParity('long string', templateInput({
    itemsJsonRaw: JSON.stringify([{ id: '1', name: 'x'.repeat(2000), price: 1, quantity: 1 }]),
  }));
});

test('PARITY: aggregate output over 32KB trimmed identically', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: 'SKU-' + i, name: 'n'.repeat(500), price: 1, quantity: 1,
    brand: 'b'.repeat(500), category: 'c'.repeat(500), variant: 'v'.repeat(500),
  }));
  assertParity('oversized aggregate', templateInput({ itemsJsonRaw: JSON.stringify(items) }));
});

test('PARITY: numeric bounds — NaN, Infinity-shaped, negative quantity, absurd magnitude', () => {
  const cases = [
    { id: '1', price: '49.99', quantity: '3' },
    { id: '1', price: 'not-a-number', quantity: 'also-not' },
    { id: '1', price: -5, quantity: -3 },
    { id: '1', price: 1e9, quantity: 1e9 },
    { id: '1', price: { evil: true }, quantity: [1, 2] },
  ];
  for (const item of cases) {
    assertParity('numeric: ' + JSON.stringify(item), templateInput({ itemsJsonRaw: JSON.stringify([item]) }));
  }
});

test('PARITY: plaintext email/phone/names hash identically', () => {
  assertParity('plaintext PII', templateInput({
    emRaw: 'Buyer@Shop.SA', phRaw: '+966 50 000 0000', fnRaw: ' Ahmed ', lnRaw: 'AL-SAUD',
    ctRaw: 'Riyadh', stRaw: 'Makkah', zpRaw: '12345', countryRaw: 'SA',
  }));
});

test('PARITY: Arabic and emoji PII names hash identically', () => {
  assertParity('unicode PII', templateInput({ fnRaw: 'محمد', lnRaw: 'José 🙂 Peña' }));
});

test('PARITY: valid lowercase and uppercase SHA-256 pass through identically, never re-hashed', () => {
  const digest = crypto.createHash('sha256').update('buyer@shop.sa', 'utf8').digest('hex');
  assertParity('lowercase hash', templateInput({ emRaw: digest }));
  assertParity('uppercase hash', templateInput({ emRaw: digest.toUpperCase() }));
  assertParity('mixed-case hash', templateInput({ emRaw: digest.slice(0, 32) + digest.slice(32).toUpperCase() }));
});

test('PARITY: malformed 64-character non-hex values hash as plaintext identically', () => {
  assertParity('64-char non-hex', templateInput({ emRaw: 'g'.repeat(64) }));
  assertParity('63-char near-miss', templateInput({ emRaw: 'a'.repeat(63) }));
  assertParity('65-char near-miss', templateInput({ emRaw: 'a'.repeat(65) }));
});

test('PARITY: no double hashing across a sanitize -> sanitize round trip, identically', () => {
  const first = runSandboxedTemplate(templateInput({ emRaw: 'buyer@shop.sa' }));
  const second = runSandboxedTemplate(templateInput({ emRaw: first.pii.em }));
  assert.strictEqual(second.pii.em, first.pii.em);
  assertParity('round trip 1', templateInput({ emRaw: 'buyer@shop.sa' }));
  assertParity('round trip 2', templateInput({ emRaw: first.pii.em }));
});

test('PARITY: empty/missing values resolve identically (absent, not dropped)', () => {
  assertParity('all empty', templateInput());
  assertParity('unusable phone', templateInput({ phRaw: '----' }));
});

test('PARITY: deterministic output — both implementations are stable across repeated calls', () => {
  const input = templateInput({
    itemsJsonRaw: JSON.stringify([{ id: '1', name: 'Widget', price: 9.99, quantity: 2 }]),
    emRaw: 'buyer@shop.sa', phRaw: '+966500000000',
  });
  const nodeRuns = Array.from({ length: 3 }, () => JSON.stringify(reference.sanitize(input)));
  const tplRuns = Array.from({ length: 3 }, () => JSON.stringify(runSandboxedTemplate(input)));
  assert.ok(nodeRuns.every(r => r === nodeRuns[0]));
  assert.ok(tplRuns.every(r => r === tplRuns[0]));
  assert.strictEqual(tplRuns[0], nodeRuns[0]);
});

test('PARITY: no raw PII appears in the sandboxed template output, including on failure paths', () => {
  const rawSecrets = ['very.real.customer@example.com', '+966500000001', 'RealFirstName'];
  const failure = runSandboxedTemplate({
    itemsJsonRaw: '{not valid json',
    emRaw: rawSecrets[0], phRaw: rawSecrets[1], fnRaw: rawSecrets[2],
  });
  const dump = JSON.stringify(failure);
  for (const secret of rawSecrets) assert.ok(!dump.includes(secret));
  assert.strictEqual(failure.pii, null);

  const success = runSandboxedTemplate(templateInput({ emRaw: rawSecrets[0] }));
  assert.ok(!JSON.stringify(success).includes(rawSecrets[0]));
});

test('PARITY: exact forwardable/errorCode contract — the three-state distinction holds in the template too', () => {
  const fieldDropped = runSandboxedTemplate(templateInput({ phRaw: '----' }));
  assert.strictEqual(fieldDropped.forwardable, true);
  assert.deepStrictEqual(fieldDropped.droppedFields, ['ph']);

  const itemDropped = runSandboxedTemplate(templateInput({
    itemsJsonRaw: JSON.stringify(['not-an-object', { id: '1', name: 'X', price: 1, quantity: 1 }]),
  }));
  assert.strictEqual(itemDropped.forwardable, true);
  assert.ok(itemDropped.droppedFields.some(f => f.indexOf('items_entries:') === 0));

  const eventBlocked = runSandboxedTemplate(templateInput({ itemsJsonRaw: 'not json' }));
  assert.strictEqual(eventBlocked.forwardable, false);
  assert.strictEqual(eventBlocked.sanitizedItemsJson, null);
  assert.strictEqual(eventBlocked.pii, null);
  assert.strictEqual(eventBlocked.errorCode, 'ITEMS_INVALID_JSON');
});

// ─────────────────────────────────────────────────────────────────────────────
// Template file structural checks — not parity, but required before this
// file could ever be pasted into a real GTM template editor.
// ─────────────────────────────────────────────────────────────────────────────

test('TEMPLATE STRUCTURE: no regex literals in the sandboxed JS block', () => {
  // A regex literal starts with '/' where a value/argument is expected.
  // Cheap, deliberately conservative heuristic: look for '/' immediately
  // followed by a non-space, non-'/' character preceded by '(', ',', '=',
  // 'return', or start-of-line — the shapes a literal would appear in.
  const suspiciousRegexLiteral = /[(,=]\s*\/[^/\s*]/;
  const lines = sandboxedJs.split('\n');
  const offenders = lines.filter(l => suspiciousRegexLiteral.test(l) && l.indexOf('//') !== l.search(/\S/));
  assert.deepStrictEqual(offenders, [], 'possible regex literal found in sandboxed JS');
});

test('TEMPLATE STRUCTURE: no try/catch/throw/new in the sandboxed JS block', () => {
  assert.ok(!/\btry\s*\{/.test(sandboxedJs), 'try{} found — unsupported in sGTM sandbox');
  assert.ok(!/\bcatch\s*\(/.test(sandboxedJs), 'catch() found — unsupported in sGTM sandbox');
  assert.ok(!/\bthrow\b/.test(sandboxedJs), 'throw found — unsupported in sGTM sandbox');
  assert.ok(!/\bnew\s+[A-Z]/.test(sandboxedJs), 'new <Constructor> found — unsupported in sGTM sandbox');
});

test('TEMPLATE STRUCTURE: no network, cookie, or logging APIs referenced', () => {
  for (const forbidden of ["require('sendHttpRequest')", "require('setCookie')", "require('getCookieValues')",
    "require('logToConsole')", "require('getEventData')", "require('getAllEventData')"]) {
    assert.ok(!sandboxedJs.includes(forbidden), `forbidden API referenced: ${forbidden}`);
  }
});

test('TEMPLATE STRUCTURE: declares zero required permissions', () => {
  const permStart = tplSource.indexOf('___SERVER_PERMISSIONS___');
  const testStart = tplSource.indexOf('___TESTS___');
  const permBlock = tplSource.slice(permStart, testStart);
  const parsed = JSON.parse(permBlock.replace('___SERVER_PERMISSIONS___', '').trim());
  assert.deepStrictEqual(parsed, [], 'template must declare zero permissions per the current design hypothesis');
});

test('TEMPLATE STRUCTURE: ___INFO___ and ___TEMPLATE_PARAMETERS___ sections are valid JSON', () => {
  const infoStart = tplSource.indexOf('___INFO___') + '___INFO___'.length;
  const paramsStart = tplSource.indexOf('___TEMPLATE_PARAMETERS___');
  const info = JSON.parse(tplSource.slice(infoStart, paramsStart).trim());
  assert.strictEqual(info.containerContexts[0], 'SERVER');
  assert.strictEqual(info.type, 'MACRO', 'MACRO is the GTM internal type name for a Variable template — see deliverable note on confidence');

  const paramsEnd = tplSource.indexOf('___SANDBOXED_JS_FOR_SERVER___');
  const params = JSON.parse(tplSource.slice(paramsStart + '___TEMPLATE_PARAMETERS___'.length, paramsEnd).trim());
  const names = params.map(p => p.name);
  assert.deepStrictEqual(names.sort(), ['ctRaw', 'countryRaw', 'emRaw', 'fnRaw', 'itemsJsonRaw', 'lnRaw', 'phRaw', 'stRaw', 'zpRaw'].sort());
});

test('TEMPLATE STRUCTURE: ___TESTS___ section is valid JSON (GTM-native test DSL)', () => {
  const testsStart = tplSource.indexOf('___TESTS___') + '___TESTS___'.length;
  const testsBlock = tplSource.slice(testsStart).trim();
  const parsed = JSON.parse(testsBlock);
  assert.ok(Array.isArray(parsed) && parsed.length > 0);
  for (const t of parsed) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0);
    assert.ok(typeof t.code === 'string' && t.code.length > 0);
  }
});
