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

async function countActiveContainers() {
  const qs = await db().collection(COLLECTION)
    .where('status', '==', 'active')
    .count().get();
  return qs.data().count;
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

module.exports = {
  isConfigured,
  saveContainer,
  getContainer,
  listContainersByClient,
  countActiveContainers,
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
  // Permanent provision audit trail
  saveAudit,
  // Auth
  verifyIdToken,
  // Storage (provisioning config blobs)
  getStorageBucket,
};
