'use strict';

/**
 * EasyTrac — Event Dispatcher  (v3 — production pipeline)
 * ─────────────────────────────────────────────────────────────────────────────
 * Full server-side tracking pipeline:
 *
 *   inbound GA4 hit (sGTM ep.* / up.*)
 *       │
 *       ▼
 *   [1] enrich()        — add requestId, serverTimestamp, hostname, env
 *       │
 *       ▼
 *   [2] sanitize()      — strip nulls, normalize PII fields, validate numerics
 *       │
 *       ▼
 *   [3] validate()      — collect non-fatal warnings, log them
 *       │
 *       ▼
 *   [4] isDuplicate()   — per-platform dedup (eventId + platform key + TTL)
 *       │  (skip if duplicate)
 *       ▼
 *   [5] Promise.allSettled() fan-out
 *       │   ├── Meta CAPI     withRetry → send()
 *       │   ├── TikTok Events withRetry → send()
 *       │   ├── Snapchat CAPI withRetry → send()
 *       │   └── Google Ads EC withRetry → send()
 *       │
 *       ▼
 *   [6] markDispatchedForPlatform()  — record successes in dedup store
 *       │
 *       ▼
 *   [7] logDispatchSummary()         — structured Cloud Logging entry
 *       │
 *       ▼
 *   return { success[], failed[], warnings[], meta }
 */

const { enrich, newRequestId }                                               = require('./event-enricher');
const { sanitize, validate: validatePayload }                                = require('./payload-sanitizer');
const { isDuplicate, markDispatchedForPlatform, withRetry, queueStats }      = require('./retry-queue');
const { createLogger, createTimer, logPlatformResponse, logDispatchSummary } = require('./observability');
const { loadConfig, getPlatformConfig, enabledPlatforms }                    = require('./config-manager');

const metaSender   = require('./capi-senders/meta-capi');
const tiktokSender = require('./capi-senders/tiktok-events');
const snapSender   = require('./capi-senders/snapchat-capi');
const gadsSender   = require('./capi-senders/google-ads-ec');

const SENDERS = {
  meta:   metaSender,
  tiktok: tiktokSender,
  snap:   snapSender,
  gads:   gadsSender,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatch function
// ─────────────────────────────────────────────────────────────────────────────

async function dispatch(rawPayload, options = {}) {
  const totalTimer = createTimer();

  const cfg     = options.config  || loadConfig();
  const ctx     = options.context || {};
  ctx.requestId = ctx.requestId   || newRequestId();

  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : (cfg.maxRetries || 3);
  const dryRun     = options.dryRun === true;

  // [1] Enrich
  const enriched = enrich(rawPayload, ctx);

  // [2] Sanitize
  const payload = sanitize(enriched);

  const logger = createLogger({
    requestId:   payload.requestId || ctx.requestId,
    eventId:     payload.eventId   || '',
    eventName:   payload.eventName || '',
    environment: payload.environment,
    debugMode:   payload.debugMode || cfg.debugMode || false,
  });

  logger.debug('Dispatch started', {
    dryRun,
    eventTime:   payload.eventTime,
    hasUserData: !!(payload.userData && Object.keys(payload.userData).length),
  });

  // [3] Validate — non-fatal
  const warnings = validatePayload(payload);
  if (warnings.length > 0) {
    logger.warning('Payload warnings', { warnings });
  }

  const requestedPlatforms = options.platforms || enabledPlatforms(cfg);

  if (dryRun) {
    logger.info('Dry run — skipping CAPI dispatch', { platforms: requestedPlatforms });
    return {
      success: [], failed: [], warnings,
      meta: {
        requestId: payload.requestId,
        eventId:   payload.eventId,
        eventName: payload.eventName,
        latencyMs: totalTimer.end(),
        dryRun:    true,
      },
    };
  }

  // [4] + [5] Dedup + fan-out
  const platformResults = await Promise.allSettled(
    requestedPlatforms.map(platform => _dispatchToPlatform({
      platform, payload, cfg, logger, maxRetries,
      skipDedup: options.skipDedup === true,
    }))
  );

  // [6] Collect results
  const success = [];
  const failed  = [];

  platformResults.forEach((result, idx) => {
    const platform = requestedPlatforms[idx];
    if (result.status === 'fulfilled') {
      const r = result.value;
      if (r.skipped) {
        logger.notice(`${platform} skipped: ${r.skipReason}`);
      } else if (r.success) {
        success.push({ platform, response: r.response });
      } else {
        failed.push({ platform, error: r.errorMessage || 'unknown', attempts: r.attempts || 1 });
      }
    } else {
      failed.push({ platform, error: String(result.reason || 'rejection'), attempts: maxRetries + 1 });
      logger.error(`Unexpected rejection from ${platform}`, { reason: String(result.reason) });
    }
  });

  // [7] Summary
  const totalMs = totalTimer.end();
  logDispatchSummary(logger, { success, failed, warnings }, totalMs);

  return {
    success, failed, warnings,
    meta: {
      requestId: payload.requestId,
      eventId:   payload.eventId,
      eventName: payload.eventName,
      latencyMs: totalMs,
      dryRun:    false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-platform helper
// ─────────────────────────────────────────────────────────────────────────────

async function _dispatchToPlatform({ platform, payload, cfg, logger, maxRetries, skipDedup }) {
  const platConfig = getPlatformConfig(platform, cfg);
  if (!platConfig) return { skipped: true, skipReason: 'no credentials configured' };

  const sender = SENDERS[platform];
  if (!sender || typeof sender.send !== 'function') {
    return { skipped: true, skipReason: 'no sender registered' };
  }

  // Deduplication
  if (!skipDedup && cfg.dedupEnabled !== false && payload.eventId) {
    if (isDuplicate(platform, payload.eventId)) {
      return { skipped: true, skipReason: 'duplicate eventId within TTL window' };
    }
  }

  const platformTimer = createTimer();
  const childLogger   = logger.child({ platform });

  const retryResult = await withRetry(
    {
      platform,
      eventId:   payload.eventId,
      requestId: payload.requestId,
      maxRetries,
      onRetry: (attempt, delayMs, err) => {
        childLogger.warning(`Retry ${attempt}/${maxRetries}`, {
          platform, attempt, delayMs, error: err ? err.message : 'unknown',
        });
      },
      onSuccess: (attempt) => {
        if (attempt > 0) childLogger.info(`Succeeded after ${attempt} retry(s)`, { platform, attempt });
      },
      onExhausted: (attempts, lastError) => {
        childLogger.error(`Exhausted ${attempts} attempt(s)`, {
          platform, attempts, error: lastError ? lastError.message : 'unknown',
        });
      },
    },
    async () => {
      const response = await sender.send(payload, platConfig);
      if (response && response.statusCode >= 400) {
        const err    = new Error(`HTTP ${response.statusCode}`);
        err.statusCode   = response.statusCode;
        err.responseBody = response.raw;
        throw err;
      }
      return response;
    }
  );

  const latencyMs = platformTimer.end();

  if (retryResult.success) {
    if (payload.eventId && cfg.dedupEnabled !== false) {
      markDispatchedForPlatform(platform, payload.eventId);
    }
    logPlatformResponse(childLogger, platform, true, {
      statusCode: retryResult.result && retryResult.result.statusCode,
      latencyMs,
      eventName:  payload.eventName,
      eventId:    payload.eventId,
      attempt:    retryResult.attempts - 1,
    });
    return { success: true, response: retryResult.result, attempts: retryResult.attempts };
  }

  const err = retryResult.error;
  logPlatformResponse(childLogger, platform, false, {
    statusCode:   err && err.statusCode,
    latencyMs,
    eventName:    payload.eventName,
    eventId:      payload.eventId,
    attempt:      retryResult.attempts - 1,
    responseBody: err && err.responseBody,
    errorMessage: err ? err.message : 'unknown',
  });
  return {
    success:      false,
    errorMessage: err ? err.message : 'unknown',
    attempts:     retryResult.attempts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

function health(cfg) {
  const c   = cfg || loadConfig();
  const ep  = enabledPlatforms(c);
  const q   = queueStats();
  return {
    status:           'ok',
    enabledPlatforms: ep,
    inFlightRetries:  q.inFlight,
    dedupEntries:     q.dedupEntries,
    environment:      c.cloudRun || {},
  };
}

module.exports = { dispatch, health, _dispatchToPlatform };
