'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// server-sanitizer.js — pure, framework-independent sanitizer logic for
// items[] and PII fields.
//
// ── WHAT THIS MODULE IS ──────────────────────────────────────────────────────
// This is a REFERENCE IMPLEMENTATION / TEST ORACLE for the Blocker A "Option C"
// server-side defensive boundary — it is Step 1 of that design, not a deployed
// defense. It does NOT run inside server-side GTM: sGTM's Custom Template
// sandbox has its own isolated JavaScript environment with no `require('./local
// /file')` capability — only Google-provided sandboxed APIs (`require('JSON')`,
// `require('sha256Sync')`, etc.) are available there, not an arbitrary Node
// module system. This file cannot be imported by a GTM template as-is.
//
// Concretely, this module is:
//   (B) a reference implementation / test oracle for the future GTM sandbox
//       template — the source of truth for CORRECT BEHAVIOR, which the eventual
//       sandboxed-JS translation (Step 2/3, not started) must reproduce exactly.
// It is explicitly NOT (A) production runtime code securing sGTM today, and it
// is NOT currently (C) shared logic consumed by a preprocessing service — though
// if a Node-based preprocessing-service design is chosen instead of/alongside
// the GTM template, THIS file could be reused directly there, since a real
// Node service (unlike the sGTM sandbox) can `require()` local modules.
//
// UNTIL a behaviorally-equivalent sandboxed-JS translation is written, tested
// against shared fixtures/contract tests, and actually wired into a generated
// GTM container, sGTM provides ZERO protection from this design. Do not cite
// this module's existence as evidence that direct Measurement Protocol traffic,
// legacy containers, or non-web-container sources are protected — they are not,
// until Step 2/3 land and are integrated.
//
// This module has zero GTM API dependency, zero network I/O, and zero
// dependency on lib/gtm-config-builder.js — testable with plain `node --test`.
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const MAX_ITEMS = 100;
const MAX_STRING_LEN = 500;
const MAX_QUANTITY = 100000;
const MAX_PRICE = 10000000;        // 10,000,000 — generous but bounded commerce ceiling
const MAX_OUTPUT_BYTES = 32768;    // 32 KB hard ceiling on the serialized items payload

// Only these keys ever survive into a sanitized item. Anything else —
// including prototype-pollution-flavored keys like __proto__ or constructor —
// is silently absent from the output regardless of what the input contained,
// because the output is built key-by-key from this fixed list, never copied
// wholesale from the input. (Verified separately: JSON.parse creates a key
// literally named "__proto__" as a normal OWN enumerable property — it does
// NOT trigger prototype-setter behavior the way an object LITERAL would. This
// module additionally reads input via hasOwnProperty as defense-in-depth,
// so this guarantee does not rely on that JSON.parse behavior alone.)
const ALLOWED_ITEM_KEYS = Object.freeze(['id', 'name', 'price', 'quantity', 'brand', 'category', 'variant']);
const NUMERIC_ITEM_KEYS = Object.freeze(new Set(['price', 'quantity']));

// Case-insensitive 64-hex check — a value already in this shape is treated as
// a pre-hashed SHA-256 digest and passed through (lowercased), never re-hashed.
const HEX64 = /^[a-fA-F0-9]{64}$/;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function boundStr(v) {
  const s = String(v);
  return s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) : s;
}

// Generic finite-number coercion, exported for reuse/testing. Field-specific
// bounds (price/quantity) are enforced separately below — this helper alone
// does NOT reject negative or absurdly large values, only NaN/Infinity.
function toFiniteNumber(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// quantity: NaN/Infinity/non-numeric -> default (1). Non-positive -> default
// (1) — a purchase line item cannot have zero or negative quantity. Absurdly
// large values are clamped, not rejected outright, so a genuine bulk order
// still forwards (bounded) rather than vanishing.
function normalizeQuantity(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_QUANTITY);
}

// price: NaN/Infinity/non-numeric -> default (0). Negative values ARE allowed
// (refunds/discount line items are legitimate commerce data) but bounded in
// magnitude either direction, so neither a fabricated windfall nor a
// fabricated massive refund can pass through unbounded.
function normalizePrice(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return Math.max(n, -MAX_PRICE);
  return Math.min(n, MAX_PRICE);
}

// ─────────────────────────────────────────────────────────────────────────────
// items[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sanitizeItemsJson — parse, validate, whitelist, bound, and re-serialize a
 * raw items_json string.
 *
 * FAIL-CLOSED CONTRACT (deliberately explicit, not silent):
 *   - Absent input (no items_json at all) is a NORMAL, valid state:
 *     `{ ok: true, sanitizedItemsJson: '[]', errorCode: null }` — a
 *     legitimately empty cart.
 *   - Structurally invalid input (unparseable JSON, or valid JSON that is not
 *     an array) is a HARD FAILURE, clearly distinguishable from the above:
 *     `{ ok: false, sanitizedItemsJson: null, errorCode: 'ITEMS_INVALID_JSON'|'ITEMS_NOT_ARRAY' }`.
 *     `sanitizedItemsJson` is `null`, NOT `'[]'`, specifically so a malformed/
 *     hostile purchase can never be confused with, or silently forwarded as,
 *     a valid empty-cart purchase. A caller MUST check `ok` before using
 *     `sanitizedItemsJson` for anything.
 *   - Individual item ENTRIES that are malformed (not an object, or beyond the
 *     MAX_ITEMS cap) are dropped INDIVIDUALLY and reported via `droppedEntries`
 *     — this does NOT fail the whole array; `ok` stays true.
 *
 * @param {string|null|undefined} raw
 * @returns {{ok: boolean, sanitizedItemsJson: string|null, itemCount: number, droppedEntries: number, errorCode: string|null}}
 */
function sanitizeItemsJson(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, sanitizedItemsJson: '[]', itemCount: 0, droppedEntries: 0, errorCode: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    return { ok: false, sanitizedItemsJson: null, itemCount: 0, droppedEntries: 0, errorCode: 'ITEMS_INVALID_JSON' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, sanitizedItemsJson: null, itemCount: 0, droppedEntries: 0, errorCode: 'ITEMS_NOT_ARRAY' };
  }

  const out = [];
  let droppedEntries = 0;

  for (let i = 0; i < parsed.length; i++) {
    if (out.length >= MAX_ITEMS) {
      droppedEntries += (parsed.length - i);
      break;
    }
    const item = parsed[i];
    if (!isPlainObject(item)) {
      droppedEntries++;
      continue;
    }

    const clean = {};
    for (const key of ALLOWED_ITEM_KEYS) {
      if (!hasOwn(item, key)) continue;          // own-properties only, defense-in-depth
      const val = item[key];
      if (val === undefined || val === null) continue;
      if (key === 'quantity') {
        clean.quantity = normalizeQuantity(val);
      } else if (key === 'price') {
        clean.price = normalizePrice(val);
      } else {
        // A nested object/array in a scalar slot (e.g. name: {evil:true}) is
        // dropped for that one key rather than stringified into something
        // misleading — the rest of the item's valid keys still survive.
        if (typeof val === 'object') continue;
        clean[key] = boundStr(String(val));
      }
    }
    out.push(clean);
  }

  // Aggregate output-size ceiling: even within the MAX_ITEMS/MAX_STRING_LEN
  // per-field bounds, 100 items x 500-char strings across 5 string fields can
  // still compound to a large payload. Progressively drop trailing items
  // (not truncate mid-array) until the serialized output fits, rather than
  // let an unbounded-total payload through.
  let serialized = JSON.stringify(out);
  while (serialized.length > MAX_OUTPUT_BYTES && out.length > 0) {
    out.pop();
    droppedEntries++;
    serialized = JSON.stringify(out);
  }

  return {
    ok: true,
    sanitizedItemsJson: serialized,
    itemCount: out.length,
    droppedEntries,
    errorCode: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PII
// ─────────────────────────────────────────────────────────────────────────────

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Documented, deterministic normalization rules — one per field family.
function normalizeEmail(s)   { return s.trim().toLowerCase(); }
function normalizePhone(s)   { return s.replace(/[^0-9]/g, ''); }   // digits only; does NOT unify local vs. international formats — documented limitation, see tests
function normalizeGeneric(s) { return s.trim().toLowerCase(); }     // names, city, state, zip, country

const NORMALIZERS = {
  em: normalizeEmail, ph: normalizePhone, fn: normalizeGeneric, ln: normalizeGeneric,
  ct: normalizeGeneric, st: normalizeGeneric, zp: normalizeGeneric, country: normalizeGeneric,
};

/**
 * sanitizePiiField — normalize-then-hash a single PII value, or pass through
 * an already-hashed one unchanged.
 *
 * `dropped` is true ONLY when non-empty input existed but produced no usable
 * value after normalization (e.g. a phone number with zero digits) — never
 * for input that was simply absent, and never for input that hashed
 * successfully. This distinguishes "nothing was provided" (fine, not dropped)
 * from "something unsafe/unusable was provided and discarded" (reported).
 *
 * @param {string} field  one of 'em'|'ph'|'fn'|'ln'|'ct'|'st'|'zp'|'country'
 * @param {*} raw
 * @returns {{value: string, dropped: boolean}}
 */
function sanitizePiiField(field, raw) {
  if (raw === null || raw === undefined) return { value: '', dropped: false };
  const s = String(raw).trim();
  if (s === '') return { value: '', dropped: false };

  // Already a hex digest (any case) — passthrough, lowercased, NEVER re-hashed.
  if (HEX64.test(s)) return { value: s.toLowerCase(), dropped: false };

  const normalize = NORMALIZERS[field] || normalizeGeneric;
  const normalized = normalize(s);
  if (normalized === '') return { value: '', dropped: true }; // had input, nothing usable survived normalization

  return { value: sha256Hex(normalized), dropped: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined entry point
// ─────────────────────────────────────────────────────────────────────────────

const PII_FIELDS = Object.freeze(['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country']);

/**
 * sanitize — the single entry point a future GTM Custom Template would call.
 *
 * OUTPUT CONTRACT — READ BEFORE CONSUMING:
 *   `forwardable === false` means EXACTLY what it says: the whole event must
 *   not be sent to any destination. `sanitizedItemsJson` and `pii` are both
 *   `null` in that state — not an empty cart, not empty-string PII — `null`,
 *   specifically so nothing in this result can be mistaken for valid,
 *   forwardable data. A caller that ignores `forwardable` and tries to use
 *   `sanitizedItemsJson`/`pii` anyway gets `null`, not a plausible-looking
 *   fallback.
 *
 *   `forwardable === true` means the event is safe to forward AS A WHOLE, even
 *   though individual pieces may have been dropped along the way (a phone
 *   number that didn't normalize, an oversized cart trimmed to fit) — those
 *   are reported in `droppedFields` for visibility, but do not block the rest
 *   of the event.
 *
 * @param {object} input
 * @param {string} [input.itemsJsonRaw]
 * @param {string} [input.emRaw] @param {string} [input.phRaw]
 * @param {string} [input.fnRaw] @param {string} [input.lnRaw]
 * @param {string} [input.ctRaw] @param {string} [input.stRaw]
 * @param {string} [input.zpRaw] @param {string} [input.countryRaw]
 * @returns {{
 *   forwardable: boolean,
 *   sanitizedItemsJson: string|null,
 *   pii: {em:string, ph:string, fn:string, ln:string, ct:string, st:string, zp:string, country:string}|null,
 *   droppedFields: string[],
 *   errorCode: string|null,
 * }}
 */
function sanitize(input) {
  input = input || {};
  const itemsResult = sanitizeItemsJson(input.itemsJsonRaw);

  if (!itemsResult.ok) {
    // Hard failure: the WHOLE event is blocked, not just items[]. Nothing
    // computed here is exposed — PII is deliberately not even attempted,
    // so there is no risk of a caller cherry-picking a "safe-looking" hash
    // out of an otherwise-blocked result.
    return {
      forwardable: false,
      sanitizedItemsJson: null,
      pii: null,
      droppedFields: [],
      errorCode: itemsResult.errorCode,
    };
  }

  const pii = {};
  const droppedFields = [];
  for (const field of PII_FIELDS) {
    const { value, dropped } = sanitizePiiField(field, input[field + 'Raw']);
    pii[field] = value;
    if (dropped) droppedFields.push(field);
  }
  if (itemsResult.droppedEntries > 0) droppedFields.push('items_entries:' + itemsResult.droppedEntries);

  return {
    forwardable: true,
    sanitizedItemsJson: itemsResult.sanitizedItemsJson,
    pii,
    droppedFields,
    errorCode: null,
  };
}

/**
 * safeLogSummary — the ONLY logging-shaped view this module ever produces.
 * Aggregate counts and booleans only — never a raw input value, never a
 * hashed digest, never a sanitized item's field content. Intended use: a
 * future GTM template's (very sparing) diagnostic logToConsole call, if any,
 * should log this and nothing else.
 */
function safeLogSummary(result) {
  let itemCount = 0;
  if (result.sanitizedItemsJson) {
    try { itemCount = JSON.parse(result.sanitizedItemsJson).length; } catch (_) { /* defensive only */ }
  }
  return {
    forwardable: result.forwardable,
    errorCode: result.errorCode,
    itemCount,
    droppedFieldCount: result.droppedFields.length,
    piiFieldsPresent: result.pii ? Object.keys(result.pii).filter(k => result.pii[k] !== '').length : 0,
  };
}

module.exports = {
  sanitize,
  sanitizeItemsJson,
  sanitizePiiField,
  safeLogSummary,
  // exported for direct unit testing of the small helpers
  isPlainObject, boundStr, toFiniteNumber, normalizeQuantity, normalizePrice, sha256Hex,
  normalizeEmail, normalizePhone, normalizeGeneric,
  MAX_ITEMS, MAX_STRING_LEN, MAX_QUANTITY, MAX_PRICE, MAX_OUTPUT_BYTES, ALLOWED_ITEM_KEYS, HEX64,
};
