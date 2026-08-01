// tests/provision-steps.test.js
// Unit tests for each lib/provision/steps/* module in isolation.
//
// Coverage per step:
//   create-gtm    — reuse/fallback/provision/CONFIG_NOT_READY/hash
//   deploy-preview  — idempotent skip + delegation
//   deploy-cloudrun — idempotent skip + delegation
//   health-check  — MISSING_TAGGING_RUN_URL + waitHealthy args
//   publish-route — saveManagedRoute + wildcard health poll
//   wire-transport — skip/no-webcontainer/setGA4TransportUrl with wildcard URL
//   finalize      — merge ss_config + containerConfig:null + active patch
//
// Run: node --test tests/provision-steps.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');
const crypto   = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const key  = (rel) => require.resolve(path.join(ROOT, rel));

// ── Mock factories ────────────────────────────────────────────────────────────

function makeMockGtm(overrides = {}) {
  return {
    provisionServerOnly: async () => ({
      containerId:     'CTR-001',
      publicId:        'GTM-SRV',
      workspaceId:     'WS-1',
      versionId:       'V-1',
      containerConfig: 'CONTAINER_CONFIG_TEST_VALUE',
    }),
    getContainerConfig: async () => 'CONTAINER_CONFIG_TEST_VALUE',
    getAccountId:       ()          => 'ACC-1',
    setGA4TransportUrl: async ()    => ({ tagId: 'TAG-1', versionId: 'V-2' }),
    ...overrides,
  };
}

function makeMockFirestore(overrides = {}) {
  return {
    getSSConfig:      async ()  => null,
    saveSSConfig:     async ()  => {},
    saveManagedRoute: async ()  => {},
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    clientId:        'client-test',
    email:           'test@test.com',
    slug:            'aabbccdd1122',
    publicServerUrl: 'https://aabbccdd1122.sgtm.easytrac.io',
    previewPublicUrl:'https://aabbccdd1122-preview.sgtm.easytrac.io',
    job:             {},
    server:          {},
    secrets:         { containerConfig: null },
    provider: {
      deployPreview: async () => ({ previewServiceName: 'sgtm-aabbccdd1122-prev', previewRunUrl: 'https://preview.run.app' }),
      deployTagging: async () => ({ taggingServiceName: 'sgtm-aabbccdd1122-tag',  taggingRunUrl:  'https://tagging.run.app' }),
      waitHealthy:   async () => {},
    },
    onTick:      async () => {},
    currentStep: null,
    ...overrides,
  };
}

function loadStep(stepName, gtm, fs) {
  const gtmKey  = key('gtm-service');
  const fsKey   = key('firestore-service');
  const stepKey = key(`lib/provision/steps/${stepName}`);

  // Always inject both mocks before requiring the step to avoid loading real modules
  require.cache[gtmKey]  = { id: gtmKey,  filename: gtmKey,  exports: gtm || makeMockGtm() };
  require.cache[fsKey]   = { id: fsKey,   filename: fsKey,   exports: fs  || makeMockFirestore() };
  delete require.cache[stepKey];

  return require(stepKey);
}

// ══════════════════════════════════════════════════════════════════════════════
// create-gtm
// ══════════════════════════════════════════════════════════════════════════════

test('create-gtm: reuses existing containerId and calls getContainerConfig', async () => {
  let getConfigCalled = 0;
  const step = loadStep('create-gtm', makeMockGtm({
    getContainerConfig: async () => { getConfigCalled++; return 'CFG'; },
  }));

  const ctx = makeCtx({ server: { gtmServerContainerId: 'CTR-EXISTING' } });
  const patch = await step.run(ctx);

  assert.equal(patch.gtmServerContainerId, 'CTR-EXISTING');
  assert.equal(getConfigCalled, 1, 'getContainerConfig called once');
  assert.equal(ctx.secrets.containerConfig, 'CFG');
  assert.ok(patch.containerConfigHash, 'containerConfigHash must be set');
  assert.ok(!('containerConfig' in patch), 'containerConfig must NOT appear in the returned patch');
});

test('create-gtm: falls back to ss_configs serverContainerId when server has none', async () => {
  let provisionCalled = false;
  const step = loadStep(
    'create-gtm',
    makeMockGtm({
      provisionServerOnly: async () => { provisionCalled = true; return {}; },
      getContainerConfig: async () => 'CFG-SS',
    }),
    makeMockFirestore({ getSSConfig: async () => ({ serverContainerId: 'CTR-SS', serverPublicId: 'GTM-SS' }) }),
  );

  const ctx = makeCtx({ server: {} });
  const patch = await step.run(ctx);

  assert.equal(patch.gtmServerContainerId, 'CTR-SS');
  assert.equal(provisionCalled, false, 'provisionServerOnly must not be called');
  assert.equal(ctx.secrets.containerConfig, 'CFG-SS');
});

test('create-gtm: provisions new server when no IDs exist anywhere', async () => {
  const step = loadStep('create-gtm', makeMockGtm(), makeMockFirestore());
  const ctx = makeCtx({ server: {} });
  const patch = await step.run(ctx);

  assert.equal(patch.gtmServerContainerId, 'CTR-001');
  assert.equal(ctx.secrets.containerConfig, 'CONTAINER_CONFIG_TEST_VALUE');
  assert.ok(patch.containerConfigHash);
});

test('create-gtm: throws CONFIG_NOT_READY when getContainerConfig returns null', async () => {
  const step = loadStep('create-gtm', makeMockGtm({ getContainerConfig: async () => null }));
  const ctx  = makeCtx({ server: { gtmServerContainerId: 'CTR-X' } });

  await assert.rejects(
    () => step.run(ctx),
    (err) => { assert.equal(err.code, 'CONFIG_NOT_READY'); return true; },
  );
});

test('create-gtm: containerConfigHash is sha256 of the config value', async () => {
  const cfg  = 'MY_TEST_CONFIG';
  const step = loadStep('create-gtm', makeMockGtm({ getContainerConfig: async () => cfg }));
  const ctx  = makeCtx({ server: { gtmServerContainerId: 'CTR-X' } });

  const patch = await step.run(ctx);
  const expected = crypto.createHash('sha256').update(cfg).digest('hex');
  assert.equal(patch.containerConfigHash, expected);
});

// ══════════════════════════════════════════════════════════════════════════════
// deploy-preview
// ══════════════════════════════════════════════════════════════════════════════

test('deploy-preview: returns {} and skips when already deployed', async () => {
  const step = loadStep('deploy-preview');
  let called = false;
  const ctx = makeCtx({
    server:   { previewServiceName: 'sgtm-x-prev', previewRunUrl: 'https://p.run.app' },
    provider: { deployPreview: async () => { called = true; return {}; } },
  });

  const patch = await step.run(ctx);
  assert.deepEqual(patch, {}, 'must return empty patch');
  assert.equal(called, false, 'deployPreview must not be called');
});

test('deploy-preview: delegates to ctx.provider.deployPreview and returns its result', async () => {
  const step    = loadStep('deploy-preview');
  const expected = { previewServiceName: 'sgtm-aabb-prev', previewRunUrl: 'https://p.run.app' };
  let receivedCtx;
  const ctx = makeCtx({
    server:   {},
    provider: { deployPreview: async (c) => { receivedCtx = c; return expected; } },
  });

  const patch = await step.run(ctx);
  assert.deepEqual(patch, expected);
  assert.strictEqual(receivedCtx, ctx, 'must pass full ctx to provider');
});

// ══════════════════════════════════════════════════════════════════════════════
// deploy-cloudrun
// ══════════════════════════════════════════════════════════════════════════════

test('deploy-cloudrun: returns {} and skips when already deployed', async () => {
  const step = loadStep('deploy-cloudrun');
  let called = false;
  const ctx  = makeCtx({
    server:   { taggingServiceName: 'sgtm-x-tag', taggingRunUrl: 'https://t.run.app' },
    provider: { deployTagging: async () => { called = true; return {}; } },
  });

  const patch = await step.run(ctx);
  assert.deepEqual(patch, {});
  assert.equal(called, false, 'deployTagging must not be called');
});

test('deploy-cloudrun: delegates to ctx.provider.deployTagging and returns its result', async () => {
  const step    = loadStep('deploy-cloudrun');
  const expected = { taggingServiceName: 'sgtm-aabb-tag', taggingRunUrl: 'https://t.run.app' };
  const ctx     = makeCtx({ server: {}, provider: { deployTagging: async () => expected } });

  const patch = await step.run(ctx);
  assert.deepEqual(patch, expected);
});

// ══════════════════════════════════════════════════════════════════════════════
// health-check
// ══════════════════════════════════════════════════════════════════════════════

test('health-check: throws MISSING_TAGGING_RUN_URL when taggingRunUrl is not set', async () => {
  const step = loadStep('health-check');
  const ctx  = makeCtx({ server: {} });

  await assert.rejects(
    () => step.run(ctx),
    (err) => { assert.equal(err.code, 'MISSING_TAGGING_RUN_URL'); return true; },
  );
});

test('health-check: calls waitHealthy with taggingRunUrl and 5-min timeout, returns healthCheckedAt', async () => {
  const step = loadStep('health-check');
  let calledUrl, calledOpts;
  const ctx = makeCtx({
    server:   { taggingRunUrl: 'https://tagging.run.app' },
    provider: { waitHealthy: async (url, opts) => { calledUrl = url; calledOpts = opts; } },
  });

  const patch = await step.run(ctx);
  assert.equal(calledUrl, 'https://tagging.run.app');
  assert.equal(calledOpts.timeoutMs, 5 * 60 * 1000);
  assert.ok(patch.healthCheckedAt, 'healthCheckedAt must be returned');
  assert.ok(!isNaN(new Date(patch.healthCheckedAt).getTime()), 'healthCheckedAt must be a valid ISO date');
});

// ══════════════════════════════════════════════════════════════════════════════
// publish-route
// ══════════════════════════════════════════════════════════════════════════════

test('publish-route: saves managed route then polls wildcard URL (not run.app)', async () => {
  let savedRoute, polledUrl;

  const fs = makeMockFirestore({
    saveManagedRoute: async (doc) => { savedRoute = doc; },
  });
  const step = loadStep('publish-route', null, fs);
  const ctx  = makeCtx({
    server:   { taggingRunUrl: 'https://tagging.run.app', previewRunUrl: 'https://preview.run.app' },
    provider: { waitHealthy: async (url) => { polledUrl = url; } },
  });

  const patch = await step.run(ctx);

  assert.ok(savedRoute, 'saveManagedRoute must be called');
  assert.equal(savedRoute.hostname, ctx.slug, 'hostname must be slug');
  assert.equal(savedRoute.clientId, ctx.clientId);
  assert.equal(savedRoute.taggingRunUrl, 'https://tagging.run.app');
  assert.equal(savedRoute.status, 'active');

  assert.equal(polledUrl, ctx.publicServerUrl, 'must poll wildcard domain');
  assert.ok(!polledUrl.includes('run.app'), 'must NOT poll run.app URL');

  assert.equal(patch.routePublished, true);
  assert.equal(patch.publicServerUrl, ctx.publicServerUrl);
  assert.equal(patch.previewPublicUrl, ctx.previewPublicUrl);
});

// ══════════════════════════════════════════════════════════════════════════════
// wire-transport
// ══════════════════════════════════════════════════════════════════════════════

test('wire-transport: returns {} and skips when transportWired is already true', async () => {
  let called = false;
  const gtm  = makeMockGtm({ setGA4TransportUrl: async () => { called = true; return {}; } });
  const step = loadStep('wire-transport', gtm);
  const ctx  = makeCtx({ server: { transportWired: true } });

  const patch = await step.run(ctx);
  assert.deepEqual(patch, {});
  assert.equal(called, false);
});

test('wire-transport: returns transportWireSkipped=true when no webContainerId', async () => {
  const step = loadStep('wire-transport', makeMockGtm());
  const ctx  = makeCtx({ server: {}, job: {} });

  const patch = await step.run(ctx);
  assert.equal(patch.transportWired, false);
  assert.equal(patch.transportWireSkipped, true);
});

test('wire-transport: calls setGA4TransportUrl with wildcard publicServerUrl (not run.app)', async () => {
  let calledArgs;
  const gtm = makeMockGtm({
    setGA4TransportUrl: async (webId, wsId, url) => {
      calledArgs = { webId, wsId, url };
      return { tagId: 'T', versionId: 'V' };
    },
  });
  const step = loadStep('wire-transport', gtm);
  const ctx  = makeCtx({
    server:          { webContainerId: 'WEB-1', webWorkspaceId: 'WS-WEB-1' },
    publicServerUrl: 'https://aabbccdd1122.sgtm.easytrac.io',
  });

  const patch = await step.run(ctx);

  assert.equal(calledArgs.webId, 'WEB-1');
  assert.equal(calledArgs.wsId, 'WS-WEB-1');
  assert.equal(calledArgs.url, 'https://aabbccdd1122.sgtm.easytrac.io');
  assert.ok(!calledArgs.url.includes('run.app'), 'must use wildcard URL, not run.app');
  assert.equal(patch.transportWired, true);
  assert.equal(patch.transportUrlWired, true);
  assert.deepEqual(patch.transportWireResult, { tagId: 'T', versionId: 'V' });
});

// ══════════════════════════════════════════════════════════════════════════════
// finalize
// ══════════════════════════════════════════════════════════════════════════════

test('finalize: merges existing ss_config and sets containerConfig:null', async () => {
  let savedConfig;
  const fs = makeMockFirestore({
    getSSConfig:  async () => ({ existing: 'value', serverContainerId: 'CTR-1' }),
    saveSSConfig: async (clientId, cfg) => { savedConfig = cfg; },
  });
  const step = loadStep('finalize', null, fs);
  const ctx  = makeCtx({ server: { gtmServerContainerId: 'CTR-1', transportWired: true } });

  await step.run(ctx);

  assert.equal(savedConfig.provider, 'gcloud-managed');
  assert.equal(savedConfig.serverUrl, ctx.publicServerUrl);
  assert.strictEqual(savedConfig.containerConfig, null, 'containerConfig must be explicitly nulled');
  assert.equal(savedConfig.existing, 'value', 'existing ss_config fields must be preserved');
});

test('finalize: returns status=active, wildcard URLs, currentStep, and activatedAt', async () => {
  const fs = makeMockFirestore({
    getSSConfig:  async () => ({}),
    saveSSConfig: async () => {},
  });
  const step = loadStep('finalize', null, fs);
  const ctx  = makeCtx({ server: {} });

  const patch = await step.run(ctx);

  assert.equal(patch.status, 'active');
  assert.equal(patch.currentStep, 'finalize');
  assert.ok(patch.activatedAt, 'activatedAt must be set');
  assert.equal(patch.publicServerUrl, ctx.publicServerUrl);
  assert.equal(patch.previewPublicUrl, ctx.previewPublicUrl);
});
