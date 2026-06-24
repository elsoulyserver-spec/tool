console.log("[BOOT] entry | node " + process.version + " | PORT=" + JSON.stringify(process.env.PORT) + " | cwd=" + process.cwd());
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
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (_) {}

// ── Pixel-scanner concurrency guard ────────────────────────────────────────
// Each Puppeteer scan launches a headless Chrome (~150-300 MB resident). Without
// a ceiling, concurrent /api/scan-url calls OOM-kill the Cloud Run instance.
// We reject with 429 once the cap is reached instead of piling up browsers.
// Tune via MAX_CONCURRENT_SCANS (keep it low — memory, not CPU, is the limit).
const MAX_CONCURRENT_SCANS = parseInt(process.env.MAX_CONCURRENT_SCANS || '3', 10);
let scanInFlight = 0;

// ── Managed GTM services (optional — endpoints return 503 if not set up) ──
const gtmService       = require('./gtm-service');
const firestoreService = require('./firestore-service');

// ── Server-Side Tracking services ─────────────────────────────────────────
const cryptoVault  = require('./lib/crypto-vault');
const rateLimiter  = require('./lib/ss-rate-limiter');
const { StapeProvider }      = require('./lib/providers/stape');
const { GoogleCloudProvider } = require('./lib/providers/gcloud');
const { SelfHostedProvider }  = require('./lib/providers/selfhosted');
// SSRF guard — reused from the providers layer to validate the pixel-scanner
// target (blocks private/loopback/link-local/cloud-metadata hosts + bad ports).
const { assertSafeUrl }       = require('./lib/providers/base');
// Cloud Tasks client — offloads long provisioning jobs to a worker request so
// Cloud Run keeps CPU allocated for their full duration (see C3 / lib/cloud-tasks.js).
const cloudTasks              = require('./lib/cloud-tasks');
// Server-config blob store (Phase-1) — serverConfigJson is too large for a
// Firestore job doc (1 MB limit + embedded customTemplate JS), so it is staged
// in a private GCS bucket and the job carries only a small { bucket, object } ref.
const configBlobStore         = require('./lib/config-blob-store');

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
  try {
    await firestoreService.saveJob(id, patch);
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

    // 1. Capacity guard — GTM caps at 500 containers per account
    const activeCount = await firestoreService.countActiveContainers();
    if (activeCount >= 490) {
      await _setJob(jobId, {
        status: 'failed',
        stage:  'capacity_exceeded',
        error:  'Managed GTM account is near capacity',
        hint:   'Provision a new GTM_ACCOUNT_ID and route new clients there',
        httpStatus: 507,
        activeContainers: activeCount,
      });
      return;
    }

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

// ══════════════════════════════════════════════════════════════════════════════
// HTTP FALLBACK (no Puppeteer)
// ══════════════════════════════════════════════════════════════════════════════
function fetchWithHttp(targetUrl, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects')); return; }
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EasyTrackScanner/1.0)' },
      timeout: 15000,
    }, res => {
      // ── Redirect: re-validate EVERY hop through the SSRF guard ──────────────
      // The first-hop check in /api/scan-url is not enough: an allow-looking host
      // can 302 into localhost / a private IP / the cloud-metadata endpoint.
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // drain the redirect body so the socket is released
        let next;
        try {
          const loc = res.headers.location;
          next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, targetUrl).href;
        } catch (_) { reject(new Error('Invalid redirect location')); return; }
        assertSafeUrl(next)
          .then(() => resolve(fetchWithHttp(next, redirects + 1)))
          .catch(e => reject(new Error('Redirect blocked by SSRF guard: ' + e.message)));
        return;
      }

      let html = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        html += c;
        if (html.length >= 800000) {           // hard cap — stop reading oversize bodies
          html = html.slice(0, 800000);
          res.destroy();
          resolve({ html, url: targetUrl, pixels: [], method: 'http' });
        }
      });
      res.on('end', () => resolve({ html, url: targetUrl, pixels: [], method: 'http' }));
    });
    req.on('timeout', () => req.destroy(new Error('Scan request timed out')));
    req.on('error', reject);
  });
}

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
const server = http.createServer((req, res) => {

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
    parseJsonBody(req, res, async body => {

      let targetUrl = (body && body.url) ? body.url.trim() : '';
      if (!targetUrl) { sendJSON(res, 400, { error: 'Missing url' }); return; }
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

      // ── SSRF guard ─────────────────────────────────────────────────────────
      // This endpoint is unauthenticated, so an unguarded fetch is a server-side
      // request forgery + cloud-metadata exfiltration vector. Reject private /
      // loopback / link-local / metadata hosts and disallowed ports BEFORE we
      // fetch. fetchWithHttp re-checks every redirect hop as well.
      try {
        await assertSafeUrl(targetUrl);
      } catch (e) {
        return sendJSON(res, 400, { error: 'URL rejected (SSRF guard): ' + e.message });
      }

      // ── Concurrency cap ────────────────────────────────────────────────────
      // Reject rather than launch an unbounded number of headless Chromes.
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
          result = await scanWithPuppeteer(targetUrl);
        } else {
          console.warn('[scanner] Puppeteer not available — falling back to HTTP fetch');
          result = await fetchWithHttp(targetUrl);
        }
        sendJSON(res, 200, result);
      } catch (e) {
        console.error('[scanner] Error:', e.message);
        sendJSON(res, 502, { error: e.message });
      } finally {
        scanInFlight--;     // always release the slot, even on error/timeout
      }
    });
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
  if (req.method === 'GET' && req.url.startsWith('/api/managed/job/')) {
    const jobId = req.url.substring('/api/managed/job/'.length).split('?')[0];
    if (!jobId) return sendJSON(res, 400, { error: 'Missing jobId' });
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    firestoreService.getJob(jobId)
      .then(job => {
        if (!job) return sendJSON(res, 404, { error: 'Job not found or expired' });
        sendJSON(res, 200, { ok: true, jobId, ...job });
      })
      .catch(e => sendJSON(res, 500, { error: e.message }));
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
  // Protected by a bearer token: set ADMIN_TOKEN env var on the server, then
  // call with header: Authorization: Bearer <ADMIN_TOKEN>
  // ══════════════════════════════════════════════════════════════════════════
  function _requireAdmin() {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      sendJSON(res, 503, { error: 'ADMIN_TOKEN is not configured on the server' });
      return false;
    }
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    if (!ok) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // GET /api/admin/export — dump all clients + containers as JSON
  // Optional ?download=1 sets Content-Disposition so the browser saves a file
  if (req.method === 'GET' && req.url.startsWith('/api/admin/export')) {
    if (!_requireAdmin()) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    const wantDownload = /[?&]download=1\b/.test(req.url);
    firestoreService.exportAll()
      .then(dump => {
        const json = JSON.stringify(dump, null, 2);
        const headers = {
          ...securityHeaders(),
          'Content-Type':   'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(json),
        };
        if (wantDownload) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          headers['Content-Disposition'] = `attachment; filename="easytrack-export-${stamp}.json"`;
        }
        res.writeHead(200, headers);
        res.end(json);
      })
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // GET /api/admin/ping — quick token validity check (used by admin login)
  if (req.method === 'GET' && req.url.startsWith('/api/admin/ping')) {
    if (!_requireAdmin()) return;
    return sendJSON(res, 200, { ok: true, firestore: firestoreService.isConfigured() });
  }

  // POST /api/admin/client/:uid — update client fields (status, plan, ...)
  const _cliUpdMatch = req.url.split('?')[0].match(/^\/api\/admin\/client\/([^/]+)$/);
  if (req.method === 'POST' && _cliUpdMatch) {
    if (!_requireAdmin()) return;
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
    if (!_requireAdmin()) return;
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
      if (/Private\/internal IP|Hostname is blocked|Port .* is not allowed|Only http\/https/i.test(msg)) {
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

          try {
            const provider = ssGetProvider({ provider: body.provider || 'selfhosted' });
            const result   = await provider.validateUrl(url);
            if (!result.valid) rateLimiter.recordError(clientId);
            else               rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, { ok: result.valid, ...result });
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

          try {
            const provider = ssGetProvider({ provider: body.provider || 'selfhosted' });
            const result   = await provider.sendTestEvent(url, testPayload);
            if (!result.ok) rateLimiter.recordError(clientId);
            else            rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok:        result.ok,
              status:    result.status,
              latencyMs: result.latencyMs,
              body:      result.body   || null,
              error:     result.error  || null,
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

          try {
            const provider = new GoogleCloudProvider();
            const result   = await provider.validateUrl(url);
            if (!result.valid) rateLimiter.recordError(clientId);
            else               rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok:      result.valid,
              message: result.valid
                ? 'تم التحقق — الخادم يستجيب بنجاح (' + result.latencyMs + 'ms)'
                : 'الخادم لا يستجيب — تأكد من اكتمال الـ deploy على Cloud Run',
              ...result,
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

        try {
          const provider = ssGetProvider({ provider: 'selfhosted' });
          const result   = await provider.getContainerStatus(url);
          sendJSON(res, 200, { ok: true, ...result });
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

server.on('error', function (e) { console.error('[BOOT] SERVER ERROR:', e && e.code, e && e.message); });
server.listen(PORT, '0.0.0.0', () => {
  console.log('[BOOT] LISTENING ->', JSON.stringify(server.address()), 'PORT_env=', process.env.PORT);
  const mode = puppeteer ? '🟢 Puppeteer (headless Chrome)' : '🟡 HTTP fallback (install puppeteer for full analysis)';
  console.log(`Easy Track server running at http://0.0.0.0:${PORT}`);
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
