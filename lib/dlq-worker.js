'use strict';

/**
 * dlq-worker.js
 *
 * Retry worker for the Firestore-backed Dead Letter Queue.
 *
 * Each failed CAPI send is stored in the `dlq_events` Firestore collection by
 * the /api/v1/internal/dlq endpoint.  This worker runs on a 60-second interval
 * (started by server.js after init), fetches events whose nextRetryAt <= now,
 * and re-POSTs their payload to the original CAPI endpoint.
 *
 * Retry schedule (exponential back-off, capped at 1 hour):
 *   attempt 0 →  60 s
 *   attempt 1 → 120 s
 *   attempt 2 → 300 s
 *   attempt 3 → 900 s
 *   attempt 4 → 3 600 s (1 h)
 *   attempt 5+ → exhausted, status = 'exhausted'
 *
 * Auth/client errors (401, 403, 4xx) are NOT retried — they are immediately
 * marked 'exhausted' with a reason code so operators are alerted.
 *
 * Rate-limited errors (429) are retried with a longer delay (Retry-After or
 * 5 minutes if the header is absent).
 */

const https   = require('https');
const http    = require('http');
const url     = require('url');
const metrics = require('./metrics');

const MAX_ATTEMPTS   = 6;
const BATCH_SIZE     = 30;   // events per tick — stay well under Firestore read quota

const BACKOFF_SECONDS = [60, 120, 300, 900, 3600, 3600];

function _nextDelayMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000;
  return (BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] || 3600) * 1000;
}

function _isRetryable(statusCode) {
  // 401/403 = auth error — operator must rotate token, no point retrying.
  // 4xx (other) = payload rejected by platform — won't improve on retry.
  // 429 = rate limited — retryable with back-off.
  // 5xx = transient platform error — retryable.
  // 0   = network error — retryable.
  if (statusCode === 401 || statusCode === 403) return false;
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) return false;
  return true;
}

// Fire a single HTTP POST. Returns { statusCode, retryAfterSec }.
function _post(targetUrl, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(targetUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const bodyBuf = Buffer.from(body, 'utf8');
    const opts    = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.path,
      method:   'POST',
      headers: {
        ...headers,
        'Content-Length': bodyBuf.length,
      },
      timeout: timeoutMs || 10000,
    };
    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        const retryAfterSec = parseInt(res.headers['retry-after'] || '0', 10) || 0;
        resolve({ statusCode: res.statusCode, retryAfterSec });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('DLQ retry request timed out')); });
    req.on('error',   reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function _processBatch(firestoreService) {
  const events = await firestoreService.listPendingDlqEvents(BATCH_SIZE);
  if (!events.length) return 0;

  let processed = 0;

  for (const ev of events) {
    const attempt = (ev.retryCount || 0);

    // Hard limit — give up after MAX_ATTEMPTS
    if (attempt >= MAX_ATTEMPTS) {
      await firestoreService.updateDlqEvent(ev._id, {
        status: 'exhausted',
        exhaustedReason: 'max_attempts_reached',
      });
      metrics.incDlqExhausted();
      console.warn('[dlq-worker] exhausted event_id=' + (ev.eventId || ev._id) +
        ' platform=' + ev.platform + ' after ' + attempt + ' attempts');
      processed++;
      continue;
    }

    // Auth errors — no retry, flag for operator
    const lastCode = ev.lastStatusCode || 0;
    if (lastCode === 401 || lastCode === 403) {
      await firestoreService.updateDlqEvent(ev._id, {
        status: 'exhausted',
        exhaustedReason: 'auth_error:' + lastCode +
          ' — rotate CAPI token for platform=' + ev.platform,
      });
      metrics.incDlqExhausted();
      console.error('[dlq-worker] AUTH_ERROR — exhausting without retry. platform=' +
        ev.platform + ' status=' + lastCode + ' event_id=' + (ev.eventId || ev._id));
      processed++;
      continue;
    }

    // Claim the event atomically before attempting the retry.
    // If another Cloud Run instance already claimed it, skip silently.
    const claimed = await firestoreService.claimDlqEvent(ev._id);
    if (!claimed) continue;

    // Attempt the retry
    let statusCode = 0;
    let retryAfterSec = 0;
    let networkError  = null;

    try {
      const rawHeaders = ev.headers_snapshot
        ? JSON.parse(ev.headers_snapshot)
        : { 'Content-Type': 'application/json' };
      const result = await _post(
        ev.destination_url,
        rawHeaders,
        ev.payload_snapshot || '{}',
        10000,
      );
      statusCode    = result.statusCode;
      retryAfterSec = result.retryAfterSec;
    } catch (e) {
      networkError = e.message;
    }

    const success = !networkError && statusCode >= 200 && statusCode < 300;

    if (success) {
      await firestoreService.deleteDlqEvent(ev._id);
      metrics.incDlqReplayed();
      metrics.incCapiSuccess(ev.platform);
      console.log('[dlq-worker] retried OK event_id=' + (ev.eventId || ev._id) +
        ' platform=' + ev.platform + ' attempt=' + (attempt + 1));
    } else if (!networkError && !_isRetryable(statusCode)) {
      await firestoreService.updateDlqEvent(ev._id, {
        status:           'exhausted',
        exhaustedReason:  'non_retryable:HTTP_' + statusCode,
        lastStatusCode:   statusCode,
        retryCount:       attempt + 1,
      });
      metrics.incDlqExhausted();
      metrics.incCapiFailure(ev.platform);
      console.warn('[dlq-worker] non-retryable HTTP ' + statusCode +
        ' for event_id=' + (ev.eventId || ev._id) + ' platform=' + ev.platform);
    } else {
      const nextDelay = _nextDelayMs(attempt + 1, retryAfterSec);
      await firestoreService.updateDlqEvent(ev._id, {
        status:         'pending',
        retryCount:     attempt + 1,
        lastStatusCode: statusCode,
        lastError:      networkError || ('HTTP_' + statusCode),
        // Firestore Admin accepts Date objects and converts to Timestamp.
        // Do NOT use raw { _seconds, _nanoseconds } — that stores a Map,
        // which breaks the nextRetryAt <= now range query.
        nextRetryAt:    new Date(Date.now() + nextDelay),
      });
    }

    processed++;
  }

  return processed;
}

let _running = false;

async function tick(firestoreService) {
  if (_running) return;
  _running = true;
  try {
    const n = await _processBatch(firestoreService);
    if (n > 0) {
      console.log('[dlq-worker] processed ' + n + ' events');
    }
  } catch (e) {
    console.error('[dlq-worker] tick error:', e.message);
  } finally {
    _running = false;
  }
}

/**
 * Start the DLQ retry worker on a fixed interval.
 * Call once from server.js after Firestore is confirmed configured.
 * Returns the interval handle (pass to clearInterval to stop).
 */
function start(firestoreService, intervalMs) {
  const ms = intervalMs || 60 * 1000;
  console.log('[dlq-worker] started — interval=' + ms + 'ms max_attempts=' + MAX_ATTEMPTS);
  // Run once immediately after a short delay so startup spike settles
  setTimeout(() => tick(firestoreService), 5000);
  return setInterval(() => tick(firestoreService), ms);
}

module.exports = { start, tick, _isRetryable, _nextDelayMs };
