'use strict';

const crypto = require('crypto');

const BUCKET_MS = 5 * 60 * 1000;
const SHARD_COUNT = 10;
const FINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SAMPLE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const REASON_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_RETENTION_MS = 13 * 31 * 24 * 60 * 60 * 1000;
const REASON_CAP = 20;
const DAILY_CLIENT_CAP = 500;
const DEBUG_DEFAULT_RETENTION_DAYS = 7;
const DEBUG_MAX_RETENTION_DAYS = 14;
const DEBUG_DAILY_TENANT_CAP = 100;
const DEBUG_DAILY_DIMENSION_CAP = 25;
const DEBUG_DEFAULT_SAMPLE_RATE = 0.01;
const DEBUG_REQUIRED_FIELDS = Object.freeze(['transaction_id', 'currency', 'value', 'items']);
const DEBUG_OPTIONAL_FIELDS = Object.freeze([
  'tax', 'shipping', 'coupon', 'affiliation', 'content_ids', 'content_name',
  'content_type', 'items_count', 'num_items', 'search_string', 'event_time',
  'device_type', 'language',
]);
const DEBUG_ALLOWED_FIELDS = new Set([...DEBUG_REQUIRED_FIELDS, ...DEBUG_OPTIONAL_FIELDS]);
const DEBUG_CMS = new Set(['salla', 'zid', 'woocommerce', 'shopify', 'custom', 'unknown']);
const DEBUG_ENVIRONMENTS = new Set(['synthetic', 'test', 'staging', 'development']);
const DEBUG_KEY_RE = /^[A-Za-z0-9._:-]{8,256}$/;

const REASON_SUMMARIES = Object.freeze({
  AUTH_ERROR: 'Destination authentication failed; rotate the destination credential.',
  VALIDATION_ERROR: 'The event did not pass the destination schema validation.',
  RATE_LIMITED: 'The destination rate limit was reached.',
  DESTINATION_REJECTED: 'The destination rejected the event.',
  TRANSPORT_ERROR: 'The destination request could not be completed.',
  TIMEOUT: 'The destination request timed out.',
  UNKNOWN_ERROR: 'The destination attempt failed for an unclassified reason.',
});
const RETRY_STATES = new Set(['pending', 'retried', 'exhausted']);
const NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

function floorBucket(now) { return new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS); }
function floorDay(now) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); }
function safePart(value) { return encodeURIComponent(value); }
function int(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(name + ' must be a non-negative integer');
  return value;
}
function dimension(value, name) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw new Error(name + ' is invalid');
  return value;
}
function optionalText(value, name, max) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\r\n]/.test(value)) throw new Error(name + ' is invalid');
  return value;
}
function optionalDate(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error(name + ' is invalid');
  return d;
}

function boundedRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEBUG_DEFAULT_SAMPLE_RATE;
}

function boundedRetentionDays(value) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days)) return DEBUG_DEFAULT_RETENTION_DAYS;
  return Math.min(Math.max(days, 1), DEBUG_MAX_RETENTION_DAYS);
}

function debugDigest(clientId, eventName, intendedDestination, sampleKey) {
  if (typeof sampleKey !== 'string' || !DEBUG_KEY_RE.test(sampleKey)) throw new Error('sampleKey is invalid');
  return crypto.createHash('sha256')
    .update([clientId, eventName, intendedDestination, sampleKey].join('|'), 'utf8')
    .digest('hex');
}

function deterministicDebugDecision(clientId, input, rate = DEBUG_DEFAULT_SAMPLE_RATE) {
  const eventName = dimension(input && input.eventName, 'eventName');
  const intendedDestination = dimension(input && input.intendedDestination, 'intendedDestination');
  const digest = debugDigest(clientId, eventName, intendedDestination, input && input.sampleKey);
  const normalizedRate = boundedRate(rate);
  const bucket = Number.parseInt(digest.slice(0, 12), 16) / 0x1000000000000;
  return { selected: normalizedRate > 0 && bucket < normalizedRate, digest, bucket, rate: normalizedRate };
}

function safeFieldNames(values) {
  if (!Array.isArray(values)) return [];
  const unique = new Set();
  for (const value of values.slice(0, 64)) {
    if (typeof value === 'string' && DEBUG_ALLOWED_FIELDS.has(value)) unique.add(value);
  }
  return Array.from(unique).sort();
}

function presentFieldNames(input) {
  const explicit = safeFieldNames(input && input.presentFields);
  const indicators = input && input.fieldIndicators;
  if (!indicators || typeof indicators !== 'object' || Array.isArray(indicators)) return explicit;
  const present = new Set(explicit);
  for (const field of DEBUG_ALLOWED_FIELDS) {
    const value = indicators[field];
    if (value !== undefined && value !== null && value !== '') present.add(field);
  }
  return Array.from(present).sort();
}

function safeEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value.toLowerCase()) ? value.toLowerCase() : fallback;
}

function safeDebugVersion(value, fallback, max) {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9._-]+$/.test(value) ? value : fallback;
}

function buildDebugSample(clientId, input, receivedAt = new Date(), options = {}) {
  const eventName = dimension(input && input.eventName, 'eventName');
  const intendedDestination = dimension(input && input.intendedDestination, 'intendedDestination');
  if (eventName !== 'purchase' || intendedDestination !== 'ga4') throw new Error('debug sampling scope is GA4 purchase only');
  const digest = options.digest || debugDigest(clientId, eventName, intendedDestination, input && input.sampleKey);
  const present = presentFieldNames(input);
  const presentSet = new Set(present);
  const invalidFieldNames = safeFieldNames(input && input.invalidFields);
  const missingRequiredFields = DEBUG_REQUIRED_FIELDS.filter(field => !presentSet.has(field));
  const optionalFieldsPresent = DEBUG_OPTIONAL_FIELDS.filter(field => presentSet.has(field));
  const retentionDays = boundedRetentionDays(options.retentionDays);
  const processingTimeMs = input && input.processingTimeMs !== undefined
    ? int(input.processingTimeMs, 'processingTimeMs', 60000) : undefined;
  const containerVersion = safeDebugVersion(input && input.containerVersion, 'unknown', 64);
  const schemaVersion = safeDebugVersion(input && input.schemaVersion, '1', 32);
  const sample = {
    sampleId: digest.slice(0, 32),
    clientId,
    eventName,
    intendedDestination,
    receivedAt,
    containerVersion,
    schemaVersion,
    ingestionAccepted: input && input.ingestionAccepted === true,
    validation: {
      passed: missingRequiredFields.length === 0 && invalidFieldNames.length === 0,
      missingRequiredFields,
      optionalFieldsPresent,
      invalidFieldNames,
    },
    metadata: {
      cms: safeEnum(input && input.cms, DEBUG_CMS, 'unknown'),
      platform: 'ga4',
      environment: safeEnum(input && input.environment, DEBUG_ENVIRONMENTS, 'synthetic'),
    },
    expiresAt: new Date(receivedAt.getTime() + retentionDays * 86400000),
  };
  if (processingTimeMs !== undefined) sample.processingTimeMs = processingTimeMs;
  return sample;
}

function buildAggregateWrite(clientId, input, receivedAt = new Date(), randomInt = n => crypto.randomInt(n)) {
  const eventName = dimension(input.eventName, 'eventName');
  const destination = dimension(input.destination, 'destination');
  const accepted = int(input.accepted || 0, 'accepted');
  const failed = int(input.failed || 0, 'failed');
  const validationFailed = int(input.validationFailed || 0, 'validationFailed');
  if (accepted + failed + validationFailed === 0) throw new Error('at least one counter must be positive');
  const bucketStart = floorBucket(receivedAt);
  const dayStart = floorDay(receivedAt);
  const shardId = randomInt(SHARD_COUNT);
  if (!Number.isInteger(shardId) || shardId < 0 || shardId >= SHARD_COUNT) throw new Error('invalid server shard selection');
  const base = [safePart(clientId), safePart(eventName), safePart(destination)];
  const counters = { accepted, failed, validationFailed };
  const shard = {
    id: [...base, bucketStart.getTime(), shardId].join('_'), clientId, eventName, destination,
    bucketStart, shardId, ...counters, expiresAt: new Date(receivedAt.getTime() + FINE_RETENTION_MS),
  };
  if (input.latencyP50Ms !== undefined) shard.latencyP50Ms = int(input.latencyP50Ms, 'latencyP50Ms', 3600000);
  if (input.latencyP95Ms !== undefined) shard.latencyP95Ms = int(input.latencyP95Ms, 'latencyP95Ms', 3600000);
  const daily = {
    id: [...base, dayStart.getTime()].join('_'), clientId, eventName, destination, dayStart,
    ...counters, updatedAt: receivedAt,
  };
  return { shard, daily };
}

function buildFailureSample(clientId, input, receivedAt = new Date()) {
  const reasonCode = dimension(input.reasonCode, 'reasonCode');
  if (!Object.hasOwn(REASON_SUMMARIES, reasonCode)) throw new Error('reasonCode is not allowed');
  const out = {
    clientId,
    eventId: optionalText(input.eventId, 'eventId', 128),
    eventName: dimension(input.eventName, 'eventName'),
    destination: dimension(input.destination, 'destination'),
    reasonCode,
    reasonSummary: REASON_SUMMARIES[reasonCode],
    httpStatus: input.httpStatus === undefined ? undefined : int(input.httpStatus, 'httpStatus', 599),
    schemaVersion: optionalText(input.schemaVersion, 'schemaVersion', 64),
    containerVersion: optionalText(input.containerVersion, 'containerVersion', 128),
    // This is the server-received timestamp used by both caps; callers cannot
    // backdate a sample to bypass either bound.
    receivedAt,
    attemptedAt: optionalDate(input.attemptedAt, 'attemptedAt'),
    failedAt: optionalDate(input.failedAt, 'failedAt'),
    attemptCount: input.attemptCount === undefined ? undefined : int(input.attemptCount, 'attemptCount', 1000),
    payloadSizeBytes: input.payloadSizeBytes === undefined ? undefined : int(input.payloadSizeBytes, 'payloadSizeBytes', 10485760),
    retryState: input.retryState === undefined ? undefined : input.retryState,
    expiresAt: new Date(receivedAt.getTime() + SAMPLE_RETENTION_MS),
  };
  if (out.retryState !== undefined && !RETRY_STATES.has(out.retryState)) throw new Error('retryState is invalid');
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function create(adapter, options = {}) {
  const randomInt = options.randomInt || (n => crypto.randomInt(n));
  const now = options.now || (() => new Date());
  const debugSampleRate = boundedRate(options.debugSampleRate);
  const debugRetentionDays = boundedRetentionDays(options.debugRetentionDays);
  return {
    async ingestTelemetry(clientId, body) {
      const receivedAt = now();
      const reports = Array.isArray(body && body.reports) ? body.reports : [body];
      if (!reports.length || reports.length > 100) throw new Error('reports must contain 1-100 items');
      const writes = reports.map(report => buildAggregateWrite(clientId, report || {}, receivedAt, randomInt));
      for (const write of writes) await adapter.incrementAggregate(write.shard, write.daily);
      return { ok: true, reports: writes.length };
    },
    async ingestFailure(clientId, body) {
      const receivedAt = now();
      const sample = buildFailureSample(clientId, body || {}, receivedAt);
      // These independent caps bound both an AUTH_ERROR/token-rotation storm for one
      // reason and a many-reason tenant-wide outage. Aggregate writes are separate.
      const reasonSince = new Date(receivedAt.getTime() - REASON_WINDOW_MS);
      const dayStart = floorDay(receivedAt);
      const allowed = await adapter.reserveFailureSample(sample, {
        reasonSince, dayStart, reasonCap: REASON_CAP, dailyCap: DAILY_CLIENT_CAP,
      });
      return { ok: true, sampled: !!allowed, ...(allowed ? { id: allowed } : {}) };
    },
    async ingestDebugSample(clientId, body) {
      // Debug sampling is deliberately fail-open: malformed diagnostic input,
      // validation errors, cap checks, and storage failures never escape this
      // independent telemetry path or affect destination forwarding.
      try {
        if (!body || body.eventName !== 'purchase' || body.intendedDestination !== 'ga4') {
          return { ok: true, sampled: false, reason: 'unsupported_scope' };
        }
        const decision = deterministicDebugDecision(clientId, body, debugSampleRate);
        if (!decision.selected) return { ok: true, sampled: false, reason: 'rate' };
        const receivedAt = now();
        const sample = buildDebugSample(clientId, body, receivedAt, {
          digest: decision.digest,
          retentionDays: debugRetentionDays,
        });
        const id = await adapter.reserveDebugSample(sample, {
          dayStart: floorDay(receivedAt),
          dailyTenantCap: DEBUG_DAILY_TENANT_CAP,
          dailyDimensionCap: DEBUG_DAILY_DIMENSION_CAP,
        });
        return id
          ? { ok: true, sampled: true, sampleId: id }
          : { ok: true, sampled: false, reason: 'cap' };
      } catch (_) {
        return { ok: true, sampled: false, reason: 'sampling_error' };
      }
    },
  };
}

module.exports = {
  BUCKET_MS, SHARD_COUNT, REASON_CAP, DAILY_CLIENT_CAP, DAILY_RETENTION_MS,
  REASON_SUMMARIES, floorBucket, floorDay, buildAggregateWrite, buildFailureSample, create,
  DEBUG_DEFAULT_RETENTION_DAYS, DEBUG_MAX_RETENTION_DAYS, DEBUG_DAILY_TENANT_CAP,
  DEBUG_DAILY_DIMENSION_CAP, DEBUG_DEFAULT_SAMPLE_RATE, DEBUG_REQUIRED_FIELDS,
  DEBUG_OPTIONAL_FIELDS, boundedRate, boundedRetentionDays, deterministicDebugDecision,
  buildDebugSample,
};
