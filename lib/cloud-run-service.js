// ══════════════════════════════════════════════════════════════════════════════
// lib/cloud-run-service.js
// Clean OO client for the Cloud Run Admin API v2 (REST).
//
// One instance per shard — construct with the shard object from shard-registry.
// All token minting goes through lib/gcp-auth; no Google credential logic here.
//
// API reference: https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
//
// Usage:
//   const svc = new CloudRunService(shard);
//   const spec = CloudRunService.buildServiceSpec({ image, env, minInstances, maxInstances, memory });
//   const op = await svc.createService('sgtm-abc123-tag', spec);
//   await svc.waitForOperation(op.name, { timeoutMs: 480_000, onTick });
//   await svc.setPublicInvoker('sgtm-abc123-tag');
//   await svc.pollHealthy('https://sgtm-abc123-tag-xxxx-ew.a.run.app', { timeoutMs: 300_000 });
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { getAccessToken } = require('./gcp-auth');

const CR_HOST           = 'https://run.googleapis.com';
const CR_SCOPE          = 'https://www.googleapis.com/auth/cloud-platform';
const LRO_POLL_INTERVAL = 4000;  // ms between LRO GET polls
const HEALTH_POLL_INTERVAL = 5000; // ms between /healthy polls
const DEFAULT_LRO_TIMEOUT_MS    = 8 * 60 * 1000;  // 8 min
const DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min
const FETCH_TIMEOUT_MS = 10_000;

// ── Internal helpers ──────────────────────────────────────────────────────────

function _makeError(message, { status, code, details } = {}) {
  const err = new Error(message);
  if (status  !== undefined) err.status  = status;
  if (code    !== undefined) err.code    = code;
  if (details !== undefined) err.details = details;
  return err;
}

async function _fetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await globalThis.fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  return res;
}

async function _crRequest(url, method, token, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await _fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }

  if (!res.ok) {
    const gErr   = data.error || {};
    const msg    = gErr.message || text.slice(0, 300);
    const code   = gErr.status  || null;
    const err    = _makeError(
      `Cloud Run API ${method} ${url} failed (HTTP ${res.status}): ${msg}`,
      { status: res.status, code, details: gErr.details },
    );
    throw err;
  }
  return data;
}

// ── CloudRunService ───────────────────────────────────────────────────────────

class CloudRunService {
  /**
   * @param {object} shard  resolved shard object from shard-registry:
   *   { id, gcpProjectId, region, saKeyJson }
   */
  /**
   * @param {object} shard  resolved shard from shard-registry
   * @param {object} [_testOpts]  test-only overrides: { lroPollMs, healthPollMs }
   */
  constructor(shard, _testOpts = {}) {
    if (!shard || !shard.gcpProjectId || !shard.region || !shard.saKeyJson) {
      throw _makeError('CloudRunService requires a resolved shard object with gcpProjectId, region, saKeyJson');
    }
    this._shard         = shard;
    this._parent        = `projects/${shard.gcpProjectId}/locations/${shard.region}`;
    this._lroPollMs     = _testOpts.lroPollMs     ?? LRO_POLL_INTERVAL;
    this._healthPollMs  = _testOpts.healthPollMs  ?? HEALTH_POLL_INTERVAL;
  }

  async _token() {
    const { accessToken } = await getAccessToken({ saKeyJson: this._shard.saKeyJson, scope: CR_SCOPE });
    return accessToken;
  }

  _serviceUrl(serviceId) {
    return `${CR_HOST}/v2/${this._parent}/services/${serviceId}`;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Create a Cloud Run service.
   * Returns `{ alreadyExists: true }` on 409 so callers can treat that as a
   * resume signal rather than a fatal error.
   */
  async createService(serviceId, spec) {
    const token = await this._token();
    const url   = `${CR_HOST}/v2/${this._parent}/services?serviceId=${encodeURIComponent(serviceId)}`;
    try {
      const op = await _crRequest(url, 'POST', token, spec);
      return op;
    } catch (err) {
      if (err.status === 409) return { alreadyExists: true };
      throw err;
    }
  }

  /** Patch-update a Cloud Run service (full replacement spec). */
  async updateService(serviceId, spec) {
    const token = await this._token();
    const url   = this._serviceUrl(serviceId);
    return _crRequest(url, 'PATCH', token, spec);
  }

  /**
   * Get current service state.
   * Returns `{ uri, terminalCondition, latestReadyRevision, raw }`.
   */
  async getService(serviceId) {
    const token = await this._token();
    const data  = await _crRequest(this._serviceUrl(serviceId), 'GET', token);
    return {
      uri:                  data.uri                  || null,
      terminalCondition:    data.terminalCondition    || null,
      latestReadyRevision:  data.latestReadyRevision  || null,
      raw:                  data,
    };
  }

  /** Delete a Cloud Run service. */
  async deleteService(serviceId) {
    const token = await this._token();
    return _crRequest(this._serviceUrl(serviceId), 'DELETE', token);
  }

  // ── IAM ───────────────────────────────────────────────────────────────────

  /**
   * Grant allUsers the `roles/run.invoker` role (makes the service publicly
   * callable without authentication).
   */
  async setPublicInvoker(serviceId) {
    const token = await this._token();
    const url   = `${this._serviceUrl(serviceId)}:setIamPolicy`;
    return _crRequest(url, 'POST', token, {
      policy: {
        bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }],
      },
    });
  }

  // ── LRO poll ──────────────────────────────────────────────────────────────

  /**
   * Poll a Long-Running Operation until done or timeout.
   * @param {string} opName   full operation resource name from createService/updateService
   * @param {object} opts
   *   timeoutMs  {number}   default 8 min
   *   onTick     {Function} called each poll cycle with { elapsed, opName }
   */
  async waitForOperation(opName, { timeoutMs = DEFAULT_LRO_TIMEOUT_MS, onTick } = {}) {
    const token    = await this._token();
    const url      = `${CR_HOST}/v2/${opName}`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const data = await _crRequest(url, 'GET', token);

      if (typeof onTick === 'function') onTick({ elapsed: Date.now() - (deadline - timeoutMs), opName });

      if (data.done) {
        if (data.error) {
          throw _makeError(
            `Cloud Run operation failed: ${data.error.message || JSON.stringify(data.error)}`,
            { code: data.error.code, details: data.error.details },
          );
        }
        return data.response || data;
      }

      await _sleep(this._lroPollMs);
    }

    throw _makeError(`Cloud Run operation timed out after ${timeoutMs}ms: ${opName}`, { code: 'DEADLINE_EXCEEDED' });
  }

  // ── Health poll ───────────────────────────────────────────────────────────

  /**
   * Poll GET `{baseUrl}/healthy` until HTTP 200 or timeout.
   * No auth header — the service is public.
   * @param {string} baseUrl   base URL of the Cloud Run service (run.app URL)
   * @param {object} opts
   *   timeoutMs  {number}   default 5 min
   *   onTick     {Function} called each cycle with { elapsed, status }
   */
  async pollHealthy(baseUrl, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, onTick } = {}) {
    const url      = baseUrl.replace(/\/$/, '') + '/healthy';
    const deadline = Date.now() + timeoutMs;
    const start    = Date.now();

    while (Date.now() < deadline) {
      let status = 0;
      try {
        const res = await _fetch(url, { method: 'GET' });
        status = res.status;
      } catch (_) {
        // network error / container not yet ready — keep polling
      }

      if (typeof onTick === 'function') onTick({ elapsed: Date.now() - start, status });

      if (status === 200) return { ok: true, url };

      await _sleep(this._healthPollMs);
    }

    throw _makeError(`Health check timed out after ${timeoutMs}ms: ${url}`, { code: 'HEALTH_TIMEOUT' });
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  /**
   * Build a Cloud Run Admin API v2 service spec.
   * Never logs env values — CONTAINER_CONFIG rides in here as an env var and
   * must remain in memory only.
   *
   * @param {object} params
   *   image         {string}   container image URI
   *   env           {object}   key→value map of env vars
   *   minInstances  {number}   default 0
   *   maxInstances  {number}   default 3
   *   memory        {string}   default '512Mi'
   *   port          {number}   default 8080
   */
  static buildServiceSpec({ image, env = {}, minInstances = 0, maxInstances = 3, memory = '512Mi', port = 8080 } = {}) {
    if (!image) throw _makeError('buildServiceSpec: image is required');
    return {
      template: {
        scaling: { minInstanceCount: minInstances, maxInstanceCount: maxInstances },
        containers: [{
          image,
          ports: [{ containerPort: port }],
          resources: { limits: { memory } },
          env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })),
          startupProbe: {
            httpGet: { path: '/healthy' },
            initialDelaySeconds: 5,
            periodSeconds:       5,
            failureThreshold:    30,
          },
        }],
      },
    };
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { CloudRunService };
