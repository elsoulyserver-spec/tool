// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/stape.js
// Stape.io API integration — full automation for sGTM container management.
//
// Auth: API Key passed as Bearer token (generated in Stape account settings).
// Docs: https://api.app.stape.io/api/doc  (Swagger UI — all plans supported)
//
// ⚠️  stapeApiKey is NEVER stored in server env vars — it is passed per-request
//     from the encrypted Firestore config and decrypted at call time.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { BaseProvider, withRetry, getAxios } = require('./base');

const STAPE_API_BASE    = 'https://api.app.stape.io';
const STAPE_API_BASE_EU = 'https://api.app.eu.stape.io';

class StapeProvider extends BaseProvider {
  constructor(config) {
    super(config);
    // config.stapeApiKey  — decrypted token, required for deploy/status calls
    // config.stapeRegion  — 'global' (default) | 'eu'
    this._apiBase = (config && config.stapeRegion === 'eu') ? STAPE_API_BASE_EU : STAPE_API_BASE;
  }

  _headers(apiKey) {
    const key = apiKey || (this.config && this.config.stapeApiKey);
    if (!key) throw new Error('Stape API key is required');
    return {
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    };
  }

  // ── deployContainer ─────────────────────────────────────────────────────────
  // Creates a new sGTM container on Stape.
  // config: { stapeApiKey, containerName, gtmConfigBody, region?, plan? }
  // Returns: { serverUrl, containerId, status }
  async deployContainer(config) {
    const apiKey = config.stapeApiKey || (this.config && this.config.stapeApiKey);
    if (!apiKey) throw new Error('Stape API key is required for deployment');

    const http = getAxios();

    return withRetry(async () => {
      const resp = await http.post(
        this._apiBase + '/api/v1/containers',
        {
          name:          config.containerName || 'Easy Track sGTM',
          config_body:   config.gtmConfigBody  || config.configBody || '',
          region:        config.region          || 'us-central',
          plan:          config.plan            || 'starter',
        },
        { headers: this._headers(apiKey) }
      );

      if (!resp.data) throw new Error('Stape API returned empty response');

      if (resp.status === 401 || resp.status === 403) {
        const err = new Error('Stape API authentication failed — check your API key');
        err.status = resp.status;
        throw err;
      }

      if (resp.status >= 400) {
        const msg = (resp.data && (resp.data.message || resp.data.error)) || 'Stape API error';
        const err = new Error('Stape API error ' + resp.status + ': ' + msg);
        err.status = resp.status;
        err.details = resp.data;
        throw err;
      }

      const data      = resp.data.data || resp.data;
      const serverUrl = data.url || data.container_url || data.server_url || null;

      return {
        serverUrl,
        containerId: data.id    || data.container_id || null,
        status:      data.status || 'provisioning',
        raw:         data,
      };
    });
  }

  // ── getContainerStatus ───────────────────────────────────────────────────────
  // Fetches real-time metrics from Stape API if containerId is available,
  // otherwise falls back to base HTTP HEAD check.
  async getContainerStatus(url) {
    const containerId = this.config && this.config.stapeContainerId;
    const apiKey      = this.config && this.config.stapeApiKey;

    // If we have a container ID + API key, fetch real metrics
    if (containerId && apiKey) {
      try {
        const http = getAxios();
        const resp = await http.get(
          this._apiBase + '/api/v1/containers/' + containerId,
          { headers: this._headers(apiKey) }
        );
        if (resp.status === 200 && resp.data) {
          const data = resp.data.data || resp.data;
          return {
            healthy:         data.status === 'active' || data.status === 'running',
            status:          data.status,
            requestCount24h: data.requests_24h || data.request_count || null,
            region:          data.region || null,
          };
        }
      } catch (_) {
        // Fall through to basic HTTP check
      }
    }

    // Fallback: basic HTTP HEAD
    return super.getContainerStatus(url);
  }

  // ── listContainers ───────────────────────────────────────────────────────────
  async listContainers(apiKey) {
    const http = getAxios();
    return withRetry(async () => {
      const resp = await http.get(
        this._apiBase + '/api/v1/containers',
        { headers: this._headers(apiKey) }
      );
      if (resp.status >= 400) {
        throw new Error('Stape API error ' + resp.status);
      }
      return resp.data.data || resp.data || [];
    });
  }
}

module.exports = { StapeProvider };
