// ══════════════════════════════════════════════════════════════════════════════
// lib/config-blob-store.js  (Phase-1 tactical remediation)
// Stages large provisioning configs (serverConfigJson) in a PRIVATE GCS bucket so
// the Firestore job doc carries only a small { bucket, object } reference. The
// config can approach/exceed Firestore's 1 MB document limit once customTemplate
// definitions (Meta/TikTok/Snap CAPI sandboxed JS) are embedded.
//
// ⚠️  SECRET-BEARING: serverConfigJson embeds CAPI access tokens. The bucket MUST
//     still be private, same-region, short-TTL, and access-logged (see
//     infra/Terraform) — envelope encryption below is defense-in-depth on top of
//     bucket ACLs, not a replacement for them.
//
// Envelope encryption (schemaVersion 2): the plaintext JSON is encrypted with the
// same AES-256-GCM vault (lib/crypto-vault.js, MASTER_ENCRYPTION_KEY) already used
// for stored CAPI tokens elsewhere, AAD-bound to the jobId so a ciphertext can't be
// silently replayed under a different job. If MASTER_ENCRYPTION_KEY isn't set,
// put() throws and the caller (server.js) falls back to the static GA4-only path —
// the same graceful degrade already used for every other failure mode here.
// schemaVersion 1 (legacy, unencrypted) blobs are still read as plaintext by get().
//
// No new dependency: firebase-admin (already a dep) bundles @google-cloud/storage.
// The Admin app + bucket handle come from firestore-service (single owner of the
// Admin app). Target bucket = PROVISIONING_BUCKET (must be co-located w/ Cloud Run).
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto      = require('crypto');
const cryptoVault = require('./crypto-vault');
const firestoreService = require('../firestore-service');

const PREFIX = 'server-config';

// Bump when the on-blob config envelope/shape changes so get() can refuse a blob
// written by a newer producer it doesn't understand (forward-compat guard).
// v2 = envelope-encrypted (AES-256-GCM); v1 = legacy plaintext JSON.
const SCHEMA_VERSION = 2;

function aad(jobId) { return 'config-blob:' + jobId; }

// sha256 of the exact bytes we upload — carried in the (small) Firestore job-doc
// ref and re-checked on download to catch corruption/tampering in transit or at
// rest (defense-in-depth on top of GCS's own CRC32C).
function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }

// Pure integrity gate (no I/O) so it is unit-testable without GCS. Throws on a
// checksum mismatch or an unsupported (newer) schema version.
function assertIntegrity(jsonStr, ref) {
  if (ref && ref.sha256) {
    const got = sha256(jsonStr);
    if (got !== ref.sha256) {
      const e = new Error('config-blob-store: checksum mismatch (expected ' +
        ref.sha256.slice(0, 12) + '…, got ' + got.slice(0, 12) + '…)');
      e.code = 'CHECKSUM_MISMATCH';
      throw e;
    }
  }
  if (ref && ref.schemaVersion != null && Number(ref.schemaVersion) > SCHEMA_VERSION) {
    const e = new Error('config-blob-store: unsupported schemaVersion ' +
      ref.schemaVersion + ' (this server understands up to ' + SCHEMA_VERSION + ')');
    e.code = 'UNSUPPORTED_SCHEMA';
    throw e;
  }
}

function bucketName() { return (process.env.PROVISIONING_BUCKET || '').trim(); }

// True only when both Firestore (Admin app) and a target bucket are configured.
function isConfigured() {
  return !!bucketName() && firestoreService.isConfigured();
}

// ── Upload a config object, encrypted at rest. Returns a small ref for the job doc. ──
// Throws (caller falls back to the static path) if MASTER_ENCRYPTION_KEY isn't set —
// same graceful-degrade contract as an unconfigured bucket or a failed upload.
async function put(jobId, configObj) {
  if (!jobId) throw new Error('config-blob-store.put: jobId required');
  const bucket   = firestoreService.getStorageBucket();          // throws if unconfigured
  const object   = PREFIX + '/' + jobId + '.json';
  const file     = bucket.file(object);
  const json     = JSON.stringify(configObj);
  const digest   = sha256(json);                                 // checksum of the PLAINTEXT
  const envelope = cryptoVault.encrypt(json, undefined, aad(jobId)); // throws if key unset
  const data     = Buffer.from(JSON.stringify(envelope), 'utf8');
  await file.save(data, {
    contentType: 'application/json',
    resumable:   false,
    metadata: {
      cacheControl: 'no-store',
      metadata: { jobId: String(jobId), createdAt: String(Date.now()),
                  sha256: digest, schemaVersion: String(SCHEMA_VERSION) },
    },
  });
  // The ref (small) goes into the Firestore job doc; it carries the integrity
  // fields and the jobId (needed to reconstruct the AAD) so get() can decrypt
  // and verify exactly what it downloaded.
  return { bucket: bucket.name, object, sha256: digest, schemaVersion: SCHEMA_VERSION, bytes: data.length, jobId: String(jobId) };
}

// ── Download + decrypt + parse a previously-staged config. Throws on missing/
// corrupt/tampered/undecryptable blobs. schemaVersion < 2 (legacy) blobs were
// staged before envelope encryption and are read back as plaintext JSON.
async function get(ref) {
  if (!ref || !ref.object) throw new Error('config-blob-store.get: invalid ref');
  const bucket = firestoreService.getStorageBucket(ref.bucket || undefined);
  const [buf]  = await bucket.file(ref.object).download();
  const raw    = buf.toString('utf8');

  let jsonStr;
  if (Number(ref.schemaVersion) >= 2) {
    const envelope = JSON.parse(raw);       // throws on corrupt envelope
    jsonStr = cryptoVault.decrypt(envelope, undefined, aad(ref.jobId)); // throws on tamper/wrong key/wrong jobId
  } else {
    jsonStr = raw;                          // legacy schemaVersion 1 — plaintext
  }

  assertIntegrity(jsonStr, ref);            // checksum + schema guards (throw on mismatch)
  return JSON.parse(jsonStr);               // throws on corrupt JSON
}

// ── Best-effort delete. Never throws on "already gone". ──
async function del(ref) {
  if (!ref || !ref.object) return;
  const bucket = firestoreService.getStorageBucket(ref.bucket || undefined);
  await bucket.file(ref.object).delete({ ignoreNotFound: true });
}

module.exports = { isConfigured, put, get, del, sha256, assertIntegrity, SCHEMA_VERSION };
