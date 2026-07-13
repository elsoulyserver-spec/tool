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
// Self-contained timeout transport (https-only). Inlined here — NOT a separate
// module — because the deploy ships only existing tracked files, so runtime code
// must stay self-contained. Three bounded layers (connect / response-inactivity /
// overall), all our own timers → cleared on settle (no leak), single-settle
// guarded, request aborted on breach.
function requestWithTimeouts(opts, body, timeouts) {
  const { connectMs = 0, responseMs = 0, overallMs = 0 } = timeouts || {};
  return new Promise((resolve, reject) => {
    let settled = false, connectTimer = null, idleTimer = null, overallTimer = null;
    const clearAll = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer)    { clearTimeout(idleTimer);    idleTimer    = null; }
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
    };
    const finish = (cb, val) => { if (settled) return; settled = true; clearAll(); cb(val); };
    const fail = (msg) => {
      const e = new Error(msg); e.code = 'ETIMEDOUT'; e.timeout = true;
      try { if (req) req.destroy(); } catch (_) {}
      finish(reject, e);
    };
    const armIdle = () => {
      if (responseMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail('response/inactivity timeout after ' + responseMs + 'ms'), responseMs);
    };
    const req = https.request(opts, (res) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      armIdle();
      let data = '';
      res.setEncoding('utf8');
      res.on('data',  (c)   => { data += c; armIdle(); });
      res.on('end',   ()    => finish(resolve, { status: res.statusCode, data }));
      res.on('error', (err) => { try { req.destroy(); } catch (_) {} finish(reject, err); });
    });
    if (connectMs > 0) connectTimer = setTimeout(() => fail('connect timeout after ' + connectMs + 'ms'), connectMs);
    req.on('socket', (socket) => {
      const onConnect = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } armIdle(); };
      if (socket.connecting) socket.once('connect', onConnect); else onConnect();
    });
    if (overallMs > 0) overallTimer = setTimeout(() => fail('overall deadline exceeded ' + overallMs + 'ms'), overallMs);
    req.on('error', (err) => { if (!settled) finish(reject, err); });
    if (body) req.write(body);
    req.end();
  });
}

// Bounded outbound timeouts for EVERY GTM API call (connect / response / overall)
// so a stalled Google endpoint can never hang a worker forever. Defaults are well
// above normal GTM latency — and the 429 backoff sleeps live in gtmRequest,
// OUTSIDE a single HTTP call, so they don't count against these. All env-tunable.
const GTM_CONNECT_TIMEOUT_MS  = parseInt(process.env.GTM_CONNECT_TIMEOUT_MS  || '15000',  10);
const GTM_RESPONSE_TIMEOUT_MS = parseInt(process.env.GTM_RESPONSE_TIMEOUT_MS || '60000',  10);
const GTM_OVERALL_TIMEOUT_MS  = parseInt(process.env.GTM_OVERALL_TIMEOUT_MS  || '120000', 10);

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

// ── PEM repair ──────────────────────────────────────────────────────────────
// Inlined (deploy ships only existing tracked files) — repairs a private_key no
// matter how the env var mangled its newlines: literal "\n", CRLF, or newlines
// collapsed to spaces (which the old \n-replace couldn't fix). Reconstructs the
// PEM body when the armor markers aren't on their own lines.
const _PEM_RE = /-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;
function normalizePrivateKey(key) {
  if (typeof key !== 'string') return key;
  let k = key.trim().replace(/^["']|["']$/g, '');
  k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  k = k.replace(/\r\n?/g, '\n');
  const m = k.match(_PEM_RE);
  if (!m) return k;
  const label   = m[1];
  const body    = m[2].replace(/\s+/g, '');
  const wrapped = body.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n' + wrapped.join('\n') + '\n-----END ' + label + '-----\n';
}

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
  // Railway/env vars mangle the PEM newlines; restore them so Node crypto can parse it.
  _sa.private_key = normalizePrivateKey(_sa.private_key);
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
  // Inject the shared keep-alive agent so every call reuses the TLS socket, then
  // run it through the bounded-timeout transport. JSON parsing is unchanged — same
  // { status, data } contract (and the same { raw } fallback on non-JSON bodies).
  const withAgent = { agent: keepAliveAgent, protocol: 'https:', ...opts };
  return requestWithTimeouts(withAgent, body, {
    connectMs:  GTM_CONNECT_TIMEOUT_MS,
    responseMs: GTM_RESPONSE_TIMEOUT_MS,
    overallMs:  GTM_OVERALL_TIMEOUT_MS,
  }).then(({ status, data }) => {
    let parsed = null;
    try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
    return { status, data: parsed };
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
  let status, data;
  try {
    ({ status, data } = await httpsJSON({
      hostname: GTM_HOST,
      path: API_BASE + path,
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, body));
  } catch (e) {
    // Bounded timeouts (NEW) can reject here. Retrying a timed-out WRITE risks a
    // duplicate side-effect (provisioning is non-idempotent), so only idempotent
    // GETs are retried; writes surface the timeout to fail the job. Non-timeout
    // socket errors keep propagating exactly as before (no behavior change).
    if (e && e.timeout && method === 'GET' && attempt < MAX_RETRIES) {
      const waitMs = [2000, 5000, 10000, 20000][attempt];
      console.warn(`[gtm] timeout on ${method} ${path} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
      await sleep(waitMs);
      return gtmRequest(method, path, body, attempt + 1);
    }
    throw e;
  }

  if (status >= 200 && status < 300) return data;

  if (attempt < MAX_RETRIES) {
    let waitMs = 0;
    if (status === 429) {
      // 429 = rejected by the per-minute quota → the request did NOT execute, so
      // retrying is duplicate-SAFE for ANY method. Wait the full quota window.
      waitMs = [20000, 40000, 70000, 90000][attempt];
    } else if (status >= 500 && status < 600 && method === 'GET') {
      // 5xx MAY have partially executed server-side. Retry ONLY idempotent GETs —
      // retrying a 5xx'd POST (createContainer / versions:import / createVersion /
      // entity create) could DUPLICATE a provision step. Writes surface the 5xx.
      waitMs = [2000, 5000, 10000, 20000][attempt];
    }

    if (waitMs > 0) {
      console.warn(`[gtm] ${status} on ${method} ${path} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
      await sleep(waitMs);
      return gtmRequest(method, path, body, attempt + 1);
    }
  }

  const msg = (data && data.error && data.error.message) || JSON.stringify(data);
  const err = new Error('GTM API ' + status + ': ' + msg);
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

// Import our generated config JSON into a container's WORKSPACE.
//
// GTM API v2 has NO bulk/import endpoint (verified against the live API and the
// discovery doc: versions:import / workspaces:import both 404). The only way to
// populate a container is entity-by-entity into a workspace, then create_version
// + publish. So this recreates Built-in Variables → Variables → Triggers → Tags,
// UPDATING (PUT) any entity that already exists by name so a re-run never
// duplicates.
//
// FRESH-STATE GUARANTEE (fixes "stale entities remain"): after upserting the new
// config, we DELETE any of OUR entities (name starts with "ET") that are in the
// workspace but NOT in the new config — i.e. leftovers from a previous
// generation (an event that was de-selected, a pixel that was removed). Deletion
// is scoped to our "ET"-prefixed names so a user's own tags are never touched.
//
// Returns { importedVariableCount, importedTriggerCount, importedTagCount,
//           deletedCount, versionId, method }. versionId is always null (this
// path never creates a version — the caller does that), so callers always
// createVersion() next.
const _OURS = (name) => typeof name === 'string' && /^ET\b/.test(name);

// GTM rejects an empty measurementIdOverride and empty LIST params (int64
// deserialize). Strip them defensively so a single bad param can't 400 the tag.
function _sanitizeParams(body) {
  if (Array.isArray(body.parameter)) {
    body.parameter = body.parameter.filter(p => {
      if (p.type === 'LIST' && Array.isArray(p.list) && p.list.length === 0) return false;
      if (p.key === 'measurementIdOverride' && (!p.value || p.value === '')) return false;
      return true;
    });
  }
  return body;
}

async function importContainerJSON(containerId, workspaceId, configJson, mode, onProgress) {
  const acc = getAccountId();
  const cv = configJson && configJson.containerVersion ? configJson.containerVersion : (configJson || {});

  const vars = cv.variable || [];
  const trigs = cv.trigger || [];
  const tags = cv.tag || [];
  const builtIns = cv.builtInVariable || [];

  const counts = {
    importedVariableCount: vars.length,
    importedTriggerCount:  trigs.length,
    importedTagCount:      tags.length,
  };
  const report = (stage, done, total) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, done: done || 0, total: total || 0 }); } catch (_) {}
    }
    console.log(`[gtm] import: ${stage}`);
  };

  // Empty config — nothing to import, skip quietly.
  if (!vars.length && !trigs.length && !tags.length) {
    report('skip — empty config', 0, 0);
    return { ...counts, deletedCount: 0, versionId: null, method: 'empty' };
  }

  const basePath = `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}`;
  const total = vars.length + trigs.length + tags.length;
  let done = 0;

  const strip = (item, idKey) => {
    const body = { ...item };
    delete body.accountId; delete body.containerId; delete body.workspaceId;
    delete body.fingerprint; delete body.path; delete body.parentFolderId;
    if (idKey) delete body[idKey];
    return body;
  };
  // POST a new entity, or PUT when one with the same name already exists.
  // A 400 "duplicate name" from a POST is treated as already-present (skip).
  const upsert = async (kind, path, body, existingId) => {
    try {
      if (existingId) return await gtmRequest('PUT', `${path}/${existingId}`, JSON.stringify(body));
      return await gtmRequest('POST', path, JSON.stringify(body));
    } catch (e) {
      if (e.status === 400 && /duplicate/i.test(e.message || '')) {
        console.warn(`[gtm] ${kind} "${body.name}" already exists — skipped`);
        return null;
      }
      throw e;
    }
  };

  // ── Built-in variables (enabled in one call; entities reference {{Page URL}} etc.)
  if (builtIns.length) {
    const q = builtIns.map(b => 'type=' + encodeURIComponent(b.type)).join('&');
    report('enable built-in variables', done, total);
    try { await gtmRequest('POST', `${basePath}/built_in_variables?${q}`, ''); }
    catch (e) { console.warn('[gtm] enable built-ins failed (non-fatal):', e.message); }
  }

  // Preload existing entities so a re-run UPDATES rather than duplicates.
  report('loading existing variables', done, total);
  const existVars  = await gtmRequest('GET', `${basePath}/variables`).catch(() => ({}));
  report('loading existing triggers', done, total);
  const existTrigs = await gtmRequest('GET', `${basePath}/triggers`).catch(() => ({}));
  const varIdByName  = {}; (existVars.variable || []).forEach(v => { varIdByName[v.name]  = v.variableId; });
  const trigIdByName = {}; (existTrigs.trigger || []).forEach(t => { trigIdByName[t.name] = t.triggerId; });

  // PHASE 1: Variables (neither tags nor triggers depend on them yet).
  for (const v of vars) {
    const body = strip(v, 'variableId');
    await upsert('variable', `${basePath}/variables`, body, varIdByName[v.name]);
    done++; report(`variable ${done}/${total}`, done, total);
  }

  // PHASE 2: Triggers — capture created IDs so tags can remap firing triggers.
  const triggerMap = {};
  for (const t of trigs) {
    const oldId = t.triggerId;
    const body = strip(t, 'triggerId');
    const existingTid = trigIdByName[t.name];
    const res = await upsert('trigger', `${basePath}/triggers`, body, existingTid);
    const newId = (res && res.triggerId) || existingTid;
    if (oldId && newId) triggerMap[oldId] = newId;
    done++; report(`trigger ${done}/${total}`, done, total);
  }

  // PHASE 3: Tags (depend on triggerMap from phase 2).
  report('loading existing tags', done, total);
  const existTags = await gtmRequest('GET', `${basePath}/tags`).catch(() => ({}));
  const tagIdByName = {}; (existTags.tag || []).forEach(g => { tagIdByName[g.name] = g.tagId; });
  for (const t of tags) {
    const body = _sanitizeParams(strip(t, 'tagId'));
    if (body.firingTriggerId)   body.firingTriggerId   = body.firingTriggerId.map(id => triggerMap[id] || id);
    if (body.blockingTriggerId) body.blockingTriggerId = body.blockingTriggerId.map(id => triggerMap[id] || id);
    await upsert('tag', `${basePath}/tags`, body, tagIdByName[t.name]);
    done++; report(`tag ${done}/${total}`, done, total);
  }

  // ── PHASE 4: DELETE our stale entities (in workspace, not in new config) ────
  // Order: tags first (they reference triggers), then triggers, then variables.
  const newTagNames = new Set(tags.map(t => t.name));
  const newTrigNames = new Set(trigs.map(t => t.name));
  const newVarNames = new Set(vars.map(v => v.name));
  let deletedCount = 0;
  const del = async (kind, path, id, name) => {
    try { await gtmRequest('DELETE', `${path}/${id}`); deletedCount++; console.log(`[gtm] deleted stale ${kind} "${name}"`); }
    catch (e) { console.warn(`[gtm] delete stale ${kind} "${name}" failed (non-fatal): ${e.message}`); }
  };
  for (const g of (existTags.tag || [])) {
    if (_OURS(g.name) && !newTagNames.has(g.name)) await del('tag', `${basePath}/tags`, g.tagId, g.name);
  }
  for (const t of (existTrigs.trigger || [])) {
    if (_OURS(t.name) && !newTrigNames.has(t.name)) await del('trigger', `${basePath}/triggers`, t.triggerId, t.name);
  }
  for (const v of (existVars.variable || [])) {
    if (_OURS(v.name) && !newVarNames.has(v.name)) await del('variable', `${basePath}/variables`, v.variableId, v.name);
  }

  console.log('[gtm] import via item-by-item', JSON.stringify({ containerId, workspaceId, deletedCount, ...counts }));
  return { ...counts, deletedCount, versionId: null, method: 'item_by_item' };
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
//
// If the exact versionId is gone (404 — e.g. a stale id carried over from an
// earlier run, or a version superseded by a concurrent publish), we do NOT give
// up: we list the container's versions and publish the latest one instead, so
// the live container still reflects the newest generated state. Any other
// status (401/403/quota/5xx) is re-thrown so the caller fails loudly — a
// publish must never be silently reported as successful.
async function publishVersion(containerId, versionId) {
  const acc = getAccountId();
  const doPublish = (vid) => gtmRequest('POST',
    `/accounts/${acc}/containers/${containerId}/versions/${vid}:publish`, '');
  try {
    return await doPublish(versionId);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.warn(`[gtm] publish v${versionId} → 404; resolving latest version to publish instead`);
    const list = await gtmRequest('GET', `/accounts/${acc}/containers/${containerId}/version_headers`);
    // version_headers → containerVersionHeader[]; the mock/list form → containerVersion[].
    const versions = list.containerVersionHeader || list.containerVersion || [];
    const latest = versions
      .map(v => v.containerVersionId)
      .filter(Boolean)
      .sort((a, b) => Number(b) - Number(a))[0];
    if (!latest) throw e;
    console.warn(`[gtm] publishing latest version v${latest} for container ${containerId}`);
    return await doPublish(latest);
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

  // 1. Create container — append millisecond timestamp + random hex so the name
  //    is unique even across rapid retries. GTM returns 400 "duplicate name" on
  //    any name collision within the account.
  const ts = Date.now().toString(36);  // base-36 ms — 6-7 chars, always unique
  const rnd = crypto.randomBytes(3).toString('hex');  // 6 hex chars for extra safety
  const baseName = (projectName || 'Easy Track Project').toString().trim();
  const uniqueName = baseName.slice(0, 55) + ' · ' + ts + rnd;
  const container = await createContainer(uniqueName, domain);
  const containerId = container.containerId;
  const publicId = container.publicId;     // e.g. GTM-XXXXXX

  // 2. Workspace
  const workspace = await getDefaultWorkspace(containerId);
  const workspaceId = workspace.workspaceId;

  // 3. Import our generated config
  const importResult = await importContainerJSON(containerId, workspaceId, configJson, null, onProgress);

  // 4. Create version from the workspace we just populated (item-by-item import
  //    never creates a version itself — GTM has no import endpoint).
  const versionName = 'Easy Track initial import — ' + new Date().toISOString().split('T')[0];
  const versionResp = await createVersion(containerId, workspaceId, versionName);
  const versionId = (versionResp.containerVersion || {}).containerVersionId;

  console.log('[gtm] provisionForClient prepared', JSON.stringify({
    containerId, publicId, workspaceId, versionId, versionName,
    importMethod: importResult.method,
    imported: {
      tags:      importResult.importedTagCount,
      triggers:  importResult.importedTriggerCount,
      variables: importResult.importedVariableCount,
    },
  }));

  // 5. Publish if requested. Capture the published version number and never
  //    report success unless publishVersion resolved (it throws on any non-2xx).
  let published = false;
  let publishedAt = null;
  let publishedVersionId = null;
  if (publishLive && versionId) {
    const pubResp = await publishVersion(containerId, versionId);
    published = true;
    publishedAt = new Date().toISOString();
    publishedVersionId = (pubResp && pubResp.containerVersion &&
      pubResp.containerVersion.containerVersionId) || versionId;
    console.log('[gtm] provisionForClient published', JSON.stringify({
      containerId, publicId, publishedVersionId,
    }));
  } else if (publishLive && !versionId) {
    console.warn('[gtm] provisionForClient: publishLive requested but no versionId — nothing published');
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
    publishedVersionId,
    importMethod:    importResult.method,
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

// ══════════════════════════════════════════════════════════════════════════════
// FULL-FIDELITY SERVER IMPORT  (Phase-1)  —  versions:import
// Mirrors the BYO flow's /api/gtm/import proxy EXACTLY (same path + body wrapping,
// see server.js) but server-side, authenticated with the managed Service Account
// token via gtmRequest. Unlike importContainerJSON (which only creates
// variable/trigger/tag), versions:import preserves the FULL container —
// variable, trigger, tag, CLIENT, and customTemplate — i.e. the Meta/TikTok/Snap
// CAPI entities. Returns the GTM response (a ContainerVersion).
async function importServerContainerVersion(containerId, configJson) {
  if (!containerId) throw new Error('importServerContainerVersion: containerId required');
  if (!configJson)  throw new Error('importServerContainerVersion: configJson required');
  const acc = getAccountId();
  // Same wrapping the BYO proxy applies for full GTM container exports.
  const apiBody = (configJson.exportFormatVersion !== undefined)
    ? { containerConfigJSON: JSON.stringify(configJson) }
    : configJson;
  return gtmRequest(
    'POST',
    `/accounts/${acc}/containers/${containerId}/versions:import`,
    JSON.stringify(apiBody),
  );
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
async function provisionServerOnly(opts) {
  if (!isConfigured()) {
    const err = new Error('Managed GTM is not configured on this server');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  opts = opts || {};
  const onProgress = opts.onProgress || function () {};

  onProgress({ stage: 'server_container', done: 0, total: 1 });
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(':', '-');
  const baseName = (opts.projectName || 'Easy Track Project').toString().trim();
  const serverName = baseName.slice(0, 50) + ' (Server) - ' + ts;

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
  const serverPublicId    = serverCt.publicId;
  onProgress({ stage: 'server_container', done: 1, total: 1 });

  const serverWs = await getDefaultWorkspace(serverContainerId);
  const serverWorkspaceId = serverWs.workspaceId;

  let importResult;
  let serverVersionId;

  if (opts.serverConfigJson) {
    onProgress({ stage: 'sgtm_import', done: 0, total: 1 });
    const imp = await importServerContainerVersion(serverContainerId, opts.serverConfigJson);
    const cv  = opts.serverConfigJson.containerVersion || {};
    importResult = {
      importedTagCount:      (cv.tag      || []).length,
      importedTriggerCount:  (cv.trigger  || []).length,
      importedVariableCount: (cv.variable || []).length,
    };
    serverVersionId = (imp && (imp.containerVersionId ||
      (imp.containerVersion && imp.containerVersion.containerVersionId))) || null;
    if (!serverVersionId) {
      console.warn('[gtm] versions:import returned no version id - server container may be unpublished');
    }
    onProgress({ stage: 'sgtm_import', done: 1, total: 1 });
  } else {
    let sgtmConfig;
    try {
      sgtmConfig = require('./lib/sgtm-default-config.json');
    } catch (e) {
      sgtmConfig = { containerVersion: { variable: [], trigger: [], tag: [] } };
      console.warn('[gtm] lib/sgtm-default-config.json missing - server container will be empty');
    }

    onProgress({ stage: 'sgtm_import', done: 0, total: 1 });
    importResult = await importContainerJSON(
      serverContainerId, serverWorkspaceId, sgtmConfig, null,
      p => onProgress({ stage: 'sgtm_import', ...p }),
    );

    const verResp  = await createVersion(serverContainerId, serverWorkspaceId,
      'sGTM initial - ' + new Date().toISOString().split('T')[0]);
    serverVersionId = verResp.containerVersion && verResp.containerVersion.containerVersionId;
  }

  onProgress({ stage: 'sgtm_publish', done: 0, total: 1 });
  if (serverVersionId) {
    await publishVersion(serverContainerId, serverVersionId);
  }
  onProgress({ stage: 'sgtm_publish', done: 1, total: 1 });

  const containerConfig = await getContainerConfig(serverContainerId);

  return {
    gtmAccountId:    getAccountId(),
    containerId:     serverContainerId,
    publicId:        serverPublicId,
    workspaceId:     serverWorkspaceId,
    versionId:       serverVersionId,
    containerName:   serverName,
    containerConfig,
    importedTagCount:      importResult.importedTagCount      || 0,
    importedTriggerCount:  importResult.importedTriggerCount  || 0,
    importedVariableCount: importResult.importedVariableCount || 0,
  };
}

async function provisionForClientWithServer(opts) {
  if (!isConfigured()) {
    const err = new Error('Managed GTM is not configured on this server');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  opts = opts || {};
  const onProgress = opts.onProgress || function () {};

  // 1. Web container — DO NOT publishLive yet.
  onProgress({ stage: 'web_container', done: 0, total: 1 });
  const web = await provisionForClient({
    ...opts,
    publishLive: false,                 // overridden — wire-transport publishes
  });
  onProgress({ stage: 'web_container', done: 1, total: 1 });

  const server = await provisionServerOnly(opts);
  return { web, server };
}

// ══════════════════════════════════════════════════════════════════════════════
// TAG OPERATIONS — used by token rotation
// ══════════════════════════════════════════════════════════════════════════════

// List all tags in a workspace. Returns raw GTM tag objects.
async function listContainerTags(containerId, workspaceId) {
  const acc = getAccountId();
  const res = await gtmRequest('GET',
    `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}/tags`);
  return (res && res.tag) ? res.tag : [];
}

// Update a single tag's parameter by key. Merges the new param value into the
// existing parameter list (preserves all other params). Returns updated tag.
async function updateContainerTag(containerId, workspaceId, tagId, paramKey, paramValue) {
  const acc = getAccountId();
  // Fetch current tag state so we can do a surgical param update.
  const current = await gtmRequest('GET',
    `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`);
  const params = (current.parameter || []).map(p => {
    if (p.key === paramKey) return { ...p, value: paramValue };
    return p;
  });
  // If param didn't exist yet, append it.
  if (!params.some(p => p.key === paramKey)) {
    params.push({ type: 'template', key: paramKey, value: paramValue });
  }
  const body = JSON.stringify({ ...current, parameter: params });
  return gtmRequest('PUT',
    `/accounts/${acc}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
    body);
}

// ══════════════════════════════════════════════════════════════════════════════
// TOKEN ROTATION — update authHeader on the CAPI tag in the sGTM container,
// create a new version, and publish it. Used by POST /api/admin/rotate-token.
// Returns { tagId, versionId, published }.
// ══════════════════════════════════════════════════════════════════════════════
async function rotateCapiTokenInContainer(containerId, workspaceId, platform, newToken) {
  // Find the CAPI tag for the platform. The universal-http.tpl tag has a
  // `platform` parameter set to 'meta'/'tiktok'/'snap'. If there are multiple
  // containers (one per platform), match by `authHeader` parameter presence.
  const tags = await listContainerTags(containerId, workspaceId);
  const CAPI_TAG_TYPES = ['cvt_', 'custom_template'];  // sGTM custom template prefix

  const capiTags = tags.filter(t => {
    // Custom templates have type 'cvt_...' in sGTM
    const isCustom = t.type && (t.type.startsWith('cvt_') || t.type === 'custom_template');
    if (!isCustom) return false;
    const params = t.parameter || [];
    const platformParam = params.find(p => p.key === 'platform');
    const hasAuthHeader = params.some(p => p.key === 'authHeader');
    return hasAuthHeader && (!platform || (platformParam && platformParam.value === platform));
  });

  if (!capiTags.length) {
    throw new Error('No CAPI tag found for platform=' + (platform || 'any') +
      ' in container ' + containerId + ' workspace ' + workspaceId);
  }

  const results = [];
  for (const tag of capiTags) {
    await updateContainerTag(containerId, workspaceId, tag.tagId, 'authHeader', newToken);
    results.push(tag.tagId);
  }

  // Create a new version and publish it.
  const verResp = await createVersion(containerId, workspaceId,
    'Token rotation — ' + (platform || 'CAPI') + ' — ' + new Date().toISOString().split('T')[0]);
  const versionId = verResp.containerVersion && verResp.containerVersion.containerVersionId;
  if (versionId) await publishVersion(containerId, versionId);

  return { tagIds: results, versionId, published: !!versionId };
}

// ══════════════════════════════════════════════════════════════════════════════
// DRIFT DETECTION — compare the live GTM container version against what Easy
// Track last published. If they differ, someone made manual changes in GTM.
// Returns { driftDetected, liveVersionId, lastKnownVersionId, warning }.
// Non-throwing — callers treat drift as a warning, never a blocker.
// ══════════════════════════════════════════════════════════════════════════════
async function getLiveContainerVersion(containerId) {
  if (!containerId) throw new Error('getLiveContainerVersion: containerId required');
  const acc  = getAccountId();
  const resp = await gtmRequest(
    'GET',
    `/accounts/${acc}/containers/${containerId}/versions:live`,
  );
  return resp.containerVersion || resp;
}

async function detectContainerDrift(containerId, lastKnownGtmVersionId) {
  try {
    const live          = await getLiveContainerVersion(containerId);
    const liveVersionId = live.containerVersionId || live.containerVersion?.containerVersionId;
    const driftDetected = liveVersionId && lastKnownGtmVersionId &&
                          String(liveVersionId) !== String(lastKnownGtmVersionId);
    return {
      driftDetected:    !!driftDetected,
      liveVersionId:    liveVersionId   || null,
      lastKnownVersionId: lastKnownGtmVersionId || null,
      warning: driftDetected
        ? `GTM container has manual changes (live: v${liveVersionId}, Easy Track last published: v${lastKnownGtmVersionId}). Rollback will overwrite them.`
        : null,
    };
  } catch (e) {
    // Non-fatal — drift check failure should never block a rollback.
    return { driftDetected: false, liveVersionId: null, lastKnownVersionId: null,
             warning: null, checkError: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROLLBACK — replace an existing container's state with a rebuilt config.
// Called by POST /api/versions/rollback.
//
// WHY versions:import instead of importContainerJSON():
//   importContainerJSON() does item-by-item POST into a workspace. GTM workspaces
//   inherit all items from the live container, so adding items would DUPLICATE
//   them (15 live + 15 rebuilt = 30 items). versions:import replaces the
//   container state entirely — the correct semantic for rollback.
//
// The configJson is rebuilt server-side from the stored configSnapshot.
// Firestore Client Config is the source of truth; the GTM container is a
// compiled artifact derived from it.
// ══════════════════════════════════════════════════════════════════════════════
async function rollbackContainer(containerId, configJson, versionLabel) {
  const acc = getAccountId();

  // Wrap in the containerConfigJSON envelope that the GTM import API requires.
  const apiBody = { containerConfigJSON: JSON.stringify(configJson) };
  const importResp = await gtmRequest(
    'POST',
    `/accounts/${acc}/containers/${containerId}/versions:import`,
    JSON.stringify(apiBody),
  );

  const versionId =
    importResp.containerVersion && importResp.containerVersion.containerVersionId;
  if (!versionId) throw new Error('rollbackContainer: versions:import returned no versionId');

  await publishVersion(containerId, versionId);
  // versions:import does not use a workspace — return null for workspaceId.
  return { versionId, workspaceId: null };
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
  rollbackContainer,
  getLiveContainerVersion,
  detectContainerDrift,
  // Server-side (client + server flow)
  createServerContainer,
  getContainerConfig,
  importServerContainerVersion,
  setGA4TransportUrl,
  provisionServerOnly,
  provisionForClientWithServer,
  // Tag operations / token rotation
  listContainerTags,
  updateContainerTag,
  rotateCapiTokenInContainer,
};
