// tests/verify-gcp.test.js
// Focused tests for the read-only production launch gate.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package.json exposes npm run verify:gcp', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify:gcp'], 'node scripts/verify-gcp.js');
});

test('verify-gcp exports helper functions for focused tests', () => {
  const verifier = require('../scripts/verify-gcp');
  assert.equal(typeof verifier.runChecks, 'function');
  assert.equal(typeof verifier.print, 'function');
  assert.equal(typeof verifier.parseShards, 'function');
  assert.equal(typeof verifier.indexSignature, 'function');
});

test('indexSignature normalizes Firestore index definitions', () => {
  const { indexSignature } = require('../scripts/verify-gcp');
  const sig = indexSignature({
    collectionGroup: 'managed_servers',
    fields: [
      { fieldPath: 'clientId', order: 'ASCENDING' },
      { fieldPath: 'status' },
    ],
  });
  assert.equal(sig, JSON.stringify({
    collectionGroup: 'managed_servers',
    fields: [
      { fieldPath: 'clientId', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
    ],
  }));
});

test('print returns failure only when missing checks exist', () => {
  const { print } = require('../scripts/verify-gcp');
  const oldLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    assert.equal(print([
      { group: 'A', status: 'ready', name: 'Ready check', detail: 'ok' },
      { group: 'B', status: 'warning', name: 'Warning check', detail: 'warn', fix: 'inspect' },
    ]), 0);
    assert.equal(print([
      { group: 'C', status: 'missing', name: 'Missing check', detail: 'nope', fix: 'set env' },
    ]), 1);
  } finally {
    console.log = oldLog;
  }
  assert.ok(lines.some(line => line.includes('Launch gate: PASSED WITH WARNINGS')));
  assert.ok(lines.some(line => line.includes('Launch gate: FAILED')));
});

test('verify-gcp script does not contain resource-creating API calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-gcp.js'), 'utf8');
  assert.doesNotMatch(source, /createService\s*\(/);
  assert.doesNotMatch(source, /deleteService\s*\(/);
  assert.doesNotMatch(source, /setPublicInvoker\s*\(/);
  assert.doesNotMatch(source, /versions:import/);
  assert.doesNotMatch(source, /\/services\?serviceId=/);
  assert.doesNotMatch(source, /method:\s*'DELETE'/);
});
