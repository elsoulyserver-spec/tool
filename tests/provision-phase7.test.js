// tests/provision-phase7.test.js
// Focused tests for lib/provision Phase 7 runner, entry, and steps.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const touched = [
  '../lib/provision/create-server',
  '../lib/provision/runner',
  '../lib/provision/context',
  '../lib/provision/steps/create-gtm',
  '../lib/provision/steps/publish-route',
  '../lib/provision/steps/wire-transport',
  '../firestore-service',
  '../lib/shard-registry',
  '../lib/providers',
  '../gtm-service',
];

function clearTouched() {
  for (const id of touched) {
    try { delete require.cache[require.resolve(id)]; } catch (_) {}
  }
}

function inject(id, exports) {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function makeFirestoreState() {
  const state = {
    jobs: new Map(),
    servers: new Map(),
    routes: new Map(),
    deployments: new Map(),
    ss: new Map(),
    audit: [],
    deploymentSeq: 0,
  };
  const api = {
    async createManagedServerJobTx(input) {
      const existing = state.servers.get(input.clientId);
      if (existing && existing.status === 'active') {
        return { outcome: 'reuse', server: existing, publicServerUrl: existing.publicServerUrl };
      }
      const server = {
        ...(existing || {}),
        ...(input.server || {}),
        clientId: input.clientId,
        shardId: input.shardId,
        status: 'provisioning',
        jobId: input.jobId,
      };
      state.servers.set(input.clientId, server);
      state.jobs.set(input.jobId, { ...(input.job || {}), clientId: input.clientId, jobId: input.jobId });
      return { outcome: existing ? 'resume' : 'created', jobId: input.jobId, server };
    },
    async getJob(jobId) { return state.jobs.get(jobId) || null; },
    async saveJob(jobId, patch) {
      state.jobs.set(jobId, { ...(state.jobs.get(jobId) || {}), ...patch, jobId });
    },
    async getManagedServer(clientId) { return state.servers.get(clientId) || null; },
    async saveManagedServer(record) {
      const prev = state.servers.get(record.clientId) || {};
      state.servers.set(record.clientId, { ...prev, ...record });
      return state.servers.get(record.clientId);
    },
    async createDeployment(record) {
      const id = record.deploymentId || `dep-${++state.deploymentSeq}`;
      const dep = { ...record, id, deploymentId: id, logs: record.logs || [] };
      state.deployments.set(id, dep);
      return dep;
    },
    async appendDeploymentLog(id, entry) {
      const dep = state.deployments.get(id);
      dep.logs.push(entry);
      return dep.logs;
    },
    async finalizeDeployment(id, patch) {
      state.deployments.set(id, { ...state.deployments.get(id), ...patch });
      return state.deployments.get(id);
    },
    async saveManagedRoute(record) {
      state.routes.set(record.hostname, record);
      return record;
    },
    async getSSConfig(clientId) { return state.ss.get(clientId) || null; },
    async saveSSConfig(clientId, config) {
      state.ss.set(clientId, { ...config });
      return state.ss.get(clientId);
    },
    async saveAudit(record) {
      state.audit.push(record);
      return `audit-${state.audit.length}`;
    },
    _state: state,
  };
  return api;
}

beforeEach(clearTouched);
afterEach(clearTouched);

test('createServer creates a managed_server job transaction and dispatches new jobs', async () => {
  const firestore = makeFirestoreState();
  inject('../firestore-service', firestore);
  inject('../lib/shard-registry', {
    pickShardForNewTenant: () => ({ id: 'prod-1', gcpProjectId: 'p1', region: 'me-central1' }),
  });

  const { createServer } = require('../lib/provision/create-server');
  const dispatched = [];
  const result = await createServer({
    clientId: 'client-1',
    email: 'owner@example.com',
    jobId: 'job-1',
  }, { dispatch: async id => dispatched.push(id) });

  assert.equal(result.outcome, 'created');
  assert.equal(result.jobId, 'job-1');
  assert.deepEqual(dispatched, ['job-1']);
  assert.equal(firestore._state.servers.get('client-1').shardId, 'prod-1');
  assert.ok(result.publicServerUrl.includes('.sgtm.easytrac.io'));
});

test('runner executes steps in order, persists patches, and never stores containerConfig', async () => {
  const firestore = makeFirestoreState();
  firestore._state.jobs.set('job-1', { jobId: 'job-1', clientId: 'client-1', shardId: 'prod-1', email: 'a@b.com' });
  firestore._state.servers.set('client-1', { clientId: 'client-1', shardId: 'prod-1', status: 'provisioning', slug: 'abc123def456' });
  inject('../firestore-service', firestore);
  inject('../lib/shard-registry', { getShard: () => ({ id: 'prod-1', gcpProjectId: 'p1', region: 'me-central1' }) });
  inject('../lib/providers', { getHostingProvider: () => ({}) });

  const calls = [];
  const steps = [
    { name: 'create_gtm', run: async ctx => { calls.push(ctx.currentStep); ctx.secrets.containerConfig = 'SECRET_CONFIG'; return { gtmServerContainerId: 'srv', containerConfigHash: 'hash' }; } },
    { name: 'deploy_preview', run: async ctx => { calls.push(ctx.currentStep); return { previewRunUrl: 'https://prev.run.app', previewServiceName: 'prev' }; } },
    { name: 'finalize', run: async ctx => { calls.push(ctx.currentStep); return { status: 'active', publicServerUrl: 'https://abc.sgtm.easytrac.io' }; } },
  ];

  const { run } = require('../lib/provision/runner');
  const result = await run('job-1', { steps });

  assert.deepEqual(calls, ['create_gtm', 'deploy_preview', 'finalize']);
  const server = firestore._state.servers.get('client-1');
  assert.equal(server.status, 'active');
  assert.equal(server.containerConfigHash, 'hash');
  assert.equal(server.containerConfig, undefined);
  assert.equal(firestore._state.jobs.get('job-1').status, 'completed');
  assert.equal(result.ok, true);
});

test('runner marks job, deployment, and managed server failed when a step throws', async () => {
  const firestore = makeFirestoreState();
  firestore._state.jobs.set('job-1', { jobId: 'job-1', clientId: 'client-1', shardId: 'prod-1' });
  firestore._state.servers.set('client-1', { clientId: 'client-1', shardId: 'prod-1', status: 'provisioning' });
  inject('../firestore-service', firestore);
  inject('../lib/shard-registry', { getShard: () => ({ id: 'prod-1' }) });
  inject('../lib/providers', { getHostingProvider: () => ({}) });

  const boom = Object.assign(new Error('provider unavailable'), { code: 'EDGE_UNAVAILABLE' });
  const { run } = require('../lib/provision/runner');
  await assert.rejects(
    () => run('job-1', { steps: [{ name: 'publish_route', run: async () => { throw boom; } }] }),
    /provider unavailable/,
  );

  assert.equal(firestore._state.servers.get('client-1').status, 'failed');
  assert.equal(firestore._state.jobs.get('job-1').status, 'failed');
  assert.equal(Array.from(firestore._state.deployments.values())[0].status, 'failed');
});

test('create-gtm step fetches containerConfig into memory and persists only hash/ids', async () => {
  const firestore = makeFirestoreState();
  inject('../firestore-service', firestore);
  inject('../gtm-service', {
    provisionServerOnly: async () => ({
      containerId: 'srv-1',
      publicId: 'GTM-SRV',
      workspaceId: 'ws-1',
      versionId: 'v1',
      containerConfig: 'SECRET_CONTAINER_CONFIG',
    }),
  });

  const step = require('../lib/provision/steps/create-gtm');
  const ctx = {
    clientId: 'client-1',
    email: 'owner@example.com',
    job: {},
    server: {},
    secrets: {},
    onTick: () => {},
  };

  const patch = await step.run(ctx);
  assert.equal(ctx.secrets.containerConfig, 'SECRET_CONTAINER_CONFIG');
  assert.equal(patch.gtmServerContainerId, 'srv-1');
  assert.ok(patch.containerConfigHash);
  assert.equal(patch.containerConfig, undefined);
});

test('publish-route writes managed route and polls the public wildcard URL', async () => {
  const firestore = makeFirestoreState();
  inject('../firestore-service', firestore);
  const seen = [];
  const step = require('../lib/provision/steps/publish-route');
  const patch = await step.run({
    clientId: 'client-1',
    slug: 'abc123def456',
    publicServerUrl: 'https://abc123def456.sgtm.easytrac.io',
    previewPublicUrl: 'https://abc123def456-preview.sgtm.easytrac.io',
    server: {
      taggingRunUrl: 'https://tag.run.app',
      previewRunUrl: 'https://prev.run.app',
    },
    provider: { waitHealthy: async url => seen.push(url) },
    onTick: () => {},
  });

  assert.equal(firestore._state.routes.get('abc123def456').taggingRunUrl, 'https://tag.run.app');
  assert.deepEqual(seen, ['https://abc123def456.sgtm.easytrac.io']);
  assert.equal(patch.routePublished, true);
});
