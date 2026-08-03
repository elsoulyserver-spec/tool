'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const svc = require('../lib/event-observability-service');
const auth = require('../lib/event-observability-auth');
const worker = require('../lib/ttl-backstop-worker');
const { buildServerConfig, _safeJsonBody } = require('../lib/gtm-config-builder');

function memoryAdapter() {
  const samples = [];
  const totals = new Map();
  return {
    samples, totals,
    async incrementAggregate(shard, daily) {
      const current = totals.get(shard.id) || { accepted: 0, failed: 0, validationFailed: 0 };
      current.accepted += shard.accepted;
      current.failed += shard.failed;
      current.validationFailed += shard.validationFailed;
      totals.set(shard.id, current);
      this.last = { shard, daily };
    },
    async reserveFailureSample(sample, caps) {
      const reasonCount = samples.filter(x => x.clientId === sample.clientId && x.eventName === sample.eventName &&
        x.destination === sample.destination && x.reasonCode === sample.reasonCode && x.receivedAt >= caps.reasonSince).length;
      const dailyCount = samples.filter(x => x.clientId === sample.clientId && x.receivedAt >= caps.dayStart).length;
      if (reasonCount >= caps.reasonCap || dailyCount >= caps.dailyCap) return null;
      samples.push(sample); return 'sample-' + samples.length;
    },
  };
}
const failure = (reasonCode = 'AUTH_ERROR', eventName = 'purchase') => ({
  eventId: 'opaque-1', eventName, destination: 'ga4', reasonCode,
  httpStatus: 401, schemaVersion: '1', containerVersion: 'v1', attemptCount: 1,
  payloadSizeBytes: 42, retryState: 'exhausted',
});

test('valid per-client API key is accepted and returns only its bound clientId', async () => {
  const api = { parse: k => k === 'valid' ? { keyId: 'kid' } : null, verify: (k, h) => k === 'valid' && h === 'hash' };
  const store = { getApiKey: async () => ({ keyHash: 'hash', clientId: 'owner-a', status: 'active' }) };
  assert.deepEqual(await auth.authenticateApiKey('valid', api, store), { clientId: 'owner-a', keyId: 'kid' });
});

test('owner reads are self-scoped and cross-tenant reads are rejected', () => {
  assert.equal(auth.authorizeOwner({ uid: 'owner-a' }, 'owner-a'), true);
  assert.equal(auth.authorizeOwner({ uid: 'owner-a' }, 'owner-b'), false);
});

test('server exposes a separate admin read tier through existing _requireAdmin', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf('const eventReadMatch'), source.indexOf('const eventReadMatch') + 1300);
  assert.match(route, /admin\\\/\)\?clients/);
  assert.match(route, /if \(isAdminRead\).*_requireAdmin\(\)/s);
});

test('forged body clientId is rejected before ingestion and is never used for attribution', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = source.slice(source.indexOf("v1Path === '/api/v1/internal/event-telemetry'"), source.indexOf("v1Path === '/api/v1/internal/event-telemetry'") + 1800);
  assert.match(source, /hasOwnProperty\.call\(body, 'clientId'\)/);
  assert.match(block, /eventBodyClaimsClientId\(body\)/);
  assert.doesNotMatch(block, /body\.clientId|body\[['"]clientId/);
  assert.match(block, /ingestTelemetry\(auth\.clientId, body\)/);
});

test('server-selected shards cover all 10 shards and never use an eleventh', () => {
  const seen = new Set();
  for (let i = 0; i < 10; i++) seen.add(svc.buildAggregateWrite('c', { eventName: 'purchase', destination: 'ga4', accepted: 1 }, new Date(0), () => i).shard.shardId);
  assert.deepEqual([...seen], [0,1,2,3,4,5,6,7,8,9]);
  assert.equal(svc.SHARD_COUNT, 10);
});

test('concurrent-style aggregate writes sum without a lost update', async () => {
  const adapter = memoryAdapter();
  const service = svc.create(adapter, { now: () => new Date('2026-01-01T00:01:00Z'), randomInt: () => 3 });
  await Promise.all(Array.from({ length: 50 }, () => service.ingestTelemetry('c', { eventName: 'purchase', destination: 'ga4', accepted: 1 })));
  assert.equal([...adapter.totals.values()][0].accepted, 50);
  const firestore = fs.readFileSync(path.join(__dirname, '..', 'firestore-service.js'), 'utf8');
  assert.match(firestore, /FieldValue\.increment/);
});

test('server receive time controls 5-minute bucket boundaries', () => {
  const input = { eventName: 'purchase', destination: 'ga4', accepted: 1, bucketStart: '1999-01-01', receivedAt: '1999-01-01' };
  const a = svc.buildAggregateWrite('c', input, new Date('2026-01-01T12:02:01Z'), () => 0);
  const b = svc.buildAggregateWrite('c', input, new Date('2026-01-01T12:04:59Z'), () => 0);
  const c = svc.buildAggregateWrite('c', input, new Date('2026-01-01T12:05:00.001Z'), () => 0);
  assert.equal(+a.shard.bucketStart, +b.shard.bucketStart);
  assert.notEqual(+b.shard.bucketStart, +c.shard.bucketStart);
  assert.equal(a.shard.bucketStart.toISOString(), '2026-01-01T12:00:00.000Z');
});

test('per-reason rolling cap is 20 and over-cap returns success without writing', async () => {
  const adapter = memoryAdapter();
  const service = svc.create(adapter, { now: () => new Date('2026-01-01T12:00:00Z') });
  for (let i = 0; i < 20; i++) assert.equal((await service.ingestFailure('c', failure())).sampled, true);
  const before = adapter.samples.length;
  assert.deepEqual(await service.ingestFailure('c', failure()), { ok: true, sampled: false });
  assert.equal(adapter.samples.length, before);
  assert.equal((await service.ingestFailure('c', failure('TIMEOUT'))).sampled, true, 'cap is independent per reason');
});

test('daily tenant cap is 500 independently and over-cap does not write', async () => {
  const adapter = memoryAdapter();
  const service = svc.create(adapter, { now: () => new Date('2026-01-01T12:00:00Z') });
  for (let i = 0; i < 500; i++) adapter.samples.push(svc.buildFailureSample('c', failure(i % 2 ? 'AUTH_ERROR' : 'TIMEOUT', 'event_' + i), new Date('2026-01-01T11:00:00Z')));
  const before = adapter.samples.length;
  assert.deepEqual(await service.ingestFailure('c', failure('TRANSPORT_ERROR')), { ok: true, sampled: false });
  assert.equal(adapter.samples.length, before);
});

test('failure projection strips PII and unknown request fields and uses controlled summary', () => {
  const sample = svc.buildFailureSample('c', { ...failure(), payload: { email: 'x@y' }, headers: { authorization: 'secret' }, cookies: 'x', ip: '1.2.3.4', email: 'x@y', phone: '1', url: 'https://x' });
  assert.deepEqual(Object.keys(sample).sort(), ['attemptCount','clientId','containerVersion','destination','eventId','eventName','expiresAt','httpStatus','payloadSizeBytes','reasonCode','reasonSummary','receivedAt','retryState','schemaVersion'].sort());
  assert.equal(sample.reasonSummary, svc.REASON_SUMMARIES.AUTH_ERROR);
  assert.doesNotMatch(JSON.stringify(sample), /x@y|secret|1\.2\.3\.4|https:\/\//);
});

test('TTL fieldOverrides declare ttl:true for both expiring collections', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
  for (const name of ['event_agg_shards', 'event_failure_samples']) {
    assert.ok(config.fieldOverrides.some(x => x.collectionGroup === name && x.fieldPath === 'expiresAt' && x.ttl === true));
  }
});

test('backstop sweep paginates across invocations and is idempotent', async () => {
  worker._resetForTests();
  const calls = [];
  const fake = { async deleteExpiredEventObservability(collection, now, limit, cursor) {
    calls.push({ collection, cursor });
    if (collection === 'event_agg_shards' && !cursor) return { deleted: 500, nextCursor: { value: new Date(0), id: '500' } };
    if (collection === 'event_agg_shards') return { deleted: 25, nextCursor: null };
    return { deleted: 0, nextCursor: null };
  }};
  assert.equal((await worker.tick(fake)).deleted, 500);
  assert.equal((await worker.tick(fake)).deleted, 25);
  assert.deepEqual(calls[1].cursor.id, '500');
  await worker.tick(fake); await worker.tick(fake); await worker.tick(fake);
  assert.ok(calls.length >= 5, 're-running empty/already-deleted pages remains safe');
});

function obsTags(config) { return config.containerVersion.tag.filter(t => /Event (Telemetry|Failure)/.test(t.name)); }
test('rollout defaults off and GA4 purchase is the only generated telemetry combination', () => {
  const base = { ga4MeasurementId: 'G-X', eventObservabilityUrl: 'https://obs.example', eventObservabilityApiKey: 'key', etClientId: 'c' };
  assert.equal(obsTags(buildServerConfig({ ...base, events: ['purchase'] })).length, 0);
  for (const events of [[], ['page_view'], ['add_to_cart'], ['page_view','search']]) {
    assert.equal(obsTags(buildServerConfig({ ...base, events, platforms: ['meta','tiktok','snap','gads'], eventObservabilityRolloutEnabled: true })).length, 0);
  }
  const tags = obsTags(buildServerConfig({ ...base, events: ['purchase','page_view'], platforms: ['meta','tiktok'], eventObservabilityRolloutEnabled: true }));
  assert.equal(tags.length, 1, 'only the telemetry (accepted-counter) tag ships in V1 — no failure tag');
  assert.equal(tags[0].name, 'ET - Event Telemetry - GA4 purchase');
  assert.ok(tags.every(t => t.type === 'http' && !('setupTag' in t) && !('teardownTag' in t)));
  assert.ok(tags.every(t => t.parameter.find(p => p.key === 'requestBody').value.includes('"destination":"ga4"')));
  assert.ok(tags.every(t => t.parameter.find(p => p.key === 'requestBody').value.includes('"eventName":"purchase"')));
});

test('failure tag, its trigger, and its dead variables are fully absent from the generated container', () => {
  const cfg = buildServerConfig({
    ga4MeasurementId: 'G-X', events: ['purchase'], sgtmUrl: 'https://sgtm.example.com',
    eventObservabilityUrl: 'https://obs.example', eventObservabilityApiKey: 'key', etClientId: 'c',
    eventObservabilityRolloutEnabled: true,
  });
  assert.equal(cfg.containerVersion.tag.filter(t => /Event Failure/.test(t.name)).length, 0);
  assert.equal(cfg.containerVersion.trigger.filter(t => /[Oo]bservability/.test(t.name)).length, 0);
  assert.equal(cfg.containerVersion.variable.filter(v => /^ET - obs /.test(v.name)).length, 0);
  const raw = JSON.stringify(cfg);
  assert.doesNotMatch(raw, /event_observability\./, 'no reference to the unproduced event_observability.* fields anywhere');
});

test('telemetry tag requestBody is built via safe JSON serialization and parses', () => {
  const cfg = buildServerConfig({
    ga4MeasurementId: 'G-X', events: ['purchase'], sgtmUrl: 'https://sgtm.example.com',
    eventObservabilityUrl: 'https://obs.example', eventObservabilityApiKey: 'key', etClientId: 'c',
    eventObservabilityRolloutEnabled: true,
  });
  const body = cfg.containerVersion.tag.find(t => t.name === 'ET - Event Telemetry - GA4 purchase')
    .parameter.find(p => p.key === 'requestBody').value;
  assert.doesNotMatch(body, /\{\{/, 'no runtime {{variable}} placeholders in the telemetry body — fully static, generation-time JSON');
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed, { eventName: 'purchase', destination: 'ga4', accepted: 1, failed: 0, validationFailed: 0 });
});

test('_safeJsonBody: full optional-field / edge-case matrix always produces parseable JSON', () => {
  const cases = [
    ['all values present', { eventName: 'purchase', accepted: 1, httpStatus: 401, attemptCount: 3 }, { eventName: 'purchase', accepted: 1, httpStatus: 401, attemptCount: 3 }],
    ['httpStatus absent (omitted via undefined)', { eventName: 'purchase', accepted: 1, httpStatus: undefined, attemptCount: 3 }, { eventName: 'purchase', accepted: 1, attemptCount: 3 }],
    ['attemptCount absent (omitted via undefined)', { eventName: 'purchase', accepted: 1, httpStatus: 401, attemptCount: undefined }, { eventName: 'purchase', accepted: 1, httpStatus: 401 }],
    ['both httpStatus and attemptCount absent', { eventName: 'purchase', accepted: 1, httpStatus: undefined, attemptCount: undefined }, { eventName: 'purchase', accepted: 1 }],
    ['quotes and special characters', { eventName: 'p"u\\r\nch\tase' }, { eventName: 'p"u\\r\nch\tase' }],
    ['empty strings', { eventName: '', reasonCode: '' }, { eventName: '', reasonCode: '' }],
    ['null values', { httpStatus: null, attemptCount: null, eventName: 'purchase' }, { httpStatus: null, attemptCount: null, eventName: 'purchase' }],
  ];
  for (const [label, input, expected] of cases) {
    const out = _safeJsonBody(input);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, `${label}: must produce parseable JSON, got: ${out}`);
    assert.deepEqual(parsed, expected, label);
  }
});

test('ingest/read endpoint flags default off and gate routes before auth/storage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /EVENT_OBSERVABILITY_INGEST_ENABLED === '1'/);
  assert.match(source, /EVENT_OBSERVABILITY_READ_ENABLED === '1'/);
  assert.match(source, /if \(!eventIngestEnabled\).*503/s);
  assert.match(source, /if \(!eventReadEnabled\).*503/s);
});

test('event-failure ingestion is hard-disabled (501) independent of any rollout flag', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = source.indexOf("v1Path === '/api/v1/internal/event-failure'");
  assert.ok(idx > -1, 'route for /event-failure must still exist');
  const block = source.slice(idx - 200, idx + 400);
  assert.match(block, /sendJSON\(res, 501,/, 'must respond 501, not delegate to ingestFailure');
  assert.doesNotMatch(block, /eventIngestEnabled/, 'must not be gated behind the ingest flag — always disabled');
  // The route must appear before the telemetry route so it short-circuits first.
  const telemetryIdx = source.indexOf("v1Path === '/api/v1/internal/event-telemetry'");
  assert.ok(idx < telemetryIdx);
});
