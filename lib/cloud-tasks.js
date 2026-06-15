// ══════════════════════════════════════════════════════════════════════════════
// lib/cloud-tasks.js
// Minimal, dependency-free Google Cloud Tasks client (REST v2 over built-in https).
//
// WHY (C3): container provisioning takes 60-120s with 65s GTM-quota sleeps. Run
// as fire-and-forget after a 202, Cloud Run throttles the instance CPU to ~0 and
// the work stalls. Instead we enqueue a Cloud Task; Cloud Tasks then POSTs to our
// own worker route as a fresh HTTP request, so CPU is allocated for the full
// duration of the work — no "CPU always allocated" billing flag required.
//
// Auth: the access token to CALL the Cloud Tasks API comes from the Cloud Run /
// GCE metadata server (the runtime service account). Grant that SA the
// `roles/cloudtasks.enqueuer` role. The task itself carries:
//   • X-Internal-Token header  — the auth the worker route enforces today
//   • an OIDC token (optional)  — for when the worker is later split onto a
//                                 --no-allow-unauthenticated service
//
// Required env vars (all must be set for isConfigured() to be true):
//   CLOUD_TASKS_PROJECT   (or GOOGLE_CLOUD_PROJECT)  — GCP project id
//   CLOUD_TASKS_LOCATION  — queue region, e.g. me-central1
//   CLOUD_TASKS_QUEUE     — queue id, e.g. provisioning-jobs
//   WORKER_BASE_URL       — this service's public base URL (https://…run.app)
// Optional:
//   CLOUD_TASKS_OIDC_SA   — service account email for the task's OIDC token
//   INTERNAL_WORKER_SECRET — shared secret sent as X-Internal-Token
//
// When these are unset (local dev / Railway), isConfigured() returns false and
// the caller runs the job in-process instead (CPU is not throttled off-GCP).
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const https = require('https');
const http  = require('http');

const METADATA_HOST = 'metadata.google.internal';
const TASKS_HOST    = 'cloudtasks.googleapis.com';

function _env(name) { return (process.env[name] || '').trim(); }

function projectId()        { return _env('CLOUD_TASKS_PROJECT') || _env('GOOGLE_CLOUD_PROJECT') || _env('GCP_PROJECT'); }
function location()         { return _env('CLOUD_TASKS_LOCATION'); }
function queueName()        { return _env('CLOUD_TASKS_QUEUE'); }
function workerBaseUrl()    { return _env('WORKER_BASE_URL').replace(/\/$/, ''); }
function oidcServiceAccount() { return _env('CLOUD_TASKS_OIDC_SA'); }
function internalSecret()   { return _env('INTERNAL_WORKER_SECRET'); }

// Fully usable only when the queue coordinates + worker URL are all present.
function isConfigured() {
  return !!(projectId() && location() && queueName() && workerBaseUrl());
}

// ── Access token via the metadata server (cached until ~1 min before expiry) ──
let _token = null;
let _tokenExp = 0;

function _getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && now < _tokenExp - 60) return Promise.resolve(_token);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host:    METADATA_HOST,
      path:    '/computeMetadata/v1/instance/service-accounts/default/token',
      method:  'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('metadata token HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        }
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { return reject(new Error('metadata token parse error')); }
        if (!parsed.access_token) return reject(new Error('metadata token missing access_token'));
        _token    = parsed.access_token;
        _tokenExp = now + (parsed.expires_in || 3600);
        resolve(_token);
      });
    });
    req.on('timeout', () => req.destroy(new Error('metadata token request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function _tasksRequest(path, bodyObj, token) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TASKS_HOST,
      path,
      method:   'POST',
      headers: {
        'Authorization':  'Bearer ' + token,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Cloud Tasks request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Enqueue a provisioning job as an HTTP-target Cloud Task ───────────────────
// `payload` is a SMALL JSON object (e.g. { jobType, jobId }). The heavy input
// (configJson, etc.) lives in the Firestore job doc — NOT in the task — so we
// stay well under the Cloud Tasks per-task size limit.
async function enqueueProvisionJob(payload) {
  if (!isConfigured()) throw new Error('Cloud Tasks is not configured');

  const token  = await _getToken();
  const parent = 'projects/' + projectId() + '/locations/' + location() + '/queues/' + queueName();
  const url    = workerBaseUrl() + '/api/internal/run-provision-job';

  const headers = { 'Content-Type': 'application/json' };
  const secret  = internalSecret();
  if (secret) headers['X-Internal-Token'] = secret;

  const httpRequest = {
    httpMethod: 'POST',
    url,
    headers,
    body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  };

  // Attach an OIDC token when a service account is configured — lets you later
  // move the worker onto a --no-allow-unauthenticated service where Cloud Run
  // verifies the token natively.
  const sa = oidcServiceAccount();
  if (sa) httpRequest.oidcToken = { serviceAccountEmail: sa, audience: workerBaseUrl() };

  const { status, data } = await _tasksRequest('/v2/' + parent + '/tasks', { task: { httpRequest } }, token);

  if (status < 200 || status >= 300) {
    const msg = (data && data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
    const err = new Error('Cloud Tasks create failed (' + status + '): ' + msg);
    err.status = status;
    throw err;
  }
  return { name: (data && data.name) || null };
}

module.exports = { isConfigured, enqueueProvisionJob };
