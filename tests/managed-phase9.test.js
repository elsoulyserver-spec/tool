// tests/managed-phase9.test.js
// Focused structural tests for Phase 9 server.js wiring.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Phase 9 imports the provision create-server entry and runner only as thin wiring', () => {
  assert.match(source, /require\('\.\/lib\/provision\/create-server'\)/);
  assert.match(source, /require\('\.\/lib\/provision\/runner'\)/);
  assert.match(source, /require\('\.\/lib\/shard-registry'\)/);
});

test('Phase 9 dispatches managed_server jobs to the Phase 7 runner', () => {
  assert.match(source, /jobType === 'managed_server'\s*\?\s*managedProvisionRunner\.run/);
  assert.match(source, /rawJobType === 'ss' \|\| rawJobType === 'managed_server'/);
  assert.match(source, /else if \(jobType === 'managed_server'\) await managedProvisionRunner\.run\(jobId\)/);
});

test('Phase 9 exposes thin managed server endpoints', () => {
  assert.match(source, /POST \/api\/managed\/create-server/);
  assert.match(source, /req\.method === 'POST' && req\.url === '\/api\/managed\/create-server'/);
  assert.match(source, /GET \/api\/managed\/server/);
  assert.match(source, /req\.method === 'GET' && req\.url === '\/api\/managed\/server'/);
  assert.match(source, /managedCreateServer\.createServer/);
  assert.match(source, /_requireManagedEntitlement\(decoded\)/);
});

test('Phase 9 managed server response is customer-safe', () => {
  const fn = source.match(/function _publicManagedServer\(server\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '_publicManagedServer helper must exist');
  const body = fn[0];
  assert.match(body, /publicServerUrl/);
  assert.match(body, /previewPublicUrl/);
  assert.doesNotMatch(body, /containerConfig/);
  assert.doesNotMatch(body, /taggingRunUrl/);
  assert.doesNotMatch(body, /previewRunUrl/);
  assert.doesNotMatch(body, /CONTAINER_CONFIG/);
  assert.doesNotMatch(body, /run\.app/);
});

test('Phase 9 managed_server job polling is customer-safe', () => {
  const fn = source.match(/function _publicManagedServerJob\(job\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '_publicManagedServerJob helper must exist');
  const body = fn[0];
  assert.match(body, /publicServerUrl/);
  assert.match(body, /previewPublicUrl/);
  assert.doesNotMatch(body, /input/);
  assert.doesNotMatch(body, /serverConfigJson/);
  assert.doesNotMatch(body, /containerConfig/);
  assert.doesNotMatch(body, /taggingRunUrl/);
  assert.doesNotMatch(body, /previewRunUrl/);
  assert.doesNotMatch(body, /CONTAINER_CONFIG/);
  assert.doesNotMatch(body, /run\.app/);
  assert.match(source, /if \(job\.jobType === 'managed_server'\) \{\s*return sendJSON\(res, 200, \{ ok: true, jobId, \.\.\._publicManagedServerJob\(job\) \}\);/);
});

test('Phase 9 reroutes legacy client_server only behind MANAGED_DEPLOY_PROVIDER=cloudrun', () => {
  assert.match(source, /function _managedProviderIsCloudRun\(\)/);
  assert.match(source, /MANAGED_DEPLOY_PROVIDER/);
  assert.match(source, /mode === 'client_server' && _managedProviderIsCloudRun\(\)/);
  assert.match(source, /rerouted:\s*true/);
});
