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

test('shell observability UI exposes only aggregate Level 1 fields and no Event Details', () => {
  for (const required of [
    'Event name', 'Intended destination', 'Container ingestions', 'Last observed',
    'Days with events', 'Days without events', 'Telemetry enabled', 'Client '
  ]) assert.match(source, new RegExp(required));

  assert.doesNotMatch(source, /createEventDetails|mountEventDetails|event replay|raw payload/i);
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
