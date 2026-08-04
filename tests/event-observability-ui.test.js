'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app-shell-bootstrap.js'), 'utf8');

function shellFunctions() {
  const context = vm.createContext({
    URL,
    console,
    localStorage: { getItem: () => null, setItem() {} },
    history: { replaceState() {}, state: null },
    window: { location: { href: 'http://localhost/tool' } },
  });
  vm.runInContext(source, context);
  return {
    eventTimestampMillis: vm.runInContext('eventTimestampMillis', context),
    buildContinuityModel: vm.runInContext('buildContinuityModel', context),
    buildEventDetailsModel: vm.runInContext('buildEventDetailsModel', context),
  };
}

test('serialized Firestore timestamps remain usable for last-observed evidence', () => {
  const { eventTimestampMillis } = shellFunctions();
  assert.equal(eventTimestampMillis({ _seconds: 1_700_000_000, _nanoseconds: 123_000_000 }), 1_700_000_000_123);
  assert.equal(eventTimestampMillis({ seconds: 1_700_000_001, nanoseconds: 0 }), 1_700_000_001_000);
});

test('Level 1 model uses daily aggregates once and explicitly fills no-event days', () => {
  const { buildContinuityModel } = shellFunctions();
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterday = today - 86400000;
  const model = buildContinuityModel({
    rows: [{
      eventName: 'purchase', destination: 'ga4', accepted: 7,
      dayStart: { _seconds: yesterday / 1000, _nanoseconds: 0 },
      updatedAt: { _seconds: (yesterday + 3600000) / 1000, _nanoseconds: 0 },
    }],
    live: [{
      eventName: 'purchase', destination: 'ga4', accepted: 7,
      bucketStart: { _seconds: (yesterday + 1800000) / 1000, _nanoseconds: 0 },
    }],
  }, 3);

  assert.equal(model.total, 7, 'live shard count must not double-count the daily aggregate');
  assert.equal(model.trend.length, 3);
  assert.equal(model.daysWithEvents, 1);
  assert.equal(model.daysWithoutEvents, 2);
  assert.deepEqual(Array.from(model.dimensions, row => [row.eventName, row.destination, row.count]), [['purchase', 'ga4', 7]]);
});

test('shell observability UI keeps Level 1 aggregate fields and delivery disclaimer unchanged', () => {
  for (const required of [
    'Event name', 'Intended destination', 'Container ingestions', 'Last observed',
    'Days with events', 'Days without events', 'Telemetry enabled', 'Client '
  ]) assert.match(source, new RegExp(required));

  assert.match(source, /does not confirm destination delivery/i);
});

test('Events Explorer has disabled, empty, error, loading, and aggregate-data render paths', () => {
  for (const state of ["result.kind === 'disabled'", "result.kind === 'error'", "result.kind === 'empty'", "result.kind === 'ok'"]) {
    if (state.endsWith("'ok'")) assert.match(source, /const model = result\.model/);
    else assert.ok(source.includes(state), 'missing state path: ' + state);
  }
  assert.match(source, /Loading aggregate container telemetry/);
  assert.match(source, /data\.telemetryEnabled === true/, 'enabled state must come from server metadata');
});

test('Event Details exposes loading, disabled, unauthorized, empty, error, and not-found states', () => {
  for (const required of [
    'Loading debug sample…',
    'Debug sampling telemetry is disabled.',
    'You are not authorized to view this debug sample.',
    'No debug sample is available.',
    'Unexpected error while loading the debug sample.',
    'Sample not found.'
  ]) assert.ok(source.includes(required), 'missing Event Details state: ' + required);
  assert.match(source, /response\.status === 503/);
  assert.match(source, /response\.status === 401 \|\| response\.status === 403/);
  assert.match(source, /response\.status === 404/);
});

test('Event Details renders only real sample stages and the permanent platform disclaimer', () => {
  const { buildEventDetailsModel } = shellFunctions();
  const model = buildEventDetailsModel({
    sampleId: 'a'.repeat(32),
    eventName: 'purchase',
    intendedDestination: 'ga4',
    receivedAt: { _seconds: 1_700_000_000, _nanoseconds: 0 },
    containerVersion: 'v42',
    schemaVersion: '1',
    ingestionAccepted: true,
    processingTimeMs: 17,
    validation: { passed: true, missingRequiredFields: [], optionalFieldsPresent: ['coupon'], invalidFieldNames: [] },
    metadata: { cms: 'salla', environment: 'synthetic', platform: 'ga4' },
  });

  assert.deepEqual(Array.from(model.timeline, step => step.title), [
    '✓ Received', '✓ Validated', '✓ Accepted by EasyTrac', '✓ Stored as Debug Sample'
  ]);
  assert.ok(source.includes('This screen describes what EasyTrac received inside the server container.'));
  assert.ok(source.includes('It does not confirm whether any advertising or analytics platform accepted the event.'));
  const rendered = JSON.stringify(model);
  assert.doesNotMatch(rendered, /Delivered|Accepted by GA4|Rejected by Meta|Success|Failed Delivery|Match Rate/i);
});

test('Event Details validation and metadata use field names and approved diagnostic metadata only', () => {
  const { buildEventDetailsModel } = shellFunctions();
  const model = buildEventDetailsModel({
    sampleId: 'b'.repeat(32),
    eventName: 'purchase', intendedDestination: 'ga4', receivedAt: '2026-08-04T10:00:00.000Z',
    containerVersion: 'v7', schemaVersion: '2', ingestionAccepted: true, processingTimeMs: 23,
    validation: {
      passed: false,
      missingRequiredFields: ['items'],
      optionalFieldsPresent: ['coupon', 'email'],
      invalidFieldNames: ['currency', 'phone'],
    },
    metadata: { cms: 'zid', environment: 'test', platform: 'ga4' },
    rawPayload: { email: 'person@example.com' },
    headers: { cookie: 'secret' },
    responseCode: 204,
    httpStatus: 204,
  });

  assert.deepEqual(Array.from(model.validation, row => [row.group, row.field, row.state]), [
    ['Required Fields', 'transaction_id', '✓ Present'],
    ['Required Fields', 'currency', '✓ Present'],
    ['Required Fields', 'value', '✓ Present'],
    ['Required Fields', 'items', 'Missing'],
    ['Optional Fields Present', 'coupon', '✓ Present'],
    ['Invalid Fields', 'currency', 'Invalid'],
  ]);
  assert.deepEqual(Array.from(model.metadata, row => row[0]), [
    'Container Version', 'Schema Version', 'Processing Time', 'CMS', 'Environment', 'Platform'
  ]);
  const rendered = JSON.stringify(model);
  assert.doesNotMatch(rendered, /person@example\.com|cookie|secret|rawPayload|responseCode|httpStatus|204/);
  assert.doesNotMatch(source, /Missing Optional/);
});

test('Debug Sample navigation uses only owner-scoped endpoints and no client override', () => {
  assert.match(source, /'\/api\/v1\/clients\/' \+ encodeURIComponent\(scope\.clientId\) \+ '\/events\/debug-samples'/);
  assert.doesNotMatch(source, /api\/v1\/admin\/clients.*debug-samples/);
  assert.doesNotMatch(source, /debug-samples.*clientId=/);
  assert.match(source, /Authorization: 'Bearer ' \+ token/);
});
