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
// long waits (≥ 60s) to let the per-minute window reset fully.
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
      // 429 means we're past the minute quota — wait the full window + jitter.
      // Schedule: 20s → 40s → 70s → 90s (covers up to 2 full quota windows).
      waitMs = [20000, 40000, 70000, 90000][attempt];
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
// GTM API v2 has no bulk import URL for new workspaces, so we recreate
// Variables → Triggers → Tags one by one. To stay under the
// "Queries per minute per user" quota (default ≈ 40/min), we pace each call.
async function importContainerJSON(containerId, workspaceId, configJson, mode, onProgress) {
  const acc = getAccountId();
  const cv = configJson && configJson.containerVersion ? configJson.containerVersion : (configJson || {});

  const vars = cv.variable || [];
  const trigs = cv.trigger || [];
  const tags = cv.tag || [];

  // Empty config — nothing to import, skip quietly.
  if (!vars.length && !trigs.length && !tags.length) {
    if (typeof onProgress === 'function') onProgress({ stage: 'skip — empty config', done: 0, total: 0 });
    console.log('[gtm] importContainerJSON: empty config, skipping import');
    return { importedTagCount: 0, importedTriggerCount: 0, importedVariableCount: 0 };
  }

  const basePath = `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}`;

  // ── BATCHED PARALLEL STRATEGY ───────────────────────────────────────────────
  // GTM's write quota is ~25 requests/minute per user.
  // Instead of sleeping 3s between each call (sequential, slow), we fire items
  // in PARALLEL bursts of 18 (safely under 25/min), then sleep 65s between
  // bursts if more work remains. Small configs (<18 items) finish in seconds.
  // Larger configs still respect the quota but progress is visible.
  // If you raise the GTM quota in Google Cloud Console, bump BURST_SIZE
  // to match (keeping ~5 headroom under the new limit).
  // Quota 30/min  → BURST_SIZE = 28
  // Quota 100/min → BURST_SIZE = 95
  // Quota 1000/min → BURST_SIZE = 900
  const BURST_SIZE   = 28;
  const BURST_WAIT_MS = 65000;

  const total = vars.length + trigs.length + tags.length;
  let done = 0;
  const report = (stage) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, done, total }); } catch (_) {}
    }
    console.log(`[gtm] import progress: ${stage} ${done}/${total}`);
  };
  report('starting');

  // Run a list of items through writeFn in parallel bursts, respecting quota.
  async function runInBursts(items, label, writeFn) {
    for (let i = 0; i < items.length; i += BURST_SIZE) {
      const batch = items.slice(i, i + BURST_SIZE);
      const batchStart = Date.now();
      // Fire all items in the burst in parallel; retry logic in gtmRequest
      // handles any 429s that slip through.
      const results = await Promise.all(batch.map(async (item) => {
        const r = await writeFn(item);
        done++;
        report(`${label} ${done}/${total}`);
        return r;
      }));
      // If there are more items, wait for the quota window to refresh
      if (i + BURST_SIZE < items.length) {
        const elapsed = Date.now() - batchStart;
        const toWait = Math.max(0, BURST_WAIT_MS - elapsed);
        if (toWait > 0) {
          console.log(`[gtm] burst done, waiting ${toWait}ms for quota window`);
          await sleep(toWait);
        }
      }
      // No-op use to satisfy linters in case batch result is needed later
      void results;
    }
  }

  const triggerMap = {};

  // PHASE 1: Variables + Triggers together (neither depends on the other)
  // Combine them so small configs finish in a single burst.
  const varsAndTrigs = [
    ...vars.map(v => ({ kind: 'variable', item: v })),
    ...trigs.map(t => ({ kind: 'trigger', item: t })),
  ];

  await runInBursts(varsAndTrigs, 'var/trig', async ({ kind, item }) => {
    const body = { ...item };
    if (kind === 'variable') {
      delete body.accountId; delete body.containerId; delete body.workspaceId;
      delete body.variableId; delete body.fingerprint; delete body.path;
      delete body.parentFolderId;
      return gtmRequest('POST', `${basePath}/variables`, JSON.stringify(body));
    }
    // trigger
    const oldId = body.triggerId;
    delete body.accountId; delete body.containerId; delete body.workspaceId;
    delete body.triggerId; delete body.fingerprint; delete body.path;
    delete body.parentFolderId;
    const created = await gtmRequest('POST', `${basePath}/triggers`, JSON.stringify(body));
    if (oldId && created.triggerId) {
      triggerMap[oldId] = created.triggerId;
    }
    return created;
  });

  // PHASE 2: Tags (depend on triggerMap from phase 1)
  await runInBursts(tags, 'tag', async (t) => {
    const body = { ...t };
    delete body.accountId; delete body.containerId; delete body.workspaceId;
    delete body.tagId; delete body.fingerprint; delete body.path;
    delete body.parentFolderId;
    if (body.firingTriggerId) {
      body.firingTriggerId = body.firingTriggerId.map(id => triggerMap[id] || id);
    }
    if (body.blockingTriggerId) {
      body.blockingTriggerId = body.blockingTriggerId.map(id => triggerMap[id] || id);
    }
    if (body.enablingTriggerId) {
      body.enablingTriggerId = body.enablingTriggerId.map(id => triggerMap[id] || id);
    }
    return gtmRequest('POST', `${basePath}/tags`, JSON.stringify(body));
  });

  return { importedVariableCount: vars.length, importedTriggerCount: trigs.length, importedTagCount: tags.length };
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
async function publishVersion(containerId, versionId) {
  const acc = getAccountId();
  return gtmRequest('POST',
    `/accounts/${acc}/containers/${containerId}/versions/${versionId}:publish`, '');
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
// END-TO-END: Client → Managed Container
// Does: createContainer → import JSON → create version → (optional) publish.
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

  // 5. Publish if requested
  let published = false;
  let publishedAt = null;
  if (publishLive && versionId) {
    await publishVersion(containerId, versionId);
    published = true;
    publishedAt = new Date().toISOString();
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

async function createServerContainer(name) {
  const acc = getAccountId();
  const body = JSON.stringify({
    name: name,
    usageContext: ['server'],   // ← the only difference from createContainer()
  });
  return gtmRequest('POST', `/accounts/${acc}/containers`, body);
}

// Fetches the *live* container config string. This is the value that GTM admin
// shows under "Container Settings → Server Container Config", which the user's
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

  // Replace any existing transport_url, append fresh.
  const params = (ga4.parameter || []).filter(p => p.key !== 'transport_url');
  params.push({ type: 'template', key: 'transport_url', value: sgtmUrl });

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
  if (!isConfigured()) {
    const err = new Error('Managed GTM is not configured on this server');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const onProgress = opts.onProgress || function () {};

  // 1. Web container — DO NOT publishLive yet.
  onProgress({ stage: 'web_container', done: 0, total: 1 });
  const web = await provisionForClient({
    ...opts,
    publishLive: false,                 // overridden — wire-transport publishes
  });
  onProgress({ stage: 'web_container', done: 1, total: 1 });

  // 2. Server container shell.
  onProgress({ stage: 'server_container', done: 0, total: 1 });
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(':', '-');
  const baseName = (opts.projectName || 'Easy Track Project').toString().trim();
  const serverName = baseName.slice(0, 50) + ' (Server) · ' + ts;

  let serverCt;
  try {
    serverCt = await createServerContainer(serverName);
  } catch (e) {
    if (e.status === 400 && /duplicate/i.test(e.message || '')) {
      const rnd = Math.random().toString(16).slice(2, 8);
      serverCt = await createServerContainer(serverName + ' ' + rnd);
    } else { throw e; }
  }
  const serverContainerId = serverCt.containerId;
  const serverPublicId    = serverCt.publicId;     // GTM-XXXXXX
  onProgress({ stage: 'server_container', done: 1, total: 1 });

  // 3. Default workspace + import sGTM default config.
  const serverWs = await getDefaultWorkspace(serverContainerId);
  const serverWorkspaceId = serverWs.workspaceId;

  let sgtmConfig;
  try {
    sgtmConfig = require('./lib/sgtm-default-config.json');
  } catch (e) {
    sgtmConfig = { containerVersion: { variable: [], trigger: [], tag: [] } };
    console.warn('[gtm] lib/sgtm-default-config.json missing — server container will be empty');
  }

  onProgress({ stage: 'sgtm_import', done: 0, total: 1 });
  const importResult = await importContainerJSON(
    serverContainerId, serverWorkspaceId, sgtmConfig, null,
    p => onProgress({ stage: 'sgtm_import', ...p }),
  );

  // 4. Grant the service account explicit Publish access on the server container
  //    before trying to publish — GTM API doesn't auto-grant publish to the SA
  //    that created the container in some account configurations.
  try {
    const sa = getSA();
    await gtmRequest('POST', `/accounts/${getAccountId()}/user_permissions`,
      JSON.stringify({
        accountId: String(getAccountId()),
        emailAddress: sa.client_email,
        accountAccess: { permission: 'user' },
        containerAccess: [{ containerId: String(serverContainerId), permission: 'publish' }],
      })
    );
    console.log('[gtm] granted publish access to SA on server container', serverContainerId);
  } catch (e) {
    console.warn('[gtm] grant publish permission non-fatal:', e.message);
  }

  // 5. Version + publish the server container so containerConfig is generated.
  onProgress({ stage: 'sgtm_publish', done: 0, total: 1 });
  const verResp  = await createVersion(serverContainerId, serverWorkspaceId,
    'sGTM initial — ' + new Date().toISOString().split('T')[0]);
  const serverVersionId = verResp.containerVersion && verResp.containerVersion.containerVersionId;
  let publishError = null;
  if (serverVersionId) {
    try {
      await publishVersion(serverContainerId, serverVersionId);
    } catch (e) {
      publishError = e.message;
      console.warn('[gtm] publishVersion non-fatal:', e.message);
    }
  }
  onProgress({ stage: 'sgtm_publish', done: 1, total: 1 });

  // 6. Pull the live containerConfig blob — this is what the user pastes
  //    into Stape / Cloud Run / Docker as the CONTAINER_CONFIG env var.
  //    Only available after a successful publish.
  let containerConfig = null;
  containerConfig = await getContainerConfig(serverContainerId).catch(e => {
    console.warn('[gtm] getContainerConfig non-fatal:', e.message);
    return null;
  });

  return {
    web,                                            // existing shape from provisionForClient
    server: {
      gtmAccountId:    getAccountId(),
      containerId:     serverContainerId,
      publicId:        serverPublicId,
      workspaceId:     serverWorkspaceId,
      versionId:       serverVersionId,
      containerName:   serverName,
      containerConfig,                              // ← the deploy blob
      importedTagCount:      importResult.importedTagCount      || 0,
      importedTriggerCount:  importResult.importedTriggerCount  || 0,
      importedVariableCount: importResult.importedVariableCount || 0,
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
  provisionForClientWithServer,
};
