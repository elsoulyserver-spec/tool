// tests/cloudrun-provider.test.js
// Unit tests for lib/providers/cloudrun.js + index.js + hosting-provider.js + legacy-stape.js
// Run: node --test tests/cloudrun-provider.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Shared test shard ─────────────────────────────────────────────────────────
const SHARD = {
  id:           'prod-1',
  gcpProjectId: 'easytrack-prod-1',
  region:       'me-central1',
  saKeyJson:    '{"client_email":"sa@p.iam.gserviceaccount.com","private_key":"pk"}',
};

// ── Mock CloudRunService ──────────────────────────────────────────────────────
// Injected via the _testOpts.svcInstance escape hatch on CloudRunProvider.
function makeMockSvc(overrides = {}) {
  return {
    createService:    overrides.createService    || (async () => ({ name: 'operations/op-1' })),
    updateService:    overrides.updateService    || (async () => ({})),
    getService:       overrides.getService       || (async (id) => ({ uri: `https://${id}.run.app`, latestReadyRevision: 'rev-1', terminalCondition: { state: 'CONDITION_SUCCEEDED' } })),
    deleteService:    overrides.deleteService    || (async () => ({})),
    waitForOperation: overrides.waitForOperation || (async () => ({})),
    setPublicInvoker: overrides.setPublicInvoker || (async () => ({})),
    pollHealthy:      overrides.pollHealthy      || (async () => ({ ok: true, url: 'https://svc.run.app/healthy' })),
  };
}

// ── ProvisionContext stub ─────────────────────────────────────────────────────
function makeCtx(overrides = {}) {
  return {
    slug:           overrides.slug           || 'abc123def456',
    previewPublicUrl: overrides.previewPublicUrl || 'https://abc123def456-preview.sgtm.easytrac.io',
    secrets:        overrides.secrets        || { containerConfig: 'FAKE_CONFIG_JSON' },
    onTick:         overrides.onTick         || (() => {}),
    ...overrides,
  };
}

function loadCloudRunProvider() {
  const key = require.resolve('../lib/providers/cloudrun');
  delete require.cache[key];
  return require('../lib/providers/cloudrun');
}

function loadIndex() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('providers')) delete require.cache[k];
  }
  return require('../lib/providers/index');
}

// ═══════════════════════════════════════════════════════════════════════════════
// slugFor / serviceNamesFor (static, pure)
// ═══════════════════════════════════════════════════════════════════════════════

test('slugFor returns 12-char hex derived from sha256 of clientId', () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const slug = CloudRunProvider.slugFor('client-abc');
  assert.equal(typeof slug, 'string');
  assert.equal(slug.length, 12);
  assert.ok(/^[0-9a-f]+$/.test(slug), 'slug must be hex');
  // deterministic
  assert.equal(CloudRunProvider.slugFor('client-abc'), slug);
  // different inputs produce different slugs
  assert.notEqual(CloudRunProvider.slugFor('client-xyz'), slug);
});

test('serviceNamesFor returns RFC-1035-valid service names', () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const names = CloudRunProvider.serviceNamesFor('abc123def456');
  assert.equal(names.tagging, 'sgtm-abc123def456-tag');
  assert.equal(names.preview, 'sgtm-abc123def456-prev');
  // both ≤ 63 chars
  assert.ok(names.tagging.length <= 63);
  assert.ok(names.preview.length <= 63);
});

// ═══════════════════════════════════════════════════════════════════════════════
// deployPreview
// ═══════════════════════════════════════════════════════════════════════════════

test('deployPreview calls createService + waitForOperation + setPublicInvoker + getService', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const calls = { create: 0, waitOp: 0, setIam: 0, get: 0 };
  const svc = makeMockSvc({
    createService:    async () => { calls.create++; return { name: 'operations/prev-op' }; },
    waitForOperation: async () => { calls.waitOp++; return {}; },
    setPublicInvoker: async () => { calls.setIam++; return {}; },
    getService:       async (id) => { calls.get++; return { uri: `https://${id}.run.app`, latestReadyRevision: 'rev-1', terminalCondition: null }; },
  });

  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });
  const ctx = makeCtx({ slug: 'abc123def456' });
  const result = await provider.deployPreview(ctx);

  assert.equal(calls.create, 1);
  assert.equal(calls.waitOp, 1);
  assert.equal(calls.setIam, 1);
  assert.equal(calls.get, 1);
  assert.equal(result.previewServiceName, 'sgtm-abc123def456-prev');
  assert.ok(result.previewRunUrl.includes('sgtm-abc123def456-prev'));
});

test('deployPreview skips waitForOperation when service alreadyExists', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  let waitCalled = false;
  const svc = makeMockSvc({
    createService:    async () => ({ alreadyExists: true }),
    waitForOperation: async () => { waitCalled = true; return {}; },
  });

  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });
  await provider.deployPreview(makeCtx());
  assert.equal(waitCalled, false, 'waitForOperation must NOT be called on alreadyExists');
});

test('deployPreview throws CONFIG_TOO_LARGE for oversized containerConfig', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const provider = new CloudRunProvider(SHARD, { svcInstance: makeMockSvc() });
  const bigConfig = 'x'.repeat(31_000);

  await assert.rejects(
    () => provider.deployPreview(makeCtx({ secrets: { containerConfig: bigConfig } })),
    (err) => {
      assert.equal(err.code, 'CONFIG_TOO_LARGE');
      return true;
    },
  );
});

test('deployPreview throws CONFIG_NOT_READY when containerConfig is empty', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const provider = new CloudRunProvider(SHARD, { svcInstance: makeMockSvc() });

  await assert.rejects(
    () => provider.deployPreview(makeCtx({ secrets: { containerConfig: '' } })),
    (err) => {
      assert.equal(err.code, 'CONFIG_NOT_READY');
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// deployTagging — PREVIEW_SERVER_URL must use the public URL, never run.app
// ═══════════════════════════════════════════════════════════════════════════════

test('deployTagging sets PREVIEW_SERVER_URL to the public preview URL', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const receivedSpecs = [];
  const svc = makeMockSvc({
    createService: async (id, spec) => { receivedSpecs.push({ id, spec }); return { name: 'operations/tag-op' }; },
  });

  const publicPreview = 'https://abc123def456-preview.sgtm.easytrac.io';
  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });
  await provider.deployTagging(makeCtx({ previewPublicUrl: publicPreview }));

  const taggingSpec = receivedSpecs.find(s => s.id.endsWith('-tag'));
  assert.ok(taggingSpec, 'createService must be called for the tagging service');
  const envVars = taggingSpec.spec.template.containers[0].env;
  const pvUrl   = envVars.find(e => e.name === 'PREVIEW_SERVER_URL');
  assert.ok(pvUrl, 'PREVIEW_SERVER_URL must be in the env');
  assert.equal(pvUrl.value, publicPreview, 'PREVIEW_SERVER_URL must be the public wildcard URL');
  assert.ok(!pvUrl.value.includes('.run.app'), 'PREVIEW_SERVER_URL must not be a run.app URL');
});

test('deployTagging returns taggingServiceName, taggingRunUrl, cloudRunRevision', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const provider = new CloudRunProvider(SHARD, { svcInstance: makeMockSvc() });
  const result = await provider.deployTagging(makeCtx({ slug: 'abc123def456' }));

  assert.equal(result.taggingServiceName, 'sgtm-abc123def456-tag');
  assert.ok(result.taggingRunUrl, 'taggingRunUrl must be set');
  assert.equal(result.cloudRunRevision, 'rev-1');
});

// ═══════════════════════════════════════════════════════════════════════════════
// waitHealthy
// ═══════════════════════════════════════════════════════════════════════════════

test('waitHealthy delegates to svc.pollHealthy', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  let pollArgs;
  const svc = makeMockSvc({
    pollHealthy: async (url, opts) => { pollArgs = { url, opts }; return { ok: true }; },
  });
  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });
  const result = await provider.waitHealthy('https://svc.run.app', { timeoutMs: 5000 });

  assert.equal(result.ok, true);
  assert.equal(pollArgs.url, 'https://svc.run.app');
  assert.equal(pollArgs.opts.timeoutMs, 5000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// getStatus
// ═══════════════════════════════════════════════════════════════════════════════

test('getStatus returns status:ready when terminalCondition.state=CONDITION_SUCCEEDED', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const svc = makeMockSvc({
    getService: async () => ({
      uri:               'https://sgtm-abc123-tag.run.app',
      latestReadyRevision: 'rev-2',
      terminalCondition:   { state: 'CONDITION_SUCCEEDED' },
    }),
  });
  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });
  const status = await provider.getStatus(makeCtx({ slug: 'abc123def456' }));

  assert.equal(status.status, 'ready');
  assert.equal(status.revision, 'rev-2');
});

// ═══════════════════════════════════════════════════════════════════════════════
// teardown
// ═══════════════════════════════════════════════════════════════════════════════

test('teardown deletes both tagging and preview services', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const deleted = [];
  const svc = makeMockSvc({ deleteService: async (id) => { deleted.push(id); return {}; } });
  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });

  await provider.teardown(makeCtx({ slug: 'abc123def456' }));
  assert.ok(deleted.includes('sgtm-abc123def456-tag'), 'tagging service must be deleted');
  assert.ok(deleted.includes('sgtm-abc123def456-prev'), 'preview service must be deleted');
});

test('teardown swallows 404 errors (service already deleted)', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const err404 = Object.assign(new Error('not found'), { status: 404 });
  const svc = makeMockSvc({ deleteService: async () => { throw err404; } });
  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });

  await assert.doesNotReject(() => provider.teardown(makeCtx({ slug: 'abc123def456' })));
});

test('teardown re-throws non-404 errors', async () => {
  const { CloudRunProvider } = loadCloudRunProvider();
  const err403 = Object.assign(new Error('forbidden'), { status: 403 });
  const svc = makeMockSvc({ deleteService: async () => { throw err403; } });
  const provider = new CloudRunProvider(SHARD, { svcInstance: svc });

  await assert.rejects(() => provider.teardown(makeCtx({ slug: 'abc123def456' })), /forbidden/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// LegacyStapeProvider
// ═══════════════════════════════════════════════════════════════════════════════

test('LegacyStapeProvider throws LEGACY_PROVIDER_NOT_SUPPORTED on all methods', async () => {
  const { LegacyStapeProvider } = require('../lib/providers/legacy-stape');
  const p = new LegacyStapeProvider();
  const ctx = makeCtx();

  for (const method of ['deployPreview', 'deployTagging', 'getStatus', 'teardown']) {
    await assert.rejects(
      () => p[method](ctx),
      (err) => {
        assert.equal(err.code, 'LEGACY_PROVIDER_NOT_SUPPORTED', `${method} must set code`);
        return true;
      },
    );
  }
  await assert.rejects(() => p.waitHealthy('https://x.run.app', {}), (err) => {
    assert.equal(err.code, 'LEGACY_PROVIDER_NOT_SUPPORTED');
    return true;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getHostingProvider factory
// ═══════════════════════════════════════════════════════════════════════════════

test('getHostingProvider returns CloudRunProvider when MANAGED_DEPLOY_PROVIDER=cloudrun', () => {
  const saved = process.env.MANAGED_DEPLOY_PROVIDER;
  process.env.MANAGED_DEPLOY_PROVIDER = 'cloudrun';
  try {
    const { getHostingProvider } = loadIndex();
    const { CloudRunProvider }   = require('../lib/providers/cloudrun');
    const p = getHostingProvider(SHARD);
    assert.ok(p instanceof CloudRunProvider);
  } finally {
    if (saved === undefined) delete process.env.MANAGED_DEPLOY_PROVIDER;
    else process.env.MANAGED_DEPLOY_PROVIDER = saved;
  }
});

test('getHostingProvider defaults to cloudrun when env is unset', () => {
  const saved = process.env.MANAGED_DEPLOY_PROVIDER;
  delete process.env.MANAGED_DEPLOY_PROVIDER;
  try {
    const { getHostingProvider } = loadIndex();
    const { CloudRunProvider }   = require('../lib/providers/cloudrun');
    const p = getHostingProvider(SHARD);
    assert.ok(p instanceof CloudRunProvider);
  } finally {
    if (saved !== undefined) process.env.MANAGED_DEPLOY_PROVIDER = saved;
  }
});

test('getHostingProvider returns LegacyStapeProvider when MANAGED_DEPLOY_PROVIDER=stape', () => {
  const saved = process.env.MANAGED_DEPLOY_PROVIDER;
  process.env.MANAGED_DEPLOY_PROVIDER = 'stape';
  try {
    const { getHostingProvider }    = loadIndex();
    const { LegacyStapeProvider }   = require('../lib/providers/legacy-stape');
    const p = getHostingProvider(null);
    assert.ok(p instanceof LegacyStapeProvider);
  } finally {
    if (saved === undefined) delete process.env.MANAGED_DEPLOY_PROVIDER;
    else process.env.MANAGED_DEPLOY_PROVIDER = saved;
  }
});

test('getHostingProvider throws for unknown provider value', () => {
  const saved = process.env.MANAGED_DEPLOY_PROVIDER;
  process.env.MANAGED_DEPLOY_PROVIDER = 'unknown-provider';
  try {
    const { getHostingProvider } = loadIndex();
    assert.throws(() => getHostingProvider(SHARD), /Unknown MANAGED_DEPLOY_PROVIDER/);
  } finally {
    if (saved === undefined) delete process.env.MANAGED_DEPLOY_PROVIDER;
    else process.env.MANAGED_DEPLOY_PROVIDER = saved;
  }
});

test('getHostingProvider throws when shard is missing for cloudrun', () => {
  const saved = process.env.MANAGED_DEPLOY_PROVIDER;
  process.env.MANAGED_DEPLOY_PROVIDER = 'cloudrun';
  try {
    const { getHostingProvider } = loadIndex();
    assert.throws(() => getHostingProvider(null), /shard is required/);
  } finally {
    if (saved === undefined) delete process.env.MANAGED_DEPLOY_PROVIDER;
    else process.env.MANAGED_DEPLOY_PROVIDER = saved;
  }
});
