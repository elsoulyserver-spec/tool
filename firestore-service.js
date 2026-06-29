// ══════════════════════════════════════════════════════════════════════════════
// firestore-service.js
// Firebase Admin wrapper for persisting managed-container records.
//
// Required env vars:
//   FIREBASE_SA_KEY_JSON  — Firebase Admin service account JSON (stringified).
//                           Can be the SAME file as GTM_SA_KEY_JSON if the
//                           service account has access to both APIs, OR a
//                           separate Firebase Admin SA from the Firebase Console
//                           (Project Settings → Service Accounts).
//
// Collection: `managed_containers`
//   documentId = gtm public id (e.g. "GTM-ABC123") for easy lookup
//   fields: see ContainerRecord below
// ══════════════════════════════════════════════════════════════════════════════

let admin = null;
try { admin = require('firebase-admin'); } catch (_) { /* lazy-handled below */ }

let _db           = null;
let _initError    = null;

function isConfigured() {
  return !!process.env.FIREBASE_SA_KEY_JSON && !!admin;
}

function init() {
  if (_db || _initError) return;
  if (!admin) {
    _initError = new Error('firebase-admin is not installed. Run `npm install firebase-admin`.');
    return;
  }
  const raw = process.env.FIREBASE_SA_KEY_JSON;
  if (!raw) {
    _initError = new Error('FIREBASE_SA_KEY_JSON is not set');
    return;
  }
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { _initError = new Error('FIREBASE_SA_KEY_JSON is not valid JSON: ' + e.message); return; }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId:  sa.project_id,
      });
    }
    _db = admin.firestore();
    // Tolerate undefined fields in writes. Provisioning results (job docs +
    // container records) can legitimately carry undefined keys — e.g. a GTM
    // versionId the API didn't return — and Firestore otherwise rejects the
    // ENTIRE write with "Cannot use undefined as a Firestore value". settings()
    // must run before any read/write and only once; this is that point.
    try { _db.settings({ ignoreUndefinedProperties: true }); } catch (_) { /* already configured */ }
  } catch (e) {
    _initError = e;
  }
}

function db() {
  init();
  if (_initError) throw _initError;
  return _db;
}

// ── Collection reference ─────────────────────────────────────────────────────
const COLLECTION = 'managed_containers';

// ── Container record schema (for documentation) ──────────────────────────────
// {
//   clientId:        string       // Firebase UID of the owner
//   clientEmail:     string
//   projectName:     string
//   domain:          string | null
//   cmsType:         string       // 'salla' | 'zid' | ...
//   platforms:       string[]     // ['meta','tiktok','ga4',...]
//   events:          string[]
//   pixelIds:        { meta?: string, tiktok?: string, ga4?: string, ... }
//   gtmAccountId:    string
//   gtmContainerId:  string       // numeric ID from GTM API
//   gtmPublicId:     string       // "GTM-XXXXXX" — also the document ID
//   gtmWorkspaceId:  string
//   gtmVersionId:    string
//   published:       boolean
//   createdAt:       Timestamp
//   updatedAt:       Timestamp
//   publishedAt:     Timestamp | null
//   status:          'active' | 'grace_period' | 'deleted'
//   snippetHead:     string
//   snippetBody:     string
// }

async function saveContainer(record) {
  if (!record.gtmPublicId) throw new Error('saveContainer: gtmPublicId is required');
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc = {
    ...record,
    createdAt: record.createdAt || now,
    updatedAt: now,
    status:    record.status    || 'active',
  };
  await db().collection(COLLECTION).doc(record.gtmPublicId).set(doc, { merge: true });
  return doc;
}

async function getContainer(gtmPublicId) {
  const snap = await db().collection(COLLECTION).doc(gtmPublicId).get();
  return snap.exists ? snap.data() : null;
}

async function listContainersByClient(clientId) {
  const qs = await db().collection(COLLECTION)
    .where('clientId', '==', clientId)
    .where('status',   '==', 'active')
    .get();
  const out = [];
  qs.forEach(d => out.push(d.data()));
  return out;
}

async function countActiveContainers(gtmAccountId) {
  let q = db().collection(COLLECTION).where('status', '==', 'active');
  if (gtmAccountId) q = q.where('gtmAccountId', '==', String(gtmAccountId));
  const qs = await q.count().get();
  return qs.data().count;
}

// Return per-account container counts for all accounts listed in env.
// GTM_ACCOUNT_IDS is a comma-separated list (includes GTM_ACCOUNT_ID as primary).
async function getAccountCapacityReport() {
  const primary = (process.env.GTM_ACCOUNT_ID || '').trim();
  const extras  = (process.env.GTM_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allIds  = Array.from(new Set([primary, ...extras].filter(Boolean)));
  if (!allIds.length) return [];
  const counts = await Promise.all(allIds.map(async id => {
    const count = await countActiveContainers(id);
    return {
      accountId: id,
      activeContainers: count,
      capacityPct: Math.round((count / 490) * 100),
      status: count >= 480 ? 'critical' : count >= 400 ? 'warning_high' : count >= 300 ? 'warning' : 'ok',
    };
  }));
  return counts;
}

async function markGracePeriod(gtmPublicId) {
  await db().collection(COLLECTION).doc(gtmPublicId).update({
    status:    'grace_period',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN helpers — update / delete a client document (bypasses security rules)
// Used by /api/admin/client/:uid endpoints, protected by ADMIN_TOKEN env var.
// ══════════════════════════════════════════════════════════════════════════════
async function updateClient(uid, fields) {
  const allowed = ['status', 'plan', 'name', 'country', 'whatsapp', 'job', 'projects_used', 'notes'];
  const update = {};
  Object.keys(fields || {}).forEach(k => {
    if (allowed.indexOf(k) !== -1 && fields[k] !== undefined && fields[k] !== null) {
      update[k] = fields[k];
    }
  });
  if (!Object.keys(update).length) throw new Error('no updatable fields provided');
  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db().collection('clients').doc(uid).set(update, { merge: true });
  return update;
}

async function deleteClient(uid) {
  await db().collection('clients').doc(uid).delete();
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN EXPORT — dump all clients + containers as plain JSON
// Used by /api/admin/export. Protected by ADMIN_TOKEN env var.
// ══════════════════════════════════════════════════════════════════════════════
async function exportAll() {
  const [clientsSnap, containersSnap] = await Promise.all([
    db().collection('clients').get(),
    db().collection(COLLECTION).get(),
  ]);
  const clients    = [];
  const containers = [];
  clientsSnap.forEach(d => clients.push({ id: d.id, ...d.data() }));
  containersSnap.forEach(d => containers.push({ id: d.id, ...d.data() }));
  return {
    exportedAt:     new Date().toISOString(),
    clientsCount:   clients.length,
    containersCount: containers.length,
    clients,
    containers,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE TRACKING CONFIG
// Collection: `ss_configs`
// Document ID: clientId (Firebase UID)
//
// Fields:
//   provider:         'stape' | 'gcloud' | 'selfhosted'
//   serverUrl:        string
//   platforms:        string[]   — ['meta','tiktok','snapchat','ga4','mixpanel']
//   encryptedTokens:  { meta?, tiktok?, snapchat?, ga4?, mixpanel? }
//                     each value = { ciphertext, iv, authTag } | null
//   stapeApiKey:      { ciphertext, iv, authTag } | null  — encrypted
//   stapeContainerId: string | null
//   createdAt:        Timestamp
//   updatedAt:        Timestamp
// ══════════════════════════════════════════════════════════════════════════════

const SS_COLLECTION = 'ss_configs';

async function saveSSConfig(clientId, config) {
  if (!clientId) throw new Error('saveSSConfig: clientId is required');
  const now = admin.firestore.FieldValue.serverTimestamp();
  const snap = await db().collection(SS_COLLECTION).doc(clientId).get();
  const doc = {
    // Core fields
    provider:         config.provider         || 'selfhosted',
    serverUrl:        config.serverUrl         || '',
    platforms:        config.platforms         || [],
    encryptedTokens:  config.encryptedTokens  || {},
    stapeApiKey:      config.stapeApiKey       || null,
    stapeContainerId: config.stapeContainerId  || null,
    // Extended client_server mode fields
    mode:                 config.mode                 || null,
    webContainerId:       config.webContainerId        || null,
    webPublicId:          config.webPublicId           || null,
    webWorkspaceId:       config.webWorkspaceId        || null,
    serverContainerId:    config.serverContainerId     || null,
    serverPublicId:       config.serverPublicId        || null,
    serverWorkspaceId:    config.serverWorkspaceId     || null,
    serverVersionId:      config.serverVersionId       || null,
    containerConfig:      config.containerConfig       || null,
    transportUrlWired:    config.transportUrlWired     || false,
    transportUrlWiredAt:  config.transportUrlWiredAt   || null,
    stapeAutoDeployed:    config.stapeAutoDeployed     || false,
    stapeDeployError:     config.stapeDeployError      || null,
    // New 6-step flow fields
    ga4MeasurementId:     config.ga4MeasurementId      || null,
    ga4Events:            Array.isArray(config.ga4Events)       ? config.ga4Events       : [],
    googleAdsEvents:      Array.isArray(config.googleAdsEvents) ? config.googleAdsEvents : [],
    ssEvents:             Array.isArray(config.ssEvents)        ? config.ssEvents        : [],
    updatedAt: now,
    createdAt: snap.exists ? snap.data().createdAt : now,
  };
  await db().collection(SS_COLLECTION).doc(clientId).set(doc);
  return doc;
}

async function getSSConfig(clientId) {
  if (!clientId) throw new Error('getSSConfig: clientId is required');
  const snap = await db().collection(SS_COLLECTION).doc(clientId).get();
  return snap.exists ? snap.data() : null;
}

// ── Public-safe SS config — redacts encrypted secrets ────────────────────────
// Same shape as getSSConfig() but never returns ciphertext or stape API key
// material. Encrypted-token slots become '***CONFIGURED***' (or null when
// empty), which is exactly what the tool.html UI expects to render
// "configured" badges. Use this from any code path that surfaces the config
// to the client — direct getSSConfig() should be reserved for server-side
// flows that actually need to decrypt (e.g. test-event with a real token).
async function getSSConfigPublic(clientId) {
  const cfg = await getSSConfig(clientId);
  if (!cfg) return null;
  const redacted = Object.assign({}, cfg);
  if (redacted.encryptedTokens) {
    const rt = {};
    Object.keys(redacted.encryptedTokens).forEach(function (k) {
      rt[k] = redacted.encryptedTokens[k] ? '***CONFIGURED***' : null;
    });
    redacted.encryptedTokens = rt;
  }
  if (redacted.stapeApiKey) redacted.stapeApiKey = '***CONFIGURED***';
  return redacted;
}

async function deleteSSConfig(clientId) {
  if (!clientId) throw new Error('deleteSSConfig: clientId is required');
  await db().collection(SS_COLLECTION).doc(clientId).delete();
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVISIONING JOBS  —  collection: `provisioning_jobs`
// Durable, cross-instance replacement for the in-memory managedJobs Map.
//
// WHY: container provisioning returns a jobId (202) and the client polls
// GET /api/managed/job/:id. With Cloud Run --max-instances>1 the poll lands on
// a random instance, so an in-memory Map 404s whenever the poll hits a different
// instance than the one that created the job. Firestore makes the job readable
// from ANY instance.
//
// documentId = jobId
// fields:     status, stage, clientId, result?, error?, progress?, ...
//             updatedAt   — server timestamp, written on every patch
//             expiresAt   — Timestamp; used by a Firestore TTL policy for cleanup
//
// ⚠️  ONE-TIME SETUP — enable automatic cleanup so finished jobs self-delete:
//     gcloud firestore fields ttls update expiresAt \
//       --collection-group=provisioning_jobs --enable-ttl
//     (or Firebase console → Firestore → TTL → add policy on `expiresAt`)
//     Without the policy, getJob() still treats expired docs as gone, but the
//     documents are not physically removed.
// ══════════════════════════════════════════════════════════════════════════════

const JOBS_COLLECTION = 'provisioning_jobs';
const JOB_TTL_MS      = 30 * 60 * 1000;   // 30 min — generous vs. 60-120s job runtime

// Upsert a partial patch onto a job document. merge:true preserves prior fields,
// matching the old `{ ...cur, ...patch }` Map semantics. Each write refreshes the
// TTL so a job that is still progressing is never pruned mid-flight.
async function saveJob(jobId, patch) {
  if (!jobId) throw new Error('saveJob: jobId is required');
  const now       = admin.firestore.FieldValue.serverTimestamp();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + JOB_TTL_MS);
  await db().collection(JOBS_COLLECTION).doc(jobId).set(
    { ...patch, updatedAt: now, expiresAt },
    { merge: true },
  );
}

// List jobs in status='pending' that have no heartbeatAt — these were created
// but never dispatched (process crashed before/during _dispatchProvisionJob).
// Only returns jobs created within the last `windowMs` to avoid re-dispatching
// ancient orphans from previous deployments.
async function listOrphanedPendingJobs(windowMs) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - (windowMs || 25 * 60 * 1000));
  const snap = await db().collection(JOBS_COLLECTION)
    .where('status', '==', 'pending')
    .where('createdAt', '>=', since)
    .limit(20)
    .get();
  const orphans = [];
  snap.docs.forEach(d => {
    const data = d.data();
    // Only recover jobs that have NEVER received a heartbeat — these are the
    // ones that were created but not dispatched.
    if (!data.heartbeatAt) {
      orphans.push({ jobId: d.id, ...data });
    }
  });
  return orphans;
}

// Scan for provisioning_jobs stuck in status=running with no heartbeat update
// in the last `thresholdMs` milliseconds. Marks them status=stalled and returns
// an array of their jobIds so the caller can emit metrics / restart them.
async function detectAndRecoverStalledJobs(thresholdMs) {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - (thresholdMs || 10 * 60 * 1000));
  const snap = await db().collection(JOBS_COLLECTION)
    .where('status', 'in', ['running', 'pending'])
    .where('heartbeatAt', '<', cutoff)
    .limit(50)
    .get();
  if (snap.empty) return [];
  const stalledIds = [];
  const batch = db().batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  snap.docs.forEach(d => {
    stalledIds.push(d.id);
    batch.update(d.ref, {
      status:    'stalled',
      stalledAt: now,
      updatedAt: now,
      stalledReason: 'no heartbeat for ' + Math.round((thresholdMs || 600000) / 60000) + ' min',
      retryable: true,
    });
  });
  await batch.commit();
  return stalledIds;
}

// Read a job document. Returns null when missing OR past its TTL (defensive —
// covers the window before the TTL policy physically deletes the doc).
async function getJob(jobId) {
  if (!jobId) throw new Error('getJob: jobId is required');
  const snap = await db().collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  const exp  = (data.expiresAt && typeof data.expiresAt.toMillis === 'function')
    ? data.expiresAt.toMillis() : 0;
  if (exp && Date.now() > exp) return null;
  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVISION AUDIT TRAIL  —  collection: `provision_audit`
// Durable, append-only record of every finished provision. UNLIKE
// provisioning_jobs this has NO expiresAt → it is never auto-pruned by the TTL
// policy, so it survives as a real audit log.
//
// Best-effort by contract: callers MUST treat a rejection as non-fatal (a failed
// audit must never fail a provision). NEVER pass secrets/tokens in `record`.
// ══════════════════════════════════════════════════════════════════════════════
const AUDIT_COLLECTION = 'provision_audit';

async function saveAudit(record) {
  const at  = admin.firestore.FieldValue.serverTimestamp();
  // Auto-id document, no expiresAt → permanent. ignoreUndefinedProperties (set in
  // init) tolerates any undefined fields in the record.
  const ref = await db().collection(AUDIT_COLLECTION).add({ ...record, at });
  return ref.id;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH — Firebase ID token verification
// Called by server.js auth middleware to authenticate /api/ss/* requests.
// Throws on:
//   - admin not initialised (FIREBASE_SA_KEY_JSON missing)
//   - token expired / revoked / signature mismatch / wrong project
// Returns the decoded token (DecodedIdToken) on success — { uid, email, ... }.
// ══════════════════════════════════════════════════════════════════════════════
async function verifyIdToken(idToken) {
  init();
  if (_initError) throw _initError;
  if (!admin) throw new Error('firebase-admin is not installed');
  if (!idToken || typeof idToken !== 'string') throw new Error('idToken is required');
  // checkRevoked = true makes admin re-fetch the user record and reject tokens
  // issued before signOut/password-change. Costs an extra Firestore read per
  // request but gives us proper revocation — acceptable for /api/ss/* volume.
  return await admin.auth().verifyIdToken(idToken, true);
}

// ══════════════════════════════════════════════════════════════════════════════
// STORAGE — provisioning config blob bucket (used by lib/config-blob-store.js)
// Reuses the same Admin app (firebase-admin bundles @google-cloud/storage → no
// new dependency). Bucket name comes from PROVISIONING_BUCKET and MUST be a
// private, same-region bucket (the staged blobs are secret-bearing).
// ══════════════════════════════════════════════════════════════════════════════
function getStorageBucket(name) {
  init();
  if (_initError) throw _initError;
  if (!admin) throw new Error('firebase-admin is not installed');
  const b = (name || process.env.PROVISIONING_BUCKET || '').trim();
  if (!b) throw new Error('PROVISIONING_BUCKET is not set');
  return admin.storage().bucket(b);
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT PROFILE  —  collection: `clients`
// Reads a single client document and the Firebase Auth user record.
// updateClientProfile allows the mutable subset of fields (name, company,
// timezone, status) — the rest are controlled by admin-only paths.
// ══════════════════════════════════════════════════════════════════════════════

async function getClient(uid) {
  if (!uid) throw new Error('getClient: uid is required');
  const snap = await db().collection('clients').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getAuthUser(uid) {
  init();
  if (_initError) throw _initError;
  if (!admin) throw new Error('firebase-admin is not installed');
  try {
    return await admin.auth().getUser(uid);
  } catch (e) {
    if (e.code === 'auth/user-not-found') return null;
    throw e;
  }
}

async function updateClientProfile(uid, fields) {
  const allowed = ['name', 'company', 'timezone', 'status', 'notes'];
  const update = {};
  Object.keys(fields || {}).forEach(k => {
    if (allowed.indexOf(k) !== -1 && fields[k] !== undefined) {
      update[k] = fields[k];
    }
  });
  if (!Object.keys(update).length) throw new Error('no updatable fields provided');
  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db().collection('clients').doc(uid).set(update, { merge: true });
  return update;
}

// ══════════════════════════════════════════════════════════════════════════════
// API KEYS  —  collection: `api_keys`
// Document ID = keyId (12 hex chars, embedded in key: eas_{keyId}_{secret})
// Enables O(1) lookup — parse keyId from raw key, fetch doc directly.
// ══════════════════════════════════════════════════════════════════════════════

async function saveApiKey(keyId, data) {
  if (!keyId) throw new Error('saveApiKey: keyId is required');
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db().collection('api_keys').doc(keyId).set({
    ...data,
    createdAt: now,
    updatedAt: now,
  });
}

async function getApiKey(keyId) {
  if (!keyId) throw new Error('getApiKey: keyId is required');
  const snap = await db().collection('api_keys').doc(keyId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function listApiKeysByClient(clientId) {
  if (!clientId) throw new Error('listApiKeysByClient: clientId is required');
  const qs = await db().collection('api_keys')
    .where('clientId', '==', clientId)
    .where('status',   '==', 'active')
    .orderBy('createdAt', 'desc')
    .get();
  const out = [];
  qs.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

async function revokeApiKey(keyId) {
  if (!keyId) throw new Error('revokeApiKey: keyId is required');
  await db().collection('api_keys').doc(keyId).update({
    status:    'revoked',
    revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function touchApiKeyLastUsed(keyId) {
  if (!keyId) return;
  // best-effort — non-fatal if it fails
  try {
    await db().collection('api_keys').doc(keyId).update({
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS  —  collection: `audit_logs`
// Append-only. Diffs only (not full snapshots). Actor email as HMAC hash.
// IP purged after 90 days (ipPurgeAfter field, enforced at read time by API).
// ══════════════════════════════════════════════════════════════════════════════

async function saveAuditLog(record) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ipPurgeAfter = admin.firestore.Timestamp.fromMillis(
    Date.now() + 90 * 24 * 60 * 60 * 1000
  );
  const ref = await db().collection('audit_logs').add({
    ...record,
    occurredAt:    now,
    ipPurgeAfter,
  });
  return ref.id;
}

async function queryAuditLogs(clientId, { limit = 50, before } = {}) {
  if (!clientId) throw new Error('queryAuditLogs: clientId is required');
  let q = db().collection('audit_logs')
    .where('clientId', '==', clientId)
    .orderBy('occurredAt', 'desc');
  if (before) {
    const beforeTs = admin.firestore.Timestamp.fromDate(new Date(before));
    q = q.startAfter(beforeTs);
  }
  q = q.limit(Math.min(limit, 200));
  const qs = await q.get();
  const now = Date.now();
  const out = [];
  qs.forEach(d => {
    const data = d.data();
    // Purge IP from response if past retention window
    const purgeAt = data.ipPurgeAfter && data.ipPurgeAfter.toMillis
      ? data.ipPurgeAfter.toMillis() : 0;
    if (purgeAt && now > purgeAt) data.ipAddress = null;
    out.push({ id: d.id, ...data });
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVITY TIMELINE  —  collection: `activity_timeline`
// Append-only. dedupeKey prevents duplicate milestone entries within 1 hour.
// ══════════════════════════════════════════════════════════════════════════════

async function saveTimelineEvent(record) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = await db().collection('activity_timeline').add({
    ...record,
    occurredAt: now,
  });
  return ref.id;
}

async function findRecentTimelineEvent(clientId, eventType, dedupeKey, windowMs) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - windowMs);
  const qs = await db().collection('activity_timeline')
    .where('clientId',  '==', clientId)
    .where('eventType', '==', eventType)
    .where('dedupeKey', '==', dedupeKey)
    .where('occurredAt', '>=', since)
    .limit(1)
    .get();
  if (qs.empty) return null;
  const d = qs.docs[0];
  return { id: d.id, ...d.data() };
}

async function queryTimeline(clientId, { limit = 50, before, eventType } = {}) {
  if (!clientId) throw new Error('queryTimeline: clientId is required');
  let q = db().collection('activity_timeline')
    .where('clientId', '==', clientId);
  if (eventType) q = q.where('eventType', '==', eventType);
  q = q.orderBy('occurredAt', 'desc');
  if (before) {
    const beforeTs = admin.firestore.Timestamp.fromDate(new Date(before));
    q = q.startAfter(beforeTs);
  }
  q = q.limit(Math.min(limit, 200));
  const qs = await q.get();
  const out = [];
  qs.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH CACHE  —  collection: `client_health_cache`
// Document ID = clientId. Computed by the health-eval job (Phase 2).
// Phase 1 reads it (may be absent → unknown state).
// ══════════════════════════════════════════════════════════════════════════════

async function getHealthCache(clientId) {
  if (!clientId) throw new Error('getHealthCache: clientId is required');
  const snap = await db().collection('client_health_cache').doc(clientId).get();
  return snap.exists ? snap.data() : null;
}

async function saveHealthCache(clientId, data) {
  if (!clientId) throw new Error('saveHealthCache: clientId is required');
  await db().collection('client_health_cache').doc(clientId).set({
    ...data,
    computedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PLATFORM HEALTH  —  collection: `platform_health`
// Document ID = platform name (e.g. 'meta', 'ga4', 'tiktok').
// Status: 'operational' | 'degraded' | 'outage'.
// ══════════════════════════════════════════════════════════════════════════════

async function getPlatformHealth() {
  const qs = await db().collection('platform_health').get();
  const out = {};
  qs.forEach(d => { out[d.id] = d.data(); });
  return out;
}

async function setPlatformHealth(platform, data) {
  if (!platform) throw new Error('setPlatformHealth: platform is required');
  await db().collection('platform_health').doc(platform).set({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT TYPE LAST SEEN  —  collection: `event_type_last_seen`
// Document ID = `{clientId}_{eventName}`. Written by the sGTM beacon endpoint.
// Used by Phase 2 diagnostic rules to detect missing events without a raw event store.
// ══════════════════════════════════════════════════════════════════════════════

async function upsertEventTypeLastSeen(clientId, eventName) {
  if (!clientId || !eventName) throw new Error('upsertEventTypeLastSeen: clientId and eventName are required');
  const docId = `${clientId}_${eventName}`;
  await db().collection('event_type_last_seen').doc(docId).set({
    clientId,
    eventName,
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVE CLIENTS  —  collection: `clients`
// Paginated list for the health-eval job. Returns QueryDocumentSnapshot[] so
// the caller can pass the last doc to startAfter() for cursor-based pagination.
// Requires composite index: clients (status ASC, createdAt ASC).
// ══════════════════════════════════════════════════════════════════════════════

async function listActiveClients(startAfterDoc, limit) {
  let q = db().collection('clients')
    .where('status', 'in', ['active', 'trial'])
    .orderBy('createdAt', 'asc')
    .limit(Math.min(limit || 100, 200));
  if (startAfterDoc) q = q.startAfter(startAfterDoc);
  const snap = await q.get();
  return snap.docs;
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT TYPE LAST SEEN — point-read all 8 known GA4 events for one client.
// Uses deterministic doc IDs ({clientId}_{eventName}) — 8 parallel point reads
// rather than a query, so no composite index is needed.
// ══════════════════════════════════════════════════════════════════════════════

const BEACON_EVENTS = [
  'page_view', 'view_item', 'add_to_cart', 'begin_checkout',
  'purchase', 'generate_lead', 'sign_up', 'search',
];

async function listEventTypeLastSeen(clientId) {
  if (!clientId) throw new Error('listEventTypeLastSeen: clientId is required');
  const snaps = await Promise.all(
    BEACON_EVENTS.map(ev =>
      db().collection('event_type_last_seen').doc(`${clientId}_${ev}`).get(),
    ),
  );
  return snaps
    .filter(s => s.exists)
    .map(s => ({ eventName: s.data().eventName, lastSeenAt: s.data().lastSeenAt || null }));
}

// ══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC RESULTS  —  collection: `diagnostic_results`
// Document ID = clientId. Written by health-eval job, read by /diagnostics API.
// ══════════════════════════════════════════════════════════════════════════════

async function saveDiagnosticResult(clientId, data) {
  if (!clientId) throw new Error('saveDiagnosticResult: clientId is required');
  await db().collection('diagnostic_results').doc(clientId).set({
    ...data,
    clientId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function getDiagnosticResult(clientId) {
  if (!clientId) throw new Error('getDiagnosticResult: clientId is required');
  const snap = await db().collection('diagnostic_results').doc(clientId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH JOB LOCK  —  collection: `health_job_lock`
// Single doc ('singleton') coordinates the health-eval job across instances.
// Heartbeat-based: acquirer must call extendHealthJobLock() every 5 minutes.
// Transaction on acquire makes the check-then-write atomic.
// ══════════════════════════════════════════════════════════════════════════════

const _LOCK_INITIAL_TTL_MS = 25 * 60 * 1000;

async function acquireHealthJobLock(ownerId) {
  const lockRef = db().collection('health_job_lock').doc('singleton');
  return db().runTransaction(async tx => {
    const snap = await tx.get(lockRef);
    const now  = Date.now();
    if (snap.exists) {
      const until = snap.data().lockedUntil;
      if (until && until.toMillis() > now) return false;
    }
    tx.set(lockRef, {
      ownerId,
      lockedUntil: admin.firestore.Timestamp.fromMillis(now + _LOCK_INITIAL_TTL_MS),
      lockedAt:    admin.firestore.FieldValue.serverTimestamp(),
      heartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
}

async function extendHealthJobLock(extendMs) {
  await db().collection('health_job_lock').doc('singleton').update({
    lockedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + extendMs),
    heartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function releaseHealthJobLock() {
  await db().collection('health_job_lock').doc('singleton').delete();
}

// ── Dead Letter Queue (Firestore-backed) ─────────────────────────────────────
// Collection: dlq_events
// Each document represents one failed CAPI send awaiting retry.
// TTL field: expiresAt — set a Firestore TTL policy on this field.
// Status values: 'pending' | 'retrying' | 'retried' | 'exhausted' | 'dropped'
const DLQ_COLLECTION = 'dlq_events';
const DLQ_TTL_MS     = 72 * 60 * 60 * 1000; // 72 hours — max retry window

async function saveDlqEvent(doc) {
  const ref = db().collection(DLQ_COLLECTION).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    ...doc,
    status:      doc.status      || 'pending',
    retryCount:  doc.retryCount  || 0,
    nextRetryAt: doc.nextRetryAt || admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 1000),
    createdAt:   now,
    updatedAt:   now,
    expiresAt:   admin.firestore.Timestamp.fromMillis(Date.now() + DLQ_TTL_MS),
  });
  return ref.id;
}

// Fetch up to `limit` pending events whose nextRetryAt <= now.
async function listPendingDlqEvents(limit) {
  const now  = admin.firestore.Timestamp.fromMillis(Date.now());
  const snap = await db().collection(DLQ_COLLECTION)
    .where('status', '==', 'pending')
    .where('nextRetryAt', '<=', now)
    .orderBy('nextRetryAt', 'asc')
    .limit(limit || 50)
    .get();
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

// Atomically claim a pending DLQ event for processing.
// Uses a Firestore transaction to flip status pending→retrying only when
// status is still 'pending'. Returns true if this worker won the claim,
// false if another instance already claimed it (concurrent race).
async function claimDlqEvent(docId) {
  const ref = db().collection(DLQ_COLLECTION).doc(docId);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    if (snap.data().status !== 'pending') return false;
    tx.update(ref, {
      status:    'retrying',
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
}

// Patch a DLQ event document (used by retry worker to update status/retryCount).
async function updateDlqEvent(docId, patch) {
  await db().collection(DLQ_COLLECTION).doc(docId).update({
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Return queue depth and oldest pending event age for observability.
async function getDlqStats() {
  const now      = admin.firestore.Timestamp.fromMillis(Date.now());
  const [pending, oldest] = await Promise.all([
    db().collection(DLQ_COLLECTION).where('status', '==', 'pending').count().get(),
    db().collection(DLQ_COLLECTION)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get(),
  ]);
  const depth = pending.data().count;
  let oldestAgeMs = null;
  if (!oldest.empty) {
    const ts = oldest.docs[0].data().createdAt;
    oldestAgeMs = ts && ts.toMillis ? Date.now() - ts.toMillis() : null;
  }
  return { depth, oldestAgeMs };
}

async function deleteDlqEvent(docId) {
  await db().collection(DLQ_COLLECTION).doc(docId).delete();
}

module.exports = {
  isConfigured,
  BEACON_EVENTS,
  saveContainer,
  getContainer,
  listContainersByClient,
  countActiveContainers,
  getAccountCapacityReport,
  markGracePeriod,
  exportAll,
  updateClient,
  deleteClient,
  // Server-Side Tracking config
  saveSSConfig,
  getSSConfig,
  getSSConfigPublic,
  deleteSSConfig,
  // Provisioning jobs (durable, cross-instance)
  saveJob,
  getJob,
  listOrphanedPendingJobs,
  detectAndRecoverStalledJobs,
  // Permanent provision audit trail
  saveAudit,
  // Auth
  verifyIdToken,
  // Storage (provisioning config blobs)
  getStorageBucket,
  // Client profile
  getClient,
  getAuthUser,
  updateClientProfile,
  // API keys
  saveApiKey,
  getApiKey,
  listApiKeysByClient,
  revokeApiKey,
  touchApiKeyLastUsed,
  // Audit logs
  saveAuditLog,
  queryAuditLogs,
  // Activity timeline
  saveTimelineEvent,
  findRecentTimelineEvent,
  queryTimeline,
  // Health
  getHealthCache,
  saveHealthCache,
  getPlatformHealth,
  setPlatformHealth,
  // Beacon / event tracking
  upsertEventTypeLastSeen,
  // Phase 2 — health job data access
  listActiveClients,
  listEventTypeLastSeen,
  saveDiagnosticResult,
  getDiagnosticResult,
  // Phase 2 — health job lock (heartbeat-based)
  acquireHealthJobLock,
  extendHealthJobLock,
  releaseHealthJobLock,
  // Dead Letter Queue
  saveDlqEvent,
  listPendingDlqEvents,
  claimDlqEvent,
  updateDlqEvent,
  deleteDlqEvent,
  getDlqStats,
};
