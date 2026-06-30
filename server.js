const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════════════════════════
// Zero-dependency .env loader — runs BEFORE any service modules that read
// process.env. Handles `KEY=value` lines, ignores comments/blank lines, does
// NOT evaluate variable expansion or quote stripping because our values are
// raw JSON payloads that include braces and colons.
// ══════════════════════════════════════════════════════════════════════════════
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    text.split(/\r?\n/).forEach(line => {
      if (!line || line.trimStart().startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 1) return;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1);
      // Strip matching surrounding quotes (but keep inner JSON braces intact)
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    });
  } catch (e) { console.warn('[.env] loader warning:', e.message); }
})();

// ── Puppeteer (optional — graceful fallback if not installed) ──────────────
const os = require('os');
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (_) {}
if (puppeteer) {
  const _memMb = os.totalmem() / 1024 / 1024;
  if (_memMb < 1024) {
    console.warn('[startup] WARNING: ' + Math.round(_memMb) + ' MB RAM detected. ' +
      'Puppeteer requires ≥1 GB. Deploy with --memory=1Gi on Cloud Run or expect OOM crashes.');
  }
}

// ── Pixel-scanner concurrency guard ────────────────────────────────────────
// Each Puppeteer scan launches a headless Chrome (~150-300 MB resident). Without
// a ceiling, concurrent /api/scan-url calls OOM-kill the Cloud Run instance.
// We reject with 429 once the cap is reached instead of piling up browsers.
// Tune via MAX_CONCURRENT_SCANS (keep it low — memory, not CPU, is the limit).
const MAX_CONCURRENT_SCANS = parseInt(process.env.MAX_CONCURRENT_SCANS || '3', 10);
let scanInFlight = 0;

// ── Managed GTM services (optional — endpoints return 503 if not set up) ──
const gtmService        = require('./gtm-service');
const firestoreService  = require('./firestore-service');
const gtmConfigBuilder  = require('./lib/gtm-config-builder');

// ── Server-Side Tracking services ─────────────────────────────────────────
const cryptoVault  = require('./lib/crypto-vault');
const rateLimiter  = require('./lib/ss-rate-limiter');
const { StapeProvider }      = require('./lib/providers/stape');
const { GoogleCloudProvider } = require('./lib/providers/gcloud');
const { SelfHostedProvider }  = require('./lib/providers/selfhosted');
// assertSafeUrl (providers/base) is no longer called directly from server.js —
// all user-URL paths now go through safeFetch / resolveHostname from ssrf-guard.
// Cloud Tasks client — offloads long provisioning jobs to a worker request so
// Cloud Run keeps CPU allocated for their full duration (see C3 / lib/cloud-tasks.js).
const cloudTasks              = require('./lib/cloud-tasks');
// Server-config blob store (Phase-1) — serverConfigJson is too large for a
// Firestore job doc (1 MB limit + embedded customTemplate JS), so it is staged
// in a private GCS bucket and the job carries only a small { bucket, object } ref.
const configBlobStore         = require('./lib/config-blob-store');
// Client Profile API services (Phase 1)
const apiKeyService   = require('./lib/api-key-service');
const auditService    = require('./lib/audit-service');
const { validateTargetUrl, safeFetch, resolveHostname, isBlockedIp } = require('./lib/ssrf-guard');
const timelineService = require('./lib/timeline-service');
const profileService  = require('./lib/profile-service');
// Health evaluation job (Phase 2)
const healthService   = require('./lib/health-service');
// DLQ retry worker — retries failed CAPI sends stored in Firestore dlq_events
const dlqWorker       = require('./lib/dlq-worker');
// In-process metrics counters — exposed via GET /api/v1/metrics
const metrics           = require('./lib/metrics');
// Cloud Monitoring push — flushes metrics to GCP every 60s (no-ops off-GCP)
const cloudMonitoring   = require('./lib/cloud-monitoring');
// Secret Manager wrapper — resolves MASTER_ENCRYPTION_KEY from GCP or ENV
const secretManager     = require('./lib/secret-manager');

// Beacon write deduplication — bucket-keyed per 5-minute window.
// Value is the bucket number; replaces itself naturally each period.
// Prune runs every 10 min and removes entries from the previous bucket.
const _beaconCache      = new Map();   // key: `${clientId}_${event}`, value: bucketNum
const _BEACON_BUCKET_MS = 5 * 60 * 1000;
setInterval(() => {
  const cur = Math.floor(Date.now() / _BEACON_BUCKET_MS);
  for (const [k, b] of _beaconCache) if (b < cur - 1) _beaconCache.delete(k);
}, 10 * 60 * 1000).unref();

// 64-char hex placeholder for timing-attack hardening in API key beacon auth.
// Must decode to 32 bytes — same length as a real keyHash — so timingSafeEqual
// always runs regardless of whether the keyId exists in Firestore.
const _BEACON_DUMMY_HASH = '0'.repeat(64);
// Beacon event allowlist — single source of truth shared with the health job's
// listEventTypeLastSeen. Prevents authenticated callers writing arbitrary doc IDs.
const _BEACON_VALID_EVENTS = new Set(firestoreService.BEACON_EVENTS);

// Self-contained concurrency limiter — inlined here (NOT a separate module)
// because the deploy ships only existing tracked files. Global FIFO + bounded
// queue for the in-process provisioning fallback so a burst can't fan out into
// hundreds of parallel GTM import sequences.
const provisionQueue = (function createProvisionQueueSingleton() {
  function createLimiter(max, queueMax) {
    const cap  = Math.max(1, parseInt(max, 10) || 1);
    const qMax = Math.max(0, parseInt(queueMax, 10) || 0);   // 0 = unlimited
    let   active = 0;
    const queue  = [];
    function pump() {
      while (active < cap && queue.length) {
        const job = queue.shift();           // FIFO
        active++;
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => { active--; pump(); });   // always free the slot + backfill
      }
    }
    function isFull() { return qMax > 0 && queue.length >= qMax; }
    function run(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
    }
    function stats() { return { active, queued: queue.length, max: cap, queueMax: qMax }; }
    return { run, stats, isFull };
  }
  return createLimiter(process.env.MANAGED_MAX_CONCURRENCY || '5', process.env.MANAGED_QUEUE_MAX || '1000');
})();

// ── Startup dependency check ──────────────────────────────────────────────
// Surface missing deps loudly. The providers do `try { require('axios') } catch{}`
// silently — so without this banner, /api/ss/* would just return 502 with no
// hint of what's wrong on the box.
(function depCheck() {
  const missing = [];
  try { require('axios');         } catch (_) { missing.push('axios'); }
  try { require('firebase-admin'); } catch (_) { missing.push('firebase-admin'); }
  if (missing.length) {
    console.warn('');
    console.warn('⚠️  STARTUP WARNING: missing npm dependencies:', missing.join(', '));
    console.warn('   /api/ss/* and /api/managed/* will return 5xx until you run:');
    console.warn('   $ npm install');
    console.warn('');
  }
})();

// ── Startup ENV check ─────────────────────────────────────────────────────
// The #1 deploy mistake: forgetting to set secrets on the host (Railway / Cloud
// Run) — .env is gitignored, so it is NEVER shipped. Without this banner the only
// symptom is a 503 "not configured" at request time, with nothing in the logs.
// We print exactly which vars are missing and which routes that breaks. Values
// are never logged.
(function envCheck() {
  const REQUIRED = [
    { key: 'GTM_SA_KEY_JSON',      breaks: '/api/managed/* and /api/ss/create-containers (GTM provisioning)' },
    { key: 'GTM_ACCOUNT_ID',       breaks: '/api/managed/* and /api/ss/create-containers (GTM provisioning)' },
    { key: 'FIREBASE_SA_KEY_JSON', breaks: '/api/ss/* auth + ALL job storage (jobs are Firestore-backed)' },
    { key: 'MASTER_ENCRYPTION_KEY',breaks: '/api/ss/save-config (token encryption)' },
    { key: 'API_KEY_SECRET',       breaks: '/api/v1/clients/:id/api-keys (API key generation + HMAC verification)' },
    { key: 'BEACON_SECRET',        breaks: '/api/v1/internal/beacon (sGTM event presence beacons — HMAC validation)' },
  ];
  const missing = REQUIRED.filter(r => !((process.env[r.key] || '').trim()));
  if (missing.length) {
    console.warn('');
    console.warn('⚠️  STARTUP WARNING: missing required environment variables:');
    missing.forEach(r => console.warn('   • ' + r.key.padEnd(22) + '→ breaks ' + r.breaks));
    console.warn('   On Railway: Service → Variables. On Cloud Run: --update-secrets / Secret Manager.');
    console.warn('   (.env is gitignored and is NOT deployed — host vars must be set explicitly.)');
    console.warn('');
  } else {
    console.log('✓ All required environment variables are set.');
  }
})();

// ── Secret Manager startup validation ────────────────────────────────────────
// Runs async but does NOT block the HTTP server from starting — a brief startup
// window where the key is sourced from ENV is acceptable. Logs source + version.
secretManager.validateAtStartup().catch(e => {
  console.error('[startup] FATAL: encryption key unavailable —', e.message);
  console.error('[startup] Set MASTER_ENCRYPTION_KEY or configure Secret Manager (SECRET_MANAGER_PROJECT + ENCRYPTION_KEY_SECRET)');
  // Don't process.exit() — the server still starts, /api/ss/save-config will
  // return 503 from ssRequireCrypto(). A hard exit would prevent healthz probes
  // from responding during GCP Secret Manager outages.
});

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ══════════════════════════════════════════════════════════════════════════════
// PHASE-1 FEATURE FLAG — import managed server containers via versions:import
// When MANAGED_IMPORT_SERVER_CONFIG=1, /api/managed/create-container stages the
// client-built serverConfigJson in GCS and the worker imports it full-fidelity
// (preserving client + customTemplate / CAPI). OFF (default) = unchanged static
// GA4-only path. Re-checked at worker time so flipping OFF rolls back instantly.
// ══════════════════════════════════════════════════════════════════════════════
function _serverConfigImportEnabled() {
  const v = (process.env.MANAGED_IMPORT_SERVER_CONFIG || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

// Most-recent managed server-config import outcome on THIS instance — surfaced
// (mode only) by /api/managed/health as lastImportMode. In-memory by design:
// zero I/O on the health path. Per-instance and resets on restart (documented);
// the durable record is the provision_audit collection.
let _lastManagedImport = null;

// Minimal structural guard before we stage a client-supplied config into our OWN
// GTM account (defense-in-depth; full validation is a later phase).
const SERVER_CONFIG_MAX_BYTES = 700 * 1024;   // stay well under the GCS/job limits
function _validateServerConfig(cfg) {
  if (!cfg || typeof cfg !== 'object')        return { ok: false, error: 'not an object' };
  if (cfg.exportFormatVersion === undefined)  return { ok: false, error: 'missing exportFormatVersion' };
  if (!cfg.containerVersion || typeof cfg.containerVersion !== 'object') {
    return { ok: false, error: 'missing containerVersion' };
  }
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(cfg)); }
  catch (_) { return { ok: false, error: 'not serializable' }; }
  if (bytes > SERVER_CONFIG_MAX_BYTES) return { ok: false, error: 'too large (' + bytes + ' bytes)' };
  return { ok: true, bytes };
}

// ══════════════════════════════════════════════════════════════════════════════
// MANAGED GTM JOBS — durable, cross-instance async job tracker (Firestore-backed)
// Container creation can take 60-120 seconds because of GTM write-quota pacing
// (~25 writes/min). That exceeds Cloudflare / Railway proxy timeouts, so we run
// the work in the background and let the client poll /api/managed/job/:id.
//
// Job state lives in Firestore (collection `provisioning_jobs`) — NOT in process
// memory — so that with Cloud Run --max-instances>1 a poll can be answered by
// ANY instance, not just the one that created the job. Cleanup is handled by a
// Firestore TTL policy on the `expiresAt` field (see firestore-service.js).
//
// ⚠️  CPU NOTE (Cloud Run): the background provisioning work runs AFTER the 202
//     response is sent. Cloud Run throttles instance CPU to ~0 once a request
//     completes, UNLESS the service is deployed with CPU always allocated
//     (--no-cpu-throttling) or the work is moved to a Cloud Tasks worker.
//     This Firestore swap fixes durability + cross-instance reads; it does NOT
//     by itself fix CPU throttling. See the C3 recommendation below.
// ══════════════════════════════════════════════════════════════════════════════

// Cryptographically-random job id — the poll route is unauthenticated, so ids
// must be unguessable (a job doc can carry container snippets / config).
function _newJobId() {
  return 'job_' + Date.now().toString(36) + '_' + crypto.randomBytes(9).toString('hex');
}

// Best-effort, per-instance throttle for high-frequency progress-only writes.
// Firestore soft-limits sustained writes to ~1/sec per document; the GTM import
// progress callback fires far faster than that. Correctness lives in Firestore —
// this Map only suppresses redundant cosmetic writes and is safe to lose on
// restart. Status/stage transitions are NEVER throttled.
const _jobProgressWriteAt = new Map();
const PROGRESS_WRITE_MIN_INTERVAL_MS = 2000;

// Persist a partial job patch to Firestore. Async + best-effort: a transient
// Firestore error is logged, not thrown, so it can never crash a background job.
// Pass { progressOnly: true } for cosmetic progress pings so they get throttled.
async function _setJob(id, patch, opts = {}) {
  if (opts.progressOnly) {
    const last = _jobProgressWriteAt.get(id) || 0;
    if (Date.now() - last < PROGRESS_WRITE_MIN_INTERVAL_MS) return;
    _jobProgressWriteAt.set(id, Date.now());
  }
  // heartbeatAt on every write — stall detector uses this field.
  // lastProgressAt only on non-terminal status transitions.
  const isTerminal = patch && (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'stalled');
  const augmented = {
    ...patch,
    heartbeatAt: new Date(),
    ...(isTerminal ? {} : { lastProgressAt: new Date() }),
  };
  try {
    await firestoreService.saveJob(id, augmented);
  } catch (e) {
    console.warn('[jobs] saveJob failed for ' + id + ':', e.message);
  }
  // Prevent unbounded growth of the progress-throttle map: a terminal job will
  // never emit another progress ping, so drop its entry once it finishes.
  if (patch && (patch.status === 'completed' || patch.status === 'failed')) {
    _jobProgressWriteAt.delete(id);
  }
}

// ── Dry-run helpers (C3 local testing) ──────────────────────────────────────
// Synthetic provisioning result so the enqueue → worker → poll flow can be
// exercised locally WITHOUT real GTM/Stape calls or credentials. Reached only
// when the route accepts dryRun (gated by ALLOW_DRY_RUN=1) — never in normal prod.
function _fakeProvision(mode, clientId) {
  const tag = (clientId || 'anon').slice(0, 8);
  const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  const webResult = {
    gtmAccountId: 'DRYRUN', gtmContainerId: '0', gtmPublicId: 'GTM-DRY' + rnd(),
    gtmWorkspaceId: '1', gtmVersionId: '1', published: false, publishedAt: null,
    importedTagCount: 0, importedTriggerCount: 0, importedVariableCount: 0,
    snippetHead: '<!-- dry-run snippet -->', snippetBody: '<!-- dry-run snippet -->',
    invited: false, inviteEmail: null, inviteError: null,
    containerName: 'DRY RUN — ' + tag,
  };
  const serverResult = mode === 'client_server' ? {
    gtmAccountId: 'DRYRUN', containerId: '1', publicId: 'GTM-DRYS' + rnd(),
    workspaceId: '1', versionId: '1', containerName: 'DRY RUN Server — ' + tag,
    containerConfig: null, importedTagCount: 0, importedTriggerCount: 0, importedVariableCount: 0,
  } : null;
  return { webResult, serverResult };
}

// Small delay so a polling client can actually observe the state transitions.
function _dryRunSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
// PROVISIONING JOB RUNNERS  (C3)
// The heavy GTM provisioning work, extracted out of the request handlers so it
// can run EITHER inside a Cloud Tasks worker request (Cloud Run keeps CPU on for
// the whole request) OR in-process as a fallback off-GCP. Each runner loads its
// input from the Firestore job doc, so the Cloud Tasks payload only needs
// { jobType, jobId } and stays well under the per-task size limit. Runners record
// their own terminal status (completed/failed) and do not throw on business errors.
//
// ⚠️  NOT idempotent — each run creates fresh GTM containers. The Cloud Tasks queue
//     MUST be created with --max-attempts=1 so a retry can't duplicate containers.
// ══════════════════════════════════════════════════════════════════════════════

async function _runManagedProvisionJob(jobId) {
  const job = await firestoreService.getJob(jobId);
  if (!job) throw new Error('run managed job: not found or expired: ' + jobId);
  const input = job.input || {};
  const { clientId, clientEmail, projectName, domain, cmsType,
          platforms, events, pixelIds, configJson, publishLive } = input;
  const mode = input.mode === 'client_server' ? 'client_server' : 'client';
  const dryRun = input.dryRun === true;

  // ── Audit / observability trackers ──────────────────────────────────────────
  // Declared in function scope so the catch can still record a failure audit with
  // whatever context we reached before throwing.
  const startedAtMs = Date.now();
  let importMode    = 'static_ga4_only';
  let auditWebId    = null;
  let auditServerId = null;
  let auditTags     = null;

  // Permanent, best-effort audit write (collection `provision_audit`, NO TTL).
  // Never throws — a failed audit must not fail the provision. Carries NO secrets.
  async function _writeManagedAudit(success, errorCode) {
    if (!success) metrics.incProvisioningFailed();
    if (dryRun) return;
    try {
      await firestoreService.saveAudit({
        jobId,
        clientId:      clientId || null,
        mode,
        importMode:    mode === 'client_server' ? importMode : null,
        capiDelivered: mode === 'client_server' && importMode === 'versions_import',
        schemaVersion: (input.serverConfigRef && input.serverConfigRef.schemaVersion) || null,
        blobBytes:     (input.serverConfigRef && input.serverConfigRef.bytes) || null,
        gtmPublicId:             auditWebId,
        serverContainerPublicId: auditServerId,
        importedTagCount:        auditTags,
        durationMs:    Date.now() - startedAtMs,
        success:       !!success,
        errorCode:     errorCode || null,
      });
    } catch (e) {
      console.warn('[managed/create][job ' + jobId + '] audit write failed (non-fatal):', e.message);
    }
  }

  try {
    // Dry-run: walk the state machine without touching GTM/Stape/saveContainer.
    if (dryRun) {
      await _setJob(jobId, { status: 'running', stage: 'gtm_provisioning', mode, dryRun: true });
      await _dryRunSleep(400);
      await _setJob(jobId, { stage: 'saving' });
      await _dryRunSleep(300);
      const { webResult, serverResult } = _fakeProvision(mode, clientId);
      await _setJob(jobId, {
        status: 'completed', stage: 'done',
        result: { ok: true, mode, dryRun: true, ...webResult, server: serverResult },
        finishedAt: Date.now(),
      });
      return;
    }

    await _setJob(jobId, { status: 'running', stage: 'capacity_check' });

    // 1. Capacity guard — GTM caps at 500 containers per account.
    // Multi-account: try primary first, fall back to extras if critical.
    const capacityReport = await firestoreService.getAccountCapacityReport();
    const primaryAccountId = (process.env.GTM_ACCOUNT_ID || '').trim();

    // Emit capacity alerts at thresholds
    capacityReport.forEach(acct => {
      if (acct.status === 'critical') {
        console.error('[capacity] CRITICAL: GTM account ' + acct.accountId +
          ' at ' + acct.activeContainers + '/490 containers — add GTM_ACCOUNT_IDS');
        metrics.incProvisioningFailed(); // count capacity failures
      } else if (acct.status === 'warning_high') {
        console.warn('[capacity] WARNING: GTM account ' + acct.accountId +
          ' at ' + acct.activeContainers + '/490 containers (>400) — plan new account');
      } else if (acct.status === 'warning') {
        console.warn('[capacity] INFO: GTM account ' + acct.accountId +
          ' at ' + acct.activeContainers + '/490 containers (>300)');
      }
    });

    // Find an account with capacity. Prefer primary; fall back to lowest-utilization extra.
    const available = capacityReport.filter(a => a.activeContainers < 480);
    if (!available.length) {
      await _setJob(jobId, {
        status: 'failed',
        stage:  'capacity_exceeded',
        error:  'All GTM accounts are at capacity (≥480 containers each)',
        hint:   'Add a new GTM account ID to GTM_ACCOUNT_IDS env var',
        httpStatus: 507,
        capacityReport,
      });
      return;
    }

    // Use primary if available, else lowest utilization
    const selectedAccount = available.find(a => a.accountId === primaryAccountId) ||
      available.sort((a, b) => a.activeContainers - b.activeContainers)[0];

    if (selectedAccount.accountId !== primaryAccountId) {
      console.log('[capacity] routing to secondary account ' + selectedAccount.accountId +
        ' (primary at capacity)');
      // Temporarily override env var for this job's GTM calls.
      // NOTE: This is process-level mutation — safe because provisioning jobs
      // run sequentially within provisionQueue, but requires care with concurrency.
      process.env.GTM_ACCOUNT_ID = selectedAccount.accountId;
    }

    const activeCount = selectedAccount.activeContainers;

    // 2. Provision via GTM API. Branch on mode:
    //    - 'client'        → existing single-container flow (publishes live).
    //    - 'client_server' → web + server containers; web is left
    //                        UNPUBLISHED so /api/ss/wire-transport can
    //                        patch the GA4 transport_url and republish
    //                        once the user confirms the sGTM URL.
    await _setJob(jobId, { stage: 'gtm_provisioning', mode });

    // C-P1: load the staged server config (if any) and pass it to the GTM layer
    // so the server container is imported full-fidelity via versions:import. The
    // flag is RE-CHECKED here, so flipping MANAGED_IMPORT_SERVER_CONFIG=0 rolls
    // back in-flight jobs to the static path. Any load failure degrades to static.
    let serverConfigJson = null;
    if (mode === 'client_server' && input.serverConfigRef && _serverConfigImportEnabled()) {
      // A staged ref means the operator INTENDED full CAPI for this container.
      // If we can't load/verify it (missing, corrupt JSON, checksum mismatch,
      // unsupported schema), FAIL the job — silently shipping a GA4-only
      // container here would hide a real operational error. The throw lands in
      // the worker's terminal-failure handler (and the finally cleans the blob).
      try {
        serverConfigJson = await configBlobStore.get(input.serverConfigRef);
      } catch (e) {
        const err = new Error('Server config import failed — the flag is ON and a config was staged, '
          + 'but the blob is unusable (' + e.message + '). Refusing to ship a GA4-only container.');
        err.code   = e.code || 'SERVER_CONFIG_UNUSABLE';
        err.status = 422;
        throw err;
      }
      importMode = 'versions_import';
      await _setJob(jobId, { serverConfigSource: 'versions_import' });
    }

    const provisionOpts = {
      projectName: projectName || `${clientEmail || 'client'} — ${cmsType || 'site'}`,
      domain,
      configJson,
      serverConfigJson,
      publishLive: mode === 'client_server' ? false : !!publishLive,
      inviteEmail: clientEmail || null,
      onProgress: (p) => { _setJob(jobId, { stage: 'gtm_provisioning', progress: p }, { progressOnly: true }); },
    };

    let webResult;
    let serverResult = null;
    if (mode === 'client_server') {
      const both    = await gtmService.provisionForClientWithServer(provisionOpts);
      webResult     = both.web;
      serverResult  = both.server;
    } else {
      webResult = await gtmService.provisionForClient(provisionOpts);
    }

    // 3. Persist web container to Firestore (existing collection)
    await _setJob(jobId, { stage: 'saving' });
    await firestoreService.saveContainer({
      clientId,
      clientEmail: clientEmail || null,
      projectName: projectName  || null,
      domain:      domain       || null,
      cmsType:     cmsType      || null,
      platforms:   platforms    || [],
      events:      events       || [],
      pixelIds:    pixelIds     || {},
      gtmAccountId:   webResult.gtmAccountId,
      gtmContainerId: webResult.gtmContainerId,
      gtmPublicId:    webResult.gtmPublicId,
      gtmWorkspaceId: webResult.gtmWorkspaceId,
      gtmVersionId:   webResult.gtmVersionId,
      published:      webResult.published,
      publishedAt:    webResult.publishedAt,
      snippetHead:    webResult.snippetHead,
      snippetBody:    webResult.snippetBody,
      containerName:  webResult.containerName || null,
      invited:        !!webResult.invited,
      inviteEmail:    webResult.inviteEmail || null,
      inviteError:    webResult.inviteError || null,
      importedCounts: {
        tags:      webResult.importedTagCount,
        triggers:  webResult.importedTriggerCount,
        variables: webResult.importedVariableCount,
      },
      mode,
      serverContainerPublicId: serverResult ? serverResult.publicId : null,
    });

    // 3b. Append a version record — source of truth is the Firestore client config;
    //     the GTM container is a compiled artifact derived from it.
    //     allocateVersionNumber uses a Firestore transaction → no race conditions.
    try {
      const vNum = await firestoreService.allocateVersionNumber(clientId);
      await firestoreService.saveVersion({
        clientId,
        version:        vNum,
        publishedBy:    clientEmail || clientId,
        containerId:    webResult.gtmContainerId,
        workspaceId:    webResult.gtmWorkspaceId,
        gtmVersionId:   webResult.gtmVersionId   || null,
        gtmPublicId:    webResult.gtmPublicId,
        deploymentType:  'publish',
        deploymentState: 'published',
        status:          'published',
        // configSnapshot: client config fields — NOT the generated GTM JSON.
        // Rollback re-derives the GTM artifact from this snapshot server-side.
        configSnapshot: {
          ga4MeasurementId: (pixelIds || {}).ga4 || null,
          sgtmUrl:          null,
          pixelIds:         pixelIds  || {},
          events:           events    || [],
          customEvents:     [],
          ecommPlatform:    cmsType   || '',
          platforms:        platforms || [],
          domain:           domain    || null,
          mode,
        },
        diffSummary: {
          added:    webResult.importedTagCount     || 0,
          modified: 0,
          removed:  0,
        },
      });
    } catch (verErr) {
      console.warn('[managed/create][job ' + jobId + '] version record write failed (non-fatal):', verErr.message);
    }

    // 4. client_server flow — auto-deploy to Stape + auto-wire transport_url.
    //    The Stape API key is a PLATFORM credential (set via STAPE_API_KEY env
    //    var) — clients never see or enter it. If the env var is missing or
    //    the deploy fails, we fall back to "manual mode": save the
    //    containerConfig blob in Firestore so the frontend can show it and
    //    /api/ss/wire-transport remains available for manual recovery.
    let stapeDeployed   = null;
    let stapeDeployErr  = null;
    let webRepublished  = false;

    if (mode === 'client_server' && serverResult) {
      const platformStapeKey = (process.env.STAPE_API_KEY || '').trim();
      const stapeRegion      = process.env.STAPE_REGION === 'eu' ? 'eu' : 'global';

      if (platformStapeKey && serverResult.containerConfig) {
        try {
          await _setJob(jobId, { stage: 'stape_deploy' });
          const stape = new StapeProvider({ stapeRegion });
          const dep = await stape.deployContainer({
            stapeApiKey:   platformStapeKey,
            containerName: serverResult.containerName ||
                           ('Easy Track sGTM — ' + (clientId || '').slice(0, 8)),
            gtmConfigBody: serverResult.containerConfig,
          });
          stapeDeployed = {
            serverUrl:   dep.serverUrl,
            containerId: dep.containerId,
            status:      dep.status,
            region:      stapeRegion,
          };

          // Wire the web container's GA4 tag → the deployed sGTM URL.
          // setGA4TransportUrl creates a new web container version + publishes
          // it, so this single call covers both wiring and going-live.
          if (dep.serverUrl) {
            await _setJob(jobId, { stage: 'wiring_transport_url' });
            try {
              await gtmService.setGA4TransportUrl(
                webResult.gtmContainerId,
                webResult.gtmWorkspaceId,
                dep.serverUrl,
              );
              webRepublished = true;
              // Refresh local snippet flags so the success UI shows LIVE.
              webResult.published   = true;
              webResult.publishedAt = new Date().toISOString();
            } catch (wireErr) {
              console.warn('[managed/create] wire transport_url failed:', wireErr.message);
              stapeDeployErr = 'Stape deployed but wiring failed: ' + wireErr.message;
            }
          }
        } catch (depErr) {
          console.warn('[managed/create] Stape deploy failed:', depErr.message);
          stapeDeployErr = depErr.message;
        }
      } else if (!platformStapeKey) {
        stapeDeployErr = 'STAPE_API_KEY env var is not set on the server — manual deploy required';
      }

      // Persist the SS config regardless of deploy outcome.
      try {
        const existingSs = await firestoreService.getSSConfig(clientId).catch(() => null);
        await firestoreService.saveSSConfig(clientId, {
          provider:         'stape',
          serverUrl:        (stapeDeployed && stapeDeployed.serverUrl) || '',
          platforms:        (existingSs && existingSs.platforms)        || (platforms || []),
          encryptedTokens:  (existingSs && existingSs.encryptedTokens)  || {},
          stapeApiKey:      null,
          stapeContainerId: stapeDeployed ? stapeDeployed.containerId : null,
          mode:                 'client_server',
          webContainerId:       webResult.gtmContainerId,
          webPublicId:          webResult.gtmPublicId,
          webWorkspaceId:       webResult.gtmWorkspaceId,
          serverContainerId:    serverResult.containerId,
          serverPublicId:       serverResult.publicId,
          serverWorkspaceId:    serverResult.workspaceId,
          serverVersionId:      serverResult.versionId,
          // Keep the blob ONLY when auto-deploy didn't succeed — saves
          // Firestore space and prevents stale blobs after redeploys.
          containerConfig:      stapeDeployed ? null : (serverResult.containerConfig || null),
          transportUrlWired:    webRepublished,
          transportUrlWiredAt:  webRepublished ? new Date() : null,
          stapeAutoDeployed:    !!stapeDeployed,
          stapeDeployError:     stapeDeployErr || null,
        });
      } catch (saveErr) {
        console.warn('[managed/create] saveSSConfig failed (non-fatal):', saveErr.message);
      }
    }

    // Attach deploy info to serverResult before returning to the client
    if (serverResult && (stapeDeployed || stapeDeployErr)) {
      serverResult.deployedUrl       = stapeDeployed ? stapeDeployed.serverUrl   : null;
      serverResult.stapeContainerId  = stapeDeployed ? stapeDeployed.containerId : null;
      serverResult.stapeStatus       = stapeDeployed ? stapeDeployed.status      : null;
      serverResult.transportUrlWired = webRepublished;
      serverResult.deployError       = stapeDeployErr || null;
      // For manual-fallback path: keep the blob in the response only if
      // auto-deploy didn't happen, so the frontend can still render it.
      if (stapeDeployed) delete serverResult.containerConfig;
    }

    // Capture audit/observability context from the successful provision.
    auditWebId    = webResult.gtmPublicId || null;
    auditServerId = serverResult ? (serverResult.publicId || null) : null;
    auditTags     = serverResult ? (serverResult.importedTagCount || 0) : (webResult.importedTagCount || 0);
    if (mode === 'client_server') {
      _lastManagedImport = { mode: importMode, capiDelivered: importMode === 'versions_import', at: Date.now() };
    }

    await _setJob(jobId, {
      status:     'completed',
      stage:      'done',
      result:     {
        ok: true,
        mode,
        ...webResult,
        server: serverResult,                  // null when mode=client
        // Did this container actually ship with full CAPI, or GA4-only? Lets the
        // caller/admin distinguish "import succeeded" from any fallback without
        // inspecting GTM. (versions_import here means GTM accepted it — gtmRequest
        // throws on any non-2xx, so reaching 'completed' implies acceptance.)
        serverConfigImport: mode === 'client_server' ? {
          mode:          importMode,                       // 'versions_import' | 'static_ga4_only'
          capiDelivered: importMode === 'versions_import',
          blobBytes:     (input.serverConfigRef && input.serverConfigRef.bytes)         || null,
          schemaVersion: (input.serverConfigRef && input.serverConfigRef.schemaVersion) || null,
        } : null,
      },
      finishedAt: Date.now(),
    });
    await _writeManagedAudit(true, null);
  } catch (e) {
    console.error('[managed/create][job ' + jobId + ']', e);
    await _setJob(jobId, {
      status:     'failed',
      stage:      'error',
      error:      e.message,
      details:    e.details || null,
      code:       e.code    || null,
      httpStatus: (e.status && e.status >= 400 && e.status < 600) ? e.status : 502,
      finishedAt: Date.now(),
    });
    await _writeManagedAudit(false, e.code || null);
  } finally {
    // C-P1: the staged server config is secret-bearing (embeds CAPI tokens) —
    // delete it as soon as provisioning reaches a terminal state. The bucket
    // lifecycle TTL is the backstop for any path that skips this.
    if (input && input.serverConfigRef) {
      try { await configBlobStore.del(input.serverConfigRef); }
      catch (e2) { console.warn('[managed/create][job ' + jobId + '] blob cleanup failed:', e2.message); }
    }
  }
}

async function _runSsProvisionJob(jobId) {
  const job = await firestoreService.getJob(jobId);
  if (!job) throw new Error('run ss job: not found or expired: ' + jobId);
  const input = job.input || {};
  const { clientId, email, projectName,
          ssEvents, ssPlatforms, ga4MeasurementId, ga4Events, googleAdsEvents } = input;
  const finalConfigJson = input.configJson ||
    { containerVersion: { variable: [], trigger: [], tag: [] } };
  const dryRun = input.dryRun === true;

  try {
    // Dry-run: walk the state machine without touching GTM/Stape/saveContainer.
    if (dryRun) {
      await _setJob(jobId, { status: 'running', stage: 'gtm_provisioning', mode: 'client_server', dryRun: true });
      await _dryRunSleep(400);
      await _setJob(jobId, { stage: 'saving' });
      await _dryRunSleep(300);
      const { webResult, serverResult } = _fakeProvision('client_server', clientId);
      await _setJob(jobId, {
        status: 'completed', stage: 'done',
        result: { ok: true, mode: 'client_server', dryRun: true, ...webResult, server: serverResult },
        finishedAt: Date.now(),
      });
      return;
    }

    await _setJob(jobId, { status: 'running', stage: 'gtm_provisioning', mode: 'client_server' });

    const both = await gtmService.provisionForClientWithServer({
      projectName: projectName || ((email || clientId.slice(0, 8)) + ' — SS Setup'),
      configJson:   finalConfigJson,
      publishLive:  false,
      inviteEmail:  email || null,
      onProgress:   (p) => { _setJob(jobId, { stage: 'gtm_provisioning', progress: p }, { progressOnly: true }); },
    });

    const { web, server } = both;
    await _setJob(jobId, { stage: 'saving' });

    // Persist web container record
    await firestoreService.saveContainer({
      clientId,
      clientEmail:    email || null,
      projectName:    projectName || null,
      platforms:      ssPlatforms || [],
      events:         ssEvents    || [],
      gtmAccountId:   web.gtmAccountId,
      gtmContainerId: web.gtmContainerId,
      gtmPublicId:    web.gtmPublicId,
      gtmWorkspaceId: web.gtmWorkspaceId,
      gtmVersionId:   web.gtmVersionId,
      published:      false,
      snippetHead:    web.snippetHead,
      snippetBody:    web.snippetBody,
      mode:           'client_server',
      serverContainerPublicId: server ? server.publicId : null,
    });

    // Persist SS config with step-1 results (no URL yet)
    try {
      const existing = await firestoreService.getSSConfig(clientId).catch(() => null);
      await firestoreService.saveSSConfig(clientId, {
        provider:           'pending',
        serverUrl:          '',
        platforms:          ssPlatforms   || [],
        encryptedTokens:    (existing && existing.encryptedTokens) || {},
        stapeApiKey:        null,
        stapeContainerId:   null,
        mode:               'client_server',
        webContainerId:     web.gtmContainerId,
        webPublicId:        web.gtmPublicId,
        webWorkspaceId:     web.gtmWorkspaceId,
        serverContainerId:  server ? server.containerId  : null,
        serverPublicId:     server ? server.publicId     : null,
        serverWorkspaceId:  server ? server.workspaceId  : null,
        serverVersionId:    server ? server.versionId    : null,
        containerConfig:    server ? (server.containerConfig || null) : null,
        transportUrlWired:  false,
        ga4MeasurementId:   ga4MeasurementId || null,
        ga4Events:          ga4Events        || [],
        googleAdsEvents:    googleAdsEvents  || [],
        ssEvents:           ssEvents         || [],
      });
    } catch (saveErr) {
      console.warn('[ss/create-containers] saveSSConfig failed (non-fatal):', saveErr.message);
    }

    await _setJob(jobId, {
      status:    'completed',
      stage:     'done',
      result:    { ok: true, mode: 'client_server', ...web, server },
      finishedAt: Date.now(),
    });
  } catch (e) {
    console.error('[ss/create-containers][job ' + jobId + ']', e);
    await _setJob(jobId, {
      status:    'failed',
      stage:     'error',
      error:     e.message,
      code:      e.code    || null,
      httpStatus: (e.status >= 400 && e.status < 600) ? e.status : 502,
      finishedAt: Date.now(),
    });
  }
}

// Dispatch a saved job to the worker. On Cloud Run (Cloud Tasks configured) this
// enqueues a task that POSTs the worker route as a fresh request, so CPU is
// allocated for the full job. Off-GCP (local / Railway) CPU is not throttled, so
// we run in-process. Either way the job doc already exists before this is called.
async function _dispatchProvisionJob(jobType, jobId) {
  if (cloudTasks.isConfigured()) {
    await cloudTasks.enqueueProvisionJob({ jobType, jobId });
    return;
  }
  // Bounded backpressure: refuse new work when the in-process queue is saturated
  // instead of growing it (and memory) without limit. Throwing here routes to the
  // request handler's catch, which marks the job failed, cleans any staged blob,
  // and returns 503.
  if (provisionQueue.isFull()) {
    const e = new Error('Provisioning queue is full (' + provisionQueue.stats().queued + ' waiting) — retry shortly');
    e.status = 503;
    e.code   = 'QUEUE_FULL';
    throw e;
  }
  const runner = jobType === 'ss' ? _runSsProvisionJob : _runManagedProvisionJob;
  // In-process fallback (local / Railway): cap global concurrency + FIFO-queue the
  // overflow so a burst can't fan out into hundreds of parallel GTM import
  // sequences. Fire-and-forget (the HTTP layer already returned 202 and the client
  // polls the job doc); the runner reads the feature flag at EXECUTION time, so a
  // still-queued job honors a mid-flight rollback. No job is dropped.
  provisionQueue.run(() => runner(jobId))
    .catch(err => console.error('[jobs] inline run failed for ' + jobId + ':', err));
}

// ── Startup queue recovery ───────────────────────────────────────────────────
// On process restart, scan Firestore for provisioning_jobs in status='pending'
// that have no heartbeatAt (i.e. they were created but never dispatched because
// the process crashed before or during enqueueing). Re-dispatch them once.
// Zombie guard: only recover jobs created in the last 25 minutes (the job TTL
// is 30 min, and a fresh worker is unlikely to see older orphans from a different
// deployment — those should be marked stalled by the stall detector instead).
async function _recoverPendingJobsOnStartup() {
  const admin = require('firebase-admin');
  const db    = require('./firestore-service');
  const cutoff = admin.firestore
    ? new Date(Date.now() - 25 * 60 * 1000)
    : null;

  // We don't have direct db() access here — use firestoreService internals
  // via a dedicated function added to firestore-service.
  const orphans = await firestoreService.listOrphanedPendingJobs(25 * 60 * 1000);
  if (!orphans.length) {
    console.log('[startup-recovery] no orphaned pending jobs found');
    return;
  }

  console.warn('[startup-recovery] found ' + orphans.length + ' orphaned pending job(s) — re-dispatching');
  for (const job of orphans) {
    try {
      // Mark as recovery attempt before dispatching to prevent duplicate recovery
      await firestoreService.saveJob(job.jobId, {
        recoveredAt: new Date(),
        recoveryAttempt: (job.recoveryAttempt || 0) + 1,
      });
      const jobType = job.jobType || 'managed';
      await _dispatchProvisionJob(jobType, job.jobId);
      console.log('[startup-recovery] re-dispatched job ' + job.jobId + ' type=' + jobType);
    } catch (e) {
      console.error('[startup-recovery] failed to re-dispatch job ' + job.jobId + ':', e.message);
      await firestoreService.saveJob(job.jobId, {
        status: 'failed',
        error:  'startup recovery re-dispatch failed: ' + e.message,
        finishedAt: Date.now(),
      }).catch(() => {});
    }
  }
}

// Shared-secret auth for the internal Cloud Tasks worker route. The public
// service runs --allow-unauthenticated, so Cloud Run does not verify the task's
// OIDC token for us — this header check is the enforced gate. INTERNAL_WORKER_SECRET
// must equal the value the enqueuer attaches as the X-Internal-Token header.
function _authorizeInternal(req, res) {
  const expected = process.env.INTERNAL_WORKER_SECRET;
  if (!expected) {
    sendJSON(res, 503, { error: 'Worker not configured (INTERNAL_WORKER_SECRET missing)' });
    return false;
  }
  const got = (req.headers['x-internal-token'] || '').trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { sendJSON(res, 401, { error: 'Unauthorized' }); return false; }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY HEADERS
// Central place for CSP + hardening headers applied to every response.
// Update CSP_DIRECTIVES whenever you add a new external provider/CDN/API.
// ══════════════════════════════════════════════════════════════════════════════
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    "'unsafe-inline'",                       // tool.html uses many onclick handlers + inline <script>
    "'unsafe-eval'",                         // Firebase SDK uses Function()/eval internally
    'https://www.gstatic.com',               // Firebase SDK
    'https://apis.google.com',               // Google OAuth
    'https://www.googletagmanager.com',      // GTM / GA4
    'https://www.google-analytics.com',
    'https://connect.facebook.net',          // Meta Pixel
    'https://sc-static.net',                 // Snapchat Pixel
    'https://static.ads-twitter.com',        // X / Twitter Pixel
    'https://analytics.tiktok.com',          // TikTok Pixel
    'https://snap.licdn.com',                // LinkedIn Insight
    'https://googleads.g.doubleclick.net',   // Google Ads
    'https://www.googleadservices.com',
    'https://cdnjs.cloudflare.com',          // Misc CDNs
  ],
  'style-src': [
    "'self'",
    "'unsafe-inline'",                       // inline styles are used throughout tool.html
    'https://fonts.googleapis.com',
  ],
  'font-src': [
    "'self'",
    'data:',
    'https://fonts.gstatic.com',
  ],
  'img-src': [
    "'self'",
    'data:',
    'blob:',
    'https:',                                // pixels and CMS logos come from many hosts
  ],
  'connect-src': [
    "'self'",
    // Firebase
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com',
    'https://firestore.googleapis.com',
    'https://firebaseinstallations.googleapis.com',
    'https://*.firebaseio.com',
    'wss://*.firebaseio.com',
    'https://*.firebaseapp.com',
    // Google APIs (GTM publish, OAuth)
    'https://tagmanager.googleapis.com',
    'https://www.googleapis.com',
    'https://oauth2.googleapis.com',
    // Fonts
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
    // Analytics endpoints
    'https://www.google-analytics.com',
    'https://region1.google-analytics.com',
    'https://analytics.google.com',
    // Project-owned
    'https://easy-track-excel-api-production.up.railway.app',
    // CORS proxies (used for CMS scan fallbacks)
    'https://api.allorigins.win',
    'https://corsproxy.io',
    'https://api.codetabs.com',
  ],
  'frame-src': [
    "'self'",
    'https://*.firebaseapp.com',             // Firebase Auth popup
    'https://accounts.google.com',           // Google OAuth popup
  ],
  'frame-ancestors': ["'none'"],             // prevent clickjacking
  'base-uri':        ["'self'"],
  'form-action':     ["'self'"],
  'object-src':      ["'none'"],
  'upgrade-insecure-requests': [],
};

const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([d, srcs]) => srcs.length ? `${d} ${srcs.join(' ')}` : d)
  .join('; ');

function securityHeaders(opts) {
  opts = opts || {};
  const h = {
    'X-Content-Type-Options':      'nosniff',
    'X-Frame-Options':             'DENY',
    'Referrer-Policy':             'strict-origin-when-cross-origin',
    'Permissions-Policy':          'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security':   'max-age=31536000; includeSubDomains',
    // Firebase auth uses popup windows, so we need *-allow-popups, not strict same-origin
    'Cross-Origin-Opener-Policy':  'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy':'cross-origin',
  };
  if (opts.html) h['Content-Security-Policy'] = CSP_HEADER;
  return h;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id, X-GTM-Account-Id, X-GTM-Container-Id, X-GTM-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TRACKING DEFINITIONS
// Each entry describes one platform, how to detect it in network requests,
// and how to extract IDs / event names / parameters from the request URLs.
// ══════════════════════════════════════════════════════════════════════════════
const TRACKING_DEFS = [
  {
    key: 'meta', name: 'Meta Pixel', icon: '👥', color: '#1877F2',
    // URLs that mean the pixel JS is loaded (client-side)
    loadPatterns:  ['connect.facebook.net/signals/fbevents', 'connect.facebook.net/en_US/fbevents', 'connect.facebook.net/signals/config'],
    // URLs that carry event hits — /tr and /tr/ (GET) + /signals/plugins (noscript fallback)
    eventPatterns: ['facebook.com/tr'],
    // URLs that indicate Conversions API / server-side
    serverPatterns: ['graph.facebook.com'],
    extractId:    (u) => {
      // ID can be in: ?id=XXXX, /signals/config/XXXX, or /tr?id=XXXX
      const m = u.match(/[?&]id=(\d{10,})/) || u.match(/signals\/config\/(\d{10,})/) || u.match(/signals\/fbevents\/config\?.*[?&]id=(\d{10,})/);
      return m ? m[1] : null;
    },
    extractEvent: (u) => { const m = u.match(/[?&]ev=([^&]+)/);           return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      // cd[param_name]=value is URL-encoded as cd%5Bparam_name%5D=value
      const raw = u.match(/cd%5B(.+?)%5D=([^&]*)/g) || [];
      return raw.map(p => { const x = p.match(/cd%5B(.+?)%5D=/); return x ? x[1] : null; }).filter(Boolean);
    },
    // Meta CAPI POSTs event data to graph.facebook.com/{pixel_id}/events with JSON body
    extractFromPost: (url, postData) => {
      if (!postData || !url.includes('graph.facebook.com')) return null;
      try {
        const body = typeof postData === 'string' ? JSON.parse(postData) : postData;
        if (body.data && Array.isArray(body.data) && body.data.length) {
          return body.data.map(d => ({
            name: d.event_name || null,
            params: Object.keys(d.custom_data || {}),
          })).filter(e => e.name);
        }
      } catch (e) {}
      return null;
    },
    requiredParams: { Purchase: ['value','currency'], AddToCart: ['content_ids','content_type'], ViewContent: ['content_ids','content_type'] },
  },
  {
    key: 'gtm', name: 'Google Tag Manager', icon: '📦', color: '#246FDB',
    loadPatterns:  ['googletagmanager.com/gtm.js'],
    eventPatterns: [],
    serverPatterns: ['googletagmanager.com/a?id='],   // GTM server-side container
    extractId: (u) => { const m = u.match(/[?&]id=(GTM-[A-Z0-9]+)/); return m ? m[1] : null; },
  },
  {
    key: 'ga4', name: 'Google Analytics (GA4)', icon: '📊', color: '#E37400',
    loadPatterns:  ['googletagmanager.com/gtag/js?id=G-'],
    eventPatterns: ['google-analytics.com/g/collect', 'analytics.google.com/g/collect'],
    serverPatterns: [],
    extractId:    (u) => { const m = u.match(/[?&]tid=(G-[A-Z0-9]+)/) || u.match(/id=(G-[A-Z0-9]+)/); return m ? m[1] : null; },
    extractEvent: (u) => { const m = u.match(/[?&]en=([^&]+)/);   return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      // GA4 sends params as ep.param or epn.param
      const keys = [];
      (u.match(/[?&]ep\.([^=]+)=/g) || []).forEach(p => { const x = p.match(/ep\.([^=]+)=/); if(x) keys.push(x[1]); });
      (u.match(/[?&]epn\.([^=]+)=/g) || []).forEach(p => { const x = p.match(/epn\.([^=]+)=/); if(x) keys.push(x[1]); });
      return keys;
    },
  },
  {
    key: 'google_ads', name: 'Google Ads', icon: '🎯', color: '#4285F4',
    loadPatterns:  ['googleadservices.com/pagead/conversion_async.js', 'googletagmanager.com/gtag/js?id=AW-'],
    eventPatterns: ['googleads.g.doubleclick.net/pagead/viewthroughconversion', 'google.com/pagead/1p-conversion', 'googleadservices.com/pagead/conversion/'],
    serverPatterns: [],
    extractId: (u) => {
      const m = u.match(/viewthroughconversion\/(\d+)/)
             || u.match(/conversion\/(\d{9,})/)
             || u.match(/[?&]id=(AW-[0-9]+)/)
             || u.match(/\/(\d{9,})\//);
      if (!m) return null;
      return m[1].startsWith('AW-') ? m[1] : 'AW-' + m[1];
    },
    // Google Ads conversion endpoints ALWAYS represent a 'conversion' event —
    // the event name isn't in the URL because it's implied by the endpoint itself.
    // Multiple hits with different conversion labels = different conversion actions.
    extractEvent: (u) => {
      if (/viewthroughconversion|1p-conversion|pagead\/conversion\//.test(u)) return 'conversion';
      return null;
    },
    extractParams: (u) => {
      const params = [];
      if (/[?&]label=/i.test(u)) params.push('label');
      if (/[?&]value=/i.test(u)) params.push('value');
      if (/[?&]currency_code=/i.test(u)) params.push('currency_code');
      if (/[?&]oid=/i.test(u) || /[?&]transaction_id=/i.test(u)) params.push('transaction_id');
      return params;
    },
  },
  {
    key: 'tiktok', name: 'TikTok Pixel', icon: '🎵', color: '#010101',
    loadPatterns:  ['analytics.tiktok.com/i18n/pixel/static', 'analytics.tiktok.com/i18n/pixel/events.js'],
    // Modern TikTok endpoint is /api/v2/pixel (POST with JSON); older one was /i18n/pixel/events
    eventPatterns: [
      'analytics.tiktok.com/api/v2/pixel',
      'analytics.tiktok.com/api/v2/pixel/track',
      'analytics.tiktok.com/api/v2/pixel/batch',
      'analytics.tiktok.com/i18n/pixel/events',
    ],
    serverPatterns: ['business-api.tiktok.com'],
    extractId:    (u) => {
      const m = u.match(/sdkid=([A-Z0-9]+)/i)
             || u.match(/pixel_code=([A-Z0-9]+)/i)
             || u.match(/pixel_id=([A-Z0-9]+)/i)
             || u.match(/\/static\/([A-Z0-9]{12,})\//i);
      return m ? m[1] : null;
    },
    extractEvent: (u) => { const m = u.match(/[?&]event=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      const raw = u.match(/properties%5B([^\]%]+)(?:%5D)?=/g) || [];
      return raw.map(p => { const x = p.match(/properties%5B([^\]%]+)/); return x ? decodeURIComponent(x[1]) : null; }).filter(Boolean);
    },
    // Modern TikTok POSTs JSON: { event: "Purchase", properties: {...}, context: {...} }
    // Or for batch: { batch: [{event, properties}, ...] }
    extractFromPost: (url, postData) => {
      if (!postData) return null;
      try {
        const body = typeof postData === 'string' ? JSON.parse(postData) : postData;
        const events = [];
        if (body.event) {
          events.push({
            name: body.event,
            params: Object.keys(body.properties || body.context || {}).filter(k => k !== 'user' && k !== 'page'),
          });
          // Merge nested properties/context/page keys for fuller view
          if (body.properties) Object.keys(body.properties).forEach(k => {
            if (events[0].params.indexOf(k) === -1) events[0].params.push(k);
          });
        }
        if (Array.isArray(body.batch)) {
          body.batch.forEach(ev => {
            if (ev.event) events.push({
              name: ev.event,
              params: Object.keys(ev.properties || {}),
            });
          });
        }
        // TikTok sometimes sends `event_name` instead of `event` (v2 API)
        if (!events.length && body.event_name) {
          events.push({
            name: body.event_name,
            params: Object.keys(body.properties || body.custom_data || {}),
          });
        }
        return events.length ? events : null;
      } catch (e) {}
      return null;
    },
    requiredParams: { Purchase: ['value','currency','content_id'], AddToCart: ['content_id','content_type'] },
  },
  {
    key: 'snapchat', name: 'Snapchat Pixel', icon: '👻', color: '#FFFC00',
    loadPatterns:  ['sc-static.net/scevent.min.js'],
    // tr.snapchat.com/p = event endpoint; /cm and /gcm = cookie/id matching only
    eventPatterns: ['tr.snapchat.com/p', 'tr.snapchat.com/cm/p', 'sc-analytics.appspot.com'],
    serverPatterns: [],
    extractId: (u) => {
      const m = u.match(/[?&]pid=([A-Za-z0-9\-]{8,})/i)
             || u.match(/[?&]pixel_id=([A-Za-z0-9\-]{8,})/i);
      return m ? m[1] : null;
    },
    // Snap pixel sends event name in e_n or e_c query param, or in path like /p/PAGE_VIEW
    extractEvent: (u) => {
      const m = u.match(/[?&]e_n=([^&]+)/)
             || u.match(/[?&]e_c=([^&]+)/)
             || u.match(/[?&]event=([^&]+)/)
             || u.match(/[?&]event_type=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      // Default PAGE_VIEW for bare tr.snapchat.com/p calls
      if (/tr\.snapchat\.com\/p(\?|$)/.test(u)) return 'PAGE_VIEW';
      return null;
    },
    // Snap params: e_pr=price, e_cu=currency, e_ti=transaction_id, e_iids=item_ids
    extractParams: (u) => {
      const params = [];
      if (/[?&]e_pr=/i.test(u)) params.push('price');
      if (/[?&]e_cu=/i.test(u)) params.push('currency');
      if (/[?&]e_ti=/i.test(u)) params.push('transaction_id');
      if (/[?&]e_iids=/i.test(u)) params.push('item_ids');
      if (/[?&]e_ic=/i.test(u)) params.push('item_category');
      if (/[?&]e_ni=/i.test(u)) params.push('number_items');
      if (/[?&]e_dl=/i.test(u)) params.push('description');
      if (/[?&]e_ss=/i.test(u)) params.push('search_string');
      return params;
    },
    // Snap CAPI can POST JSON bodies to /v3/<pixel_id>/events
    extractFromPost: (url, postData) => {
      if (!postData) return null;
      try {
        const body = typeof postData === 'string' ? JSON.parse(postData) : postData;
        if (body && body.data && Array.isArray(body.data) && body.data.length) {
          return body.data.map(d => ({
            name: d.event_name || d.event_type || null,
            params: Object.keys(d.custom_data || d.event_custom_data || {}),
          })).filter(e => e.name);
        }
        if (body && (body.event_name || body.event_type)) {
          return {
            name: body.event_name || body.event_type,
            params: Object.keys(body.custom_data || body.event_custom_data || {}),
          };
        }
      } catch (e) {}
      return null;
    },
  },
  {
    key: 'twitter', name: 'X (Twitter) Pixel', icon: '𝕏', color: '#000000',
    loadPatterns:  ['static.ads-twitter.com/uwt.js'],
    eventPatterns: ['t.co/i/adsct', 'analytics.twitter.com/i/adsct'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/[?&]p_id=(\w+)/) || u.match(/[?&]txn_id=(\w+)/); return m ? m[1] : null; },
    // X/Twitter adsct: events param carries the event name, or "page_view" by default
    extractEvent: (u) => {
      const m = u.match(/[?&]events=%5B%5B%22([^%]+)%22/) || u.match(/[?&]events=\[\[%22([^%]+)%22/);
      if (m) return decodeURIComponent(m[1]);
      if (/\/i\/adsct/.test(u)) return 'PageView';
      return null;
    },
    extractParams: (u) => {
      const params = [];
      if (/[?&]value=/i.test(u)) params.push('value');
      if (/[?&]currency=/i.test(u)) params.push('currency');
      if (/[?&]conversion_id=/i.test(u)) params.push('conversion_id');
      return params;
    },
  },
  {
    key: 'linkedin', name: 'LinkedIn Insight', icon: '💼', color: '#0A66C2',
    loadPatterns:  ['snap.licdn.com/li.lms-analytics'],
    eventPatterns: ['px.ads.linkedin.com'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/partner_id=(\d+)/) || u.match(/pid=(\d+)/); return m ? m[1] : null; },
    // LinkedIn Insight Tag: conversionId param = conversion event, otherwise page_view
    extractEvent: (u) => {
      if (/[?&]conversionId=/i.test(u)) return 'conversion';
      if (/px\.ads\.linkedin\.com/.test(u)) return 'page_view';
      return null;
    },
    extractParams: (u) => {
      const params = [];
      if (/[?&]conversionId=/i.test(u)) params.push('conversion_id');
      if (/[?&]value=/i.test(u)) params.push('value');
      if (/[?&]currency=/i.test(u)) params.push('currency');
      return params;
    },
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// ANALYSE INTERCEPTED NETWORK REQUESTS
// ══════════════════════════════════════════════════════════════════════════════
function analyzeRequests(requests) {
  const found = {};

  const addEvent = (entry, name, params) => {
    if (!name) return;
    const existing = entry.events.find(e => e.name === name);
    if (existing) {
      (params || []).forEach(p => { if (p && !existing.params.includes(p)) existing.params.push(p); });
    } else {
      entry.events.push({ name, params: params || [] });
    }
  };

  requests.forEach(req => {
    const url = req.url || '';
    const postData = req.postData || null;

    TRACKING_DEFS.forEach(def => {
      const isLoad   = (def.loadPatterns   || []).some(p => url.includes(p));
      const isEvent  = (def.eventPatterns  || []).some(p => url.includes(p));
      const isServer = (def.serverPatterns || []).some(p => url.includes(p));
      if (!isLoad && !isEvent && !isServer) return;

      if (!found[def.key]) {
        found[def.key] = {
          key:           def.key,
          name:          def.name,
          icon:          def.icon,
          color:         def.color || '#adc6ff',
          ids:           [],
          events:        [],
          isServerSide:  false,
          requestCount:  0,
          eventHitCount: 0, // separate counter: how many event-endpoint hits we saw
        };
      }
      const entry = found[def.key];
      entry.requestCount++;

      if (isServer) entry.isServerSide = true;
      if (isEvent || isServer) entry.eventHitCount++;

      // Extract pixel / tag ID (try URL first)
      if (def.extractId) {
        const id = def.extractId(url);
        if (id && !entry.ids.includes(id)) entry.ids.push(id);
      }

      // ── Extract event from URL query ──
      let extractedFromUrl = false;
      if (def.extractEvent) {
        const evName = def.extractEvent(url);
        if (evName) {
          const params = def.extractParams ? def.extractParams(url) : [];
          addEvent(entry, evName, params);
          extractedFromUrl = true;
        }
      }

      // ── Extract event from POST body (modern TikTok v2, Meta CAPI, etc.) ──
      if (!extractedFromUrl && postData && def.extractFromPost) {
        try {
          const result = def.extractFromPost(url, postData);
          if (result) {
            if (Array.isArray(result)) {
              result.forEach(ev => addEvent(entry, ev.name, ev.params));
            } else if (result.name) {
              addEvent(entry, result.name, result.params);
            }
          }
        } catch (e) { /* ignore malformed bodies */ }
      }

      // Note: no more generic fallback — every platform now has extractEvent,
      // so if no event was parsed it genuinely means the pixel didn't fire.
    });
  });

  return Object.values(found);
}

// ══════════════════════════════════════════════════════════════════════════════
// PUPPETEER SCANNER
// Opens the page in a real headless Chrome, intercepts every network request,
// waits for lazy-loaded scripts, then returns HTML + full request log + pixels.
// ══════════════════════════════════════════════════════════════════════════════
async function scanWithPuppeteer(targetUrl) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });

  try {
    const page = await browser.newPage();

    // Realistic desktop UA
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Collect every outgoing request (including POST bodies — critical for modern
    // pixels like TikTok v2 API and Meta CAPI which ship events in JSON bodies)
    const requests = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      requests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        postData: req.postData() || null,
      });
      req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Initial wait for pixels that fire on DOM ready
    await new Promise(r => setTimeout(r, 2000));

    // Simulate scroll — triggers lazy-loaded pixels (e.g. scroll-based Meta events,
    // lazy-loaded GTM snippets, or Scroll trigger in GTM). Also triggers viewport
    // observers which many pixels rely on.
    try {
      await page.evaluate(() => {
        window.scrollTo(0, Math.min(document.body.scrollHeight / 2, 1500));
      });
      await new Promise(r => setTimeout(r, 1500));
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) { /* scroll can fail on some sites — ignore */ }

    // Final wait for post-scroll pixel fires
    await new Promise(r => setTimeout(r, 1500));

    const html        = await page.content();
    const resolvedUrl = page.url();

    await browser.close();

    const pixels = analyzeRequests(requests);

    return {
      html,
      url:        resolvedUrl,
      pixels,
      method:     'puppeteer',
      reqCount:   requests.length,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// fetchWithHttp removed — replaced by safeFetch in /api/scan-url.
// safeFetch resolves DNS once, validates the IP, and connects to the IP
// directly (no TOCTOU window). See lib/ssrf-guard.js.

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const mime = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.json':  'application/json',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.txt':   'text/plain; charset=utf-8',
  '.map':   'application/json',
};

// Extensions the public static server is allowed to hand out.
// Everything NOT in this set (server.js, package.json, Dockerfile, .env, ...)
// is blocked with 403 even if present in the root folder.
const STATIC_ALLOW_EXT = new Set([
  '.html', '.css',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.txt', '.map',
]);

// ══════════════════════════════════════════════════════════════════════════════
// STATIC ASSET CACHE  (C6)
// Each file is read + compressed ONCE and kept for the process lifetime. On
// Cloud Run the container image is immutable, so files never change without a
// redeploy — and a redeploy starts a fresh process with an empty cache, so
// staleness is a non-issue. Each entry carries the raw bytes plus pre-computed
// gzip + brotli buffers and a strong ETag, so a hit costs zero disk reads and
// zero re-compression — critical for the ~825 KB tool.html under load.
// ══════════════════════════════════════════════════════════════════════════════
const _staticCache  = new Map();   // absolute fp → { etag, ext, isHtml, raw, gzip, br }
const _COMPRESSIBLE = new Set(['.html', '.css', '.svg', '.txt', '.map', '.json', '.js']);

function _loadStatic(fp) {
  let data;
  try { data = fs.readFileSync(fp); }
  catch (_) { return null; }                 // missing/unreadable → caller 404s
  const ext    = path.extname(fp).toLowerCase();
  const isHtml = ext === '.html';
  const etag   = '"' + crypto.createHash('sha1').update(data).digest('base64').slice(0, 22) + '"';
  const entry  = { etag, ext, isHtml, raw: data, gzip: null, br: null };
  // Pre-compress text assets only — images/fonts are already compressed.
  if (_COMPRESSIBLE.has(ext) && data.length > 1024) {
    try { entry.gzip = zlib.gzipSync(data, { level: 6 }); } catch (_) {}
    try {
      entry.br = zlib.brotliCompressSync(data, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },   // 5 = strong but fast
      });
    } catch (_) {}
  }
  _staticCache.set(fp, entry);
  return entry;
}

// Default 1 MB body cap (covers full GTM container imports). Override per-call
// by passing a maxBytes argument. /api/ss/* endpoints use a 64 KB cap because
// they only ever receive small JSON config blobs.
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const SS_BODY_LIMIT      = 64   * 1024;

function parseBody(req, cb, maxBytes) {
  const limit = maxBytes || DEFAULT_BODY_LIMIT;
  // Reject early when the client advertises an oversize body
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared && declared > limit) {
    const err = new Error('Request body too large');
    err.code = 'BODY_TOO_LARGE';
    err.statusCode = 413;
    return cb(err);
  }

  let received = 0;
  const chunks  = [];
  let aborted   = false;

  req.on('data', chunk => {
    if (aborted) return;
    received += chunk.length;
    if (received > limit) {
      aborted = true;
      const err = new Error('Request body exceeded ' + limit + ' bytes');
      err.code = 'BODY_TOO_LARGE';
      err.statusCode = 413;
      // Stop reading and signal the client
      req.destroy();
      return cb(err);
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { cb(e); }
  });
  req.on('error', e => { if (!aborted) { aborted = true; cb(e); } });
}

// Wraps parseBody with proper HTTP-error responses on failure:
//   err.code === 'BODY_TOO_LARGE' → 413 with the limit in bytes
//   any other error / empty body  → 400 with a generic JSON error
// On success: cb(body) is called. Use this from every /api/* route that
// reads a JSON body — it surfaces 413 correctly to clients trying to upload
// oversize payloads, instead of swallowing it as 400 'Invalid JSON'.
function parseJsonBody(req, res, cb, limit) {
  parseBody(req, (err, body) => {
    if (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendJSON(res, 413, { error: 'الـ body أكبر من المسموح (' + (limit || DEFAULT_BODY_LIMIT) + ' bytes)' });
      } else {
        sendJSON(res, 400, { error: 'Invalid JSON' });
      }
      return;
    }
    if (!body) { sendJSON(res, 400, { error: 'Empty or invalid JSON body' }); return; }
    cb(body);
  }, limit);
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
    ...securityHeaders(),
  });
  res.end(body);
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders(), ...securityHeaders() });
    res.end();
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL WORKER  —  POST /api/internal/run-provision-job   (C3)
  // Invoked by Cloud Tasks (not the browser). Runs the provisioning job
  // SYNCHRONOUSLY inside this request, so Cloud Run keeps CPU allocated for the
  // full 60-120s — the whole reason for the Cloud Tasks hop. Auth is the
  // X-Internal-Token shared secret (see _authorizeInternal).
  //
  // Body (from the Cloud Tasks payload): { jobType: 'managed' | 'ss', jobId }
  // The heavy input lives in the Firestore job doc, loaded by the runner.
  //
  // Always ACKs 2xx once a terminal state is reached (success OR recorded
  // failure): provisioning is NOT idempotent, so a Cloud Tasks retry would
  // create duplicate GTM containers. The queue is also set to --max-attempts=1.
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/internal/run-provision-job') {
    if (!_authorizeInternal(req, res)) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    parseJsonBody(req, res, async body => {
      const jobId   = body && body.jobId;
      const jobType = (body && body.jobType) === 'ss' ? 'ss' : 'managed';
      if (!jobId) return sendJSON(res, 400, { error: 'Missing jobId' });

      let job;
      try { job = await firestoreService.getJob(jobId); }
      catch (e) { return sendJSON(res, 500, { error: e.message }); }
      if (!job) return sendJSON(res, 404, { error: 'Job not found or expired' });

      // Idempotency guard — if a prior attempt already finished, ACK so Cloud
      // Tasks stops without re-running (which would duplicate containers).
      if (job.status === 'completed' || job.status === 'failed') {
        return sendJSON(res, 200, { ok: true, alreadyDone: true, status: job.status });
      }

      try {
        if (jobType === 'ss') await _runSsProvisionJob(jobId);
        else                  await _runManagedProvisionJob(jobId);
        sendJSON(res, 200, { ok: true, jobId });
      } catch (e) {
        // Runner records 'failed' itself; ACK 200 anyway (non-idempotent — no retry).
        console.error('[worker] job ' + jobId + ' crashed:', e);
        sendJSON(res, 200, { ok: false, jobId, error: e.message });
      }
    }, SS_BODY_LIMIT);
    return;
  }

  // ── GTM Import Proxy ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/gtm/import') {
    parseJsonBody(req, res, body => {

      const accountId   = req.headers['x-gtm-account-id'];
      const containerId = req.headers['x-gtm-container-id'];
      const authToken   = req.headers['x-gtm-token'];

      if (!accountId || !containerId || !authToken) {
        sendJSON(res, 400, { error: 'Missing x-gtm-account-id, x-gtm-container-id, or x-gtm-token headers' });
        return;
      }

      const gtmApiBody = body.exportFormatVersion !== undefined
        ? { containerConfigJSON: JSON.stringify(body) }
        : body;

      const postData = JSON.stringify(gtmApiBody);
      const options  = {
        hostname: 'tagmanager.googleapis.com',
        path: `/tagmanager/v2/accounts/${accountId}/containers/${containerId}/versions:import`,
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${authToken}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const apiReq = https.request(options, apiRes => {
        let result = '';
        apiRes.on('data', c => { result += c; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
            ...securityHeaders(),
          });
          res.end(result);
        });
      });
      apiReq.on('error', e => sendJSON(res, 502, { error: e.message }));
      apiReq.write(postData);
      apiReq.end();
    });
    return;
  }

  // ── Pixel Scanner ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/scan-url') {
    (async () => {
      // ── P0: Firebase auth — endpoint was previously unauthenticated ─────────
      if (!firestoreService.isConfigured()) {
        return sendJSON(res, 503, { error: 'Firebase غير مُهيَّأ على هذا الخادم' });
      }
      const scanAuthz = (req.headers['authorization'] || '').trim();
      const scanAuthMatch = /^Bearer\s+(.+)$/i.exec(scanAuthz);
      if (!scanAuthMatch) {
        return sendJSON(res, 401, { error: 'Authorization header مطلوب' });
      }
      const scanToken = scanAuthMatch[1].trim();
      if (!scanToken || scanToken.length > 8192) {
        return sendJSON(res, 401, { error: 'Token غير صالح' });
      }
      let scanDecoded;
      try { scanDecoded = await firestoreService.verifyIdToken(scanToken); }
      catch (e) {
        return sendJSON(res, 401, { error: 'Firebase token غير صالح', code: String((e && e.code) || 'auth/invalid-id-token') });
      }
      if (!scanDecoded || !scanDecoded.uid) {
        return sendJSON(res, 401, { error: 'Token بدون uid' });
      }
      const scanRl = rateLimiter.check(scanDecoded.uid);
      if (!scanRl.allowed) {
        res.writeHead(429, { ...corsHeaders(), ...securityHeaders(), 'Retry-After': Math.ceil((scanRl.resetAt - Date.now()) / 1000) });
        res.end(JSON.stringify({ error: 'Rate limit exceeded', resetAt: scanRl.resetAt }));
        return;
      }

      parseJsonBody(req, res, async body => {
        let targetUrl = (body && body.url) ? body.url.trim() : '';
        if (!targetUrl) { sendJSON(res, 400, { error: 'Missing url' }); return; }
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

        // ── SSRF guard: sync pre-check (protocol / port / IP-literal) ──────────
        try { validateTargetUrl(targetUrl); }
        catch (e) { return sendJSON(res, 400, { error: 'URL rejected: ' + e.message }); }

        // ── Concurrency cap ──────────────────────────────────────────────────
        if (scanInFlight >= MAX_CONCURRENT_SCANS) {
          return sendJSON(res, 429, {
            error:        'Scanner is at capacity — please retry shortly',
            retryAfterMs: 3000,
          });
        }

        scanInFlight++;
        try {
          let result;
          if (puppeteer) {
            // Puppeteer re-resolves DNS internally (unavoidable with a browser engine).
            // validateTargetUrl above blocks IP-literals and bad ports synchronously.
            result = await scanWithPuppeteer(targetUrl);
          } else {
            // safeFetch: DNS resolved once, IP validated, connection to IP — no TOCTOU.
            console.warn('[scanner] Puppeteer not available — falling back to safeFetch');
            const { body: html } = await safeFetch(targetUrl, {
              maxRedirects : 3,
              timeoutMs    : 15_000,
              maxBodyBytes : 800 * 1024,
            });
            result = { html, url: targetUrl, pixels: [], method: 'http' };
          }
          sendJSON(res, 200, result);
        } catch (e) {
          console.error('[scanner] Error:', e.message);
          const status = /blocked|not allowed|SSRF|Invalid URL|hostname/i.test(e.message) ? 400 : 502;
          sendJSON(res, status, { error: e.message });
        } finally {
          scanInFlight--;
        }
      });
    })();
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANAGED GTM ENDPOINTS
  // Creates containers in our own GTM account so non-technical clients don't
  // have to OAuth into their own GTM. See gtm-service.js + firestore-service.js.
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/managed/health — capacity + config status (for ops dashboard)
  if (req.method === 'GET' && req.url === '/api/managed/health') {
    (async () => {
      const ready = gtmService.isConfigured() && firestoreService.isConfigured();
      let count = null, tokenOk = false, err = null;
      if (ready) {
        try { await gtmService.getAccessToken(); tokenOk = true; } catch (e) { err = e.message; }
        try { count = await firestoreService.countActiveContainers(); } catch (e) { err = err || e.message; }
      }
      sendJSON(res, 200, {
        configured: ready,
        tokenOk,
        activeContainers: count,
        capacityHint: count !== null ? Math.max(0, 500 - count) : null,
        error: err,
        gtmConfigured:       gtmService.isConfigured(),
        firestoreConfigured: firestoreService.isConfigured(),
        // Server-side CAPI import readiness — lets operators confirm whether
        // managed server containers will ship with CAPI tags (Meta/TikTok/Snap)
        // or silently fall back to the GA4-only static config. deliversCapi is
        // true ONLY when the flag AND the staging bucket are both in place.
        serverConfigImport: {
          enabled:          _serverConfigImportEnabled(),
          bucketConfigured: configBlobStore.isConfigured(),
          deliversCapi:     _serverConfigImportEnabled() && configBlobStore.isConfigured(),
          schemaVersion:    configBlobStore.SCHEMA_VERSION,
          lastImportMode:   _lastManagedImport ? _lastManagedImport.mode : null,
        },
        provisionQueue: provisionQueue.stats(),
      });
    })().catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // POST /api/managed/create-container
  // Body: { clientId, clientEmail, projectName, domain?, cmsType, platforms,
  //         events, pixelIds, configJson, publishLive }
  //
  // Returns { ok: true, jobId } IMMEDIATELY (202). The actual GTM provisioning
  // runs in the background because it takes 60-120s (write-quota pacing) and
  // that would blow past Cloudflare / Railway proxy timeouts. Client must poll
  // GET /api/managed/job/:jobId until status === 'completed' or 'failed'.
  if (req.method === 'POST' && req.url === '/api/managed/create-container') {
    parseJsonBody(req, res, async body => {

      // dryRun: simulate provisioning without real GTM/Stape calls. Opt-in and
      // gated by ALLOW_DRY_RUN=1 so it can never be triggered in normal prod.
      const dryRun = body.dryRun === true && process.env.ALLOW_DRY_RUN === '1';

      if (!dryRun && !gtmService.isConfigured()) {
        return sendJSON(res, 503, {
          error: 'Managed GTM is not configured on this server',
          hint:  'Set GTM_SA_KEY_JSON and GTM_ACCOUNT_ID env vars',
        });
      }
      if (!firestoreService.isConfigured()) {
        return sendJSON(res, 503, {
          error: 'Firestore is not configured on this server',
          hint:  'Set FIREBASE_SA_KEY_JSON env var and `npm install firebase-admin`',
        });
      }

      const { clientId, clientEmail, projectName, domain, cmsType,
              platforms, events, pixelIds, configJson, publishLive } = body;
      // C-P1: full client-built server config (staged to GCS, not the job doc).
      const serverConfigJson = body.serverConfigJson || null;

      // Tracking mode picker — 'client' (default) or 'client_server'.
      // Anything else is normalised to 'client' so old callers keep working.
      const mode = (body.mode === 'client_server') ? 'client_server' : 'client';

      if (!clientId)               return sendJSON(res, 400, { error: 'Missing clientId' });
      if (!configJson && !dryRun)  return sendJSON(res, 400, { error: 'Missing configJson' });

      // Bundle everything the worker needs into the job doc; the Cloud Tasks
      // payload then carries only { jobType, jobId } (heavy configJson stays here).
      const input = { clientId, clientEmail, projectName, domain, cmsType,
                      platforms, events, pixelIds, configJson, publishLive, mode, dryRun };

      // Create the job doc BEFORE responding so an immediate poll can never 404.
      // Direct saveJob (not _setJob) so a write failure fails the request loudly
      // instead of handing back a jobId that was never persisted.
      const jobId = _newJobId();

      // C-P1: stage the full server config in a private GCS bucket (NOT the 1 MB
      // Firestore doc). Flag-gated; on ANY failure we omit the ref and the worker
      // uses the existing static GA4-only path — graceful degrade, never blocks.
      if (!dryRun && mode === 'client_server' && serverConfigJson && _serverConfigImportEnabled()) {
        const v = _validateServerConfig(serverConfigJson);
        if (!v.ok) {
          console.warn('[managed/create] serverConfigJson rejected by guard (' + v.error + ') — static path');
        } else if (!configBlobStore.isConfigured()) {
          console.warn('[managed/create] PROVISIONING_BUCKET not configured — static path');
        } else {
          try {
            input.serverConfigRef = await configBlobStore.put(jobId, serverConfigJson);
          } catch (e) {
            console.warn('[managed/create] serverConfig blob upload failed (' + e.message + ') — static path');
          }
        }
      }

      try {
        await firestoreService.saveJob(jobId, {
          status:    'pending',
          stage:     'queued',
          clientId,
          jobType:   'managed',
          input,
          startedAt: Date.now(),
        });
      } catch (e) {
        return sendJSON(res, 500, { error: 'Failed to create provisioning job: ' + e.message });
      }

      // Hand off to the worker: a Cloud Task on GCP (CPU stays allocated for the
      // whole job) or an in-process run off-GCP (local / Railway).
      try {
        await _dispatchProvisionJob('managed', jobId);
      } catch (e) {
        // The worker never started, so its finally{} blob cleanup won't run.
        // Delete the secret-bearing staged config now (the bucket lifecycle TTL
        // is the backstop only for hard process crashes, not for this path).
        if (input.serverConfigRef) {
          try { await configBlobStore.del(input.serverConfigRef); }
          catch (e2) { console.warn('[managed/create] blob cleanup after enqueue failure failed:', e2.message); }
        }
        await _setJob(jobId, {
          status: 'failed', stage: 'enqueue_error',
          error:  'Failed to enqueue provisioning job: ' + e.message,
          finishedAt: Date.now(),
        });
        return sendJSON(res, (e.status && e.status >= 400 && e.status < 600) ? e.status : 502, { error: 'Failed to enqueue provisioning job: ' + e.message });
      }

      // 202 Accepted — job doc already exists, so the client's first poll is safe.
      sendJSON(res, 202, { ok: true, jobId, status: 'pending' });
    });
    return;
  }

  // GET /api/managed/job/:jobId — poll status of a provisioning job.
  // Reads from Firestore so ANY Cloud Run instance can answer the poll, not just
  // the instance that created the job.
  // Auth: Firebase ID token required; job.clientId must match token uid.
  if (req.method === 'GET' && req.url.startsWith('/api/managed/job/')) {
    const jobId = req.url.substring('/api/managed/job/'.length).split('?')[0];
    if (!jobId) return sendJSON(res, 400, { error: 'Missing jobId' });
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    (async () => {
      // Verify caller identity via Firebase ID token.
      const authHeader = req.headers['authorization'] || '';
      const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!tokenMatch) return sendJSON(res, 401, { error: 'Authorization header required' });
      const idToken = tokenMatch[1].trim();
      let decoded;
      try {
        decoded = await firestoreService.verifyIdToken(idToken);
      } catch (e) {
        return sendJSON(res, 401, { error: 'Invalid token', code: String((e && e.code) || 'auth/invalid-id-token') });
      }
      const uid = decoded.uid;
      try {
        const job = await firestoreService.getJob(jobId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found or expired' });
        // Ownership check — prevent cross-tenant job reads.
        if (job.clientId && job.clientId !== uid) {
          return sendJSON(res, 403, { error: 'Forbidden: job does not belong to this account' });
        }
        sendJSON(res, 200, { ok: true, jobId, ...job });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // GET /api/managed/container/:gtmPublicId
  if (req.method === 'GET' && req.url.startsWith('/api/managed/container/')) {
    const gtmPublicId = req.url.substring('/api/managed/container/'.length).split('?')[0];
    if (!gtmPublicId) return sendJSON(res, 400, { error: 'Missing GTM public ID' });
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    firestoreService.getContainer(gtmPublicId)
      .then(doc => {
        if (!doc) return sendJSON(res, 404, { error: 'Container not found' });
        sendJSON(res, 200, doc);
      })
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // GET /api/managed/client/:clientId — list all containers for a client
  if (req.method === 'GET' && req.url.startsWith('/api/managed/client/')) {
    const clientId = req.url.substring('/api/managed/client/'.length).split('?')[0];
    if (!clientId) return sendJSON(res, 400, { error: 'Missing client ID' });
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    firestoreService.listContainersByClient(clientId)
      .then(list => sendJSON(res, 200, { containers: list, count: list.length }))
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS
  // Accepts EITHER:
  //   1) Legacy:   Authorization: Bearer <ADMIN_TOKEN>  (ADMIN_TOKEN env var)
  //   2) Firebase: Authorization: Bearer <firebase-id-token>, where the
  //      decoded token has the `admin: true` custom claim (same convention
  //      as /api/v1/* — see line ~3459) or an email in ADMIN_EMAILS.
  // ══════════════════════════════════════════════════════════════════════════
  async function _requireAdmin() {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return false;
    }

    // 1) Legacy ADMIN_TOKEN — constant-time comparison to prevent timing attacks
    const expected = process.env.ADMIN_TOKEN;
    if (expected) {
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) {
        return true;
      }
    }

    // 2) Firebase ID token with admin claim or ADMIN_EMAILS allowlist
    try {
      const decoded = await firestoreService.verifyIdToken(token);
      const admins = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      // TEMP: remove once ADMIN_EMAILS auth is confirmed working in prod
      console.log('[ADMIN AUTH]', {
        email: decoded?.email,
        admin: decoded?.admin,
        role: decoded?.role,
        allowed: admins.includes(decoded?.email),
      });
      if (decoded.admin === true || decoded.role === 'admin' || admins.includes(decoded.email)) {
        req.adminUser = decoded;
        return true;
      }
    } catch (_) {}

    sendJSON(res, 401, { error: 'Unauthorized' });
    return false;
  }

  // GET /api/admin/export — internal admin data dump (JSON only, no file download)
  if (req.method === 'GET' && req.url.startsWith('/api/admin/export')) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    firestoreService.exportAll()
      .then(dump => {
        const json = JSON.stringify(dump, null, 2);
        res.writeHead(200, {
          ...securityHeaders(),
          'Content-Type':   'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
      })
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // GET /api/admin/ping — quick token validity check (used by admin login)
  if (req.method === 'GET' && req.url.startsWith('/api/admin/ping')) {
    if (!(await _requireAdmin())) return;
    return sendJSON(res, 200, { ok: true, firestore: firestoreService.isConfigured() });
  }

  // POST /api/admin/rotate-token
  // Rotates a CAPI token for a client: re-encrypts in Firestore, then updates
  // the authHeader parameter on the deployed sGTM tag, creates a new GTM version,
  // and publishes it so the new token is live immediately.
  //
  // Body: { clientId, platform, newToken }
  //   platform: 'meta' | 'tiktok' | 'snap'
  //   newToken:  the new raw access token (will be encrypted before storage)
  //
  // Returns: { ok, platform, gtm: { tagIds, versionId, published } }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/admin/rotate-token') {
    if (!(await _requireAdmin())) return;
    parseJsonBody(req, res, async body => {
      const { clientId, platform, newToken } = body || {};
      const ALLOWED_PLATFORMS = ['meta', 'tiktok', 'snap'];
      if (!clientId) return sendJSON(res, 400, { error: 'clientId is required' });
      if (!platform || !ALLOWED_PLATFORMS.includes(platform))
        return sendJSON(res, 400, { error: 'platform must be one of: ' + ALLOWED_PLATFORMS.join(', ') });
      if (!newToken || !String(newToken).trim())
        return sendJSON(res, 400, { error: 'newToken is required' });
      if (!firestoreService.isConfigured())
        return sendJSON(res, 503, { error: 'Firestore not configured' });

      try {
        // 1. Load current ss_config to get container IDs
        const cfg = await firestoreService.getSSConfig(clientId);
        if (!cfg) return sendJSON(res, 404, { error: 'No ss_config found for clientId: ' + clientId });

        // 2. Re-encrypt the new token and save to Firestore
        const aad = clientId + ':' + platform;
        const encryptedToken = cryptoVault.encryptToken(String(newToken).trim(), aad);
        const updatedTokens = { ...(cfg.encryptedTokens || {}), [platform]: encryptedToken };
        await firestoreService.saveSSConfig(clientId, { ...cfg, encryptedTokens: updatedTokens });

        // 3. Update the sGTM container if we have container IDs
        let gtmResult = null;
        const serverContainerId = cfg.serverContainerId;
        const serverWorkspaceId = cfg.serverWorkspaceId;

        if (gtmService.isConfigured() && serverContainerId && serverWorkspaceId) {
          try {
            // Create a fresh workspace (current workspace may have uncommitted changes)
            // We rotate directly in the stored workspaceId. If it has pending changes
            // the version will include them — acceptable for a token rotation.
            gtmResult = await gtmService.rotateCapiTokenInContainer(
              serverContainerId,
              serverWorkspaceId,
              platform,
              String(newToken).trim(),
            );
          } catch (gtmErr) {
            // GTM update is best-effort: Firestore already has the new token. Log
            // the error prominently so the operator knows to manually re-publish.
            console.error('[rotate-token] GTM container update failed for clientId=' + clientId +
              ' platform=' + platform + ':', gtmErr.message);
            gtmResult = { error: gtmErr.message, manual: true };
          }
        } else {
          gtmResult = { skipped: true, reason: !gtmService.isConfigured()
            ? 'GTM not configured on server'
            : 'no serverContainerId/serverWorkspaceId in ss_config' };
        }

        // 4. Audit log
        await firestoreService.saveAuditLog({
          clientId,
          action:   'rotate_token',
          platform,
          actor:    'admin',
          gtmUpdated: !!(gtmResult && gtmResult.versionId),
        }).catch(() => {});

        sendJSON(res, 200, {
          ok:       true,
          clientId,
          platform,
          firestore: { updated: true },
          gtm:       gtmResult,
        });
      } catch (e) {
        console.error('[rotate-token] error:', e.message);
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── VERSION HISTORY ENDPOINTS ──────────────────────────────────────────────

  // ── GET /api/versions/:clientId ──────────────────────────────────────────────
  // List container_versions for a client, newest first (by version number desc).
  // No pagination — returns up to 50 records (hardcoded in listVersions).
  // Auth: admin token.
  /*
  Response:
  {
    "ok": true,
    "clientId": "uid_abc123",
    "versions": [
      {
        "id": "firestore_doc_id",
        "version": 12,
        "publishedAt": "2026-06-30T10:00:00.000Z",
        "publishedBy": "admin/rollback",
        "deploymentType": "publish",
        "status": "published",
        "gtmVersionId": "45",
        "gtmPublicId": "GTM-XXXXX",
        "diffSummary": { "added": 0, "modified": 0, "removed": 0 },
        "configSnapshot": { "..." : "..." }
      }
    ]
  }
  Note: driftDetected is NOT in this response. It is in GET /api/health and
        GET /api/deployments (versions[].driftDetected).
  Errors:
    401 { "error": "Unauthorized" }
    503 { "error": "Firestore not configured" }
    500 { "error": "..." }
  */
  const _verListMatch = req.url.split('?')[0].match(/^\/api\/versions\/([^/]+)$/);
  if (req.method === 'GET' && _verListMatch) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) return sendJSON(res, 503, { error: 'Firestore not configured' });
    const clientId = decodeURIComponent(_verListMatch[1]);
    (async () => {
      try {
        const versions = await firestoreService.listVersions(clientId);
        // Serialize Firestore Timestamps to ISO strings for JSON transport
        const out = versions.map(v => ({
          id:             v.id,
          version:        v.version,
          publishedAt:    v.publishedAt && v.publishedAt.toDate ? v.publishedAt.toDate().toISOString() : (v.publishedAt || null),
          publishedBy:    v.publishedBy || null,
          deploymentType: v.deploymentType || 'publish',
          status:         v.status         || 'published',
          gtmVersionId:   v.gtmVersionId   || null,
          gtmPublicId:    v.gtmPublicId    || null,
          diffSummary:    v.diffSummary    || null,
          configSnapshot: v.configSnapshot || null,
        }));
        sendJSON(res, 200, { ok: true, clientId, versions: out });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/versions/rollback ──────────────────────────────────────────────
  // Full state machine: lock → pre-flight → drift check → build → import → publish → audit.
  // Auth: admin token.
  /*
  Request body: { "clientId": "uid_abc123", "version": 11 }
  Success response:
  {
    "ok": true,
    "clientId": "uid_abc123",
    "deploymentId": "rb_lxyz9a",
    "rolledBackFrom": 11,
    "newVersion": 12,
    "gtmVersionId": "46",
    "drift": null
  }
  drift when detected: { "detected": true, "warning": "GTM ver changed outside Easy Track" }
  Errors:
    400 { "error": "clientId is required" | "version (number) is required" }
    401 { "error": "Unauthorized" }
    404 { "error": "Version N not found for clientId X" }
    409 { "error": "Another deployment is already in progress..." }
    422 { "error": "Cannot rollback a rollback deployment", "hint": "..." }
        { "error": "Version has no configSnapshot — cannot rollback", "hint": "..." }
        { "error": "Version record missing containerId" }
    500 { "error": "...", "deploymentId": "rb_xxx" }
    503 { "error": "Firestore not configured" | "GTM not configured" }
  */
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/versions/rollback') {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) return sendJSON(res, 503, { error: 'Firestore not configured' });
    if (!gtmService.isConfigured())       return sendJSON(res, 503, { error: 'GTM not configured' });

    parseJsonBody(req, res, async body => {
      const { clientId, version } = body || {};
      if (!clientId) return sendJSON(res, 400, { error: 'clientId is required' });
      if (typeof version !== 'number' && !version)
        return sendJSON(res, 400, { error: 'version (number) is required' });

      const targetVersion = Number(version);
      let lockAcquired    = false;
      let versionDocId    = null;
      const deploymentId  = 'rb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      try {
        // ── STEP 1: Load target version record ─────────────────────────────────
        const targetVer = await firestoreService.getVersionByNumber(clientId, targetVersion);
        if (!targetVer) {
          return sendJSON(res, 404, {
            error: `Version ${targetVersion} not found for clientId ${clientId}`,
          });
        }

        // ── STEP 2: Guard — prevent rollback-on-rollback ───────────────────────
        if (targetVer.deploymentType === 'rollback') {
          return sendJSON(res, 422, {
            error: 'Cannot rollback a rollback deployment',
            hint:  `v${targetVersion} is itself a rollback. Choose an original publish version.`,
          });
        }

        // ── STEP 3: Pre-flight validation ──────────────────────────────────────
        if (!targetVer.configSnapshot) {
          return sendJSON(res, 422, {
            error: 'Version has no configSnapshot — cannot rollback',
            hint:  `v${targetVersion} was created before configSnapshot tracking was added.`,
          });
        }
        const containerId = targetVer.containerId;
        if (!containerId) {
          return sendJSON(res, 422, { error: 'Version record missing containerId' });
        }

        // ── STEP 4: Acquire deployment lock — prevent concurrent rollbacks ─────
        lockAcquired = await firestoreService.acquireDeploymentLock(clientId, deploymentId);
        if (!lockAcquired) {
          return sendJSON(res, 409, {
            error: 'Another deployment is already in progress for this client',
            hint:  'Wait for the current deployment to complete (max 10 minutes) then retry.',
          });
        }

        // ── STEP 5: Drift detection — warn if GTM has manual changes ──────────
        // Load the latest known version to compare against live GTM.
        let driftInfo = { driftDetected: false, warning: null };
        try {
          const latestVersions = await firestoreService.listVersions(clientId, { limit: 1 });
          const latestKnownGtmVersionId = latestVersions[0] && latestVersions[0].gtmVersionId;
          if (latestKnownGtmVersionId) {
            driftInfo = await gtmService.detectContainerDrift(containerId, latestKnownGtmVersionId);
            if (driftInfo.driftDetected) {
              console.warn('[versions/rollback][' + deploymentId + '] DRIFT DETECTED:', driftInfo.warning);
            }
          }
        } catch (driftErr) {
          console.warn('[versions/rollback][' + deploymentId + '] drift check failed (non-fatal):', driftErr.message);
        }

        // ── STEP 6: Allocate atomic version number ─────────────────────────────
        const newVersionNum = await firestoreService.allocateVersionNumber(clientId);

        // ── STEP 7: Create version record in 'building' state ──────────────────
        // Creating before GTM ops means failure recovery can update this doc.
        const snap = targetVer.configSnapshot;
        versionDocId = await firestoreService.saveVersionGetId({
          clientId,
          version:        newVersionNum,
          deploymentId,
          publishedBy:    'admin/rollback',
          containerId,
          workspaceId:    null,
          gtmVersionId:   null,
          gtmPublicId:    targetVer.gtmPublicId || null,
          deploymentType: 'rollback',
          deploymentState: 'building',
          status:         'building',
          rolledBackFrom: targetVersion,
          configSnapshot: snap,
          diffSummary:    { added: 0, modified: 0, removed: 0 },
          driftDetected:  driftInfo.driftDetected,
          driftWarning:   driftInfo.warning || null,
        });

        // Log: rollback started
        await firestoreService.saveDeploymentLog({
          deploymentId,
          clientId,
          action:      'rollback_start',
          actor:       'admin',
          targetVersion,
          newVersion:  newVersionNum,
          versionDocId,
          success:     null,
          metadata:    { drift: driftInfo.driftDetected },
        }).catch(() => {});

        // ── STEP 8: Build GTM config from configSnapshot (source of truth) ─────
        await firestoreService.updateVersion(versionDocId, { deploymentState: 'building' });

        const rebuiltConfig = gtmConfigBuilder.buildWebConfig({
          ga4MeasurementId: snap.ga4MeasurementId || (snap.pixelIds && snap.pixelIds.ga4) || '',
          sgtmUrl:          snap.sgtmUrl          || '',
          pixelIds:         snap.pixelIds         || {},
          events:           snap.events           || [],
          customEvents:     snap.customEvents     || [],
          ecommPlatform:    snap.ecommPlatform    || snap.cmsType || '',
        });

        // ── STEP 9: Import + Publish via GTM API ───────────────────────────────
        await firestoreService.updateVersion(versionDocId, { deploymentState: 'importing' });

        const rollResult = await gtmService.rollbackContainer(
          containerId,
          rebuiltConfig,
          `Easy Track Rollback to v${targetVersion}`,
        );
        // If rollbackContainer throws, catch below sets deploymentState = 'failed'.
        // If we reach here, GTM is live.

        // ── STEP 10: Finalize version record as published ──────────────────────
        await firestoreService.updateVersion(versionDocId, {
          deploymentState: 'published',
          status:          'published',
          gtmVersionId:    rollResult.versionId,
          workspaceId:     rollResult.workspaceId,
          publishedAt:     firestoreService.serverTimestamp ? firestoreService.serverTimestamp() : null,
        });

        // ── STEP 11: Mark previous live version as rolled_back (best-effort) ───
        try {
          const currentVersions = await firestoreService.listVersions(clientId, { limit: 5 });
          const prevPublished = currentVersions.find(
            v => v.id !== versionDocId && v.status === 'published',
          );
          if (prevPublished && prevPublished.id) {
            await firestoreService.markVersionRolledBack(prevPublished.id);
          }
        } catch (markErr) {
          console.warn('[versions/rollback][' + deploymentId + '] markVersionRolledBack failed (non-fatal):', markErr.message);
        }

        // ── STEP 12: Audit log — success ──────────────────────────────────────
        await firestoreService.saveDeploymentLog({
          deploymentId,
          clientId,
          action:      'rollback_success',
          actor:       'admin',
          targetVersion,
          newVersion:  newVersionNum,
          gtmVersionId: rollResult.versionId,
          success:     true,
          metadata:    { drift: driftInfo.driftDetected, driftWarning: driftInfo.warning },
        }).catch(() => {});

        sendJSON(res, 200, {
          ok:             true,
          clientId,
          deploymentId,
          rolledBackFrom: targetVersion,
          newVersion:     newVersionNum,
          gtmVersionId:   rollResult.versionId,
          drift:          driftInfo.driftDetected ? { detected: true, warning: driftInfo.warning } : null,
        });

      } catch (e) {
        console.error('[versions/rollback][' + deploymentId + '] FAILED:', e.message);

        // ── FAILURE RECOVERY: mark version record as failed (do NOT leave as 'building') ──
        if (versionDocId) {
          firestoreService.updateVersion(versionDocId, {
            deploymentState: 'failed',
            status:          'failed',
            failureReason:   e.message,
          }).catch(() => {});
        }

        // Audit log — failure
        firestoreService.saveDeploymentLog({
          deploymentId,
          clientId,
          action:  'rollback_failed',
          actor:   'admin',
          targetVersion,
          success: false,
          error:   e.message,
        }).catch(() => {});

        sendJSON(res, 500, { error: e.message, deploymentId });

      } finally {
        // ── ALWAYS release the lock, even on crash ─────────────────────────────
        if (lockAcquired) {
          firestoreService.releaseDeploymentLock(clientId).catch(() => {});
        }
      }
    });
    return;
  }

  // ── GET /api/deployments/:clientId ───────────────────────────────────────────
  // Returns two parallel arrays that the frontend JOIN by deploymentId.
  //
  // JOIN CONTRACT:
  //   logs[].deploymentId  — always present for rollback and recovery events.
  //   versions[].deploymentId — present for rollbacks; NULL for regular publishes.
  //
  // Regular publishes (from /api/internal/run-provision-job) only create a
  // container_versions doc with no deployment log and deploymentId === null.
  // Rollbacks always produce: one version doc + ≥2 log entries (start + success/fail).
  //
  // Frontend algorithm:
  //   const byId = {};
  //   versions.forEach(v => { byId[v.deploymentId || v.id] = { ...v, logs: [] }; });
  //   logs.forEach(l => { if (byId[l.deploymentId]) byId[l.deploymentId].logs.push(l); });
  //
  // Auth: admin token.
  /*
  Response:
  {
    "ok": true,
    "clientId": "uid_abc123",
    "logs": [
      {
        "id": "doc_id",
        "deploymentId": "rb_lxyz9a",
        "action": "rollback_success",
        "actor": "admin",
        "targetVersion": 11,
        "newVersion": 12,
        "gtmVersionId": "46",
        "success": true,
        "error": null,
        "timestamp": "2026-06-30T10:00:00.000Z",
        "metadata": { "drift": false, "driftWarning": null }
      }
    ],
    "versions": [
      {
        "id": "doc_id",
        "version": 12,
        "deploymentId": "rb_lxyz9a",
        "deploymentType": "rollback",
        "deploymentState": "published",
        "status": "published",
        "publishedAt": "2026-06-30T10:00:00.000Z",
        "publishedBy": "admin/rollback",
        "gtmVersionId": "46",
        "driftDetected": false,
        "failureReason": null,
        "rolledBackFrom": 11
      }
    ]
  }
  Errors:
    401 { "error": "Unauthorized" }
    503 { "error": "Firestore not configured" }
    500 { "error": "..." }
  */
  const _depLogsMatch = req.url.split('?')[0].match(/^\/api\/deployments\/([^/]+)$/);
  if (req.method === 'GET' && _depLogsMatch) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) return sendJSON(res, 503, { error: 'Firestore not configured' });
    const clientId = decodeURIComponent(_depLogsMatch[1]);
    (async () => {
      try {
        const [logs, versions] = await Promise.all([
          firestoreService.listDeploymentLogs(clientId, { limit: 50 }),
          firestoreService.listVersions(clientId, { limit: 20 }),
        ]);
        const _ts = v => v && v.toDate ? v.toDate().toISOString() : (v || null);
        sendJSON(res, 200, {
          ok: true,
          clientId,
          logs: logs.map(l => ({
            id:            l.id,
            deploymentId:  l.deploymentId  || null,
            action:        l.action        || null,
            actor:         l.actor         || null,
            targetVersion: l.targetVersion || null,
            newVersion:    l.newVersion    || null,
            gtmVersionId:  l.gtmVersionId  || null,
            success:       l.success,
            error:         l.error         || null,
            timestamp:     _ts(l.timestamp),
            metadata:      l.metadata      || null,
          })),
          versions: versions.map(v => ({
            id:              v.id,
            version:         v.version,
            deploymentId:    v.deploymentId    || null,
            deploymentType:  v.deploymentType  || 'publish',
            deploymentState: v.deploymentState || 'published',
            status:          v.status          || 'published',
            publishedAt:     _ts(v.publishedAt),
            publishedBy:     v.publishedBy     || null,
            gtmVersionId:    v.gtmVersionId    || null,
            driftDetected:   v.driftDetected   || false,
            failureReason:   v.failureReason   || null,
            rolledBackFrom:  v.rolledBackFrom  || null,
          })),
        });
      } catch (e) {
        console.error('[deployments] error:', e.message);
        sendJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── GET /api/audit/:clientId ─────────────────────────────────────────────────
  // Admin audit log with serialized timestamps.
  // Auth: ADMIN_TOKEN (same _requireAdmin as all /api/* admin routes).
  // Distinct from /api/v1/clients/:id/audit-log which requires Firebase JWT.
  // Query params:
  //   limit  — integer 1-200, default 50
  //   before — ISO timestamp string (cursor for next page)
  /*
  Response:
  {
    "ok": true,
    "clientId": "uid_abc123",
    "logs": [
      {
        "id": "firestore_doc_id",
        "occurredAt": "2026-06-30T12:00:00.000Z",
        "actorType": "admin",
        "actorId": "uid_admin",
        "action": "client.profile.update",
        "entityType": "client",
        "entityId": "uid_abc123",
        "diff": { "name": { "from": "Old", "to": "New" } },
        "ipAddress": "1.2.3.4"
      }
    ],
    "total": 10
  }
  Errors:
    401 { "error": "Unauthorized" }
    503 { "error": "Firestore not configured" }
    500 { "error": "..." }
  */
  const _auditMatch = req.url.split('?')[0].match(/^\/api\/audit\/([^/]+)$/);
  if (req.method === 'GET' && _auditMatch) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) return sendJSON(res, 503, { error: 'Firestore not configured' });
    const clientId = decodeURIComponent(_auditMatch[1]);
    const _qp  = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    const limit  = Math.min(parseInt(_qp.get('limit') || '50', 10), 200);
    const before = _qp.get('before') || null;
    (async () => {
      try {
        const rawLogs = await firestoreService.queryAuditLogs(clientId, { limit, before });
        // Serialize every Firestore Timestamp to ISO string before JSON transport.
        const _ts = v => v && v.toDate ? v.toDate().toISOString() : (typeof v === 'string' ? v : null);
        const logs = rawLogs.map(l => ({
          id:         l.id,
          occurredAt: _ts(l.occurredAt),
          actorType:  l.actorType  || null,
          actorId:    l.actorId    || null,
          action:     l.action     || null,
          entityType: l.entityType || null,
          entityId:   l.entityId   || null,
          diff:       l.diff       || null,
          ipAddress:  l.ipAddress  || null,
        }));
        sendJSON(res, 200, { ok: true, clientId, logs, total: logs.length });
      } catch (e) {
        console.error('[audit] error:', e.message);
        sendJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── GET /api/health/:clientId ─────────────────────────────────────────────────
  // Unified tracking health report. Composes:
  //   diagnostic_results + client_health_cache + latest version + platform health
  //   + active deployment count from recovery system.
  // Auth: admin token.
  /*
  Response:
  {
    "ok": true,
    "clientId": "uid_abc123",
    "trackingHealthScore": 75,
    "ga4": true,
    "meta": false,
    "googleAds": true,
    "tiktok": false,
    "lastEventReceived": "2026-06-30T10:00:00.000Z",
    "lastPublish": "2026-06-30T10:00:00.000Z",
    "lastVersion": 12,
    "driftDetected": false,
    "activeDeployment": false,
    "stuckDeployments": 0,
    "lastRecovery": null,
    "platformHealth": {},
    "alerts": [
      { "message": "1 deployment(s) currently active", "severity": "info" }
    ],
    "computedAt": null
  }
  Notes:
    - trackingHealthScore: 0-100. Sourced from diagnostic_results.healthScore,
      then client_health_cache.healthScore, then computed as 25pts per active platform.
    - driftDetected: sourced from container_versions (latest record).
    - alerts: derived from diag.alerts, diag.issues, + active deployment count.
    - ga4/meta/googleAds/tiktok: boolean — true means platform is active.
  Errors:
    401 { "error": "Unauthorized" }
    503 { "error": "Firestore not configured" }
    500 { "error": "..." }
  */
  const _healthMatch = req.url.split('?')[0].match(/^\/api\/health\/([^/]+)$/);
  if (req.method === 'GET' && _healthMatch) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) return sendJSON(res, 503, { error: 'Firestore not configured' });
    const clientId = decodeURIComponent(_healthMatch[1]);
    (async () => {
      try {
        const [diagResult, healthCache, versions, platformHealth, activeDeployments] = await Promise.all([
          firestoreService.getDiagnosticResult(clientId).catch(() => null),
          firestoreService.getHealthCache(clientId).catch(() => null),
          firestoreService.listVersions(clientId, { limit: 1 }).catch(() => []),
          firestoreService.getPlatformHealth().catch(() => ({})),
          firestoreService.countActiveDeployments().catch(() => 0),
        ]);

        const lastVersion = versions[0] || null;

        // Derive per-platform status from diagnostic result or health cache
        const diag = diagResult || healthCache || {};
        const platforms = {
          ga4:       !!(diag.ga4Active        || diag.ga4),
          meta:      !!(diag.metaActive       || diag.meta),
          googleAds: !!(diag.googleAdsActive  || diag.googleAds),
          tiktok:    !!(diag.tiktokActive     || diag.tiktok),
        };

        // Health score: 25 pts per active platform (max 4 platforms)
        const activeCount   = Object.values(platforms).filter(Boolean).length;
        const platformCount = Object.values(platforms).filter(v => v !== undefined).length || 4;
        const score = diagResult && diagResult.healthScore != null
          ? diagResult.healthScore
          : healthCache && healthCache.healthScore != null
            ? healthCache.healthScore
            : Math.round((activeCount / platformCount) * 100);

        const alerts = (diag.alerts || diag.issues || []).map(a =>
          typeof a === 'string' ? { message: a, severity: 'warning' } : a,
        );

        // Add alert if there are active (potentially stuck) deployments
        if (activeDeployments > 0) {
          alerts.push({ message: `${activeDeployments} deployment(s) currently active`, severity: 'info' });
        }

        sendJSON(res, 200, {
          ok:                   true,
          clientId,
          trackingHealthScore:  score,
          ga4:                  platforms.ga4,
          meta:                 platforms.meta,
          googleAds:            platforms.googleAds,
          tiktok:               platforms.tiktok,
          lastEventReceived:    diag.lastEventAt
            ? (diag.lastEventAt.toDate ? diag.lastEventAt.toDate().toISOString() : diag.lastEventAt)
            : null,
          lastPublish:          lastVersion && lastVersion.publishedAt
            ? (lastVersion.publishedAt.toDate ? lastVersion.publishedAt.toDate().toISOString() : lastVersion.publishedAt)
            : null,
          lastVersion:          lastVersion ? lastVersion.version : null,
          // driftDetected: sourced from the most recent container_versions doc.
          // Only rollback deployments set this; regular publishes default to false.
          driftDetected:        lastVersion ? (lastVersion.driftDetected || false) : false,
          activeDeployment:     activeDeployments > 0,
          stuckDeployments:     0,           // filled by recovery job on next sweep
          lastRecovery:         null,        // filled when recovery runs
          platformHealth,
          alerts,
          computedAt:           diag.computedAt || diag.updatedAt || null,
        });
      } catch (e) {
        console.error('[health] error:', e.message);
        sendJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // POST /api/admin/client/:uid — update client fields (status, plan, ...)
  const _cliUpdMatch = req.url.split('?')[0].match(/^\/api\/admin\/client\/([^/]+)$/);
  if (req.method === 'POST' && _cliUpdMatch) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    const uid = decodeURIComponent(_cliUpdMatch[1]);
    parseJsonBody(req, res, body => {
      firestoreService.updateClient(uid, body || {})
        .then(upd => sendJSON(res, 200, { ok: true, update: upd }))
        .catch(e => sendJSON(res, 500, { error: e.message }));
    });
    return;
  }

  // DELETE /api/admin/client/:uid — delete a client document
  if (req.method === 'DELETE' && _cliUpdMatch) {
    if (!(await _requireAdmin())) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    const uid = decodeURIComponent(_cliUpdMatch[1]);
    firestoreService.deleteClient(uid)
      .then(() => sendJSON(res, 200, { ok: true }))
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SERVER-SIDE TRACKING ENDPOINTS  /api/ss/*
  //
  // Authenticated via Firebase ID token (Authorization: Bearer <ID_TOKEN>).
  // The token is verified server-side via firebase-admin.auth().verifyIdToken();
  // we use decoded.uid as the canonical clientId — the X-Client-Id header is
  // accepted only when present and must equal decoded.uid (defense-in-depth
  // against header-confusion bugs in upstream layers). Tokens are AES-256-GCM
  // encrypted at rest. See ssAuthAndRate() below.
  // ══════════════════════════════════════════════════════════════════════════

  if (req.url.startsWith('/api/ss/')) {

    // ── Shared SS helpers ──────────────────────────────────────────────────

    // Verify Firebase ID token + apply rate-limit. Returns { clientId, email,
    // decoded } on success, or null after writing the appropriate error
    // response (401/403/429/503). All callers MUST `if (!auth) return;`.
    async function ssAuthAndRate() {
      // Auth setup must be ready — same env var as Firestore.
      if (!firestoreService.isConfigured()) {
        sendJSON(res, 503, { error: 'Firebase Auth غير مُهيَّأ على هذا الخادم', hint: 'اضبط FIREBASE_SA_KEY_JSON في ملف .env' });
        return null;
      }

      const authz = (req.headers['authorization'] || req.headers['Authorization'] || '').trim();
      if (!authz) {
        sendJSON(res, 401, { error: 'Authorization header مطلوب', hint: 'أرسل Authorization: Bearer <Firebase ID token>' });
        return null;
      }
      const m = /^Bearer\s+(.+)$/i.exec(authz);
      if (!m) {
        sendJSON(res, 401, { error: 'Authorization header غير صحيح — استخدم Bearer scheme' });
        return null;
      }
      const idToken = m[1].trim();
      // Firebase ID tokens are JWTs (~1.0–2.5 KB). 8 KB is a generous upper
      // bound — anything larger is almost certainly garbage and we reject
      // before paying the verifyIdToken round-trip.
      if (!idToken || idToken.length > 8192) {
        sendJSON(res, 401, { error: 'الـ token فارغ أو طويل جداً' });
        return null;
      }

      let decoded;
      try {
        decoded = await firestoreService.verifyIdToken(idToken);
      } catch (e) {
        // Don't leak token internals to clients. Log server-side, surface
        // a generic 401 with the firebase error code (auth/id-token-expired etc.)
        // so the frontend can refresh and retry on its own.
        const code = (e && e.code) || 'auth/invalid-id-token';
        sendJSON(res, 401, { error: 'Firebase ID token غير صالح', code: String(code) });
        return null;
      }
      if (!decoded || !decoded.uid) {
        sendJSON(res, 401, { error: 'Firebase token بدون uid' });
        return null;
      }

      // If the client also sent X-Client-Id (legacy / debugging), it MUST
      // match the verified uid. Mismatches are a sign of a broken caller or
      // an attempted impersonation — fail closed with 403.
      const claimed = (req.headers['x-client-id'] || '').trim().slice(0, 128);
      if (claimed && claimed !== decoded.uid) {
        sendJSON(res, 403, { error: 'X-Client-Id لا يطابق الـ Firebase UID' });
        return null;
      }

      const clientId = decoded.uid;
      const rl = rateLimiter.check(clientId);
      if (!rl.allowed) {
        const msg = rl.locked ? 'حسابك محظور مؤقتاً بسبب أخطاء متكررة' : 'تجاوزت الحد المسموح (100 طلب/دقيقة)';
        res.writeHead(429, { ...corsHeaders(), ...securityHeaders(), 'Retry-After': Math.ceil((rl.resetAt - Date.now()) / 1000) });
        res.end(JSON.stringify({ error: msg, resetAt: rl.resetAt }));
        return null;
      }

      return { clientId, email: decoded.email || null, decoded };
    }

    function ssRequireFirestore() {
      if (!firestoreService.isConfigured()) {
        sendJSON(res, 503, { error: 'Firestore غير مُهيَّأ على هذا الخادم', hint: 'اضبط FIREBASE_SA_KEY_JSON في ملف .env' });
        return false;
      }
      return true;
    }

    function ssRequireCrypto() {
      try { cryptoVault.getMasterKey(); return true; }
      catch (e) {
        sendJSON(res, 503, { error: 'MASTER_ENCRYPTION_KEY غير مُهيَّأ', hint: 'شغّل: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\')" ثم أضف النتيجة في .env' });
        return false;
      }
    }

    // Categorise provider errors so the response code matches the cause:
    //   missing dep / invalid URL / programmer error → 500  (server-side bug)
    //   SSRF guard hit / private IP                  → 400  (caller mistake)
    //   actual upstream failure (timeout, DNS, etc.) → 502  (bad gateway)
    // Returns { status, payload } for the caller to pass to sendJSON.
    function ssClassifyError(e, fallbackArMsg) {
      const msg = (e && e.message) || String(e);
      if (/axios is not installed|firebase-admin is not installed/i.test(msg)) {
        return { status: 500, payload: { error: 'مكتبة مفقودة على الخادم', detail: msg, hint: 'شغّل npm install على الخادم ثم أعد التشغيل' } };
      }
      if (/Private\/internal IP|Hostname is blocked|Port .* is not allowed|Only http\/https|blocked range|blocked by SSRF|hostname is blocked|zone identifier|Invalid URL/i.test(msg)) {
        return { status: 400, payload: { error: 'الرابط مرفوض (SSRF guard)', detail: msg } };
      }
      return { status: 502, payload: { error: fallbackArMsg + ': ' + msg } };
    }

    // Body parser dedicated to /api/ss/* — small cap (64 KB), surfaces 413 properly.
    // Delegates to the top-level parseJsonBody helper (which handles 413/400 + empty).
    function ssParseBody(cb) {
      parseJsonBody(req, res, cb, SS_BODY_LIMIT);
    }

    function ssGetProvider(config) {
      const provider = (config && config.provider) || 'selfhosted';
      switch (provider) {
        case 'stape':    return new StapeProvider(config);
        case 'gcloud':   return new GoogleCloudProvider(config);
        default:         return new SelfHostedProvider(config);
      }
    }

    const ssPath = req.url.split('?')[0];

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/health-check?url=... — fetch a customer site through the server
    // to detect installed pixels without exposing customer URLs to third-party proxies.
    // Authenticated via Firebase token.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/health-check') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;

        const targetUrl = (req.url.includes('?')
          ? new URLSearchParams(req.url.split('?')[1]).get('url')
          : null) || '';

        // Basic presence check before calling validateTargetUrl for a cleaner
        // Arabic error message when the caller omits the parameter entirely.
        if (!targetUrl) {
          sendJSON(res, 400, { error: 'url param مطلوب ويجب أن يبدأ بـ http(s)://' });
          return;
        }

        try {
          // validateTargetUrl() throws with a descriptive English message for
          // any blocked protocol, private IP, internal hostname, or bad port.
          // safeFetch() calls it again on every redirect Location header, so
          // open-redirect SSRF chains are blocked at each hop, not just on
          // the initial URL.
          const { body } = await safeFetch(targetUrl, {
            maxRedirects : 3,
            timeoutMs    : 10_000,
            maxBodyBytes : 500 * 1024,
          });
          sendJSON(res, 200, { contents: body });
        } catch (e) {
          const msg = (e && e.message) || 'فشل الاتصال بالموقع';
          // SSRF guard errors → 400 (caller mistake, not upstream failure)
          const status = /SSRF guard|blocked|not allowed|Only http|Invalid URL|hostname/i.test(msg)
            ? 400 : 502;
          sendJSON(res, status, { error: msg });
        }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/config — return user's SS config (tokens redacted)
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/config') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        try {
          // getSSConfigPublic redacts encryptedTokens + stapeApiKey internally —
          // never leaks ciphertext, even if a future caller forgets to redact.
          const cfg = await firestoreService.getSSConfigPublic(clientId);
          if (!cfg) { sendJSON(res, 404, { error: 'لا يوجد إعداد Server-Side لهذا الحساب' }); return; }
          sendJSON(res, 200, { ok: true, config: cfg });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/validate-url — ping sGTM URL, return latency + status
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/validate-url') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        ssParseBody(async body => {
          const url = (body.url || '').trim();
          if (!url) return sendJSON(res, 400, { error: 'حقل url مطلوب' });
          if (!/^https?:\/\/.+\..+/.test(url)) return sendJSON(res, 400, { error: 'الرابط غير صالح — يجب أن يبدأ بـ https://' });

          // safeFetch: DNS resolved once, IP validated, connect to IP — no TOCTOU.
          // maxRedirects:0 — sGTM servers must not redirect; redirect here means misconfiguration.
          const t0 = Date.now();
          try {
            const { statusCode } = await safeFetch(url, {
              maxRedirects : 0,
              timeoutMs    : 5_000,
              maxBodyBytes : 512,
            });
            const latencyMs = Date.now() - t0;
            const valid = statusCode >= 200 && statusCode < 500;
            if (!valid) rateLimiter.recordError(clientId);
            else        rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, { ok: valid, valid, latencyMs, status: statusCode });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل الاتصال بالخادم'); sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/save-config — encrypt tokens + save to Firestore
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/save-config') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        if (!ssRequireCrypto()) return;

        ssParseBody(async body => {
          const { provider, serverUrl, platforms, tokens, stapeApiKey } = body;
          if (!provider) return sendJSON(res, 400, { error: 'حقل provider مطلوب' });
          if (!serverUrl && provider !== 'gcloud') return sendJSON(res, 400, { error: 'حقل serverUrl مطلوب' });

          try {
            // Encrypt each token
            // AAD = clientId + ':' + platform — binds each token's ciphertext to
            // its slot. Re-using a ciphertext under a different (clientId, platform)
            // pair will fail decryption.
            const encryptedTokens = {};
            const VALID_PLATFORMS = ['meta', 'tiktok', 'snapchat', 'ga4', 'mixpanel'];
            VALID_PLATFORMS.forEach(function (p) {
              const t = tokens && tokens[p];
              // '***CONFIGURED***' = unchanged (already stored) — skip re-encryption
              if (t && t !== '***CONFIGURED***') {
                encryptedTokens[p] = cryptoVault.encryptToken(t, clientId + ':' + p);
              }
            });

            // Merge with existing config (preserve tokens not updated)
            let existing = null;
            try { existing = await firestoreService.getSSConfig(clientId); } catch (_) {}

            const mergedTokens = Object.assign(
              {},
              (existing && existing.encryptedTokens) || {},
              encryptedTokens
            );

            const mergedStapeKey = (stapeApiKey && stapeApiKey !== '***CONFIGURED***')
              ? cryptoVault.encryptToken(stapeApiKey, clientId + ':stape')
              : (existing && existing.stapeApiKey) || null;

            await firestoreService.saveSSConfig(clientId, {
              provider,
              serverUrl:        serverUrl   || '',
              platforms:        Array.isArray(platforms) ? platforms : [],
              encryptedTokens:  mergedTokens,
              stapeApiKey:      mergedStapeKey,
              stapeContainerId: body.stapeContainerId || (existing && existing.stapeContainerId) || null,
            });

            sendJSON(res, 200, { ok: true, message: 'تم حفظ الإعدادات بنجاح' });
          } catch (e) {
            sendJSON(res, 500, { error: 'فشل الحفظ: ' + e.message });
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/test-event — send test event to sGTM, return trace
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/test-event') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        ssParseBody(async body => {
          const url = (body.serverUrl || '').trim();
          if (!url) return sendJSON(res, 400, { error: 'حقل serverUrl مطلوب' });
          if (!/^https?:\/\/.+\..+/.test(url)) return sendJSON(res, 400, { error: 'الرابط غير صالح' });

          const ts = Date.now();
          const testPayload = {
            v:          '2',
            tid:        body.measurementId || 'G-TEST000001',
            en:         'purchase',
            _et:        String(ts),
            ep_event_id: 'test_' + ts.toString(36).toUpperCase(),
            ep_currency: 'SAR',
            epn_value:   '100',
            ep_transaction_id: 'TEST_' + ts.toString(36).toUpperCase(),
            // user data
            uid:  'test_user_et',
            up_external_id: 'test_user_et',
          };

          // Hardened POST — mirrors safeFetch internals:
          // DNS resolved once, IP validated, http.request connects to the IP
          // (not the hostname), so there is no TOCTOU window.
          try {
            const endpoint   = url.replace(/\/$/, '') + '/g/collect';
            const endParsed  = new URL(endpoint);
            validateTargetUrl(endpoint); // sync: protocol / port / IP-literal guard
            const rawHost    = endParsed.hostname; // may include [] brackets for IPv6
            const resolvedIp = await resolveHostname(rawHost, 5000);
            if (isBlockedIp(resolvedIp)) {
              throw new Error('Resolved IP is in a blocked range: ' + resolvedIp);
            }
            const port     = endParsed.port
              ? parseInt(endParsed.port, 10)
              : (endParsed.protocol === 'https:' ? 443 : 80);
            const bareHost = (rawHost.startsWith('[') && rawHost.endsWith(']'))
              ? rawHost.slice(1, -1) : rawHost;
            const lib      = endParsed.protocol === 'https:' ? https : http;
            const postData = JSON.stringify(testPayload);
            const reqOpts  = {
              hostname : resolvedIp,
              port,
              path     : (endParsed.pathname || '/') + endParsed.search,
              method   : 'POST',
              headers  : {
                'Host'           : (port === 80 || port === 443) ? bareHost : (bareHost + ':' + port),
                'Content-Type'   : 'application/json',
                'Content-Length' : Buffer.byteLength(postData),
                'User-Agent'     : 'EasyTrack-SST-Tester/1.0',
                'Connection'     : 'close',
              },
              timeout : 5000,
            };
            if (endParsed.protocol === 'https:') reqOpts.servername = bareHost;

            const t0 = Date.now();
            const evtResult = await new Promise((resolve, reject) => {
              const evtReq = lib.request(reqOpts, apiRes => {
                let respBody = '';
                apiRes.setEncoding('utf8');
                apiRes.on('data', c => { if (respBody.length < 4096) respBody += c; });
                apiRes.on('end', () => resolve({ statusCode: apiRes.statusCode, body: respBody }));
              });
              evtReq.on('timeout', () => { evtReq.destroy(); reject(new Error('Test event request timed out')); });
              evtReq.on('error', reject);
              evtReq.write(postData);
              evtReq.end();
            });

            const latencyMs = Date.now() - t0;
            const ok        = evtResult.statusCode >= 200 && evtResult.statusCode < 300;
            if (!ok) rateLimiter.recordError(clientId);
            else     rateLimiter.recordSuccess(clientId);

            let respBody = null;
            try { respBody = JSON.parse(evtResult.body); }
            catch (_) { respBody = evtResult.body.slice(0, 200) || null; }

            sendJSON(res, 200, {
              ok,
              status:    evtResult.statusCode,
              latencyMs,
              body:      respBody,
              error:     ok ? null : ('HTTP ' + evtResult.statusCode),
              eventId:   testPayload.ep_event_id,
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل إرسال الحدث'); sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/deploy-stape — DEPRECATED (returns 410 Gone)
    // The Stape API auto-deploy was removed in favour of the new client+server
    // flow: /api/managed/create-container with mode=client_server creates the
    // server container in GTM and returns its containerConfig blob. Users
    // deploy that blob themselves to Stape / Cloud Run / Docker, then call
    // /api/ss/wire-transport to wire the web container.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/deploy-stape') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        sendJSON(res, 410, {
          error: 'هذه النقطة ملغاة',
          hint:  'استخدم /api/managed/create-container مع mode=client_server للحصول على containerConfig، ثم انشره بنفسك على Stape/Cloud Run.',
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/gcp-instructions — return guided GCP deployment steps
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/gcp-instructions') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const configBody = (req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('configBody') : null) || '';
        const region     = (req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('region') : null) || 'me-central1';

        try {
          const provider = new GoogleCloudProvider();
          const result   = await provider.deployContainer({ configBody, region });
          sendJSON(res, 200, { ok: true, ...result });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/gcp-confirm-url — validate Cloud Run URL after manual deploy
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/gcp-confirm-url') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        ssParseBody(async body => {
          const url = (body.url || '').trim();
          if (!url) return sendJSON(res, 400, { error: 'حقل url مطلوب' });

          // safeFetch: DNS resolved once, IP validated, connect to IP — no TOCTOU.
          // Replaces provider.validateUrl() which used assertSafeUrl+axios (TOCTOU).
          const t0 = Date.now();
          try {
            const { statusCode } = await safeFetch(url, {
              maxRedirects : 0,
              timeoutMs    : 5_000,
              maxBodyBytes : 512,
            });
            const latencyMs = Date.now() - t0;
            const valid     = statusCode >= 200 && statusCode < 500;
            if (!valid) rateLimiter.recordError(clientId);
            else        rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok:      valid,
              valid,
              latencyMs,
              status:  statusCode,
              message: valid
                ? 'تم التحقق — الخادم يستجيب بنجاح (' + latencyMs + 'ms)'
                : 'الخادم لا يستجيب — تأكد من اكتمال الـ deploy على Cloud Run',
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل التحقق'); sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/wire-transport — patch web container's GA4 tag with sGTM URL
    // Body: { sgtmUrl }   (web container ids come from the user's ss_configs)
    // After the user pastes back the deployed sGTM URL, this route writes
    // transport_url onto the GA4 Configuration tag, creates a new container
    // version, and publishes it. Marks transportUrlWired=true in Firestore.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/wire-transport') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;

        ssParseBody(async body => {
          const sgtmUrl = (body.sgtmUrl || '').trim();
          if (!sgtmUrl)              return sendJSON(res, 400, { error: 'حقل sgtmUrl مطلوب' });
          if (!/^https:\/\//.test(sgtmUrl)) return sendJSON(res, 400, { error: 'يجب أن يبدأ sgtmUrl بـ https://' });

          try {
            const cfg = await firestoreService.getSSConfig(clientId);
            if (!cfg)                       return sendJSON(res, 404, { error: 'لا يوجد إعداد Server-Side لهذا الحساب' });
            if (cfg.mode !== 'client_server') return sendJSON(res, 400, { error: 'الـ mode الحالي ليس client_server — لا يوجد web container للربط' });
            if (!cfg.webContainerId || !cfg.webWorkspaceId) {
              return sendJSON(res, 400, { error: 'بيانات الـ web container ناقصة في الإعداد' });
            }

            const result = await gtmService.setGA4TransportUrl(
              cfg.webContainerId, cfg.webWorkspaceId, sgtmUrl,
            );

            await firestoreService.saveSSConfig(clientId, {
              ...cfg,
              serverUrl:           sgtmUrl,
              transportUrlWired:   true,
              transportUrlWiredAt: new Date(),
            });

            rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok: true,
              tagId:        result.tagId,
              versionId:    result.versionId,
              transportUrl: result.transportUrl,
              message:      'تم ربط الـ web container بـ sGTM ونشره بنجاح',
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل ربط الـ transport URL');
            sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // DELETE /api/ss/config — wipe user's SS config from Firestore
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && ssPath === '/api/ss/config') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        try {
          await firestoreService.deleteSSConfig(clientId);
          sendJSON(res, 200, { ok: true, message: 'تم حذف إعدادات Server-Side Tracking' });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/health — check sGTM container uptime
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/health') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const url = (req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('url') : null) || '';
        if (!url) { sendJSON(res, 400, { error: 'query param url مطلوب' }); return; }

        // safeFetch: DNS resolved once, IP validated, connect to IP — no TOCTOU.
        const t0 = Date.now();
        try {
          const { statusCode } = await safeFetch(url, {
            maxRedirects : 0,
            timeoutMs    : 5_000,
            maxBodyBytes : 512,
          });
          const latencyMs = Date.now() - t0;
          sendJSON(res, 200, { ok: true, healthy: statusCode >= 200 && statusCode < 500, latencyMs, status: statusCode });
        } catch (e) {
          sendJSON(res, 502, { error: e.message });
        }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/create-containers
    // Authenticated via Firebase token.
    // Body: { configJson, projectName?, ga4MeasurementId?, ga4Events?,
    //         googleAdsEvents?, ssEvents?, ssPlatforms? }
    // Spawns a GTM provisioning job (mode=client_server) and returns jobId
    // immediately. Poll GET /api/managed/job/:jobId for progress.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/create-containers') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId, email } = auth;
        if (!ssRequireFirestore()) return;

        ssParseBody(async body => {
          // dryRun: simulate provisioning without real GTM/Stape calls. Opt-in
          // and gated by ALLOW_DRY_RUN=1 so it's never reachable in normal prod.
          const dryRun = body.dryRun === true && process.env.ALLOW_DRY_RUN === '1';

          if (!dryRun && !gtmService.isConfigured()) {
            return sendJSON(res, 503, {
              error: 'GTM غير مُهيَّأ على هذا الخادم',
              hint:  'اضبط GTM_SA_KEY_JSON و GTM_ACCOUNT_ID في .env',
            });
          }

          const {
            configJson, projectName,
            ga4MeasurementId, ga4Events, googleAdsEvents,
            ssEvents, ssPlatforms,
          } = body;

          // configJson is optional — backend uses a minimal empty template if absent.
          const finalConfigJson = configJson ||
            { containerVersion: { variable: [], trigger: [], tag: [] } };

          const activeCount = await firestoreService.countActiveContainers().catch(() => 0);
          if (activeCount >= 490) {
            return sendJSON(res, 507, { error: 'حساب GTM وصل للحد الأقصى (490 container)' });
          }

          // Bundle the worker's input into the job doc; the Cloud Tasks payload
          // then carries only { jobType, jobId }.
          const input = {
            clientId, email, projectName,
            configJson: finalConfigJson,
            ssEvents, ssPlatforms, ga4MeasurementId, ga4Events, googleAdsEvents,
            dryRun,
          };

          // Create the job doc BEFORE responding so an immediate poll can't 404.
          const jobId = _newJobId();
          try {
            await firestoreService.saveJob(jobId, { status: 'pending', stage: 'queued', clientId, jobType: 'ss', input, startedAt: Date.now() });
          } catch (e) {
            return sendJSON(res, 500, { error: 'Failed to create provisioning job: ' + e.message });
          }

          // Hand off to the worker (Cloud Task on GCP; in-process off-GCP).
          try {
            await _dispatchProvisionJob('ss', jobId);
          } catch (e) {
            await _setJob(jobId, {
              status: 'failed', stage: 'enqueue_error',
              error:  'Failed to enqueue provisioning job: ' + e.message,
              finishedAt: Date.now(),
            });
            return sendJSON(res, (e.status && e.status >= 400 && e.status < 600) ? e.status : 502, { error: 'Failed to enqueue provisioning job: ' + e.message });
          }

          sendJSON(res, 202, { ok: true, jobId });
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/full-status
    // Returns combined container + SS config data for the Overview section.
    // Tokens are always redacted. Container snippets are included.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/full-status') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        try {
          const [ssCfg, containers] = await Promise.all([
            firestoreService.getSSConfigPublic(clientId).catch(() => null),
            firestoreService.listContainersByClient(clientId).catch(() => []),
          ]);

          // Prefer the client_server container; fallback to most-recent
          const sorted = (containers || []).sort((a, b) => {
            const ta = (a.updatedAt && a.updatedAt.toMillis) ? a.updatedAt.toMillis() : 0;
            const tb = (b.updatedAt && b.updatedAt.toMillis) ? b.updatedAt.toMillis() : 0;
            return tb - ta;
          });
          const csContainer = sorted.find(c => c.mode === 'client_server') || sorted[0] || null;

          sendJSON(res, 200, {
            ok: true,
            ss: ssCfg || null,
            container: csContainer ? {
              webGtmId:    csContainer.gtmPublicId              || null,
              serverGtmId: csContainer.serverContainerPublicId  || null,
              snippetHead: csContainer.snippetHead              || null,
              snippetBody: csContainer.snippetBody              || null,
              platforms:   csContainer.platforms                || [],
              events:      csContainer.events                   || [],
              published:   csContainer.published                || false,
              mode:        csContainer.mode                     || 'client',
            } : null,
          });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // Unknown /api/ss/* path
    sendJSON(res, 404, { error: 'SS endpoint غير موجود: ' + ssPath });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CLIENT PROFILE API  /api/v1/*
  // Auth: Firebase ID token — Authorization: Bearer <token>
  // Admin role: Firebase custom claim  decoded.admin === true
  // Self-access: decoded.uid === targetClientId
  // ══════════════════════════════════════════════════════════════════════════

  if (req.url.startsWith('/api/v1/')) {
    const v1Path   = req.url.split('?')[0];
    const v1Params = req.url.includes('?')
      ? new URLSearchParams(req.url.split('?')[1])
      : new URLSearchParams();

    // ── GET /api/v1/healthz — unauthenticated liveness probe ───────────────
    if (req.method === 'GET' && v1Path === '/api/v1/healthz') {
      sendJSON(res, 200, { ok: true, ts: new Date().toISOString() });
      return;
    }

    // ── GET /api/v1/metrics — in-process operational metrics ──────────────
    // Returns Prometheus-style counters + DLQ queue depth + alert status.
    // Secured by ADMIN_TOKEN to prevent public exposure of operational data.
    if (req.method === 'GET' && v1Path === '/api/v1/metrics') {
      const adminToken = (process.env.ADMIN_TOKEN || '').trim();
      if (adminToken) {
        const provided = (req.headers['x-admin-token'] || '').trim();
        if (!provided || provided.length !== adminToken.length ||
            !require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(adminToken))) {
          sendJSON(res, 401, { error: 'X-Admin-Token required' });
          return;
        }
      }
      (async () => {
        const snap = metrics.snapshot();
        let dlqDepth = null;
        let dlqOldestAgeMs = null;
        if (firestoreService.isConfigured()) {
          try {
            const dlqStats = await firestoreService.getDlqStats();
            dlqDepth      = dlqStats.depth;
            dlqOldestAgeMs = dlqStats.oldestAgeMs;
          } catch (_) {}
        }
        const alerts = metrics.checkAlerts(dlqDepth, dlqOldestAgeMs);
        sendJSON(res, 200, {
          ...snap,
          dlq: { depth: dlqDepth, oldestAgeMs: dlqOldestAgeMs },
          alerts,
          healthy: alerts.length === 0,
        });
      })();
      return;
    }

    // ── POST /api/v1/internal/dlq — sGTM failed-event ingest ─────────────
    // Called by _fireDLQ() in the sGTM template when a CAPI send fails.
    // Auth: BEACON_SECRET HMAC (same as beacon) or INTERNAL_WORKER_SECRET header
    // so the sGTM template can authenticate using the shared secret it already has.
    // The dlq-worker picks up these records and retries with exponential back-off.
    if (req.method === 'POST' && v1Path === '/api/v1/internal/dlq') {
      if (!firestoreService.isConfigured()) {
        sendJSON(res, 503, { error: 'Firestore not configured' });
        return;
      }
      // Auth: accept either BEACON_SECRET HMAC (X-DLQ-Sig header) or the
      // internal worker secret (X-Internal-Token) so sGTM can call this without
      // a Firebase token, using the same BEACON_SECRET it uses for the beacon ping.
      const dlqSig      = (req.headers['x-dlq-sig']      || '').trim();
      const internalTok = (req.headers['x-internal-token'] || '').trim();
      const beaconSecret  = (process.env.BEACON_SECRET        || '').trim();
      const workerSecret  = (process.env.INTERNAL_WORKER_SECRET || '').trim();

      let authed = false;
      if (internalTok && workerSecret) {
        const a = Buffer.from(internalTok);
        const b = Buffer.from(workerSecret);
        authed  = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!authed && dlqSig && beaconSecret) {
        // sGTM signs: HMAC-SHA256(beaconSecret, event_id + '|' + timestamp)
        // Timestamp must be within ±5 minutes to prevent replay.
        const dlqTs  = parseInt(req.headers['x-dlq-ts'] || '0', 10);
        const ageSec = Math.abs(Date.now() / 1000 - dlqTs);
        if (ageSec <= 300) {
          const expected = crypto.createHmac('sha256', beaconSecret)
            .update((req.headers['x-dlq-event-id'] || '') + '|' + dlqTs)
            .digest('hex');
          const a = Buffer.from(dlqSig);
          const b = Buffer.from(expected);
          authed  = a.length === b.length && crypto.timingSafeEqual(a, b);
        }
      }
      // If neither secret is configured, accept unauthenticated (DLQ is ingest-only,
      // not a read endpoint — worst case an attacker fills the collection with junk).
      // Log a warning so operators know to configure secrets.
      if (!authed && (beaconSecret || workerSecret)) {
        sendJSON(res, 401, { error: 'DLQ auth failed' });
        return;
      }
      if (!beaconSecret && !workerSecret) {
        console.warn('[dlq] BEACON_SECRET and INTERNAL_WORKER_SECRET both unset — DLQ endpoint is unauthenticated');
      }

      parseJsonBody(req, res, async body => {
        if (!body || !body.event_name) {
          sendJSON(res, 400, { error: 'Missing event_name' });
          return;
        }

        // Classify: AUTH_ERROR events should NOT be queued for retry (they'll
        // immediately exhaust on the next worker tick anyway — skip the round-trip).
        const errCode = (body.error_code || 0);
        if (errCode === 401 || errCode === 403) {
          console.error('[dlq] AUTH_ERROR received — not queuing for retry.' +
            ' platform=' + body.destination + ' event_id=' + body.event_id +
            ' Rotate the CAPI token for customer_id=' + body.customer_id);
          sendJSON(res, 200, { ok: true, queued: false, reason: 'auth_error_not_retryable' });
          return;
        }

        try {
          const docId = await firestoreService.saveDlqEvent({
            eventId:          body.event_id          || '',
            eventName:        body.event_name,
            eventChecksum:    body.event_checksum     || '',
            platform:         body.destination        || '',
            // Field names must match what dlq-worker reads exactly.
            destination_url:  body.destination_url    || '',
            payload_snapshot: body.payload_snapshot   || '',
            headers_snapshot: body.headers_snapshot   || JSON.stringify({ 'Content-Type': 'application/json' }),
            customerId:       body.customer_id        || '',
            sessionId:        body.session_id         || '',
            anonymousId:      body.anonymous_id       || '',
            errorCode:        errCode,
            errorMessage:     body.error_message      || '',
            payloadSize:      body.payload_size        || 0,
            schemaVersion:    body.schema_version      || 1,
          });
          metrics.incDlqCreated();
          sendJSON(res, 202, { ok: true, queued: true, docId });
        } catch (e) {
          console.error('[dlq] saveDlqEvent failed:', e.message);
          sendJSON(res, 500, { error: e.message });
        }
      }, SS_BODY_LIMIT);
      return;
    }

    // ── GET /api/v1/internal/beacon — sGTM event presence ping ───────────────
    // Auth path A (Phase 2, API key):  ?key=&clientId=&event=
    // Auth path B (Phase 1, HMAC):     ?clientId=&event=&sig=&ts=
    // Cache-Control: no-store prevents proxies from collapsing writes into a
    // single cached 200, which would silently drop real pings.
    if (req.method === 'GET' && v1Path === '/api/v1/internal/beacon') {
      res.setHeader('Cache-Control', 'no-store');
      (async () => {
        const bClientId = v1Params.get('clientId') || '';
        const bEvent    = v1Params.get('event')    || '';
        const bApiKey   = v1Params.get('key')      || '';

        if (!bClientId || !bEvent) {
          sendJSON(res, 400, { error: 'clientId and event are required' });
          return;
        }

        let authenticated = false;

        if (bApiKey) {
          // ── Path A: per-client API key (sGTM beacon tag) ─────────────────
          const parsed = apiKeyService.parse(bApiKey);
          if (!parsed) {
            // Always call verify() to consume constant time regardless of format validity.
            apiKeyService.verify(bApiKey, _BEACON_DUMMY_HASH);
            sendJSON(res, 401, { error: 'invalid api key format' });
            return;
          }
          let keyDoc;
          try { keyDoc = await firestoreService.getApiKey(parsed.keyId); } catch (_) {}
          // Always verify — prevents timing oracle on whether the keyId exists.
          const hash  = (keyDoc && keyDoc.keyHash) || _BEACON_DUMMY_HASH;
          const valid = apiKeyService.verify(bApiKey, hash);
          if (!valid || !keyDoc || keyDoc.status !== 'active') {
            sendJSON(res, 401, { error: 'invalid or revoked api key' });
            return;
          }
          if (keyDoc.clientId !== bClientId) {
            sendJSON(res, 403, { error: 'api key does not belong to this client' });
            return;
          }
          authenticated = true;

        } else {
          // ── Path B: HMAC signature (Phase 1 — shared BEACON_SECRET) ──────
          const beaconSecret = (process.env.BEACON_SECRET || '').trim();
          if (!beaconSecret) {
            sendJSON(res, 503, { error: 'BEACON_SECRET is not configured' });
            return;
          }
          const bSig = v1Params.get('sig') || '';
          const bTs  = v1Params.get('ts')  || '';
          if (!bSig || !bTs) {
            sendJSON(res, 400, { error: 'sig and ts are required for HMAC auth' });
            return;
          }
          const tsNum  = parseInt(bTs, 10);
          const nowMin = Math.floor(Date.now() / 60000);
          if (isNaN(tsNum) || Math.abs(nowMin - tsNum) > 5) {
            sendJSON(res, 400, { error: 'beacon ts outside ±5 minute window' });
            return;
          }
          const expected = crypto.createHmac('sha256', beaconSecret)
            .update(bClientId + bEvent + bTs).digest('hex');
          let valid = false;
          try {
            const aBuf = Buffer.from(expected, 'hex');
            const bBuf = Buffer.from(bSig, 'hex');
            if (aBuf.length === bBuf.length) valid = crypto.timingSafeEqual(aBuf, bBuf);
          } catch (_) {}
          if (!valid) {
            sendJSON(res, 401, { error: 'invalid beacon signature' });
            return;
          }
          authenticated = true;
        }

        if (!authenticated) { sendJSON(res, 401, { error: 'authentication required' }); return; }

        if (!_BEACON_VALID_EVENTS.has(bEvent)) {
          sendJSON(res, 400, { error: 'unknown event type' });
          return;
        }

        // ── Bucket-based dedup ────────────────────────────────────────────────
        // One Firestore write per 5-minute bucket per (clientId, event).
        // Prevents write storms on high-traffic sites without masking outages.
        const bucket = Math.floor(Date.now() / _BEACON_BUCKET_MS);
        const ck     = `${bClientId}_${bEvent}`;
        if (_beaconCache.get(ck) === bucket) {
          sendJSON(res, 200, { ok: true });
          return;
        }
        _beaconCache.set(ck, bucket);

        try {
          await firestoreService.upsertEventTypeLastSeen(bClientId, bEvent);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // ── v1 auth helper — closure over req/res ──────────────────────────────
    // Mirrors ssAuthAndRate: verifies Firebase JWT, rejects revoked tokens,
    // applies per-uid rate limiting (100 req/min), returns {clientId, email, decoded}.
    // All callers MUST `if (!auth) return;` — null means response already sent.
    async function v1Auth() {
      if (!firestoreService.isConfigured()) {
        sendJSON(res, 503, { error: 'Firebase Auth is not configured', hint: 'Set FIREBASE_SA_KEY_JSON' });
        return null;
      }
      const authz = (req.headers['authorization'] || req.headers['Authorization'] || '').trim();
      if (!authz) {
        sendJSON(res, 401, { error: 'Authorization header required', hint: 'Send Authorization: Bearer <Firebase ID token>' });
        return null;
      }
      if (!authz.toLowerCase().startsWith('bearer ')) {
        sendJSON(res, 401, { error: 'Authorization must be a Bearer token' });
        return null;
      }
      const idToken = authz.slice(7).trim();
      // Firebase JWTs are ~1-2 KB. Reject anything suspiciously large before
      // paying the verifyIdToken network round-trip.
      if (!idToken || idToken.length > 8192) {
        sendJSON(res, 401, { error: 'Token is empty or too long' });
        return null;
      }
      let decoded;
      try {
        decoded = await firestoreService.verifyIdToken(idToken);
      } catch (e) {
        const expired = (e.code === 'auth/id-token-expired');
        sendJSON(res, 401, { error: expired ? 'Token expired — refresh and retry' : 'Invalid or expired token', code: e.code });
        return null;
      }
      if (!decoded || !decoded.uid) {
        sendJSON(res, 401, { error: 'Token missing uid' });
        return null;
      }
      // Rate limit by uid — shared store with /api/ss/* (same bucket, same 100 req/min)
      const rl = rateLimiter.check(decoded.uid);
      if (!rl.allowed) {
        const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
        res.writeHead(429, { ...corsHeaders(), ...securityHeaders(), 'Retry-After': retryAfter });
        res.end(JSON.stringify({ error: rl.locked ? 'Account temporarily locked due to repeated errors' : 'Rate limit exceeded (100 req/min)', resetAt: rl.resetAt }));
        return null;
      }
      return { clientId: decoded.uid, email: decoded.email || null, decoded };
    }

    function v1RequireAdmin(auth) {
      if (!auth.decoded.admin) {
        sendJSON(res, 403, { error: 'Admin access required' });
        return false;
      }
      return true;
    }

    function v1RequireAccess(auth, targetId) {
      if (auth.decoded.admin || auth.clientId === targetId) return true;
      sendJSON(res, 403, { error: 'Access denied' });
      return false;
    }

    // ── Route: /api/v1/clients/:id/* ──────────────────────────────────────
    const v1ClientMatch = v1Path.match(/^\/api\/v1\/clients\/([^/]+)(\/.*)?$/);

    if (v1ClientMatch) {
      const targetId = v1ClientMatch[1];
      const subPath  = v1ClientMatch[2] || '';

      // GET /api/v1/clients/:id/profile
      if (req.method === 'GET' && subPath === '/profile') {
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAccess(auth, targetId)) return;
          try {
            const bundle = await profileService.getBundle(targetId, !!auth.decoded.admin);
            if (!bundle) { sendJSON(res, 404, { error: 'Client not found' }); return; }
            sendJSON(res, 200, bundle);
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        })();
        return;
      }

      // GET /api/v1/clients/:id/timeline
      if (req.method === 'GET' && subPath === '/timeline') {
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAccess(auth, targetId)) return;
          const limit  = Math.min(parseInt(v1Params.get('limit')  || '50', 10), 200);
          const before = v1Params.get('before') || null;
          try {
            const events = await firestoreService.queryTimeline(targetId, { limit, before });
            sendJSON(res, 200, { ok: true, events, total: events.length });
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        })();
        return;
      }

      // GET /api/v1/clients/:id/audit-log  (admin only)
      if (req.method === 'GET' && subPath === '/audit-log') {
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAdmin(auth)) return;
          const limit  = Math.min(parseInt(v1Params.get('limit')  || '50', 10), 200);
          const before = v1Params.get('before') || null;
          try {
            const logs = await firestoreService.queryAuditLogs(targetId, { limit, before });
            sendJSON(res, 200, { ok: true, logs, total: logs.length });
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        })();
        return;
      }

      // PATCH /api/v1/clients/:id  (admin only)
      if (req.method === 'PATCH' && subPath === '') {
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAdmin(auth)) return;
          parseJsonBody(req, res, async body => {
            try {
              const before = await firestoreService.getClient(targetId);
              if (!before) { sendJSON(res, 404, { error: 'Client not found' }); return; }
              const updated = await firestoreService.updateClientProfile(targetId, body);
              const diff = auditService.computeDiff(before, { ...before, ...updated });
              if (diff) {
                const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
                await Promise.all([
                  firestoreService.saveAuditLog({
                    clientId:       targetId,
                    actorType:      'admin',
                    actorId:        auth.clientId,
                    actorEmailHash: auditService.hashEmail(auth.email),
                    action:         'client.profile.update',
                    entityType:     'client',
                    entityId:       targetId,
                    diff,
                    ipAddress:      ip,
                  }),
                  timelineService.record({
                    clientId:    targetId,
                    eventType:   'profile.updated',
                    actorType:   'admin',
                    actorId:     auth.clientId,
                    summary:     'Profile updated by admin',
                    meta:        { fields: Object.keys(diff) },
                    isMilestone: false,
                    dedupeKey:   null,
                  }),
                ]);
              }
              sendJSON(res, 200, { ok: true, updated });
            } catch (e) { sendJSON(res, 500, { error: e.message }); }
          });
        })();
        return;
      }

      // POST /api/v1/clients/:id/api-keys  (admin or self)
      if (req.method === 'POST' && subPath === '/api-keys') {
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAccess(auth, targetId)) return;
          try {
            const client = await firestoreService.getClient(targetId);
            if (!client) { sendJSON(res, 404, { error: 'Client not found' }); return; }

            const { keyId, rawKey, keyHash, prefix } = apiKeyService.generate(targetId);
            await firestoreService.saveApiKey(keyId, {
              clientId:   targetId,
              keyHash,
              prefix,
              status:     'active',
              lastUsedAt: null,
              revokedAt:  null,
            });
            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            await Promise.all([
              firestoreService.saveAuditLog({
                clientId:       targetId,
                actorType:      auth.decoded.admin ? 'admin' : 'user',
                actorId:        auth.clientId,
                actorEmailHash: auditService.hashEmail(auth.email),
                action:         'api_key.created',
                entityType:     'api_key',
                entityId:       keyId,
                diff:           null,
                ipAddress:      ip,
              }),
              timelineService.record({
                clientId:    targetId,
                eventType:   'api_key.created',
                actorType:   auth.decoded.admin ? 'admin' : 'user',
                actorId:     auth.clientId,
                summary:     'New API key created',
                meta:        { prefix },
                isMilestone: false,
                dedupeKey:   null,
              }),
            ]);
            // rawKey returned exactly once — not stored, never retrievable again
            sendJSON(res, 201, { ok: true, keyId, rawKey, prefix });
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        })();
        return;
      }

      // GET /api/v1/clients/:id/diagnostics  (admin or self)
      if (req.method === 'GET' && subPath === '/diagnostics') {
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAccess(auth, targetId)) return;
          try {
            const result = await firestoreService.getDiagnosticResult(targetId);
            if (!result) {
              sendJSON(res, 404, { error: 'no diagnostic data yet — health job has not evaluated this client' });
              return;
            }
            const _tiso = ts => {
              if (!ts) return null;
              if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
              if (ts instanceof Date) return ts.toISOString();
              return null;
            };
            sendJSON(res, 200, {
              ok:            true,
              overallStatus: result.overallStatus || null,
              rules:         result.rules || {},
              updatedAt:     _tiso(result.updatedAt),
            });
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        })();
        return;
      }

      // DELETE /api/v1/clients/:id/api-keys/:keyId  (admin or self)
      const v1ApiKeyMatch = subPath.match(/^\/api-keys\/([^/]+)$/);
      if (req.method === 'DELETE' && v1ApiKeyMatch) {
        const keyId = v1ApiKeyMatch[1];
        (async () => {
          const auth = await v1Auth();
          if (!auth) return;
          if (!v1RequireAccess(auth, targetId)) return;
          try {
            const key = await firestoreService.getApiKey(keyId);
            if (!key || key.clientId !== targetId) {
              sendJSON(res, 404, { error: 'API key not found' });
              return;
            }
            await firestoreService.revokeApiKey(keyId);
            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            await Promise.all([
              firestoreService.saveAuditLog({
                clientId:       targetId,
                actorType:      auth.decoded.admin ? 'admin' : 'user',
                actorId:        auth.clientId,
                actorEmailHash: auditService.hashEmail(auth.email),
                action:         'api_key.revoked',
                entityType:     'api_key',
                entityId:       keyId,
                diff:           null,
                ipAddress:      ip,
              }),
              timelineService.record({
                clientId:    targetId,
                eventType:   'api_key.revoked',
                actorType:   auth.decoded.admin ? 'admin' : 'user',
                actorId:     auth.clientId,
                summary:     'API key revoked',
                meta:        { keyId },
                isMilestone: false,
                dedupeKey:   keyId,
              }),
            ]);
            sendJSON(res, 200, { ok: true });
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        })();
        return;
      }
    }

    // POST /api/v1/admin/platform-health  (admin only)
    if (req.method === 'POST' && v1Path === '/api/v1/admin/platform-health') {
      (async () => {
        const auth = await v1Auth();
        if (!auth) return;
        if (!v1RequireAdmin(auth)) return;
        parseJsonBody(req, res, async body => {
          try {
            const platform = (body && body.platform) ? String(body.platform).trim() : '';
            const status   = (body && body.status)   ? String(body.status).trim()   : '';
            const message  = (body && body.message)  ? String(body.message).trim()  : null;
            if (!platform || !status) {
              sendJSON(res, 400, { error: 'platform and status are required' });
              return;
            }
            const VALID_STATUSES = ['operational', 'degraded', 'outage'];
            if (!VALID_STATUSES.includes(status)) {
              sendJSON(res, 400, { error: 'status must be one of: ' + VALID_STATUSES.join(', ') });
              return;
            }
            await firestoreService.setPlatformHealth(platform, { status, message });
            sendJSON(res, 200, { ok: true });
          } catch (e) { sendJSON(res, 500, { error: e.message }); }
        });
      })();
      return;
    }

    // Stale Phase-4 DLQ endpoint — unreachable (handler registered earlier wins).
    // Disabled with `if (false)` to preserve git history without breaking routing.
    if (false && req.method === 'POST' && v1Path === '/api/v1/internal/dlq') {
      parseJsonBody(req, res, async body => {
        try {
          const apiKey = (req.headers['x-api-key'] || '').trim();
          if (!apiKey) {
            sendJSON(res, 401, { error: 'x-api-key required' });
            return;
          }
          // Validate required fields
          const eventName = body && typeof body.event_name === 'string' ? body.event_name.trim() : '';
          const eventId   = body && typeof body.event_id   === 'string' ? body.event_id.trim()   : '';
          if (!eventName || !eventId) {
            sendJSON(res, 400, { error: 'event_name and event_id are required' });
            return;
          }
          const ALLOWED_DESTS = ['meta', 'tiktok', 'snap'];
          const dest = body && typeof body.destination === 'string' ? body.destination.trim() : '';
          if (!ALLOWED_DESTS.includes(dest)) {
            sendJSON(res, 400, { error: 'destination must be one of: ' + ALLOWED_DESTS.join(', ') });
            return;
          }
          const customerId = body && typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
          const now = Date.now();
          // TTL: DLQ entries expire after 7 days (604800 seconds)
          const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000);
          const entry = {
            event_name:      eventName,
            event_id:        eventId,
            event_checksum:  body.event_checksum  || '',
            destination:     dest,
            destination_url: typeof body.destination_url === 'string' ? body.destination_url.slice(0, 512) : '',
            error_code:      typeof body.error_code    === 'number' ? body.error_code    : 0,
            error_message:   typeof body.error_message === 'string' ? body.error_message.slice(0, 256) : '',
            payload_size:    typeof body.payload_size  === 'number' ? body.payload_size  : 0,
            items_count:     typeof body.items_count   === 'number' ? body.items_count   : 0,
            customer_id:     customerId,
            timestamp:       body.timestamp || Math.floor(now / 1000),
            retry_count:     0,
            status:          'pending',
            received_at:     new Date(now).toISOString(),
            expires_at:      expiresAt.toISOString(),
          };
          const db = firestoreService.getDb();
          if (db) {
            await db.collection('dlq_events').add(entry);
          }
          sendJSON(res, 202, { ok: true, queued: true });
        } catch (e) {
          console.error('[DLQ] store error:', e.message);
          sendJSON(res, 500, { error: 'dlq store failed' });
        }
      });
      return;
    }

    // Stale Phase-7 replay endpoint — calls firestoreService.getDb() which is not
    // exported. Disabled until a proper implementation replaces it.
    if (false && req.method === 'POST' && v1Path === '/api/v1/internal/replay') {
      (async () => {
        const auth = await v1Auth();
        if (!auth) return;
        if (!v1RequireAdmin(auth)) return;
        parseJsonBody(req, res, async body => {
          try {
            const eventId = body && typeof body.event_id === 'string' ? body.event_id.trim() : '';
            if (!eventId) {
              sendJSON(res, 400, { error: 'event_id is required' });
              return;
            }
            const db = firestoreService.getDb();
            if (!db) {
              sendJSON(res, 503, { error: 'Firestore unavailable' });
              return;
            }
            // Locate the DLQ entry
            const snap = await db.collection('dlq_events')
              .where('event_id', '==', eventId)
              .where('status', '==', 'pending')
              .limit(1)
              .get();
            if (snap.empty) {
              sendJSON(res, 404, { error: 'no pending DLQ entry for event_id: ' + eventId });
              return;
            }
            const docRef = snap.docs[0].ref;
            const entry  = snap.docs[0].data();
            // Idempotency: refuse if already replayed within the last 24h
            if (entry.last_replayed_at) {
              const lastMs = new Date(entry.last_replayed_at).getTime();
              if (Date.now() - lastMs < 24 * 60 * 60 * 1000) {
                sendJSON(res, 409, {
                  error:            'duplicate replay within 24h window',
                  last_replayed_at: entry.last_replayed_at,
                  event_checksum:   entry.event_checksum,
                });
                return;
              }
            }
            // Mark as replaying before the HTTP call (optimistic lock)
            await docRef.update({
              status:           'replaying',
              last_replayed_at: new Date().toISOString(),
              retry_count:      (entry.retry_count || 0) + 1,
            });
            // The actual re-fire goes to the sGTM test-event endpoint (same path
            // used by /api/ss/test-event). We trust the sGTM container to re-route
            // to the correct platform — this avoids duplicating CAPI auth logic here.
            const ssConfig = await firestoreService.getSSConfig(entry.customer_id);
            if (!ssConfig || !ssConfig.serverUrl) {
              await docRef.update({ status: 'failed', last_error: 'no sGTM URL on file' });
              sendJSON(res, 422, { error: 'no sGTM server URL configured for this customer' });
              return;
            }
            const replayUrl  = ssConfig.serverUrl.replace(/\/$/, '') + '/g/collect';
            const replayBody = JSON.stringify({
              v:              '2',
              en:             entry.event_name,
              'ep.event_id':  entry.event_id,
              'ep.replayed':  '1',
              'ep.checksum':  entry.event_checksum,
            });
            const https = require('https');
            const replayReq = https.request(replayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(replayBody) } }, replayRes => {
              const ok = replayRes.statusCode >= 200 && replayRes.statusCode < 300;
              docRef.update({
                status:     ok ? 'replayed' : 'failed',
                last_error: ok ? null : 'sGTM responded ' + replayRes.statusCode,
              }).catch(() => {});
            });
            replayReq.on('error', err => {
              docRef.update({ status: 'failed', last_error: err.message }).catch(() => {});
            });
            replayReq.write(replayBody);
            replayReq.end();
            sendJSON(res, 202, {
              ok:             true,
              event_id:       eventId,
              event_checksum: entry.event_checksum,
              retry_count:    (entry.retry_count || 0) + 1,
            });
          } catch (e) {
            console.error('[Replay] error:', e.message);
            sendJSON(res, 500, { error: 'replay failed: ' + e.message });
          }
        });
      })();
      return;
    }

    // Unknown /api/v1/* path
    sendJSON(res, 404, { error: 'v1 endpoint not found: ' + v1Path });
    return;
  }

  // ── Static File Server ────────────────────────────────────────
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (_) {
    res.writeHead(400, securityHeaders()); res.end('Bad Request'); return;
  }

  // Default root → tool.html (the app's single-page entry)
  const requestedPath = urlPath === '/' ? '/tool.html' : urlPath;
  const filePath      = path.normalize(path.join(ROOT, requestedPath));

  // Path traversal guard — filePath MUST stay within ROOT
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, securityHeaders()); res.end('Forbidden'); return;
  }

  // Dotfile/dotdir guard (.env, .git/, .DS_Store, ...)
  if (filePath.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    res.writeHead(403, securityHeaders()); res.end('Forbidden'); return;
  }

  function serveStatic(fp, triedFallback) {
    const entry = _staticCache.get(fp) || _loadStatic(fp);
    if (!entry) {
      // Extensionless URLs (e.g. /tool) → try <name>.html once
      if (!triedFallback && !path.extname(fp)) return serveStatic(fp + '.html', true);
      res.writeHead(404, securityHeaders()); res.end('Not found');
      return;
    }

    // Extension allowlist — blocks server.js / package.json / Dockerfile / etc.
    if (!STATIC_ALLOW_EXT.has(entry.ext)) {
      res.writeHead(403, securityHeaders()); res.end('Forbidden');
      return;
    }

    const cacheControl = entry.isHtml
      ? 'no-cache'                                   // HTML: always revalidate via ETag
      : 'public, max-age=31536000, immutable';       // assets: cache hard (content-hashed via ETag)

    // Conditional request — client already holds this exact content → 304.
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, {
        'ETag':          entry.etag,
        'Cache-Control': cacheControl,
        ...securityHeaders({ html: entry.isHtml }),
      });
      res.end();
      return;
    }

    // Negotiate encoding against what we pre-compressed. Brotli preferred.
    const accept = req.headers['accept-encoding'] || '';
    let body = entry.raw, encoding = null;
    if (entry.br && /\bbr\b/.test(accept))            { body = entry.br;   encoding = 'br'; }
    else if (entry.gzip && /\bgzip\b/.test(accept))   { body = entry.gzip; encoding = 'gzip'; }

    const headers = {
      'Content-Type':   mime[entry.ext] || 'text/plain',
      'ETag':           entry.etag,
      'Cache-Control':  cacheControl,
      'Vary':           'Accept-Encoding',
      'Content-Length': Buffer.byteLength(body),
      ...securityHeaders({ html: entry.isHtml }),
    };
    if (encoding) headers['Content-Encoding'] = encoding;

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  serveStatic(filePath);

});

// ══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER TUNING + PROCESS SAFETY NET  (C7)
// ══════════════════════════════════════════════════════════════════════════════

// keepAliveTimeout MUST be < the upstream LB/proxy idle timeout, and
// headersTimeout MUST be slightly greater than keepAliveTimeout (Node guidance)
// so a socket isn't reused at the exact moment the server is closing it — the
// classic cause of sporadic 502s behind Cloud Run / Cloudflare / Railway.
server.keepAliveTimeout = 65000;   // 65s
server.headersTimeout   = 66000;   // 66s — must exceed keepAliveTimeout
server.requestTimeout   = 30000;   // 30s — kill slowloris-style stalled requests
server.maxConnections   = 2000;    // hard ceiling on concurrent sockets per instance

// Malformed HTTP (bad TLS, garbage bytes) — answer once and drop the socket
// instead of throwing inside the server.
server.on('clientError', (err, socket) => {
  if (socket.writable && !socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  const mode = puppeteer ? '🟢 Puppeteer (headless Chrome)' : '🟡 HTTP fallback (install puppeteer for full analysis)';
  console.log(`Easy Track server running at http://localhost:${PORT}`);
  console.log(`Scanner mode: ${mode}`);

  // Server-side CAPI import state — operators must be able to confirm at a glance
  // whether managed server containers will ship with CAPI tags or silently fall
  // back to the GA4-only static config. See docs/ENABLE-SERVER-SIDE-CAPI-AR.md.
  const _capiOn  = _serverConfigImportEnabled();
  const _capiBkt = configBlobStore.isConfigured();
  if (_capiOn && _capiBkt) {
    console.log('Server-side CAPI import: 🟢 ENABLED (MANAGED_IMPORT_SERVER_CONFIG=1 + PROVISIONING_BUCKET set)');
  } else if (_capiOn && !_capiBkt) {
    console.warn('Server-side CAPI import: 🔴 FLAG ON but staging bucket NOT configured — managed server containers will fall back to GA4-only. Set PROVISIONING_BUCKET (+ FIREBASE_SA_KEY_JSON).');
  } else {
    console.log('Server-side CAPI import: ⚪ disabled (default GA4-only). Set MANAGED_IMPORT_SERVER_CONFIG=1 + PROVISIONING_BUCKET to enable.');
  }

  // Health evaluation job — evaluates diagnostic rules for all active clients.
  // Staggered 90s after startup so Firebase init and first-request spike settle
  // before the job issues its first full client scan.
  setTimeout(() => {
    healthService.runHealthJob().catch(e => console.error('[health-job] startup run failed:', e.message));
    setInterval(() => {
      healthService.runHealthJob().catch(e => console.error('[health-job] tick failed:', e.message));
    }, 15 * 60 * 1000).unref();
  }, 90 * 1000);

  // Provisioning stall detector — runs every 5 minutes. Marks any job stuck
  // in status=running/pending with heartbeatAt older than 10 minutes as stalled
  // and increments the provisioning_stalled_total metric for alerting.
  if (firestoreService.isConfigured()) {
    setInterval(() => {
      firestoreService.detectAndRecoverStalledJobs(10 * 60 * 1000).then(ids => {
        if (ids.length) {
          ids.forEach(() => metrics.incProvisioningStalled());
          console.error('[stall-detector] ' + ids.length + ' stalled provisioning job(s) detected: ' + ids.join(', '));
        }
      }).catch(e => console.error('[stall-detector] sweep failed:', e.message));
    }, 5 * 60 * 1000).unref();
  }

  // ── Deployment Recovery Job ───────────────────────────────────────────────
  // Runs every 5 minutes. Finds container_version records stuck in transient
  // states (building / importing / publishing) for > 15 minutes — these are
  // orphaned by a server crash after the lock was acquired but before release.
  // Recovery: mark failed + release lock + emit warning log entry.
  // Threshold: 15 min (generous vs. the 10-min lock TTL — ensures the lock
  // has also expired before we declare a deployment dead).
  const DEPLOYMENT_STUCK_THRESHOLD_MS = 15 * 60 * 1000;
  if (firestoreService.isConfigured()) {
    const _runDeploymentRecovery = async () => {
      let recovered = 0;
      try {
        const stuck = await firestoreService.detectStuckDeployments(DEPLOYMENT_STUCK_THRESHOLD_MS);
        if (!stuck.length) return;

        console.warn('[deployment-recovery] found ' + stuck.length + ' stuck deployment(s)');

        for (const dep of stuck) {
          try {
            const deploymentId = dep.deploymentId || ('orphan_' + dep.id);
            const clientId     = dep.clientId;

            // 1. Log recovery event
            await firestoreService.saveDeploymentLog({
              deploymentId,
              clientId,
              action:   'deployment_recovered',
              actor:    'recovery-job',
              success:  false,
              error:    'Deployment timed out (stuck in state: ' + dep.deploymentState + ')',
              metadata: { stuckState: dep.deploymentState, recoveredAt: new Date().toISOString() },
            }).catch(() => {});

            // 2. Mark version record as failed
            await firestoreService.updateVersion(dep.id, {
              deploymentState: 'failed',
              status:          'failed',
              failureReason:   'Deployment timed out — recovered by recovery job',
            });

            // 3. Release deployment lock (may already be expired — delete is safe)
            await firestoreService.releaseDeploymentLock(clientId);

            console.warn('[deployment-recovery] recovered stuck deployment ' + deploymentId +
              ' for client ' + clientId + ' (was: ' + dep.deploymentState + ')');
            recovered++;
          } catch (recErr) {
            console.error('[deployment-recovery] failed to recover deployment ' + dep.id + ':', recErr.message);
          }
        }
      } catch (e) {
        console.error('[deployment-recovery] sweep failed:', e.message);
      }
      if (recovered > 0) {
        console.log('[deployment-recovery] recovered ' + recovered + ' orphaned deployment(s)');
      }
    };

    // Run 2 minutes after startup (let Firestore settle), then every 5 minutes.
    setTimeout(() => {
      _runDeploymentRecovery();
      setInterval(_runDeploymentRecovery, 5 * 60 * 1000).unref();
    }, 2 * 60 * 1000);
  }

  // DLQ retry worker — only started when Firestore is configured.
  // Picks up failed CAPI sends (written to `dlq_events` by POST /api/v1/internal/dlq)
  // and retries with exponential back-off. Interval: 60s.
  if (firestoreService.isConfigured()) {
    dlqWorker.start(firestoreService, 60 * 1000).unref();
  } else {
    console.warn('[dlq-worker] Firestore not configured — DLQ retry worker disabled');
  }

  // ── Cloud Monitoring metrics flush — every 60s ───────────────────────────
  setInterval(() => {
    const snap = metrics.snapshot();
    (async () => {
      let dlqDepth = null, dlqOldestAgeMs = null, capacityReport = null;
      if (firestoreService.isConfigured()) {
        try {
          const dlqStats = await firestoreService.getDlqStats();
          dlqDepth = dlqStats.depth;
          dlqOldestAgeMs = dlqStats.oldestAgeMs;
          capacityReport = await firestoreService.getAccountCapacityReport();
        } catch (_) {}
      }
      cloudMonitoring.pushSnapshot(snap, dlqDepth, dlqOldestAgeMs, capacityReport)
        .catch(e => console.warn('[cloud-monitoring] flush error:', e.message));
    })();
  }, 60 * 1000).unref();

  // ── Queue restart recovery ────────────────────────────────────────────────
  // On restart, any job that was in status='pending' and never picked up (e.g.
  // the process crashed between job creation and enqueueing) needs to be
  // re-queued. We scan for jobs created in the last 30 minutes that are still
  // in status='pending' and haven't been heartbeated yet.
  if (firestoreService.isConfigured()) {
    setTimeout(() => {
      _recoverPendingJobsOnStartup().catch(e =>
        console.error('[startup-recovery] failed:', e.message));
    }, 15 * 1000);  // 15s delay so Firestore init settles
  }
});

// ── Global process guards ─────────────────────────────────────────────────────
// A single unhandled error must not silently wedge the process. We log, stop
// accepting new connections, drain briefly, then exit non-zero so the platform
// (Cloud Run / Railway) restarts a clean instance.
let _shuttingDown = false;
function _fatalShutdown(label, errOrReason) {
  console.error('[fatal] ' + label + ':', (errOrReason && errOrReason.stack) || errOrReason);
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    server.close(() => process.exit(1));
  } catch (_) {
    process.exit(1);
  }
  // Hard backstop — never hang forever waiting for in-flight sockets to drain.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('uncaughtException', (err) => _fatalShutdown('uncaughtException', err));
process.on('unhandledRejection', (reason) => _fatalShutdown('unhandledRejection', reason));

// Graceful shutdown on platform stop signals (SIGTERM on Cloud Run / Railway).
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    console.log('[shutdown] received ' + sig + ' — closing server');
    if (_shuttingDown) return;
    _shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
});
