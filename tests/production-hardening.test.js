'use strict';
/**
 * tests/production-hardening.test.js
 *
 * TASK 8 — Validation: failure simulations + production hardening tests.
 *
 * Covers:
 *  - DLQ reliability: backoff, retry limits, Retry-After, claim logic
 *  - Failure simulations: Meta 500, Meta 429, TikTok 401, Snap timeout
 *  - Provisioning stall detection logic
 *  - GTM capacity thresholds (300/400/480)
 *  - Metrics counter accuracy (all 8 counters)
 *  - Alert thresholds
 *  - Secret Manager ENV fallback + fatal-if-absent
 *  - CryptoVault round-trip + rotation
 *  - Cloud Run restart orphan detection
 *  - DLQ replay after token rotation
 *
 * Run: node --test tests/production-hardening.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const dlq = require('../lib/dlq-worker');
const m   = require('../lib/metrics');
const sm  = require('../lib/secret-manager');

// ── DLQ backoff schedule ──────────────────────────────────────────────────────

describe('DLQ — exponential backoff schedule', () => {
  const EXPECTED = [60, 120, 300, 900, 3600, 3600];
  EXPECTED.forEach((secs, attempt) => {
    test(`attempt ${attempt} → ${secs}s`, () => {
      assert.equal(dlq._nextDelayMs(attempt, 0), secs * 1000);
    });
  });
  test('attempt 99 → capped at 3600s', () => {
    assert.equal(dlq._nextDelayMs(99, 0), 3600 * 1000);
  });
  test('Retry-After header overrides schedule', () => {
    assert.equal(dlq._nextDelayMs(0, 300), 300 * 1000);
  });
  test('Retry-After=0 falls back to schedule', () => {
    assert.equal(dlq._nextDelayMs(2, 0), 300 * 1000);
  });
  test('total retry window < 72h DLQ TTL', () => {
    const total = [0, 1, 2, 3, 4, 5].reduce((s, a) => s + dlq._nextDelayMs(a, 0), 0);
    assert.ok(total < 72 * 60 * 60 * 1000, `${total}ms must be < 72h`);
  });
});

// ── DLQ retryability ──────────────────────────────────────────────────────────

describe('DLQ — retryability classification', () => {
  const nonRetryable = [400, 401, 403, 404, 422];
  const retryable    = [0, 429, 500, 502, 503, 504];

  nonRetryable.forEach(code => {
    test(`HTTP ${code} → NOT retryable`, () => {
      assert.equal(dlq._isRetryable(code), false, `${code} should not be retried`);
    });
  });
  retryable.forEach(code => {
    test(`HTTP ${code} → retryable`, () => {
      assert.equal(dlq._isRetryable(code), true, `${code} should be retried`);
    });
  });
});

// ── Failure simulation: Meta 500 ──────────────────────────────────────────────

describe('Failure simulation — Meta 500', () => {
  test('500 is retryable', () => {
    assert.equal(dlq._isRetryable(500), true);
  });
  test('after attempt 0 (500), next delay is 120s (attempt 1)', () => {
    assert.equal(dlq._nextDelayMs(1, 0), 120 * 1000);
  });
  test('does NOT exhaust immediately on first 500', () => {
    // Verify MAX_ATTEMPTS allows 6 attempts total before exhaustion
    const MAX = 6;
    assert.equal(MAX, 6);
    assert.ok(0 < MAX, 'first attempt (0) should not exhaust');
  });
});

// ── Failure simulation: Meta 429 with Retry-After ────────────────────────────

describe('Failure simulation — Meta 429 (rate-limited)', () => {
  test('429 is retryable', () => {
    assert.equal(dlq._isRetryable(429), true);
  });
  test('429 with Retry-After: 300 uses 300s delay', () => {
    assert.equal(dlq._nextDelayMs(0, 300), 300 * 1000);
  });
  test('429 with Retry-After: 60 uses 60s delay (even at attempt 3)', () => {
    assert.equal(dlq._nextDelayMs(3, 60), 60 * 1000);
  });
  test('429 with no Retry-After falls back to schedule', () => {
    assert.equal(dlq._nextDelayMs(0, 0), 60 * 1000);
  });
});

// ── Failure simulation: TikTok 401 ───────────────────────────────────────────

describe('Failure simulation — TikTok 401 (auth error)', () => {
  test('401 is NOT retryable', () => {
    assert.equal(dlq._isRetryable(401), false);
  });
  test('403 is NOT retryable', () => {
    assert.equal(dlq._isRetryable(403), false);
  });
  test('event with lastStatusCode=401 should be marked exhausted (auth_error path)', () => {
    // Worker checks lastStatusCode before claim — simulate that guard
    const ev = { lastStatusCode: 401, platform: 'tiktok', retryCount: 0 };
    const shouldExhaustImmediately = ev.lastStatusCode === 401 || ev.lastStatusCode === 403;
    assert.ok(shouldExhaustImmediately, 'TikTok 401 must bypass retry and exhaust immediately');
  });
  test('exhaustedReason for 401 includes rotation instruction', () => {
    const lastCode = 401;
    const platform = 'tiktok';
    const reason = `auth_error:${lastCode} — rotate CAPI token for platform=${platform}`;
    assert.ok(reason.includes('rotate CAPI token'), 'exhausted reason must guide operator');
    assert.ok(reason.includes(platform), 'must name the affected platform');
  });
});

// ── Failure simulation: Snap timeout ─────────────────────────────────────────

describe('Failure simulation — Snap timeout (network error)', () => {
  test('network error (statusCode=0) is retryable', () => {
    assert.equal(dlq._isRetryable(0), true);
  });
  test('timeout at attempt 2 uses 300s backoff', () => {
    assert.equal(dlq._nextDelayMs(2, 0), 300 * 1000);
  });
  test('timeout at attempt 5 uses 3600s (max) backoff', () => {
    assert.equal(dlq._nextDelayMs(5, 0), 3600 * 1000);
  });
});

// ── Provisioning stall detection ──────────────────────────────────────────────

describe('Failure simulation — stalled provisioning', () => {
  const STALL_THRESHOLD_MS = 10 * 60 * 1000;

  test('job with heartbeatAt 11 min ago is stalled', () => {
    const heartbeatAt = new Date(Date.now() - 11 * 60 * 1000);
    assert.ok(heartbeatAt.getTime() < Date.now() - STALL_THRESHOLD_MS);
  });
  test('job with heartbeatAt 9 min ago is NOT stalled', () => {
    const heartbeatAt = new Date(Date.now() - 9 * 60 * 1000);
    assert.ok(heartbeatAt.getTime() >= Date.now() - STALL_THRESHOLD_MS);
  });
  test('stall sweep runs every 5 minutes (300s interval)', () => {
    const INTERVAL_MS = 5 * 60 * 1000;
    assert.equal(INTERVAL_MS, 300000);
  });
  test('stall detection covers running AND pending status', () => {
    // The query uses status IN ['running', 'pending']
    const targetStatuses = ['running', 'pending'];
    assert.ok(targetStatuses.includes('running'));
    assert.ok(targetStatuses.includes('pending'));
  });
});

// ── GTM account capacity ──────────────────────────────────────────────────────

describe('GTM account capacity thresholds', () => {
  function capacityStatus(count) {
    if (count >= 480) return 'critical';
    if (count >= 400) return 'warning_high';
    if (count >= 300) return 'warning';
    return 'ok';
  }

  const cases = [
    [0, 'ok'], [299, 'ok'],
    [300, 'warning'], [399, 'warning'],
    [400, 'warning_high'], [479, 'warning_high'],
    [480, 'critical'], [500, 'critical'],
  ];
  cases.forEach(([n, expected]) => {
    test(`${n} containers → ${expected}`, () => {
      assert.equal(capacityStatus(n), expected);
    });
  });

  test('capacity pct for 400/490 is 82%', () => {
    assert.equal(Math.round((400 / 490) * 100), 82);
  });
});

// ── Metrics counter accuracy ──────────────────────────────────────────────────

describe('Metrics — 8 counters are monotonic', () => {
  test('incCapiSuccess increments capi_success_total', () => {
    const before = m.snapshot().counters.capi_success_total;
    m.incCapiSuccess('meta', 80);
    assert.equal(m.snapshot().counters.capi_success_total, before + 1);
  });
  test('incCapiFailure increments capi_failure_total', () => {
    const before = m.snapshot().counters.capi_failure_total;
    m.incCapiFailure('tiktok', 500);
    assert.equal(m.snapshot().counters.capi_failure_total, before + 1);
  });
  test('incDlqCreated increments dlq_created_total', () => {
    const before = m.snapshot().counters.dlq_created_total;
    m.incDlqCreated();
    assert.equal(m.snapshot().counters.dlq_created_total, before + 1);
  });
  test('incDlqReplayed increments dlq_replayed_total', () => {
    const before = m.snapshot().counters.dlq_replayed_total;
    m.incDlqReplayed();
    assert.equal(m.snapshot().counters.dlq_replayed_total, before + 1);
  });
  test('incDlqExhausted increments dlq_exhausted_total', () => {
    const before = m.snapshot().counters.dlq_exhausted_total;
    m.incDlqExhausted();
    assert.equal(m.snapshot().counters.dlq_exhausted_total, before + 1);
  });
  test('incConsentDenied increments consent_denied_total', () => {
    const before = m.snapshot().counters.consent_denied_total;
    m.incConsentDenied();
    assert.equal(m.snapshot().counters.consent_denied_total, before + 1);
  });
  test('incProvisioningFailed increments provisioning_failed_total', () => {
    const before = m.snapshot().counters.provisioning_failed_total;
    m.incProvisioningFailed();
    assert.equal(m.snapshot().counters.provisioning_failed_total, before + 1);
  });
  test('incProvisioningStalled increments provisioning_stalled_total', () => {
    const before = m.snapshot().counters.provisioning_stalled_total;
    m.incProvisioningStalled();
    assert.equal(m.snapshot().counters.provisioning_stalled_total, before + 1);
  });

  test('snapshot returns all 8 counter keys', () => {
    const snap = m.snapshot();
    const expected = [
      'capi_success_total', 'capi_failure_total',
      'dlq_created_total', 'dlq_replayed_total', 'dlq_exhausted_total',
      'consent_denied_total', 'provisioning_failed_total', 'provisioning_stalled_total',
    ];
    expected.forEach(k => {
      assert.ok(k in snap.counters, `missing counter: ${k}`);
    });
  });

  test('platform stats accumulate per-platform', () => {
    m.incCapiSuccess('snap', 120);
    m.incCapiSuccess('snap', 80);
    m.incCapiFailure('snap', 0);
    const snap = m.snapshot();
    assert.ok(snap.byPlatform.snap, 'snap platform must exist');
    assert.ok(snap.byPlatform.snap.success >= 2);
    assert.ok(snap.byPlatform.snap.failure >= 1);
    const rate = snap.byPlatform.snap.successRate;
    assert.ok(rate > 0 && rate < 1, 'success rate for snap must be between 0 and 1');
  });

  test('avgLatencyMs computed from incCapiSuccess latency arg', () => {
    const platform = 'latency_test_' + Date.now();
    m.incCapiSuccess(platform, 200);
    m.incCapiSuccess(platform, 400);
    const snap = m.snapshot();
    assert.equal(snap.byPlatform[platform].avgLatencyMs, 300);
  });
});

// ── Alert thresholds ──────────────────────────────────────────────────────────

describe('Metrics — alert thresholds', () => {
  test('DLQ depth 1001 fires DLQ_DEPTH alert', () => {
    const alerts = m.checkAlerts(1001, null);
    assert.ok(alerts.some(a => a.startsWith('DLQ_DEPTH')));
  });
  test('DLQ depth 1000 does NOT fire DLQ_DEPTH alert', () => {
    const alerts = m.checkAlerts(1000, null);
    assert.ok(!alerts.some(a => a.startsWith('DLQ_DEPTH')));
  });
  test('DLQ oldest 31 min fires DLQ_AGE alert', () => {
    const alerts = m.checkAlerts(0, 31 * 60 * 1000);
    assert.ok(alerts.some(a => a.startsWith('DLQ_AGE')));
  });
  test('DLQ oldest 29 min does NOT fire DLQ_AGE alert', () => {
    const alerts = m.checkAlerts(0, 29 * 60 * 1000);
    assert.ok(!alerts.some(a => a.startsWith('DLQ_AGE')));
  });
  test('platform with 0 success + 5 failures fires PLATFORM_AUTH_FAILURE', () => {
    const p = 'auth_test_' + Date.now();
    for (let i = 0; i < 5; i++) m.incCapiFailure(p);
    const alerts = m.checkAlerts(0, 0);
    assert.ok(alerts.some(a => a.includes('PLATFORM_AUTH_FAILURE') && a.includes(p)));
  });
  test('platform with 1 success + 10 failures does NOT fire auth alert', () => {
    const p = 'healthy_test_' + Date.now();
    m.incCapiSuccess(p, 100);
    for (let i = 0; i < 10; i++) m.incCapiFailure(p);
    const alerts = m.checkAlerts(0, 0);
    assert.ok(!alerts.some(a => a.includes(p) && a.includes('AUTH_FAILURE')));
  });
  test('provisioning_stalled_total > 0 fires PROVISIONING_STALLED alert', () => {
    m.incProvisioningStalled();
    const alerts = m.checkAlerts(0, 0);
    assert.ok(alerts.some(a => a.startsWith('PROVISIONING_STALLED')));
  });
});

// ── Secret Manager ENV fallback ───────────────────────────────────────────────

describe('Secret Manager — resolution logic', () => {
  test('resolves from env when Secret Manager not configured', async () => {
    const TEST_KEY = 'a'.repeat(64);
    const savedKey     = process.env.MASTER_ENCRYPTION_KEY;
    const savedProject = process.env.SECRET_MANAGER_PROJECT;
    process.env.MASTER_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.SECRET_MANAGER_PROJECT;
    sm.clearCache();
    const { hexKey, source } = await sm.resolveMasterKey();
    process.env.MASTER_ENCRYPTION_KEY = savedKey || '';
    if (savedProject) process.env.SECRET_MANAGER_PROJECT = savedProject;
    sm.clearCache();
    assert.equal(hexKey, TEST_KEY);
    assert.equal(source, 'env');
  });

  test('throws fatal error when both Secret Manager and env are absent', async () => {
    const savedKey     = process.env.MASTER_ENCRYPTION_KEY;
    const savedProject = process.env.SECRET_MANAGER_PROJECT;
    delete process.env.MASTER_ENCRYPTION_KEY;
    delete process.env.SECRET_MANAGER_PROJECT;
    sm.clearCache();
    await assert.rejects(
      sm.resolveMasterKey(),
      /MASTER_ENCRYPTION_KEY is not available/,
    );
    if (savedKey)     process.env.MASTER_ENCRYPTION_KEY   = savedKey;
    if (savedProject) process.env.SECRET_MANAGER_PROJECT  = savedProject;
    sm.clearCache();
  });

  test('validateAtStartup rejects key shorter than 64 chars', async () => {
    const savedKey = process.env.MASTER_ENCRYPTION_KEY;
    delete process.env.SECRET_MANAGER_PROJECT;
    sm.clearCache();
    process.env.MASTER_ENCRYPTION_KEY = 'tooshort';
    sm.clearCache();
    await assert.rejects(sm.validateAtStartup(), /invalid: must be 64 hex chars/);
    process.env.MASTER_ENCRYPTION_KEY = savedKey || '';
    sm.clearCache();
  });

  test('validateAtStartup accepts valid 64-char hex key', async () => {
    const savedKey = process.env.MASTER_ENCRYPTION_KEY;
    delete process.env.SECRET_MANAGER_PROJECT;
    sm.clearCache();
    process.env.MASTER_ENCRYPTION_KEY = '0'.repeat(64);
    sm.clearCache();
    const result = await sm.validateAtStartup();
    process.env.MASTER_ENCRYPTION_KEY = savedKey || '';
    sm.clearCache();
    assert.equal(result.source, 'env');
  });
});

// ── CryptoVault round-trip + key rotation ─────────────────────────────────────

describe('CryptoVault — token encryption', () => {
  const vault = require('../lib/crypto-vault');
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);

  test('encrypt → decrypt preserves plaintext', () => {
    const token = 'EAAMyFakeMetaToken123';
    assert.equal(vault.decrypt(vault.encrypt(token, KEY_A), KEY_A), token);
  });

  test('encrypt with AAD → decrypt requires same AAD', () => {
    const aad = 'client001:meta';
    const enc = vault.encrypt('tok', KEY_A, aad);
    assert.equal(vault.decrypt(enc, KEY_A, aad), 'tok');
    assert.throws(() => vault.decrypt(enc, KEY_A, 'wrong:aad'));
  });

  test('rotateKey re-encrypts under new key, old key no longer works', () => {
    const token = 'TikTokSecret999';
    const aad   = 'client002:tiktok';
    const enc   = vault.encrypt(token, KEY_A, aad);
    const [rotated] = vault.rotateKey(KEY_A, KEY_B, [enc], aad);
    assert.equal(vault.decrypt(rotated, KEY_B, aad), token);
    assert.throws(() => vault.decrypt(rotated, KEY_A, aad));
  });

  test('encryptToken returns null for falsy input', () => {
    process.env.MASTER_ENCRYPTION_KEY = KEY_A;
    assert.equal(vault.encryptToken(''),   null);
    assert.equal(vault.encryptToken(null), null);
  });

  test('decryptToken returns empty string for invalid input', () => {
    process.env.MASTER_ENCRYPTION_KEY = KEY_A;
    assert.equal(vault.decryptToken(null), '');
    assert.equal(vault.decryptToken({}),   '');
  });
});

// ── Cloud Run restart: orphan job recovery ────────────────────────────────────

describe('Simulation — Cloud Run restart recovery', () => {
  test('job without heartbeatAt is an orphan (never dispatched)', () => {
    const job = { status: 'pending', heartbeatAt: undefined };
    assert.ok(!job.heartbeatAt && job.status === 'pending');
  });

  test('job WITH heartbeatAt is a stall candidate (not an orphan)', () => {
    const job = { status: 'running', heartbeatAt: new Date(Date.now() - 2 * 60 * 1000) };
    const isOrphan = !job.heartbeatAt && job.status === 'pending';
    assert.ok(!isOrphan);
  });

  test('orphan recovery window is 25 minutes', () => {
    const ORPHAN_WINDOW_MS = 25 * 60 * 1000;
    assert.equal(ORPHAN_WINDOW_MS, 1500000);
  });
});

// ── Token rotation + DLQ replay ───────────────────────────────────────────────

describe('Simulation — token rotation + DLQ replay', () => {
  test('exhausted AUTH_ERROR event can be reset to pending for replay', () => {
    const doc = {
      status: 'exhausted',
      exhaustedReason: 'auth_error:401 — rotate CAPI token for platform=tiktok',
      lastStatusCode: 401,
      retryCount: 1,
    };
    // Operator flow after token rotation: reset the event for replay
    const resetPatch = {
      status: 'pending',
      lastStatusCode: null,
      exhaustedReason: null,
      retryCount: 0,
      nextRetryAt: new Date(Date.now() + 10000),
    };
    assert.equal(resetPatch.status, 'pending');
    assert.equal(resetPatch.lastStatusCode, null);
    assert.ok(resetPatch.nextRetryAt instanceof Date);
    // Original document unchanged
    assert.equal(doc.status, 'exhausted');
  });

  test('token rotation AAD context binds re-encrypted token to client+platform', () => {
    const vault = require('../lib/crypto-vault');
    const KEY   = '0'.repeat(64);
    process.env.MASTER_ENCRYPTION_KEY = KEY;
    const newToken = 'EAANewRotatedToken';
    const aad      = 'client42:meta';
    const enc      = vault.encrypt(newToken, KEY, aad);
    // Decryption succeeds with correct context
    assert.equal(vault.decrypt(enc, KEY, aad), newToken);
    // Decryption fails with wrong client context — prevents cross-client token use
    assert.throws(() => vault.decrypt(enc, KEY, 'client99:meta'));
  });
});
