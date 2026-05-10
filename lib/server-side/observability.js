'use strict';

/**
 * EasyTrac — Observability
 * ─────────────────────────────────────────────────────────────────────────────
 * Structured JSON logging + latency tracking compatible with Google Cloud Logging.
 *
 * Log format follows the Cloud Logging LogEntry JSON payload spec:
 *   https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
 *
 * Severity levels (Cloud Logging): DEBUG < INFO < NOTICE < WARNING < ERROR < CRITICAL
 *
 * Features:
 *   • createLogger(context)  — scoped logger bound to a requestId / eventId
 *   • Latency tracker        — measure per-platform round-trip time
 *   • Platform response log  — structured CAPI response logging
 *   • Token masking          — tokens replaced with '***…XXXX' in all log output
 *   • Debug mode             — controlled by ET_LOG_LEVEL=debug or payload.debugMode
 *   • Sampling               — log INFO at configurable rate to reduce volume
 *
 * Pure Node.js — NOT for use inside sGTM sandboxed JS.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Level config ──────────────────────────────────────────────────────────────

const LEVELS = {
  debug:    100,
  info:     200,
  notice:   300,
  warning:  400,
  error:    500,
  critical: 600,
};

const CLOUD_SEVERITY = {
  debug:    'DEBUG',
  info:     'INFO',
  notice:   'NOTICE',
  warning:  'WARNING',
  error:    'ERROR',
  critical: 'CRITICAL',
};

/** Minimum level to emit, driven by ET_LOG_LEVEL env var. Default: 'info'. */
function resolveMinLevel() {
  const raw = (process.env.ET_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] !== undefined ? raw : 'info';
}

let _minLevel = resolveMinLevel();
const _minLevelNum = () => LEVELS[_minLevel] || LEVELS.info;

// ── Token masking ──────────────────────────────────────────────────────────────

/**
 * Sensitive field names that should be masked in log output.
 * Case-insensitive match against object keys.
 */
const SENSITIVE_KEYS = new Set([
  'accesstoken', 'access_token', 'apikey', 'api_key',
  'token', 'developertoken', 'developer_token',
  'metacacapitoken', 'meta_capi_token', 'tiktokeventstoken',
  'tiktok_events_token', 'snapchatcapitoken', 'snapchat_capi_token',
  'secret', 'password', 'authorization',
]);

/**
 * Mask a token string: show only the last 4 characters.
 * e.g. 'EAABsbCS...' → '***…SBCS'
 *
 * @param {string} token
 * @returns {string}
 */
function maskToken(token) {
  if (typeof token !== 'string' || token.length <= 4) return '***MASKED***';
  return `***…${token.slice(-4).toUpperCase()}`;
}

/**
 * Recursively sanitize an object for logging.
 * Replaces sensitive field values with masked versions.
 * Truncates long strings to 512 chars to avoid log bloat.
 *
 * @param {any}    value
 * @param {number} [depth=0]  — recursion guard
 * @returns {any}
 */
function sanitizeForLog(value, depth = 0) {
  if (depth > 8) return '[DEEP]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 512 ? value.slice(0, 512) + '…[truncated]' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(v => sanitizeForLog(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLower = k.toLowerCase();
      if (SENSITIVE_KEYS.has(keyLower)) {
        out[k] = typeof v === 'string' ? maskToken(v) : '***MASKED***';
      } else {
        out[k] = sanitizeForLog(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// ── Log emission ───────────────────────────────────────────────────────────────

/**
 * Emit a single Cloud Logging-compatible JSON log line to stdout.
 *
 * @param {string} level    — 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical'
 * @param {string} message
 * @param {object} [data]   — additional structured fields (will be sanitized)
 * @param {object} [ctx]    — logger context (requestId, eventId, …)
 */
function emit(level, message, data, ctx) {
  if ((LEVELS[level] || 0) < _minLevelNum()) return;

  const entry = {
    severity:  CLOUD_SEVERITY[level] || 'INFO',
    message:   `ET: ${message}`,
    timestamp: new Date().toISOString(),
    // Cloud Logging structured fields
    'logging.googleapis.com/labels': {
      service: 'easytrac-dispatcher',
      version: '3',
    },
  };

  // Merge context (requestId, eventId, platform, …)
  if (ctx && typeof ctx === 'object') {
    const safeCtx = sanitizeForLog(ctx);
    Object.assign(entry, safeCtx);
  }

  // Merge additional data
  if (data && typeof data === 'object') {
    entry.data = sanitizeForLog(data);
  } else if (data !== undefined) {
    entry.data = data;
  }

  // Cloud Run structured log trace if available
  if (process.env.GOOGLE_CLOUD_PROJECT && ctx && ctx.requestId) {
    entry['logging.googleapis.com/trace'] =
      `projects/${process.env.GOOGLE_CLOUD_PROJECT}/traces/${ctx.requestId}`;
  }

  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a scoped logger bound to a request / event context.
 * All log calls automatically include the context fields.
 *
 * @param {object} context
 * @param {string} [context.requestId]
 * @param {string} [context.eventId]
 * @param {string} [context.eventName]
 * @param {string} [context.environment]
 * @param {boolean} [context.debugMode]   — if true, forces DEBUG level for this logger
 * @returns {Logger}
 */
function createLogger(context = {}) {
  const ctx = {
    requestId:   context.requestId   || '',
    eventId:     context.eventId     || '',
    eventName:   context.eventName   || '',
    environment: context.environment || (process.env.ET_ENVIRONMENT || 'unknown'),
  };
  const forceDebug = context.debugMode === true;

  function log(level, message, data) {
    if (forceDebug && level === 'debug') {
      // Always emit debug when debugMode is on, regardless of ET_LOG_LEVEL
      const prev = _minLevel;
      _minLevel = 'debug';
      emit('debug', message, data, ctx);
      _minLevel = prev;
    } else {
      emit(level, message, data, ctx);
    }
  }

  return {
    debug:    (msg, data) => log('debug',    msg, data),
    info:     (msg, data) => log('info',     msg, data),
    notice:   (msg, data) => log('notice',   msg, data),
    warning:  (msg, data) => log('warning',  msg, data),
    warn:     (msg, data) => log('warning',  msg, data),
    error:    (msg, data) => log('error',    msg, data),
    critical: (msg, data) => log('critical', msg, data),
    /** Extend this logger with additional context fields */
    child: (extra) => createLogger(Object.assign({}, context, extra)),
    context: ctx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Latency tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a latency tracker for a single operation.
 *
 * @returns {{ start: Function, end: Function, elapsedMs: Function }}
 *
 * Usage:
 *   const t = createTimer();
 *   await doWork();
 *   logger.info('Done', { latencyMs: t.end() });
 */
function createTimer() {
  const startHr = process.hrtime.bigint();
  return {
    /** Returns elapsed milliseconds since construction (float). */
    elapsedMs() {
      return Number(process.hrtime.bigint() - startHr) / 1e6;
    },
    /** Alias for elapsedMs() — stops notional timer and returns ms. */
    end() {
      return this.elapsedMs();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform response logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log a structured CAPI platform response.
 * Strips response bodies longer than 1 KB to avoid log bloat.
 *
 * @param {Logger}  logger
 * @param {string}  platform   — 'meta' | 'tiktok' | 'snap' | 'gads'
 * @param {boolean} success
 * @param {object}  opts
 * @param {number}  opts.statusCode
 * @param {number}  opts.latencyMs
 * @param {string}  [opts.eventName]
 * @param {string}  [opts.eventId]
 * @param {number}  [opts.attempt]        — retry attempt index (0 = first try)
 * @param {any}     [opts.responseBody]   — raw API response (will be truncated)
 * @param {string}  [opts.errorMessage]
 */
function logPlatformResponse(logger, platform, success, opts = {}) {
  const {
    statusCode, latencyMs, eventName, eventId,
    attempt = 0, responseBody, errorMessage,
  } = opts;

  const icon    = success ? '✅' : '❌';
  const retryNote = attempt > 0 ? ` (retry #${attempt})` : '';
  const msg     = `${icon} ${platform} CAPI ${success ? 'success' : 'error'}${retryNote}`;

  const data = {
    platform,
    success,
    statusCode,
    latencyMs:  latencyMs !== undefined ? Math.round(latencyMs) : undefined,
    eventName,
    eventId,
    attempt,
  };

  if (!success) {
    if (errorMessage) data.errorMessage = errorMessage;
    if (responseBody !== undefined) {
      const bodyStr = typeof responseBody === 'string'
        ? responseBody
        : JSON.stringify(responseBody);
      data.responseBody = bodyStr.length > 1024
        ? bodyStr.slice(0, 1024) + '…[truncated]'
        : bodyStr;
    }
    logger.error(msg, data);
  } else {
    logger.info(msg, data);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch summary logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log the aggregate result of a full dispatch cycle (all platforms).
 *
 * @param {Logger}   logger
 * @param {object}   result         — from event-dispatcher.dispatch()
 * @param {number}   totalLatencyMs
 */
function logDispatchSummary(logger, result, totalLatencyMs) {
  const { success = [], failed = [], warnings = [] } = result || {};
  const allOk = failed.length === 0;

  const msg = allOk
    ? `✅ dispatch complete — ${success.length} platform(s) succeeded`
    : `⚠️ dispatch partial — ${success.length} succeeded, ${failed.length} failed`;

  logger.info(msg, {
    successPlatforms: success.map(s => s.platform),
    failedPlatforms:  failed.map(f => f.platform),
    totalLatencyMs:   Math.round(totalLatencyMs),
    warningCount:     warnings.length,
    warnings:         warnings.length > 0 ? warnings : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Global logger (for module-level use without a request context)
// ─────────────────────────────────────────────────────────────────────────────
const globalLogger = createLogger({ environment: process.env.ET_ENVIRONMENT || 'unknown' });

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  createLogger,
  createTimer,
  logPlatformResponse,
  logDispatchSummary,
  sanitizeForLog,
  maskToken,
  emit,
  // Global logger for convenience
  logger: globalLogger,
  // Level control (for tests)
  setMinLevel(level) { _minLevel = LEVELS[level] !== undefined ? level : _minLevel; },
  getMinLevel() { return _minLevel; },
  LEVELS,
};
