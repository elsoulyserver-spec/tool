'use strict';

/**
 * lib/cloud-monitoring.js
 *
 * Writes custom metrics to Google Cloud Monitoring (formerly Stackdriver)
 * via the REST API. Zero external dependencies — uses built-in https.
 *
 * On non-GCP environments (Railway, local) where the metadata server is
 * unreachable, all writes silently no-op. The in-process /api/v1/metrics
 * endpoint is always available regardless.
 *
 * Custom metric types (all under custom.googleapis.com/easytrac/):
 *   capi_success_total
 *   capi_failure_total
 *   dlq_depth
 *   dlq_oldest_age_seconds
 *   provisioning_failed_total
 *   provisioning_stalled_total
 *   consent_denied_total
 *   gtm_account_capacity_pct   (one time series per account)
 *
 * Alert policies (define in Cloud Monitoring console or via Terraform):
 *   capi_failure_rate  > 1%    for 5 min  → P1
 *   dlq_depth          > 1000             → P1
 *   dlq_oldest_age     > 30 min           → P2
 *   provisioning_stalled > 0  for 5 min  → P2
 *   gtm_account_capacity_pct > 90%        → P2
 *   consent_denied spike > 10x baseline   → P3
 */

const https = require('https');
const http  = require('http');

const METADATA_HOST = 'metadata.google.internal';
const CM_HOST       = 'monitoring.googleapis.com';

let _project      = null;
let _accessToken  = null;
let _tokenExp     = 0;
let _enabled      = null;  // null = unknown, true/false after first probe

function _envProject() {
  return (process.env.CLOUD_MONITORING_PROJECT ||
          process.env.GOOGLE_CLOUD_PROJECT      ||
          process.env.GCP_PROJECT               || '').trim();
}

// Probe GCP metadata server once. Caches result — avoids 3s timeout penalty
// on every metric write when running off-GCP.
async function _isGcp() {
  if (_enabled !== null) return _enabled;
  if (_envProject()) {
    // Project is explicitly configured — try metadata server
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({
          host:    METADATA_HOST,
          path:    '/computeMetadata/v1/project/project-id',
          method:  'GET',
          headers: { 'Metadata-Flavor': 'Google' },
          timeout: 2000,
        }, res => { res.resume(); resolve(res.statusCode === 200); });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error',   () => resolve(false));
        req.end();
      });
      _enabled = true;
    } catch (_) {
      _enabled = false;
    }
  } else {
    _enabled = false;
  }
  if (!_enabled) {
    console.log('[cloud-monitoring] not on GCP or project not set — metrics writes disabled (in-process /api/v1/metrics still active)');
  }
  return _enabled;
}

async function _getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_accessToken && now < _tokenExp - 60) return _accessToken;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host:    METADATA_HOST,
      path:    '/computeMetadata/v1/instance/service-accounts/default/token',
      method:  'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 3000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('metadata HTTP ' + res.statusCode));
        const parsed = JSON.parse(raw);
        _accessToken = parsed.access_token;
        _tokenExp    = now + (parsed.expires_in || 3600);
        resolve(_accessToken);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('metadata timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function _writeTimeSeries(timeSeries) {
  if (!(await _isGcp())) return;
  if (!_project) _project = _envProject();
  const token = await _getToken();
  const body  = JSON.stringify({ timeSeries });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: CM_HOST,
      path:     `/v3/projects/${_project}/timeSeries`,
      method:   'POST',
      headers:  {
        Authorization:   'Bearer ' + token,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
        // Non-fatal — log once then continue
        console.warn('[cloud-monitoring] write failed HTTP ' + res.statusCode + ':', raw.slice(0, 200));
        resolve();
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(); });  // non-fatal
    req.on('error',   (e) => { console.warn('[cloud-monitoring] write error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

function _gauge(metricType, value, labels) {
  const now = new Date().toISOString();
  return {
    metric: {
      type:   'custom.googleapis.com/easytrac/' + metricType,
      labels: labels || {},
    },
    resource: { type: 'global', labels: { project_id: _project || _envProject() } },
    points: [{
      interval: { endTime: now },
      value:    { doubleValue: value },
    }],
  };
}

function _counter(metricType, value, labels) {
  const now = new Date().toISOString();
  return {
    metric: {
      type:   'custom.googleapis.com/easytrac/' + metricType,
      labels: labels || {},
    },
    metricKind: 'CUMULATIVE',
    resource: { type: 'global', labels: { project_id: _project || _envProject() } },
    points: [{
      interval: { startTime: new Date(Date.now() - 60000).toISOString(), endTime: now },
      value:    { int64Value: String(Math.round(value)) },
    }],
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Push a full metrics snapshot to Cloud Monitoring. Called every 60s by the
// metrics flush interval in server.js.
async function pushSnapshot(metricsSnapshot, dlqDepth, dlqOldestAgeMs, capacityReport) {
  if (!(await _isGcp())) return;
  const c = metricsSnapshot.counters;
  const ts = [
    _counter('capi_success_total',         c.capi_success_total),
    _counter('capi_failure_total',         c.capi_failure_total),
    _counter('dlq_created_total',          c.dlq_created_total),
    _counter('dlq_replayed_total',         c.dlq_replayed_total),
    _counter('dlq_exhausted_total',        c.dlq_exhausted_total),
    _counter('consent_denied_total',       c.consent_denied_total),
    _counter('provisioning_failed_total',  c.provisioning_failed_total),
    _counter('provisioning_stalled_total', c.provisioning_stalled_total),
  ];
  if (dlqDepth != null)       ts.push(_gauge('dlq_depth',            dlqDepth));
  if (dlqOldestAgeMs != null) ts.push(_gauge('dlq_oldest_age_seconds', dlqOldestAgeMs / 1000));

  if (Array.isArray(capacityReport)) {
    capacityReport.forEach(acct => {
      ts.push(_gauge('gtm_account_capacity_pct', acct.capacityPct,
        { account_id: acct.accountId }));
    });
  }

  // Per-platform success rate
  Object.keys(metricsSnapshot.byPlatform || {}).forEach(p => {
    const ps = metricsSnapshot.byPlatform[p];
    if (ps.successRate != null) {
      ts.push(_gauge('capi_success_rate', ps.successRate, { platform: p }));
    }
    if (ps.avgLatencyMs != null) {
      ts.push(_gauge('capi_latency_ms', ps.avgLatencyMs, { platform: p }));
    }
  });

  // Cloud Monitoring accepts max 200 time series per request
  for (let i = 0; i < ts.length; i += 200) {
    await _writeTimeSeries(ts.slice(i, i + 200));
  }
}

module.exports = { pushSnapshot };
