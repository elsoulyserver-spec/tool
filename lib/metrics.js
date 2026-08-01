'use strict';

/**
 * metrics.js — in-process Prometheus-style counters.
 *
 * All counters are reset on process restart (no persistence). For durable
 * metrics use Cloud Monitoring custom metrics or export to a time-series DB.
 * The /api/v1/metrics endpoint exposes these for scraping by Cloud Monitoring,
 * Datadog, or a simple uptime monitor.
 *
 * Counters (monotonically increasing since last restart):
 *   capi_success_total        — CAPI sends that returned 2xx
 *   capi_failure_total        — CAPI sends that did NOT return 2xx
 *   dlq_created_total         — events written to dlq_events
 *   dlq_replayed_total        — DLQ events successfully retried
 *   dlq_exhausted_total       — DLQ events exhausted (all attempts failed)
 *   consent_denied_total      — events dropped at the consent gate
 *   provisioning_failed_total — GTM provisioning jobs that finished with status=failed
 *   provisioning_stalled_total— GTM provisioning jobs detected stalled (no update >10 min)
 *
 * Per-platform latency/success:
 *   _platformStats[platform] = { success, failure, latencyMsTotal, latencyCount }
 */

const _counters = {
  capi_success_total:          0,
  capi_failure_total:          0,
  dlq_created_total:           0,
  dlq_replayed_total:          0,
  dlq_exhausted_total:         0,
  consent_denied_total:        0,
  provisioning_failed_total:   0,
  provisioning_stalled_total:  0,
};

// Per-platform stats — keyed by platform name ('meta', 'tiktok', 'snap', 'ga4', ...)
const _platformStats = {};

const _startedAt = Date.now();

function _ensurePlatform(platform) {
  if (!_platformStats[platform]) {
    _platformStats[platform] = { success: 0, failure: 0, latencyMsTotal: 0, latencyCount: 0 };
  }
}

// ── Increment helpers ────────────────────────────────────────────────────────

function incCapiSuccess(platform, latencyMs) {
  _counters.capi_success_total++;
  if (platform) {
    _ensurePlatform(platform);
    _platformStats[platform].success++;
    if (latencyMs != null) {
      _platformStats[platform].latencyMsTotal += latencyMs;
      _platformStats[platform].latencyCount++;
    }
  }
}

function incCapiFailure(platform, latencyMs) {
  _counters.capi_failure_total++;
  if (platform) {
    _ensurePlatform(platform);
    _platformStats[platform].failure++;
    if (latencyMs != null) {
      _platformStats[platform].latencyMsTotal += latencyMs;
      _platformStats[platform].latencyCount++;
    }
  }
}

function incDlqCreated()    { _counters.dlq_created_total++; }
function incDlqReplayed()   { _counters.dlq_replayed_total++; }
function incDlqExhausted()  { _counters.dlq_exhausted_total++; }
function incConsentDenied() { _counters.consent_denied_total++; }
function incProvisioningFailed()  { _counters.provisioning_failed_total++; }
function incProvisioningStalled() { _counters.provisioning_stalled_total++; }

// ── Snapshot ─────────────────────────────────────────────────────────────────

function snapshot() {
  const totalCapi = _counters.capi_success_total + _counters.capi_failure_total;
  const successRate = totalCapi > 0
    ? (_counters.capi_success_total / totalCapi)
    : null;

  const platformSummary = {};
  Object.keys(_platformStats).forEach(p => {
    const s = _platformStats[p];
    const tot = s.success + s.failure;
    platformSummary[p] = {
      success:      s.success,
      failure:      s.failure,
      successRate:  tot > 0 ? (s.success / tot) : null,
      avgLatencyMs: s.latencyCount > 0 ? Math.round(s.latencyMsTotal / s.latencyCount) : null,
    };
  });

  const uptimeSec = Math.floor((Date.now() - _startedAt) / 1000);
  const throughputEps = uptimeSec > 0 ? +(totalCapi / uptimeSec).toFixed(3) : 0;

  return {
    uptimeSec,
    counters:       { ..._counters },
    successRate,
    throughputEps,
    byPlatform:     platformSummary,
  };
}

// ── Alert threshold check ─────────────────────────────────────────────────────
// Returns an array of active alert strings. Empty = healthy.

function checkAlerts(dlqDepth, dlqOldestAgeMs) {
  const alerts = [];
  const total = _counters.capi_success_total + _counters.capi_failure_total;

  if (total >= 100) {
    const failRate = _counters.capi_failure_total / total;
    if (failRate > 0.01) {
      alerts.push('CAPI_FAILURE_RATE: ' + (failRate * 100).toFixed(1) + '% (threshold 1%)');
    }
  }

  if (dlqDepth != null && dlqDepth > 1000) {
    alerts.push('DLQ_DEPTH: ' + dlqDepth + ' pending events (threshold 1000)');
  }

  if (dlqOldestAgeMs != null && dlqOldestAgeMs > 30 * 60 * 1000) {
    alerts.push('DLQ_AGE: oldest pending event is ' +
      Math.round(dlqOldestAgeMs / 60000) + ' min old (threshold 30 min)');
  }

  // Auth failures are tracked per-platform — flag any platform with >5% auth errors
  // (proxy: platform has failures but 0 successes)
  Object.keys(_platformStats).forEach(p => {
    const s = _platformStats[p];
    if (s.success === 0 && s.failure >= 5) {
      alerts.push('PLATFORM_AUTH_FAILURE: ' + p + ' has ' + s.failure + ' failures and 0 successes — rotate CAPI token');
    }
  });

  if (_counters.provisioning_stalled_total > 0) {
    alerts.push('PROVISIONING_STALLED: ' + _counters.provisioning_stalled_total + ' stalled jobs detected');
  }

  return alerts;
}

module.exports = {
  incCapiSuccess,
  incCapiFailure,
  incDlqCreated,
  incDlqReplayed,
  incDlqExhausted,
  incConsentDenied,
  incProvisioningFailed,
  incProvisioningStalled,
  snapshot,
  checkAlerts,
};
