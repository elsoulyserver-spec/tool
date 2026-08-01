// tests/provision-runner.test.js
// Unit tests for lib/provision/runner.js
//
// Coverage:
//   run()         — missing args, step ordering, patch persistence,
//                   success path (finalize+complete), failure path (mark failed),
//                   log emission
//   sanitizeResult — whitelisted fields only (no containerConfig, no run.app URLs)
//   publicError    — message/code/status extraction
//
// Steps are passed via opts.steps so individual step modules are never called;
// only the runner's orchestration logic is exercised.
//
// Run: node --test tests/provision-runner.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');

const ROOT = path.resolve(__dirname, '..');
const key  = (rel) => require.resolve(path.join(ROOT, rel));

// ── Mock factories ────────────────────────────────────────────────────────────

function makeJob(overrides = {}) {
  return {
    clientId:  'client-test',
    email:     'test@test.com',
    shardId:   'prod-1',
    trigger:   'create-server',
    ...overrides,
  };
}

function makeServer(overrides = {}) {
  return {
    clientId: 'client-test',
    shardId:  'prod-1',
    slug:     'aabbccdd1122',
    status:   'provisioning',
    ...overrides,
  };
}

function makeMockFs(job, initialServer) {
  let currentServer = initialServer ? { ...initialServer } : null;
  const state = {
    saveJobCalls:          [],
    saveManagedServerCalls:[],
    logEntries:            [],
    finalizeCall:          null,
  };

  return {
    getJob:            async ()       => (job ? { ...job } : null),
    getManagedServer:  async ()       => (currentServer ? { ...currentServer } : null),
    createDeployment:  async (doc)    => ({ id: 'dep-test-001', ...doc }),
    saveManagedServer: async (doc)    => {
      state.saveManagedServerCalls.push({ ...doc });
      currentServer = { ...currentServer, ...doc };
    },
    appendDeploymentLog: async (depId, entry) => { state.logEntries.push(entry); },
    saveJob:           async (jobId, data) => { state.saveJobCalls.push({ ...data }); },
    finalizeDeployment:async (depId, data) => { state.finalizeCall = { ...data }; },
    saveAudit:         async ()       => {},
    _state: state,
  };
}

const mockShard    = { id: 'prod-1', gcpProjectId: 'easytrack-proj', region: 'us-central1' };
const mockProvider = { deployPreview: async () => ({}), deployTagging: async () => ({}), waitHealthy: async () => {} };

function loadRunner(mockFs) {
  const fsKey        = key('firestore-service');
  const shardKey     = key('lib/shard-registry');
  const providersKey = key('lib/providers/index');
  const gtmKey       = key('gtm-service');
  const runnerKey    = key('lib/provision/runner');
  const stepsIdxKey  = key('lib/provision/steps/index');
  const stepNames    = ['create-gtm', 'deploy-preview', 'deploy-cloudrun',
    'health-check', 'publish-route', 'wire-transport', 'finalize'];

  // Inject all external mocks so no real cloud / firebase modules are loaded
  require.cache[fsKey] = { id: fsKey, filename: fsKey, exports: mockFs };
  require.cache[shardKey] = {
    id: shardKey, filename: shardKey,
    exports: { getShard: () => ({ ...mockShard }), pickShardForNewTenant: () => ({ ...mockShard }) },
  };
  require.cache[providersKey] = {
    id: providersKey, filename: providersKey,
    exports: { getHostingProvider: () => mockProvider },
  };
  require.cache[gtmKey] = {
    id: gtmKey, filename: gtmKey,
    exports: { provisionServerOnly: async () => {}, getContainerConfig: async () => null, setGA4TransportUrl: async () => {} },
  };

  // Clear step modules so they pick up fresh mocks when steps/index.js loads
  for (const name of stepNames) {
    try { delete require.cache[key(`lib/provision/steps/${name}`)]; } catch (_) {}
  }
  try { delete require.cache[stepsIdxKey]; } catch (_) {}
  delete require.cache[runnerKey];

  return require(runnerKey);
}

// ══════════════════════════════════════════════════════════════════════════════
// run() — argument validation
// ══════════════════════════════════════════════════════════════════════════════

test('runner.run: throws when jobId is missing', async () => {
  const { run } = loadRunner(makeMockFs(makeJob(), makeServer()));
  await assert.rejects(
    () => run(undefined, { provider: mockProvider, shard: mockShard }),
    /jobId is required/,
  );
});

test('runner.run: throws JOB_NOT_FOUND when job does not exist', async () => {
  const { run } = loadRunner(makeMockFs(null, makeServer()));
  await assert.rejects(
    () => run('missing-job', { provider: mockProvider, shard: mockShard }),
    (err) => { assert.equal(err.code, 'JOB_NOT_FOUND'); return true; },
  );
});

test('runner.run: throws when managed server is not found', async () => {
  const { run } = loadRunner(makeMockFs(makeJob(), null));
  await assert.rejects(
    () => run('job-1', { provider: mockProvider, shard: mockShard }),
    /not found for client/,
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// run() — step orchestration
// ══════════════════════════════════════════════════════════════════════════════

test('runner.run: executes provided steps in order', async () => {
  const order = [];
  const steps = ['alpha', 'beta', 'gamma'].map((name) => ({
    name,
    run: async () => { order.push(name); return {}; },
  }));

  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);
  await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  assert.deepEqual(order, ['alpha', 'beta', 'gamma']);
});

test('runner.run: persists non-empty patches from each step to managed_servers', async () => {
  const steps = [
    { name: 'step_a', run: async () => ({ gtmServerContainerId: 'CTR-X' }) },
    { name: 'step_b', run: async () => ({ taggingRunUrl: 'https://t.run.app' }) },
  ];

  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);
  await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  const saves = mockFs._state.saveManagedServerCalls;
  assert.ok(saves.some((s) => s.gtmServerContainerId === 'CTR-X'),    'step_a patch must be persisted');
  assert.ok(saves.some((s) => s.taggingRunUrl === 'https://t.run.app'), 'step_b patch must be persisted');
});

test('runner.run: saves job stage for each step', async () => {
  const steps = [
    { name: 'setup_step', run: async () => ({}) },
    { name: 'work_step',  run: async () => ({}) },
  ];

  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);
  await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  const stages = mockFs._state.saveJobCalls.map((c) => c.stage);
  assert.ok(stages.includes('setup_step'), 'setup_step stage must be saved');
  assert.ok(stages.includes('work_step'),  'work_step stage must be saved');
});

// ══════════════════════════════════════════════════════════════════════════════
// run() — success path
// ══════════════════════════════════════════════════════════════════════════════

test('runner.run: finalizes deployment as succeeded on success', async () => {
  const steps  = [{ name: 'ok', run: async () => ({}) }];
  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);

  await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  assert.equal(mockFs._state.finalizeCall.status, 'succeeded');
});

test('runner.run: saves job as completed with sanitized result on success', async () => {
  const steps = [{
    name: 'step',
    run:  async (ctx) => {
      ctx.secrets.containerConfig = 'SECRET_VALUE';
      return { publicServerUrl: 'https://x.sgtm.easytrac.io', gtmServerPublicId: 'GTM-PUB' };
    },
  }];

  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);
  await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  const completed = mockFs._state.saveJobCalls.find((c) => c.status === 'completed');
  assert.ok(completed, 'job must be saved as completed');
  assert.equal(completed.result.ok, true);
  assert.ok(!completed.result.containerConfig, 'result must not expose containerConfig');
});

test('runner.run: returns sanitized result from run() itself', async () => {
  const steps = [{
    name: 'step',
    run:  async (ctx) => {
      ctx.secrets.containerConfig = 'SECRET_VALUE';
      return { publicServerUrl: 'https://x.sgtm.easytrac.io', gtmServerPublicId: 'GTM-PUB', transportWired: true };
    },
  }];

  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);
  const result = await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  assert.equal(result.ok, true);
  assert.ok(!result.containerConfig, 'containerConfig must not be in run() return value');
});

// ══════════════════════════════════════════════════════════════════════════════
// run() — failure path
// ══════════════════════════════════════════════════════════════════════════════

test('runner.run: on step failure marks server failed and finalizes deployment as failed', async () => {
  const stepErr = Object.assign(new Error('deploy failed'), { code: 'CLOUD_RUN_500', status: 500 });
  const steps   = [{ name: 'fail_step', run: async () => { throw stepErr; } }];
  const mockFs  = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);

  await assert.rejects(
    () => run('job-1', { steps, provider: mockProvider, shard: mockShard }),
    /deploy failed/,
  );

  assert.ok(
    mockFs._state.saveManagedServerCalls.some((s) => s.status === 'failed'),
    'server must be saved as failed',
  );
  assert.equal(mockFs._state.finalizeCall.status, 'failed');
  assert.ok(mockFs._state.finalizeCall.errorMessage, 'errorMessage must be set');

  const failedJob = mockFs._state.saveJobCalls.find((c) => c.status === 'failed');
  assert.ok(failedJob, 'job must be saved as failed');
});

// ══════════════════════════════════════════════════════════════════════════════
// run() — logging
// ══════════════════════════════════════════════════════════════════════════════

test('runner.run: logs step start and completion for each step', async () => {
  const steps  = [{ name: 'my_step', run: async () => ({}) }];
  const mockFs = makeMockFs(makeJob(), makeServer());
  const { run } = loadRunner(mockFs);
  await run('job-1', { steps, provider: mockProvider, shard: mockShard });

  const stepLogs = mockFs._state.logEntries.filter((e) => e.step === 'my_step');
  assert.ok(stepLogs.length >= 2, 'must have at least start + completion entries');
  assert.ok(stepLogs.some((e) => e.message.includes('starting')),  'must log start');
  assert.ok(stepLogs.some((e) => e.message.includes('completed')), 'must log completion');
});

// ══════════════════════════════════════════════════════════════════════════════
// sanitizeResult — pure function, no deps on injected mocks
// ══════════════════════════════════════════════════════════════════════════════

test('sanitizeResult: exposes only whitelisted fields; excludes containerConfig and run.app URLs', () => {
  const { sanitizeResult } = require(key('lib/provision/runner'));
  const server = {
    publicServerUrl:  'https://x.sgtm.easytrac.io',
    previewPublicUrl: 'https://x-preview.sgtm.easytrac.io',
    gtmServerPublicId:'GTM-PUB',
    transportWired:   true,
    taggingRunUrl:    'https://t.run.app',   // must NOT appear in result
    containerConfig:  'SECRET',              // must NOT appear in result
  };

  const result = sanitizeResult(server);
  assert.equal(result.ok, true);
  assert.equal(result.publicServerUrl, 'https://x.sgtm.easytrac.io');
  assert.equal(result.gtmServerPublicId, 'GTM-PUB');
  assert.equal(result.transportWired, true);
  assert.ok(!result.taggingRunUrl,   'taggingRunUrl must not be exposed');
  assert.ok(!result.containerConfig, 'containerConfig must not be exposed');
});

// ══════════════════════════════════════════════════════════════════════════════
// publicError — pure function
// ══════════════════════════════════════════════════════════════════════════════

test('publicError: extracts message, code, and status from error', () => {
  const { publicError } = require(key('lib/provision/runner'));
  const err = Object.assign(new Error('something bad'), { code: 'ERR_CODE', status: 503 });
  const out = publicError(err);
  assert.equal(out.message, 'something bad');
  assert.equal(out.code,    'ERR_CODE');
  assert.equal(out.status,  503);
});

test('publicError: returns null code and status when error has neither', () => {
  const { publicError } = require(key('lib/provision/runner'));
  const out = publicError(new Error('plain'));
  assert.equal(out.message, 'plain');
  assert.equal(out.code,    null);
  assert.equal(out.status,  null);
});
