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
  };
}

module.exports = {
  BUCKET_MS, SHARD_COUNT, REASON_CAP, DAILY_CLIENT_CAP, DAILY_RETENTION_MS,
  REASON_SUMMARIES, floorBucket, floorDay, buildAggregateWrite, buildFailureSample, create,
};
