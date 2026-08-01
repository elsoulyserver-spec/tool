// ════════════════════════════════════════════════════════════════════════════
// tests/config-blob-store.encryption.test.js
//
// Covers the envelope-encryption behavior added to lib/config-blob-store.js:
// put() must upload ciphertext (never the plaintext serverConfigJson), and
// get() must decrypt + verify it back to the original object. GCS is faked
// with an in-memory bucket so this stays a fast, no-network unit test.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { test, after } = require('node:test');
const assert    = require('node:assert/strict');

process.env.MASTER_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.PROVISIONING_BUCKET   = 'fake-bucket';

const firestoreService = require('../firestore-service');

// ── Fake GCS bucket: enough surface for config-blob-store's put()/get()/del(). ──
function makeFakeBucket() {
  const files = new Map();
  return {
    name: 'fake-bucket',
    file(objectPath) {
      return {
        save: async (data) => { files.set(objectPath, Buffer.from(data)); },
        download: async () => {
          if (!files.has(objectPath)) throw new Error('fake bucket: object not found: ' + objectPath);
          return [files.get(objectPath)];
        },
        delete: async () => { files.delete(objectPath); },
      };
    },
    _raw(objectPath) { return files.get(objectPath); },
  };
}

const fakeBucket = makeFakeBucket();
const realGetStorageBucket = firestoreService.getStorageBucket;
const realIsConfigured     = firestoreService.isConfigured;
firestoreService.getStorageBucket = () => fakeBucket;
firestoreService.isConfigured     = () => true;

const store = require('../lib/config-blob-store');

after(() => {
  firestoreService.getStorageBucket = realGetStorageBucket;
  firestoreService.isConfigured     = realIsConfigured;
});

test('put() stores ciphertext, not the plaintext config, on the fake bucket', async () => {
  const configObj = { exportFormatVersion: 2, containerVersion: { tag: [{ name: 'Meta CAPI', accessToken: 'SECRET_TOKEN_123' }] } };
  const ref = await store.put('job_enc_1', configObj);

  const stored = fakeBucket._raw(ref.object).toString('utf8');
  assert.doesNotMatch(stored, /SECRET_TOKEN_123/, 'raw stored bytes must not contain the plaintext token');
  assert.doesNotMatch(stored, /Meta CAPI/, 'raw stored bytes must not contain plaintext field values');

  const envelope = JSON.parse(stored);
  assert.ok(envelope.ciphertext && envelope.iv && envelope.authTag, 'stored object must be an encryption envelope');
});

test('get() decrypts an envelope written by put() back to the original object', async () => {
  const configObj = { exportFormatVersion: 2, containerVersion: { tag: [{ name: 'TikTok EAPI' }] } };
  const ref = await store.put('job_enc_2', configObj);

  const recovered = await store.get(ref);
  assert.deepEqual(recovered, configObj);
});

test('get() rejects a blob whose jobId/AAD does not match the ref (tamper/reuse guard)', async () => {
  const configObj = { exportFormatVersion: 2, containerVersion: { tag: [] } };
  const ref = await store.put('job_enc_3', configObj);

  const wrongJobRef = Object.assign({}, ref, { jobId: 'job_enc_OTHER' });
  await assert.rejects(() => store.get(wrongJobRef));
});

test('get() still reads a legacy (schemaVersion 1, unencrypted) blob as plaintext JSON', async () => {
  const configObj = { exportFormatVersion: 2, containerVersion: { tag: [] } };
  const json = JSON.stringify(configObj);
  const object = 'server-config/job_legacy.json';
  await fakeBucket.file(object).save(Buffer.from(json, 'utf8'));

  const legacyRef = { bucket: 'fake-bucket', object, sha256: store.sha256(json), schemaVersion: 1 };
  const recovered = await store.get(legacyRef);
  assert.deepEqual(recovered, configObj);
});
