// ════════════════════════════════════════════════════════════════════════════
// tests/config-blob-store.integrity.test.js
//
// Unit tests for the PURE integrity gate of the staged server-config blob
// (sha256 checksum + schemaVersion guard). These run without GCS/Firestore — they
// exercise only the no-I/O helpers that put()/get() rely on, so a corrupt or
// tampered blob is provably rejected before it ever reaches GTM versions:import.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const store    = require('../lib/config-blob-store');

test('sha256 is deterministic, hex-64, and content-sensitive', () => {
  assert.equal(store.sha256('{"a":1}'), store.sha256('{"a":1}'));
  assert.match(store.sha256('{"a":1}'), /^[0-9a-f]{64}$/);
  assert.notEqual(store.sha256('{"a":1}'), store.sha256('{"a":2}'));
});

test('assertIntegrity passes when checksum + schema match', () => {
  const json = JSON.stringify({ containerVersion: { tag: [] } });
  const ref  = { sha256: store.sha256(json), schemaVersion: store.SCHEMA_VERSION };
  assert.doesNotThrow(() => store.assertIntegrity(json, ref));
});

test('assertIntegrity throws CHECKSUM_MISMATCH on a single tampered byte', () => {
  const json = JSON.stringify({ containerVersion: { tag: [] } });
  const ref  = { sha256: store.sha256(json) };
  assert.throws(
    () => store.assertIntegrity(json + ' ', ref),   // one byte different
    (e) => e.code === 'CHECKSUM_MISMATCH',
  );
});

test('assertIntegrity throws UNSUPPORTED_SCHEMA for a newer producer', () => {
  assert.throws(
    () => store.assertIntegrity('{}', { schemaVersion: store.SCHEMA_VERSION + 1 }),
    (e) => e.code === 'UNSUPPORTED_SCHEMA',
  );
});

test('assertIntegrity is a no-op for a legacy ref without integrity fields', () => {
  assert.doesNotThrow(() => store.assertIntegrity('{}', { object: 'server-config/x.json' }));
});
