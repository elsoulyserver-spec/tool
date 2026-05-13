// ══════════════════════════════════════════════════════════════════════════════
// gtm-service.js
// Google Tag Manager API client authenticated with a Service Account.
// Uses built-in `crypto` to sign the JWT — zero external dependencies.
//
// Required env vars:
//   GTM_SA_KEY_JSON  — full service-account JSON, stringified
//   GTM_ACCOUNT_ID   — the GTM account ID that will host managed containers
//
// How to obtain these:
//   1. https://console.cloud.google.com → create a project
//   2. Enable "Tag Manager API" in API Library
//   3. IAM & Admin → Service Accounts → Create Service Account
//   4. Create Key → JSON → download and paste into GTM_SA_KEY_JSON
//   5. Open tagmanager.google.com → your account → Admin → User Management
//      → invite the service account's `client_email` as "Admin"
// ══════════════════════════════════════════════════════════════════════════════

const https = require('https');
const crypto = require('crypto');

// Shared keep-alive agent — reuses TLS connections across all GTM API calls.
// Without this, each request pays ~200ms for TCP+TLS handshake. With it, that
// cost is paid once and amortized across every request.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets:   20,   // allow up to 20 concurrent requests to Google
  maxFreeSockets: 10,
});

const GTM_SCOPE = 'https://www.googleapis.com/auth/tagmanager.edit.containers '
  + 'https://www.googleapis.com/auth/tagmanager.edit.containerversions '
  + 'https://www.googleapis.com/auth/tagmanager.publish '
  + 'https://www.googleapis.com/auth/tagmanager.manage.users '
  + 'https://www.googleapis.com/auth/tagmanager.readonly';
const TOKEN_HOST = 'oauth2.googleapis.com';
const TOKEN_PATH = '/token';
const GTM_HOST = 'tagmanager.googleapis.com';
const API_BASE = '/tagmanager/v2';

// ── Load & validate the service-account credentials ─────────────────────────
let _sa = null;
function getSA() {
  if (_sa) return _sa;
  const raw = process.env.GTM_SA_KEY_JSON;
  if (!raw) throw new Error('GTM_SA_KEY_JSON is not set');
  try { _sa = JSON.parse(raw); }
  catch (e) { throw new Error('GTM_SA_KEY_JSON is not valid JSON: ' + e.message); }
  if (!_sa.client_email || !_sa.private_key) {
    throw new Error('GTM_SA_KEY_JSON is missing client_email or private_key');
  }
  return _sa;
}

function getAccountId() {
  const id = process.env.GTM_ACCOUNT_ID;
  if (!id) throw new Error('GTM_ACCOUNT_ID is not set');
  return String(id).trim();
}

// True only when the module is fully usable — routes should 503 otherwise.
function isConfigured() {
  return !!(process.env.GTM_SA_KEY_JSON && process.env.GTM_ACCOUNT_ID);
}

// ── JWT → Access Token (cached until ~1min before expiry) ───────────────────
let _cachedToken = null;
let _cachedExp = 0;

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildSignedJWT() {
  const sa = getSA();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: GTM_SCOPE,
    aud: `https://${TOKEN_HOST}${TOKEN_PATH}`,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key);
  return unsigned + '.' + base64url(signature);
}

function httpsJSON(opts, body) {
  return new Promise((resolve, reject) => {
    // Inject the shared keep-alive agent so every call reuses the TLS socket
    const withAgent = { agent: keepAliveAgent, ...opts };
    const req = https.request(withAgent, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _cachedExp - 60) return _cachedToken;

  const jwt = buildSignedJWT();
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
    + '&assertion=' + encodeURIComponent(jwt);
  const { status, data } = await httpsJSON({
    hostname: TOKEN_HOST, path: TOKEN_PATH, method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
    },
  }, form);

  if (status !== 200 || !data.access_token) {
    throw new Error('Token exchange failed (' + status + '): ' + JSON.stringify(data));
  }
  _cachedToken = data.access_token;
  _cachedExp = now + (data.expires_in || 3600);
  return _cachedToken;
}

// ── Small helpers ────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Generic GTM REST call wrapper with retry/backoff ────────────────────────
// GTM quotas default to ~25 writes/minute per user, so we retry 429 with
// long waits (>= 60s) to let the per-minute window reset fully.
async function gtmRequest(method, path, body, attempt = 0) {
  const MAX_RETRIES = 4;

  const token = await getAccessToken();
  const { status, data } = await httpsJSON({
    hostname: GTM_HOST,
    path: API_BASE + path,
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
    },
  }, body);

  if (status >= 200 && status < 300) return data;

  if (attempt < MAX_RETRIES) {
    let waitMs = 0;
    if (status === 429) {
      // 429 means we're past the minute quota — wait the full window + buffer.
      // GTM quota is "per minute per user", so we need >= 60s to reset.
      // Schedule: 65s -> 70s -> 80s -> 90s (always > one full quota window).
      waitMs = [65000, 70000, 80000, 90000][attempt];
    } else if (status >= 500 && status < 600) {
      // Transient 5xx — shorter exponential backoff
      waitMs = [2000, 5000, 10000, 20000][attempt];
    }

    if (waitMs > 0) {
      console.warn(`[gtm] ${status} on ${method} ${path} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
      await sleep(waitMs);
      return gtmRequest(method, path, body, attempt + 1);
    }
  }

  const msg = (data && data.error && data.error.message) || JSON.stringify(data);
  const err = new Error('GTM API ' + status + ' [' + method + ' ' + path + ']: ' + msg);
  err.status = status;
  err.details = data;
  throw err;
}

// ══════════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

// List all containers under the managed account (used for capacity checks).
async function listContainers() {
  const acc = getAccountId();
  const res = await gtmRequest('GET', `/accounts/${acc}/containers`);
  return res.container || [];
}

// Create a new web container in the managed account.
async function createContainer(name, domainName) {
  const acc = getAccountId();
  const body = JSON.stringify({
    name: name,
    usageContext: ['web'],
    domainName: domainName ? [domainName] : undefined,
  });
  return gtmRequest('POST', `/accounts/${acc}/containers`, body);
}

// Default workspace is created automatically with every new container.
async function getDefaultWorkspace(containerId) {
  const acc = getAccountId();
  const res = await gtmRequest('GET',
    `/accounts/${acc}/containers/${containerId}/workspaces`);
  const ws = (res.workspace || [])[0];
  if (!ws) throw new Error('No workspace found in new container ' + containerId);
  return ws;
}

// Import our generated config JSON into the workspace.
// PRIMARY: GTM Workspace Import API — one POST for all entities (~3-5 seconds).
// FALLBACK: individual entity creates in parallel bursts if bulk endpoint fails.
async function importContainerJSON(containerId, workspaceId, configJson, mode, onProgress) {
  const acc = getAccountId();
  const cv = configJson && configJson.containerVersion ? configJson.containerVersion : (configJson || {});

  const vars    = cv.variable || [];
  const trigs   = cv.trigger  || [];
  const tags    = cv.tag      || [];
  // client[] lives at the top level of the config (server containers only)
  const clients = (configJson && configJson.client) || cv.client || [];

  const total = vars.length + trigs.length + tags.length + clients.length;

  // Empty config — nothing to import, skip quietly.
  if (!total) {
    if (typeof onProgress === 'function') onProgress({ stage: 'skip — empty config', done: 0, total: 0 });
    console.log('[gtm] importContainerJSON: empty config, skipping import');
    return { importedTagCount: 0, importedTriggerCount: 0, importedVariableCount: 0, importedClientCount: 0 };
  }

  const basePath = `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}`;
  const report   = (stage, done) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, done: done || 0, total }); } catch (_) {}
    }
    console.log(`[gtm] ${stage} — ${done || 0}/${total}`);
  };

  // ── ATTEMPT 1: Single-call Workspace Import (GTM API v2 custom method) ────
  // POST .../workspaces/{id}:import  with the full ContainerVersion as body.
  // importOption=OVERWRITE merges cleanly with an empty or existing workspace.
  report('importing', 0);
  const importOption = (mode === 'merge') ? 'MERGE' : 'OVERWRITE';
  const importBody = JSON.stringify({
    ...(vars.length    ? { variable: vars }    : {}),
    ...(trigs.length   ? { trigger:  trigs }   : {}),
    ...(tags.length    ? { tag:      tags }     : {}),
    ...(clients.length ? { client:   clients }  : {}),
  });

  try {
    await gtmRequest('POST', `${basePath}:import?importOption=${importOption}`, importBody);
    report('done', total);
    console.log('[gtm] bulk import succeeded — 1 API call');
    return {
      importedVariableCount: vars.length,
      importedTriggerCount:  trigs.length,
      importedTagCount:      tags.length,
      importedClientCount:   clients.length,
    };
  } catch (bulkErr) {
    // Bulk endpoint doesn't exist on this GTM account/quota tier -> fall through
    // to individual entity creation.  Any error other than 404/405 is re-thrown.
    const isMissing = bulkErr.status === 404 || bulkErr.status === 405 ||
      /method not (found|allowed)|not implemented/i.test(bulkErr.message || '');
    if (!isMissing) throw bulkErr;
    console.warn('[gtm] bulk import not available (' + bulkErr.status + ') — falling back to individual calls');
  }

  // ── FALLBACK: Parallel bursts, one call per entity ────────────────────────
  // GTM write quota: ~25 ops/min. Fire BURST_SIZE items in parallel, then wait
  // BURST_WAIT_MS for the quota window to reset before the next burst.
  // BURST_SIZE=18 per 45s = 24/min — stays just under the 25/min hard quota.
  // Saves ~20s per burst cycle vs the old 65s window.
  const BURST_SIZE    = 18;
  const BURST_WAIT_MS = 45000;

  let done = 0;
  const reportBurst = (label) => report(`${label}`, done);

  async function runInBursts(items, label, writeFn) {
    for (let i = 0; i < items.length; i += BURST_SIZE) {
      const batch     = items.slice(i, i + BURST_SIZE);
      const batchStart = Date.now();
      await Promise.all(batch.map(async (item) => {
        await writeFn(item);
        done++;
        reportBurst(label);
      }));
      if (i + BURST_SIZE < items.length) {
        const wait = Math.max(0, BURST_WAIT_MS - (Date.now() - batchStart));
        if (wait > 0) {
          console.log(`[gtm] burst done — waiting ${wait}ms`);
          await sleep(wait);
        }
      }
    }
  }

  const triggerMap = {};

  // Phase 1: Variables + Triggers (parallel, no dependency)
  const varsAndTrigs = [
    ...vars.map(v  => ({ kind: 'variable', item: v })),
    ...trigs.map(t => ({ kind: 'trigger',  item: t })),
  ];

  // Pre-load existing variables and triggers to avoid duplicate-name 400s on retry.
  // GTM returns 400 "Found entity with duplicate name" if we POST an entity whose
  // name already exists in the workspace (e.g. from a previous partial attempt).
  // We build name->id maps so we can update instead of blindly POSTing.
  let existingVarMap = {};   // name -> variableId
  let existingTrigMap = {};  // name -> triggerId
  try {
    const evr = await gtmRequest('GET', `${basePath}/variables`).catch(() => ({ variable: [] }));
    (evr.variable || []).forEach(v => { existingVarMap[v.name] = v.variableId; });
    const etr = await gtmRequest('GET', `${basePath}/triggers`).catch(() => ({ trigger: [] }));
    (etr.trigger || []).forEach(t => { existingTrigMap[t.name] = t.triggerId; });
  } catch (_) { /* non-fatal — proceed and handle duplicates inline */ }

  await runInBursts(varsAndTrigs, 'var/trig', async ({ kind, item }) => {
    const body = { ...item };
    delete body.accountId; delete body.containerId; delete body.workspaceId;
    delete body.fingerprint; delete body.path; delete body.parentFolderId;
    if (kind === 'variable') {
      const existingId = existingVarMap[body.name];
      if (existingId) {
        // Already exists — update in place instead of creating a duplicate.
        console.log(`[gtm] variable "${body.name}" already exists (id=${existingId}) — updating`);
        delete body.variableId;
        try {
          return await gtmRequest('PUT', `${basePath}/variables/${existingId}`, JSON.stringify({ ...body, variableId: existingId }));
        } catch (putErr) {
          console.warn(`[gtm] variable "${body.name}" PUT failed — skipping:`, putErr.message);
          return;
        }
      }
      delete body.variableId;
      try {
        const created = await gtmRequest('POST', `${basePath}/variables`, JSON.stringify(body));
        existingVarMap[body.name] = created.variableId; // track for later items
        return created;
      } catch (e) {
        if (e.status === 400 && /duplicate/i.test(e.message || '')) {
          console.warn(`[gtm] variable "${body.name}" duplicate on POST — skipping`);
          return;
        }
        throw e;
      }
    }
    // kind === 'trigger'
    const oldId = body.triggerId;
    delete body.triggerId;
    const existingTriggerId = existingTrigMap[body.name];
    if (existingTriggerId) {
      console.log(`[gtm] trigger "${body.name}" already exists (id=${existingTriggerId}) — skipping`);
      if (oldId) triggerMap[oldId] = existingTriggerId;
      return;
    }
    try {
      const created = await gtmRequest('POST', `${basePath}/triggers`, JSON.stringify(body));
      if (oldId && created.triggerId) triggerMap[oldId] = created.triggerId;
      existingTrigMap[body.name] = created.triggerId;
      return created;
    } catch (e) {
      if (e.status === 400 && /duplicate/i.test(e.message || '')) {
        console.warn(`[gtm] trigger "${body.name}" duplicate on POST — skipping`);
        return;
      }
      throw e;
    }
  });

  // Phase 2: Tags (depend on triggerMap from phase 1)
  let existingTagMap = {};   // name -> tagId
  try {
    const etagr = await gtmRequest('GET', `${basePath}/tags`).catch(() => ({ tag: [] }));
    (etagr.tag || []).forEach(t => { existingTagMap[t.name] = t.tagId; });
  } catch (_) { /* non-fatal */ }

  await runInBursts(tags, 'tag', async (t) => {
    const body = { ...t };
    delete body.accountId; delete body.containerId; delete body.workspaceId;
    delete body.tagId; delete body.fingerprint; delete body.path; delete body.parentFolderId;
    if (body.firingTriggerId)   body.firingTriggerId   = body.firingTriggerId.map(id => triggerMap[id] || id);
    if (body.blockingTriggerId) body.blockingTriggerId = body.blockingTriggerId.map(id => triggerMap[id] || id);
    if (body.enablingTriggerId) body.enablingTriggerId = body.enablingTriggerId.map(id => triggerMap[id] || id);
    const existingTagId = existingTagMap[body.name];
    if (existingTagId) {
      console.log(`[gtm] tag "${body.name}" already exists (id=${existingTagId}) — updating`);
      try {
        return await gtmRequest('PUT', `${basePath}/tags/${existingTagId}`, JSON.stringify({ ...body, tagId: existingTagId }));
      } catch (putErr) {
        console.warn(`[gtm] tag "${body.name}" PUT failed — skipping:`, putErr.message);
        return;
      }
    }
    try {
      const created = await gtmRequest('POST', `${basePath}/tags`, JSON.stringify(body));
      existingTagMap[body.name] = created.tagId;
      return created;
    } catch (e) {
      if (e.status === 400 && /duplicate/i.test(e.message || '')) {
        console.warn(`[gtm] tag "${body.name}" duplicate on POST — skipping`);
        return;
      }
      throw e;
    }
  });

  // Phase 3: Clients (server containers only)
  if (clients.length > 0) {
    await runInBursts(clients, 'client', async (c) => {
      const body = { ...c };
      delete body.accountId; delete body.containerId; delete body.workspaceId;
      delete body.clientId; delete body.fingerprint; delete body.path; delete body.parentFolderId;
      return gtmRequest('POST', `${basePath}/clients`, JSON.stringify(body));
    });
  }

  return {
    importedVariableCount: vars.length,
    importedTriggerCount:  trigs.length,
    importedTagCount:      tags.length,
    importedClientCount:   clients.length,
  };
}

// Create a version from the current workspace state.
async function createVersion(containerId, workspaceId, versionName) {
  const acc = getAccountId();
  const body = JSON.stringify({ name: versionName || 'Easy Track auto-deploy' });
  return gtmRequest('POST',
    `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}:create_version`,
    body);
}

// Publish a version to Live.
// If the given versionId returns 404 (version not found / already published),
// we fall back to listing all versions and publishing the latest unfinished one.
async function publishVersion(containerId, versionId) {
  const acc = getAccountId();

  // Guard: if versionId is missing, skip direct publish and go straight to fallback
  if (versionId) {
    try {
      return await gtmRequest('POST',
        `/accounts/${acc}/containers/${containerId}/versions/${versionId}:publish`, '');
    } catch (e) {
      if (e.status !== 404) throw e;
      console.warn(`[gtm] publish version ${versionId} returned 404 — trying fallbacks`);
    }
  } else {
    console.warn(`[gtm] publishVersion: no versionId — fallback for container ${containerId}`);
  }

  // Fallback 1: fetch live version
  try {
    const liveResp = await gtmRequest('GET',
      `/accounts/${acc}/containers/${containerId}/versions?containerVersionId=live`);
    const liveId = liveResp && liveResp.containerVersionId;
    if (liveId) {
      console.log(`[gtm] re-publishing live version ${liveId}`);
      return await gtmRequest('POST',
        `/accounts/${acc}/containers/${containerId}/versions/${liveId}:publish`, '');
    }
  } catch (liveErr) {
    console.warn(`[gtm] live-version fetch failed:`, liveErr.message);
  }

  // Fallback 2: list all versions, publish latest
  try {
    const listResp = await gtmRequest('GET', `/accounts/${acc}/containers/${containerId}/versions`);
    const versions = (listResp.containerVersion || [])
      .map(v => ({ ...v, _id: parseInt(v.containerVersionId, 10) || 0 }))
      .sort((a, b) => b._id - a._id);
    if (!versions.length) throw new Error('No versions found in container ' + containerId);
    const latest = versions[0];
    console.log(`[gtm] publishing latest version ${latest.containerVersionId}`);
    return await gtmRequest('POST',
      `/accounts/${acc}/containers/${containerId}/versions/${latest.containerVersionId}:publish`, '');
  } catch (fallbackErr) {
    console.warn(`[gtm] all publish fallbacks failed for container ${containerId}:`, fallbackErr.message);
    throw fallbackErr;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// INVITE USER TO CONTAINER
// Grants a user READ access to a single container in our managed GTM account.
// Google sends an invitation email automatically to the address provided.
// The user must have a Google account on that email to accept.
// ══════════════════════════════════════════════════════════════════════════════
async function inviteUserToContainer(containerId, email, permission) {
  if (!email) throw new Error('inviteUserToContainer: email is required');
  const acc = getAccountId();
  const body = JSON.stringify({
    accountId: acc,
    emailAddress: email,
    accountAccess: { permission: 'user' },
    containerAccess: [
      { containerId: String(containerId), permission: permission || 'read' },
    ],
  });
  try {
    return await gtmRequest('POST', `/accounts/${acc}/user_permissions`, body);
  } catch (e) {
    // If the email is already on the account, the API returns 409 — treat as success
    if (e.status === 409) {
      console.log('[gtm] user already has access:', email);
      return { alreadyMember: true };
    }
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// END-TO-END: Client -> Managed Container
// Does: createContainer -> import JSON -> create version -> (optional) publish.
// Returns everything the frontend needs to show the overview.
// ══════════════════════════════════════════════════════════════════════════════
async function provisionForClient({ projectName, domain, configJson, publishLive, onProgress, inviteEmail }) {
  if (!isConfigured()) {
    const err = new Error('Managed GTM is not configured on this server');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  // 1. Create container — always append a short timestamp suffix so names are
  //    unique across retries. GTM returns HTTP 400 "duplicate name" otherwise.
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(':', '-'); // "YYYY-MM-DD HH-MM"
  const baseName = (projectName || 'Easy Track Project').toString().trim();
  const uniqueName = baseName.slice(0, 60) + ' · ' + ts;
  let container;
  try {
    container = await createContainer(uniqueName, domain);
  } catch (e) {
    // Fallback — if still a duplicate, append random hex too.
    if (e.status === 400 && /duplicate/i.test(e.message || '')) {
      const rnd = Math.random().toString(16).slice(2, 8);
      container = await createContainer(uniqueName + ' ' + rnd, domain);
    } else { throw e; }
  }
  const containerId = container.containerId;
  const publicId = container.publicId;     // e.g. GTM-XXXXXX

  // 2. Workspace
  const workspace = await getDefaultWorkspace(containerId);
  const workspaceId = workspace.workspaceId;

  // 3. Import our generated config
  const importResult = await importContainerJSON(containerId, workspaceId, configJson, null, onProgress);

  // 4. Create version
  const versionResp = await createVersion(containerId, workspaceId,
    'Easy Track initial import — ' + new Date().toISOString().split('T')[0]);
  const containerVersion = versionResp.containerVersion || {};
  const versionId = containerVersion.containerVersionId;

  // 5. Publish if requested (non-fatal — stays draft if publish fails)
  let published = false;
  let publishedAt = null;
  if (publishLive && versionId) {
    try {
      await publishVersion(containerId, versionId);
      published = true;
      publishedAt = new Date().toISOString();
    } catch (pubErr) {
      console.warn('[gtm] publish failed (non-fatal), container stays draft:', pubErr.message);
    }
  }

  // 6. Invite the client by email with READ access (non-fatal if it fails)
  let invited = false;
  let inviteError = null;
  if (inviteEmail) {
    try {
      if (typeof onProgress === 'function') {
        try { onProgress({ stage: 'inviting_user', done: 1, total: 1 }); } catch (_) {}
      }
      await inviteUserToContainer(containerId, inviteEmail, 'read');
      invited = true;
      console.log('[gtm] invitation sent to', inviteEmail);
    } catch (e) {
      inviteError = e.message;
      console.warn('[gtm] invitation failed for', inviteEmail, '—', e.message);
      // Don't throw — container was still created successfully
    }
  }

  // 7. Build the snippet the client will paste on their site
  const snippetHead = "<!-- Google Tag Manager -->\n"
    + "<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':\n"
    + "new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],\n"
    + "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=\n"
    + "'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);\n"
    + `})(window,document,'script','dataLayer','${publicId}');</script>\n`
    + "<!-- End Google Tag Manager -->";
  const snippetBody = "<!-- Google Tag Manager (noscript) -->\n"
    + `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${publicId}"\n`
    + 'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n'
    + "<!-- End Google Tag Manager (noscript) -->";

  return {
    gtmAccountId:    getAccountId(),
    gtmContainerId:  containerId,
    gtmPublicId:     publicId,
    gtmWorkspaceId:  workspaceId,
    gtmVersionId:    versionId,
    published,
    publishedAt,
    importedTagCount:      importResult.importedTagCount      || 0,
    importedTriggerCount:  importResult.importedTriggerCount  || 0,
    importedVariableCount: importResult.importedVariableCount || 0,
    snippetHead,
    snippetBody,
    invited,
    inviteEmail:  inviteEmail || null,
    inviteError:  inviteError,
    containerName: uniqueName,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE CONTAINER (sGTM)  —  added in client+server flow
// A "server" container has usageContext: ['server'] and exposes a containerConfig
// blob string that gets pasted into Stape / Cloud Run / self-hosted Docker as the
// CONTAINER_CONFIG env var. We provision it via the same GTM API as the web one.
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// CAPI CUSTOM TEMPLATES  —  create sandboxed-JS tag templates in sGTM workspace
// so users don't need to install community templates manually.
// Each template makes a direct HTTPS call to the platform's CAPI endpoint using
// the stored access token.  Templates are created via GTM API before the config
// import so tags can reference them immediately.
//
// Tag type in the container = the INFO block "id" field in the template data.
// We use deterministic IDs: et_meta_capi_manual | et_tiktok_events_manual |
//                            et_snapchat_capi_manual | et_gads_ec_manual
// ══════════════════════════════════════════════════════════════════════════════

// ── Template source builders ────────────────────────────────────────────────

function _metaCAPITemplateData() {
  const js = `
const sendHttpRequest = require('sendHttpRequest');
const JSON = require('JSON');
const Math = require('Math');

const pixelId     = data.pixelId;
const accessToken = data.accessToken;
if (!pixelId || !accessToken) { data.gtmOnSuccess(); return; }

function arr(v) { return v ? [v] : undefined; }
function pick(obj) {
  var out = {};
  Object.keys(obj).forEach(function(k){ if(obj[k] !== undefined && obj[k] !== '') out[k] = obj[k]; });
  return Object.keys(out).length ? out : undefined;
}

var ud = pick({
  em:                  arr(data.userEmail),
  ph:                  arr(data.userPhone),
  fn:                  arr(data.userFirstName),
  ln:                  arr(data.userLastName),
  external_id:         arr(data.externalId),
  client_ip_address:   data.clientIpAddress,
  client_user_agent:   data.clientUserAgent,
  fbclid:              data.fbclid,
  fbp:                 data.fbp,
  fbc:                 data.fbc
});

var cd = pick({
  value:       data.value,
  currency:    data.currency,
  order_id:    data.orderId,
  content_ids: data.contentIds,
  contents:    data.contents
});

var payload = {
  data: [{
    event_name:       data.eventName,
    event_time:       Math.round(Date.now() / 1000),
    event_id:         data.eventId,
    action_source:    'website',
    event_source_url: data.sourceUrl,
    user_data:        ud,
    custom_data:      cd
  }]
};

var url = 'https://graph.facebook.com/v22.0/' + pixelId +
          '/events?access_token=' + accessToken;

sendHttpRequest(url, function(sc) {
  if (sc >= 200 && sc < 300) { data.gtmOnSuccess(); } else { data.gtmOnFailure(); }
}, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), timeout:5000 });
`.trim();

  const params = [
    'pixelId','accessToken','eventName','eventId','value','currency',
    'orderId','contentIds','contents','userEmail','userPhone',
    'userFirstName','userLastName','externalId',
    'clientIpAddress','clientUserAgent','sourceUrl','fbclid','fbp','fbc'
  ].map(n => ({type:'TEXT', name:n, displayName:n, simpleValueType:true}));

  const perm = JSON.stringify([{
    instance:{ key:{publicId:'send_http',versionId:'1'},
      param:[{key:'allowedUrls',value:{type:1,listItem:[{type:3,
        mapKey:[{type:1,string:'value'},{type:1,string:'id'}],
        mapValue:[{type:1,string:'https://graph.facebook.com/'},{type:1,string:'specific'}]}]}}]},
    isRequired:true
  }]);

  return [
    '___INFO___', '',
    JSON.stringify({type:'TAG',id:'et_meta_capi_manual',version:1,securityGroups:[],
      displayName:'ET - Meta Conversions API',
      description:'Easy Track — server-side Meta CAPI. Auto-created by Easy Track.',
      containerContexts:['SERVER']}),
    '', '___TEMPLATE_PARAMETERS___', '', JSON.stringify(params),
    '', '___SANDBOXED_JS_FOR_SERVER___', '', js,
    '', '___WEB_PERMISSIONS___', '', perm, ''
  ].join('\n');
}

function _tiktokEventsTemplateData() {
  const js = `
const sendHttpRequest = require('sendHttpRequest');
const JSON = require('JSON');

const pixelId     = data.pixelId;
const accessToken = data.accessToken;
if (!pixelId || !accessToken) { data.gtmOnSuccess(); return; }

function pick(obj) {
  var out = {};
  Object.keys(obj).forEach(function(k){ if(obj[k] !== undefined && obj[k] !== '') out[k] = obj[k]; });
  return Object.keys(out).length ? out : undefined;
}

var contact = pick({ email:data.email, phone:data.phone, external_id:data.externalId });
var props   = pick({ value:data.value ? parseFloat(data.value)||undefined : undefined,
                     currency:data.currency, order_id:data.orderId,
                     content_id:data.contentIds, contents:data.contents });
var ctx = { ip:data.ipAddress, user_agent:data.userAgent,
            page: data.pageUrl ? {url:data.pageUrl} : undefined,
            ad:   data.ttclid  ? {callback:data.ttclid} : undefined,
            user: contact };

var payload = {
  pixel_code: pixelId,
  event:      data.eventName,
  event_id:   data.eventId,
  timestamp:  new Date(Date.now()).toISOString(),
  properties: props,
  context:    ctx
};

var url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

sendHttpRequest(url, function(sc) {
  if (sc >= 200 && sc < 300) { data.gtmOnSuccess(); } else { data.gtmOnFailure(); }
}, { method:'POST',
     headers:{'Content-Type':'application/json','Access-Token':accessToken},
     body:JSON.stringify(payload), timeout:5000 });
`.trim();

  const params = [
    'pixelId','accessToken','eventName','eventId','value','currency',
    'orderId','contentIds','contents','email','phone','externalId',
    'ipAddress','userAgent','pageUrl','ttclid'
  ].map(n => ({type:'TEXT', name:n, displayName:n, simpleValueType:true}));

  const perm = JSON.stringify([{
    instance:{ key:{publicId:'send_http',versionId:'1'},
      param:[{key:'allowedUrls',value:{type:1,listItem:[{type:3,
        mapKey:[{type:1,string:'value'},{type:1,string:'id'}],
        mapValue:[{type:1,string:'https://business-api.tiktok.com/'},{type:1,string:'specific'}]}]}}]},
    isRequired:true
  }]);

  return [
    '___INFO___', '',
    JSON.stringify({type:'TAG',id:'et_tiktok_events_manual',version:1,securityGroups:[],
      displayName:'ET - TikTok Events API',
      description:'Easy Track — server-side TikTok Events API. Auto-created by Easy Track.',
      containerContexts:['SERVER']}),
    '', '___TEMPLATE_PARAMETERS___', '', JSON.stringify(params),
    '', '___SANDBOXED_JS_FOR_SERVER___', '', js,
    '', '___WEB_PERMISSIONS___', '', perm, ''
  ].join('\n');
}

function _snapCAPITemplateData() {
  const js = `
const sendHttpRequest = require('sendHttpRequest');
const JSON = require('JSON');
const Math = require('Math');

const pixelId     = data.pixelId;
const accessToken = data.accessToken;
if (!pixelId || !accessToken) { data.gtmOnSuccess(); return; }

function pick(obj) {
  var out = {};
  Object.keys(obj).forEach(function(k){ if(obj[k] !== undefined && obj[k] !== '') out[k] = obj[k]; });
  return Object.keys(out).length ? out : undefined;
}

var payload = {
  data: [{
    event_type:             data.eventType,
    event_conversion_type:  'WEB',
    event_tag:              data.eventId,
    timestamp:              Math.round(Date.now() / 1000),
    page_url:               data.pageUrl,
    hashed_data_fields: pick({
      em:                  data.email,
      ph:                  data.phone,
      external_id:         data.externalId,
      client_ip_address:   data.ipAddress,
      client_user_agent:   data.userAgent
    }),
    custom_data: pick({
      price:    data.price,
      currency: data.currency,
      order_id: data.orderId,
      item_ids: data.itemIds
    })
  }]
};

var url = 'https://tr.snapchat.com/v2/conversion';

sendHttpRequest(url, function(sc) {
  if (sc >= 200 && sc < 300) { data.gtmOnSuccess(); } else { data.gtmOnFailure(); }
}, { method:'POST',
     headers:{'Content-Type':'application/json','Authorization':'Bearer ' + accessToken},
     body:JSON.stringify(payload), timeout:5000 });
`.trim();

  const params = [
    'pixelId','accessToken','eventType','eventId','price','currency',
    'orderId','itemIds','email','phone','externalId',
    'ipAddress','userAgent','pageUrl'
  ].map(n => ({type:'TEXT', name:n, displayName:n, simpleValueType:true}));

  const perm = JSON.stringify([{
    instance:{ key:{publicId:'send_http',versionId:'1'},
      param:[{key:'allowedUrls',value:{type:1,listItem:[{type:3,
        mapKey:[{type:1,string:'value'},{type:1,string:'id'}],
        mapValue:[{type:1,string:'https://tr.snapchat.com/'},{type:1,string:'specific'}]}]}}]},
    isRequired:true
  }]);

  return [
    '___INFO___', '',
    JSON.stringify({type:'TAG',id:'et_snapchat_capi_manual',version:1,securityGroups:[],
      displayName:'ET - Snapchat CAPI',
      description:'Easy Track — server-side Snapchat CAPI. Auto-created by Easy Track.',
      containerContexts:['SERVER']}),
    '', '___TEMPLATE_PARAMETERS___', '', JSON.stringify(params),
    '', '___SANDBOXED_JS_FOR_SERVER___', '', js,
    '', '___WEB_PERMISSIONS___', '', perm, ''
  ].join('\n');
}

function _gadsECTemplateData() {
  const js = `
const sendHttpRequest = require('sendHttpRequest');
const JSON = require('JSON');
const Math = require('Math');

const customerId     = data.customerId;
const accessToken    = data.accessToken;
const developerToken = data.developerToken;
const convActionId   = data.conversionActionId;
if (!customerId || !accessToken || !convActionId) { data.gtmOnSuccess(); return; }

// Build the Google Ads Enhanced Conversions payload (REST API v18)
var conversion = {
  conversionAction: 'customers/' + customerId + '/conversionActions/' + convActionId,
  conversionDateTime: data.conversionDateTime || (() => {
    var d = new Date(Date.now());
    var pad = function(n){return n<10?'0'+n:String(n);};
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+
           pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+'+00:00';
  })(),
  orderId: data.orderId || undefined,
  conversionValue: data.value ? parseFloat(data.value)||undefined : undefined,
  currencyCode: data.currency || undefined,
  userIdentifiers: []
};

if (data.userEmail) {
  conversion.userIdentifiers.push({ hashedEmail: data.userEmail });
}
if (data.userPhone) {
  conversion.userIdentifiers.push({ hashedPhoneNumber: data.userPhone });
}
if (!conversion.userIdentifiers.length) delete conversion.userIdentifiers;

var payload = { conversions: [conversion], partialFailure: true };

var cid = customerId.replace(/-/g,'');
var url = 'https://googleads.googleapis.com/v18/customers/' + cid + ':uploadClickConversions';

sendHttpRequest(url, function(sc) {
  if (sc >= 200 && sc < 300) { data.gtmOnSuccess(); } else { data.gtmOnFailure(); }
}, { method:'POST',
     headers:{
       'Content-Type':'application/json',
       'Authorization':'Bearer ' + accessToken,
       'developer-token': developerToken || ''
     },
     body:JSON.stringify(payload), timeout:8000 });
`.trim();

  const params = [
    'customerId','accessToken','developerToken','conversionActionId',
    'conversionDateTime','value','currency','orderId',
    'userEmail','userPhone'
  ].map(n => ({type:'TEXT', name:n, displayName:n, simpleValueType:true}));

  const perm = JSON.stringify([{
    instance:{ key:{publicId:'send_http',versionId:'1'},
      param:[{key:'allowedUrls',value:{type:1,listItem:[{type:3,
        mapKey:[{type:1,string:'value'},{type:1,string:'id'}],
        mapValue:[{type:1,string:'https://googleads.googleapis.com/'},{type:1,string:'specific'}]}]}}]},
    isRequired:true
  }]);

  return [
    '___INFO___', '',
    JSON.stringify({type:'TAG',id:'et_gads_ec_manual',version:1,securityGroups:[],
      displayName:'ET - Google Ads Enhanced Conversions',
      description:'Easy Track — server-side Google Ads Enhanced Conversions. Auto-created by Easy Track.',
      containerContexts:['SERVER']}),
    '', '___TEMPLATE_PARAMETERS___', '', JSON.stringify(params),
    '', '___SANDBOXED_JS_FOR_SERVER___', '', js,
    '', '___WEB_PERMISSIONS___', '', perm, ''
  ].join('\n');
}

// ── Template creation ────────────────────────────────────────────────────────

const CAPI_TEMPLATE_BUILDERS = {
  meta:   { infoId: 'et_meta_capi_manual',      build: _metaCAPITemplateData   },
  tiktok: { infoId: 'et_tiktok_events_manual',  build: _tiktokEventsTemplateData },
  snap:   { infoId: 'et_snapchat_capi_manual',  build: _snapCAPITemplateData   },
  gads:   { infoId: 'et_gads_ec_manual',        build: _gadsECTemplateData     },
};

/**
 * Creates CAPI custom templates in the sGTM workspace for the given platforms.
 * Must be called BEFORE importContainerJSON so tags can reference the templates.
 * Returns a map: { meta: 'et_meta_capi_manual', tiktok: 'et_tiktok_events_manual',
 *                  snap: 'et_snapchat_capi_manual', gads: 'et_gads_ec_manual' }
 */
async function createCAPITemplates(containerId, workspaceId, platforms) {
  const acc      = getAccountId();
  const basePath = `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}/templates`;
  const result   = {};

  for (const platform of (platforms || [])) {
    const tpl = CAPI_TEMPLATE_BUILDERS[platform];
    if (!tpl) continue;
    try {
      const body = JSON.stringify({ name: tpl.infoId, templateData: tpl.build() });
      await gtmRequest('POST', basePath, body);
      result[platform] = tpl.infoId;
      console.log('[gtm] created CAPI template for', platform, '— type:', tpl.infoId);
    } catch (e) {
      // Non-fatal — if template already exists (409) or any other error, skip
      console.warn('[gtm] createCAPITemplates skipped', platform, ':', e.message);
    }
  }
  return result;
}


async function createServerContainer(name) {
  const acc = getAccountId();
  const body = JSON.stringify({
    name: name,
    usageContext: ['server'],   // <- the only difference from createContainer()
  });
  return gtmRequest('POST', `/accounts/${acc}/containers`, body);
}

// Fetches the *live* container config string. This is the value that GTM admin
// shows under "Container Settings -> Server Container Config", which the user's
// chosen sGTM host (Stape/Cloud Run/Docker) consumes. It only becomes non-null
// after a version is created and published.
async function getContainerConfig(containerId) {
  const acc = getAccountId();
  const c = await gtmRequest('GET', `/accounts/${acc}/containers/${containerId}`);
  return c && c.containerConfig ? c.containerConfig : null;
}

// Patches the GA4 Configuration tag on the WEB container to set transport_url
// so the browser sends GA4 hits through the user's sGTM instead of straight to
// Google. Then bumps the version + republishes — otherwise the change stays
// in the workspace and never reaches the live container.
//
// `tagType` accepts both legacy `gaawc` and the new unified `googtag`. If
// neither tag exists we throw — callers should treat that as "the web container
// wasn't built from our standard config".
async function setGA4TransportUrl(webContainerId, webWorkspaceId, sgtmUrl) {
  if (!webContainerId)  throw new Error('setGA4TransportUrl: webContainerId required');
  if (!webWorkspaceId)  throw new Error('setGA4TransportUrl: webWorkspaceId required');
  if (!sgtmUrl || !/^https:\/\//.test(sgtmUrl)) {
    throw new Error('setGA4TransportUrl: sgtmUrl must be https://');
  }

  const acc      = getAccountId();
  const basePath = `/accounts/${acc}/containers/${webContainerId}/workspaces/${webWorkspaceId}`;
  const tagsResp = await gtmRequest('GET', `${basePath}/tags`);
  const tags     = tagsResp.tag || [];

  // Find the GA4 Configuration / unified Google Tag.
  const ga4 = tags.find(t => t.type === 'gaawc' || t.type === 'googtag');
  if (!ga4) {
    throw new Error('No GA4 Configuration tag in web container — was it created by Easy Track?');
  }

  // Replace any existing transportUrl (camelCase — GTM JSON format requirement), append fresh.
  const params = (ga4.parameter || []).filter(p => p.key !== 'transportUrl' && p.key !== 'transport_url');
  params.push({ type: 'template', key: 'transportUrl', value: sgtmUrl });

  // PUT the full tag object back. GTM requires fingerprint to match for write
  // — gtmRequest already includes auth, fingerprint comes from the GET response.
  const updated = { ...ga4, parameter: params };
  await gtmRequest('PUT', `${basePath}/tags/${ga4.tagId}`, JSON.stringify(updated));

  // Re-version + republish so the change is live.
  const ver = await createVersion(webContainerId, webWorkspaceId, 'wire sGTM transport_url');
  const versionId = ver.containerVersion && ver.containerVersion.containerVersionId;
  if (versionId) await publishVersion(webContainerId, versionId);

  return { tagId: ga4.tagId, versionId, transportUrl: sgtmUrl };
}

// Create or update the "ET - sGTM URL" constant variable in a server container
// workspace.  Called by wire-transport after the user supplies their sGTM URL.
async function upsertServerUrlVariable(serverContainerId, serverWorkspaceId, sgtmUrl) {
  const acc      = getAccountId();
  const basePath = `/accounts/${acc}/containers/${serverContainerId}/workspaces/${serverWorkspaceId}`;

  // List existing variables and look for one named "ET - sGTM URL".
  const varsResp   = await gtmRequest('GET', `${basePath}/variables`).catch(() => ({ variable: [] }));
  const variables  = varsResp.variable || [];
  const existing   = variables.find(v => v.name === 'ET - sGTM URL');

  const varBody = {
    name:      'ET - sGTM URL',
    type:      'c',   // constant
    parameter: [{ type: 'template', key: 'value', value: sgtmUrl }],
    notes:     'sGTM server URL — set by Easy Track wire-transport',
  };

  let variable;
  if (existing) {
    // Update in place.
    const updated = { ...existing, ...varBody };
    variable = await gtmRequest('PUT', `${basePath}/variables/${existing.variableId}`, JSON.stringify(updated));
  } else {
    variable = await gtmRequest('POST', `${basePath}/variables`, JSON.stringify(varBody));
  }

  // Re-version + republish the server container so the variable is live.
  try {
    const ver = await createVersion(serverContainerId, serverWorkspaceId, 'wire sGTM URL variable');
    const versionId = ver.containerVersion && ver.containerVersion.containerVersionId;
    if (versionId) await publishVersion(serverContainerId, versionId);
  } catch (e) {
    console.warn('[gtm] upsertServerUrlVariable republish non-fatal:', e.message);
  }

  return { variableId: variable.variableId, name: variable.name };
}

// End-to-end provisioning when the user picks "client + server".
// 1. Web container — same as provisionForClient (kept unpublished, we publish
//    after wiring transport_url so we don't ship two versions).
// 2. Server container — empty shell created with usageContext=['server'].
// 3. Default sGTM config imported into the server workspace (GA4 + pixels).
// 4. Server version created and published so containerConfig is generated.
// 5. containerConfig string returned to the caller.
//
// The transport_url wiring happens AFTER the user pastes back the deployed
// sGTM URL — that's the wire-transport route, not this function.
async function provisionForClientWithServer(opts) {
  // ══════════════════════════════════════════════════════════════════════════
  // OPTIMISED CLIENT+SERVER PROVISIONING
  // ──────────────────────────────────────────────────────────────────────────
  // Old flow:  web-import (7-8 min) → server-create → server-import (7-8 min)
  //            Total: ~15 min
  //
  // New flow:
  //   Phase 1 (parallel)  : create web + server container shells   (~2s)
  //   Phase 2 (parallel)  : fetch both workspaces                  (~1s)
  //   Phase 3 (sequential): CAPI templates in server workspace      (~3s)
  //   Phase 4 (sequential): import web config   (BURST_SIZE=18/45s) (~2.5 min)
  //   Phase 5 (sequential): import server config (BURST_SIZE=18/45s)(~2.5 min)
  //   Phase 6 (parallel)  : create versions, publish server        (~5s)
  //   Phase 7 (parallel)  : get containerConfig + invite user      (~1s)
  //   Total: ~7 min  (2x faster than before)
  // ══════════════════════════════════════════════════════════════════════════

  if (!isConfigured()) {
    const err = new Error('Managed GTM is not configured on this server');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const onProgress = opts.onProgress || function () {};
  const ts       = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(':', '-');
  const baseName = (opts.projectName || 'Easy Track Project').toString().trim();
  const webName  = baseName.slice(0, 60) + ' · ' + ts;
  const srvName  = baseName.slice(0, 50) + ' (Server) · ' + ts;

  // ── Phase 1: Create BOTH containers in parallel ───────────────────────────
  onProgress({ stage: 'creating_containers', done: 0, total: 2 });

  async function _createWithRetry(name, domain, type) {
    const createFn = type === 'server' ? createServerContainer : createContainer;
    try {
      return await createFn(name, domain);
    } catch (e) {
      if (e.status === 400 && /duplicate/i.test(e.message || '')) {
        const rnd = Math.random().toString(16).slice(2, 8);
        return createFn(name + ' ' + rnd, domain);
      }
      throw e;
    }
  }

  const [webCt, serverCt] = await Promise.all([
    _createWithRetry(webName,  opts.domain || null, 'web'),
    _createWithRetry(srvName,  null,                'server'),
  ]);
  const webContainerId    = webCt.containerId;
  const webPublicId       = webCt.publicId;
  const serverContainerId = serverCt.containerId;
  const serverPublicId    = serverCt.publicId;
  onProgress({ stage: 'creating_containers', done: 2, total: 2 });

  // ── Phase 2: Fetch both workspaces in parallel ────────────────────────────
  const [webWs, serverWs] = await Promise.all([
    getDefaultWorkspace(webContainerId),
    getDefaultWorkspace(serverContainerId),
  ]);
  const webWorkspaceId    = webWs.workspaceId;
  const serverWorkspaceId = serverWs.workspaceId;

  // ── Phase 3: CAPI templates in server workspace ───────────────────────────
  // Must happen BEFORE server config import so tags can reference templates.
  const capiPlatforms = Object.keys(opts.capiTokens || {})
    .filter(p => (opts.capiTokens[p] || '').trim());
  if (capiPlatforms.length) {
    onProgress({ stage: 'capi_templates', done: 0, total: capiPlatforms.length });
    await createCAPITemplates(serverContainerId, serverWorkspaceId, capiPlatforms);
    onProgress({ stage: 'capi_templates', done: capiPlatforms.length, total: capiPlatforms.length });
    console.log('[gtm] CAPI templates created for:', capiPlatforms.join(', '));
  }

  // ── Phase 4: Import web config ────────────────────────────────────────────
  onProgress({ stage: 'web_import', done: 0, total: 1 });
  const webImport = await importContainerJSON(
    webContainerId, webWorkspaceId, opts.configJson, null,
    p => onProgress({ stage: 'web_import', ...p }),
  );

  // ── Phase 5: Import server config ─────────────────────────────────────────
  let sgtmConfig;
  if (opts.serverConfigJson) {
    sgtmConfig = opts.serverConfigJson;
  } else {
    try { sgtmConfig = require('./lib/sgtm-default-config.json'); }
    catch (_) { sgtmConfig = { containerVersion: { variable: [], trigger: [], tag: [] } }; }
  }
  onProgress({ stage: 'sgtm_import', done: 0, total: 1 });
  const serverImport = await importContainerJSON(
    serverContainerId, serverWorkspaceId, sgtmConfig, null,
    p => onProgress({ stage: 'sgtm_import', ...p }),
  );

  // ── Phase 6: Create versions for both containers in parallel ──────────────
  // Web is kept as DRAFT (publish happens after transport_url wiring).
  // Server is published immediately so containerConfig blob is generated.
  onProgress({ stage: 'versioning', done: 0, total: 2 });
  const today = new Date().toISOString().split('T')[0];
  const [webVer, srvVer] = await Promise.all([
    createVersion(webContainerId, webWorkspaceId, 'Easy Track initial — ' + today),
    createVersion(serverContainerId, serverWorkspaceId, 'sGTM initial — ' + today),
  ]);
  const webVersionId = webVer.containerVersion && webVer.containerVersion.containerVersionId;
  const srvVersionId = srvVer.containerVersion && srvVer.containerVersion.containerVersionId;
  onProgress({ stage: 'versioning', done: 2, total: 2 });

  if (srvVersionId) {
    await publishVersion(serverContainerId, srvVersionId).catch(e => {
      console.warn('[gtm] sGTM publish non-fatal:', e.message);
    });
  }

  // ── Phase 7: containerConfig + invite user (parallel) ────────────────────
  const [containerConfig] = await Promise.all([
    getContainerConfig(serverContainerId),
    opts.inviteEmail
      ? Promise.all([
          inviteUserToContainer(webContainerId,    opts.inviteEmail, 'read').catch(() => {}),
          inviteUserToContainer(serverContainerId, opts.inviteEmail, 'read').catch(() => {}),
        ])
      : Promise.resolve(),
  ]);

  // Build web GTM snippet
  const snippetHead = "<!-- Google Tag Manager -->\n"
    + "<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':\n"
    + "new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],\n"
    + "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=\n"
    + "'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);\n"
    + `})(window,document,'script','dataLayer','${webPublicId}');</script>\n`
    + "<!-- End Google Tag Manager -->";
  const snippetBody = "<!-- Google Tag Manager (noscript) -->\n"
    + `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${webPublicId}"\n`
    + 'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n'
    + "<!-- End Google Tag Manager (noscript) -->";

  return {
    // Web container result (same shape as provisionForClient)
    gtmAccountId:    getAccountId(),
    gtmContainerId:  webContainerId,
    gtmPublicId:     webPublicId,
    gtmWorkspaceId:  webWorkspaceId,
    gtmVersionId:    webVersionId,
    published:       false,   // web stays DRAFT until transport_url wired
    publishedAt:     null,
    containerName:   webName,
    importedTagCount:      webImport.importedTagCount      || 0,
    importedTriggerCount:  webImport.importedTriggerCount  || 0,
    importedVariableCount: webImport.importedVariableCount || 0,
    snippetHead,
    snippetBody,
    invited:    !!(opts.inviteEmail),
    inviteEmail: opts.inviteEmail || null,
    inviteError: null,
    // Server container (nested)
    server: {
      gtmAccountId:    getAccountId(),
      containerId:     serverContainerId,
      publicId:        serverPublicId,
      workspaceId:     serverWorkspaceId,
      versionId:       srvVersionId,
      containerName:   srvName,
      containerConfig,
      importedTagCount:      serverImport.importedTagCount      || 0,
      importedTriggerCount:  serverImport.importedTriggerCount  || 0,
      importedVariableCount: serverImport.importedVariableCount || 0,
    },
  };
}

module.exports = {
  isConfigured,
  getAccessToken,
  listContainers,
  createContainer,
  importContainerJSON,
  createVersion,
  publishVersion,
  inviteUserToContainer,
  provisionForClient,
  // Server-side (client + server flow)
  createServerContainer,
  getContainerConfig,
  setGA4TransportUrl,
  upsertServerUrlVariable,
  createCAPITemplates,
  provisionForClientWithServer,
};
