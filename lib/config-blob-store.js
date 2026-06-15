// ══════════════════════════════════════════════════════════════════════════════
// lib/config-blob-store.js  (Phase-1 tactical remediation)
// Stages large provisioning configs (serverConfigJson) in a PRIVATE GCS bucket so
// the Firestore job doc carries only a small { bucket, object } reference. The
// config can approach/exceed Firestore's 1 MB document limit once customTemplate
// definitions (Meta/TikTok/Snap CAPI sandboxed JS) are embedded.
//
// ⚠️  SECRET-BEARING: serverConfigJson embeds CAPI access tokens. The bucket MUST
//     be private, same-region, short-TTL, and access-logged (see infra/Terraform).
//
// No new dependency: firebase-admin (already a dep) bundles @google-cloud/storage.
// The Admin app + bucket handle come from firestore-service (single owner of the
// Admin app). Target bucket = PROVISIONING_BUCKET (must be co-located w/ Cloud Run).
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const firestoreService = require('../firestore-service');

const PREFIX = 'server-config';

function bucketName() { return (process.env.PROVISIONING_BUCKET || '').trim(); }

// True only when both Firestore (Admin app) and a target bucket are configured.
function isConfigured() {
  return !!bucketName() && firestoreService.isConfigured();
}

// ── Upload a config object as JSON. Returns a small reference for the job doc. ──
async function put(jobId, configObj) {
  if (!jobId) throw new Error('config-blob-store.put: jobId required');
  const bucket = firestoreService.getStorageBucket();          // throws if unconfigured
  const object = PREFIX + '/' + jobId + '.json';
  const file   = bucket.file(object);
  const data   = Buffer.from(JSON.stringify(configObj), 'utf8');
  await file.save(data, {
    contentType: 'application/json',
    resumable:   false,
    metadata: {
      cacheControl: 'no-store',
      metadata: { jobId: String(jobId), createdAt: String(Date.now()) },
    },
  });
  return { bucket: bucket.name, object };
}

// ── Download + parse a previously-staged config. Throws on missing/corrupt. ──
async function get(ref) {
  if (!ref || !ref.object) throw new Error('config-blob-store.get: invalid ref');
  const bucket = firestoreService.getStorageBucket(ref.bucket || undefined);
  const [buf]  = await bucket.file(ref.object).download();
  return JSON.parse(buf.toString('utf8'));
}

// ── Best-effort delete. Never throws on "already gone". ──
async function del(ref) {
  if (!ref || !ref.object) return;
  const bucket = firestoreService.getStorageBucket(ref.bucket || undefined);
  await bucket.file(ref.object).delete({ ignoreNotFound: true });
}

module.exports = { isConfigured, put, get, del };
