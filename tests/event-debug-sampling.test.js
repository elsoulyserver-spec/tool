'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const debug = require('../lib/event-observability-service');
const auth = require('../lib/event-observability-auth');
const worker = require('../lib/ttl-backstop-worker');
const { buildServerConfig } = require('../lib/gtm-config-builder');

function input(sampleKey = 'safe-event-0001', overrides = {}) {
  return {
    sampleKey,
    eventName: 'purchase',
    intendedDestination: 'ga4',
    containerVersion: 'test-v1',
    processingTimeMs: 12,
    schemaVersion: '1',
    ingestionAccepted: true,
    presentFields: ['transaction_id', 'currency', 'value', 'items', 'tax'],
    cms: 'shopify',
    environment: 'test',
    ...overrides,
  };
}

function adapter(seed = []) {
  const samples = seed.slice();
  return {
    samples,
    async reserveDebugSample(sample, caps) {
      const duplicate = samples.find(row => row.sampleId === sample.sampleId);
      if (duplicate) return duplicate.sampleId;
      const daily = samples.filter(row => row.clientId === sample.clientId && row.receivedAt >= caps.dayStart);
      const dimension = daily.filter(row => row.eventName === sample.eventName &&
        row.intendedDestination === sample.intendedDestination);
      if (daily.length >= caps.dailyTenantCap || dimension.length >= caps.dailyDimensionCap) return null;
      samples.push(sample);
      return sample.sampleId;
    },
  };
}

test('debug sampling defaults are bounded, low-volume, and short-lived', () => {
  assert.equal(debug.DEBUG_DEFAULT_SAMPLE_RATE, 0.01);
  assert.equal(debug.DEBUG_DEFAULT_RETENTION_DAYS, 7);
  assert.equal(debug.DEBUG_MAX_RETENTION_DAYS, 14);
  assert.equal(debug.DEBUG_DAILY_TENANT_CAP, 100);
  assert.equal(debug.DEBUG_DAILY_DIMENSION_CAP, 25);
  assert.equal(debug.boundedRetentionDays(999), 14);
  assert.equal(debug.boundedRetentionDays(0), 1);
});

test('deterministic sampling returns the same decision for the same safe identifier', () => {
  const first = debug.deterministicDebugDecision('tenant-a', input(), 0.37);
  const second = debug.deterministicDebugDecision('tenant-a', input(), 0.37);
  assert.equal(first.selected, second.selected);
  assert.equal(first.digest, second.digest);
  assert.equal(first.bucket, second.bucket);
});

test('different safe identifiers distribute across deterministic decisions', () => {
  const decisions = new Set();
  for (let i = 0; i < 200; i++) {
    decisions.add(debug.deterministicDebugDecision('tenant-a', input('safe-event-' + String(i).padStart(4, '0')), 0.5).selected);
  }
  assert.deepEqual([...decisions].sort(), [false, true]);
});

test('sampling rate zero disables writes and rate one enables them', async () => {
  const offAdapter = adapter();
  const off = debug.create(offAdapter, { debugSampleRate: 0 });
  assert.deepEqual(await off.ingestDebugSample('tenant-a', input()), { ok: true, sampled: false, reason: 'rate' });
  assert.equal(offAdapter.samples.length, 0);

  const onAdapter = adapter();
  const on = debug.create(onAdapter, { debugSampleRate: 1, now: () => new Date('2026-08-04T12:00:00Z') });
  assert.equal((await on.ingestDebugSample('tenant-a', input())).sampled, true);
  assert.equal(onAdapter.samples.length, 1);
});

test('initial rollout accepts GA4 purchase only', async () => {
  const service = debug.create(adapter(), { debugSampleRate: 1 });
  assert.deepEqual(await service.ingestDebugSample('tenant-a', input('safe-event-page', { eventName: 'page_view' })),
    { ok: true, sampled: false, reason: 'unsupported_scope' });
  assert.deepEqual(await service.ingestDebugSample('tenant-a', input('safe-event-meta', { intendedDestination: 'meta' })),
    { ok: true, sampled: false, reason: 'unsupported_scope' });
});

test('strict projection stores only the approved schema and field names, never values or nested PII', () => {
  const sample = debug.buildDebugSample('tenant-a', input('safe-event-projection', {
    presentFields: ['transaction_id', 'currency', 'value', 'items', 'tax', 'email', 'user_id'],
    invalidFields: ['currency', 'email', 'gclid'],
    fieldIndicators: {
      transaction_id: 'ACTUAL-ORDER-123', currency: 'SAR', value: '900.00', items: '[raw items]',
      email: 'person@example.com', user_data: { phone: '+20123456789' },
    },
    metadata: { arbitrary: 'must-not-survive', email: 'person@example.com' },
    containerVersion: 'person@example.com',
    email: 'person@example.com', phone: '+20123456789', payload: { address: 'secret' },
  }), new Date('2026-08-04T12:00:00Z'));

  assert.deepEqual(Object.keys(sample).sort(), [
    'clientId', 'containerVersion', 'eventName', 'expiresAt', 'ingestionAccepted',
    'intendedDestination', 'metadata', 'processingTimeMs', 'receivedAt', 'sampleId',
    'schemaVersion', 'validation',
  ].sort());
  assert.deepEqual(sample.validation.missingRequiredFields, []);
  assert.deepEqual(sample.validation.optionalFieldsPresent, ['tax']);
  assert.deepEqual(sample.validation.invalidFieldNames, ['currency']);
  assert.deepEqual(sample.metadata, { cms: 'shopify', platform: 'ga4', environment: 'test' });
  assert.equal(sample.containerVersion, 'unknown');
  const stored = JSON.stringify(sample);
  for (const forbidden of ['ACTUAL-ORDER-123', '900.00', 'person@example.com', '+20123456789', '[raw items]', 'secret']) {
    assert.doesNotMatch(stored, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(stored, /email|phone|user_id|gclid|user_data|payload|address/i);
});

test('validation stores presence and missing field names only', () => {
  const sample = debug.buildDebugSample('tenant-a', input('safe-event-missing', {
    presentFields: ['transaction_id', 'currency', 'coupon'],
  }), new Date('2026-08-04T12:00:00Z'));
  assert.equal(sample.validation.passed, false);
  assert.deepEqual(sample.validation.missingRequiredFields, ['value', 'items']);
  assert.deepEqual(sample.validation.optionalFieldsPresent, ['coupon']);
});

test('per-event/destination daily cap is hard and over-cap is success without writing', async () => {
  const store = adapter();
  const service = debug.create(store, { debugSampleRate: 1, now: () => new Date('2026-08-04T12:00:00Z') });
  for (let i = 0; i < debug.DEBUG_DAILY_DIMENSION_CAP; i++) {
    assert.equal((await service.ingestDebugSample('tenant-a', input('safe-dimension-' + String(i).padStart(4, '0')))).sampled, true);
  }
  const result = await service.ingestDebugSample('tenant-a', input('safe-dimension-over-cap'));
  assert.deepEqual(result, { ok: true, sampled: false, reason: 'cap' });
  assert.equal(store.samples.length, debug.DEBUG_DAILY_DIMENSION_CAP);
});

test('daily tenant cap is passed as a hard bound and over-cap remains fail-open', async () => {
  const fake = { async reserveDebugSample(sample, caps) {
    assert.equal(caps.dailyTenantCap, 100);
    assert.equal(caps.dailyDimensionCap, 25);
    return null;
  }};
  const service = debug.create(fake, { debugSampleRate: 1 });
  assert.deepEqual(await service.ingestDebugSample('tenant-a', input('safe-tenant-over-cap')),
    { ok: true, sampled: false, reason: 'cap' });
});

test('storage or validation failure is fail-open', async () => {
  const service = debug.create({ async reserveDebugSample() { throw new Error('firestore unavailable'); } }, { debugSampleRate: 1 });
  assert.deepEqual(await service.ingestDebugSample('tenant-a', input('safe-storage-error')),
    { ok: true, sampled: false, reason: 'sampling_error' });
  assert.deepEqual(await service.ingestDebugSample('tenant-a', input('bad key!')),
    { ok: true, sampled: false, reason: 'sampling_error' });
});

test('TTL is present, defaults to 7 days, and never exceeds 14 days', () => {
  const receivedAt = new Date('2026-08-04T12:00:00Z');
  const defaultSample = debug.buildDebugSample('tenant-a', input(), receivedAt);
  const boundedSample = debug.buildDebugSample('tenant-a', input(), receivedAt, { retentionDays: 999 });
  assert.equal(defaultSample.expiresAt - receivedAt, 7 * 86400000);
  assert.equal(boundedSample.expiresAt - receivedAt, 14 * 86400000);
  const indexes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
  const ttl = indexes.fieldOverrides.find(row => row.collectionGroup === 'event_debug_samples' && row.fieldPath === 'expiresAt');
  assert.equal(ttl.ttl, true);
  assert.ok(ttl.indexes.some(index => index.order === 'ASCENDING'), 'backstop expiry query remains indexed');
});

test('debug TTL backstop participates in bounded paginated idempotent rotation', async () => {
  worker._resetForTests();
  const calls = [];
  const fake = { async deleteExpiredEventObservability(collection, now, limit, cursor) {
    calls.push({ collection, limit, cursor });
    if (collection === 'event_debug_samples' && !cursor) return { deleted: 500, nextCursor: { value: now, id: 'page-1' } };
    if (collection === 'event_debug_samples') return { deleted: 0, nextCursor: null };
    return { deleted: 0, nextCursor: null };
  }};
  await worker.tick(fake); await worker.tick(fake); await worker.tick(fake);
  const first = await worker.tick(fake);
  const second = await worker.tick(fake);
  assert.equal(first.collection, 'event_debug_samples');
  assert.equal(first.deleted, 500);
  assert.equal(second.collection, 'event_debug_samples');
  assert.equal(second.deleted, 0);
  assert.equal(calls[4].cursor.id, 'page-1');
  assert.ok(calls.every(call => call.limit === 500));
});

test('API flags default off, forged clientId is rejected, and reads reuse owner/admin authorization', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(server, /EVENT_DEBUG_SAMPLING_INGEST_ENABLED === '1'/);
  assert.match(server, /EVENT_DEBUG_SAMPLING_READ_ENABLED === '1'/);
  assert.match(server, /debugBodyClaimsClientId\(body\)/);
  assert.match(server, /eventObservabilityService\.ingestDebugSample\(auth\.clientId, body\)/);
  assert.match(server, /if \(isAdminRead\).*_requireAdmin\(\)/s);
  assert.match(server, /eventOwnerAuth\(targetId\)/);
  assert.match(env, /^EVENT_DEBUG_SAMPLING_INGEST_ENABLED=$/m);
  assert.match(env, /^EVENT_DEBUG_SAMPLING_READ_ENABLED=$/m);
  assert.match(env, /^EVENT_DEBUG_SAMPLING_SGTM_ROLLOUT_ENABLED=$/m);
  assert.equal(auth.authorizeOwner({ uid: 'tenant-a' }, 'tenant-a'), true);
  assert.equal(auth.authorizeOwner({ uid: 'tenant-a' }, 'tenant-b'), false);
});

test('Firestore reads are client-scoped, bounded, paginated, and safely projected', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'firestore-service.js'), 'utf8');
  assert.match(source, /EVENT_DEBUG_SAMPLES_COLLECTION = 'event_debug_samples'/);
  assert.match(source, /where\('clientId', '==', clientId\)/);
  assert.match(source, /limit\(caps\.dailyTenantCap\)/);
  assert.match(source, /limit\(caps\.dailyDimensionCap\)/);
  assert.match(source, /tenantSnap\.size >= caps\.dailyTenantCap/);
  assert.match(source, /dimensionSnap\.size >= caps\.dailyDimensionCap/);
  assert.match(source, /14 \* 86400000/);
  assert.match(source, /Math\.min\(Math\.max\(filters\.limit \|\| 50, 1\), 100\)/);
  assert.match(source, /_projectEventDebugSample\(doc\.data\(\), doc\.id, clientId\)/);
  assert.match(source, /_debugSampleNames\(validation\.missingRequiredFields\)/);
  assert.match(source, /data\.clientId !== clientId/);
});

test('generated debug tag is GA4 purchase-only, synthetic-opt-in, independent, and default off', () => {
  const base = {
    ga4MeasurementId: 'G-X', events: ['purchase'], eventObservabilityUrl: 'https://obs.example',
    eventObservabilityApiKey: 'key', etClientId: 'synthetic-a',
  };
  const find = cfg => cfg.containerVersion.tag.filter(tag => /Event Debug Sample/.test(tag.name));
  assert.equal(find(buildServerConfig(base)).length, 0);
  assert.equal(find(buildServerConfig({ ...base, eventDebugSamplingRolloutEnabled: true })).length, 0);
  assert.equal(find(buildServerConfig({ ...base, events: ['page_view'], eventDebugSamplingRolloutEnabled: true,
    eventDebugSamplingSyntheticTenant: true })).length, 0);
  const [tag] = find(buildServerConfig({ ...base, eventDebugSamplingRolloutEnabled: true,
    eventDebugSamplingSyntheticTenant: true }));
  assert.equal(tag.name, 'ET - Event Debug Sample - GA4 purchase');
  assert.equal(tag.type, 'http');
  assert.ok(!('setupTag' in tag) && !('teardownTag' in tag));
  const body = JSON.parse(tag.parameter.find(param => param.key === 'requestBody').value);
  assert.equal(body.eventName, 'purchase');
  assert.equal(body.intendedDestination, 'ga4');
  assert.deepEqual(Object.keys(body.fieldIndicators).sort(), ['currency', 'items', 'transaction_id', 'value']);
  assert.doesNotMatch(JSON.stringify(body), /email|phone|user_data|cookie|header|page_location|referrer|gclid|access_token/i);
});
