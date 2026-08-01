// tests/cloud-run-service.test.js
// Unit tests for lib/cloud-run-service.js
// Run: node --test tests/cloud-run-service.test.js

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Real RSA key for gcp-auth (used internally by CloudRunService) ────────────
const { privateKey: _priv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY = _priv.export({ type: 'pkcs1', format: 'pem' });

const FAKE_SHARD = {
  id:           'prod-1',
  gcpProjectId: 'easytrack-prod-1',
  region:       'me-central1',
  saKeyJson:    JSON.stringify({
    client_email: 'sa@easytrack-prod-1.iam.gserviceaccount.com',
    private_key:  TEST_PRIVATE_KEY,
  }),
};

// ── fetch mock ────────────────────────────────────────────────────────────────
let _origFetch;
let _fetchSpy;    // [{ url, method, body }]
let _fetchQueue;  // [fn|object] — each call consumes one entry

function _installMockFetch() {
  _origFetch = globalThis.fetch;
  _fetchSpy  = [];
  _fetchQueue = [];
  globalThis.fetch = async (url, opts = {}) => {
    const entry = _fetchQueue.shift();
    if (!entry) throw new Error(`Unexpected fetch call to ${url} — no mock queued`);
    const resp = typeof entry === 'function' ? entry(url, opts) : entry;
    _fetchSpy.push({ url, method: opts.method || 'GET', body: opts.body });
    return resp;
  };
}

function _restoreFetch() {
  globalThis.fetch = _origFetch;
}

function _tokenResp() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'test-tok', expires_in: 3600 }) };
}
function _okResp(data) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
}
function _errResp(status, data) {
  return { ok: false, status, text: async () => JSON.stringify(data) };
}

const FAST = { lroPollMs: 10, healthPollMs: 10 };  // collapse sleep for tests

function loadModule() {
  // Clear both cloud-run-service and gcp-auth from require cache
  for (const key of Object.keys(require.cache)) {
    if (key.includes('cloud-run-service') || key.includes('gcp-auth')) delete require.cache[key];
  }
  return require('../lib/cloud-run-service');
}

before(() => { _installMockFetch(); });
after(() => { _restoreFetch(); });

// Reset spy + queue before each test
function _reset() {
  _fetchSpy   = [];
  _fetchQueue = [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// buildServiceSpec (static, pure)
// ═══════════════════════════════════════════════════════════════════════════════

test('buildServiceSpec returns valid spec with defaults', () => {
  const { CloudRunService } = loadModule();
  const spec = CloudRunService.buildServiceSpec({ image: 'gcr.io/gtm:stable', env: { FOO: 'bar' } });

  assert.equal(spec.template.scaling.minInstanceCount, 0);
  assert.equal(spec.template.scaling.maxInstanceCount, 3);
  const c = spec.template.containers[0];
  assert.equal(c.image, 'gcr.io/gtm:stable');
  assert.equal(c.ports[0].containerPort, 8080);
  assert.equal(c.resources.limits.memory, '512Mi');
  assert.deepEqual(c.env, [{ name: 'FOO', value: 'bar' }]);
  assert.ok(c.startupProbe.httpGet.path === '/healthy');
});

test('buildServiceSpec applies custom scaling and memory', () => {
  const { CloudRunService } = loadModule();
  const spec = CloudRunService.buildServiceSpec({ image: 'img', minInstances: 1, maxInstances: 5, memory: '1Gi' });
  assert.equal(spec.template.scaling.minInstanceCount, 1);
  assert.equal(spec.template.scaling.maxInstanceCount, 5);
  assert.equal(spec.template.containers[0].resources.limits.memory, '1Gi');
});

test('buildServiceSpec throws when image is missing', () => {
  const { CloudRunService } = loadModule();
  assert.throws(() => CloudRunService.buildServiceSpec({}), /image is required/);
});

test('buildServiceSpec converts numeric env values to strings', () => {
  const { CloudRunService } = loadModule();
  const spec = CloudRunService.buildServiceSpec({ image: 'img', env: { PORT: 8080 } });
  assert.deepEqual(spec.template.containers[0].env, [{ name: 'PORT', value: '8080' }]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constructor validation
// ═══════════════════════════════════════════════════════════════════════════════

test('constructor throws when shard is missing required fields', () => {
  const { CloudRunService } = loadModule();
  assert.throws(() => new CloudRunService({}), /shard/);
  assert.throws(() => new CloudRunService(null), /shard/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// createService
// ═══════════════════════════════════════════════════════════════════════════════

test('createService POSTs to the correct URL and returns the LRO', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);
  const spec = CloudRunService.buildServiceSpec({ image: 'img' });

  // fetch 1: token; fetch 2: createService
  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_okResp({ name: 'operations/create-op-1', done: false }));

  const op = await svc.createService('sgtm-abc123-tag', spec);
  assert.equal(op.name, 'operations/create-op-1');

  const createCall = _fetchSpy[1];
  assert.ok(createCall.url.includes('/services?serviceId=sgtm-abc123-tag'));
  assert.equal(createCall.method, 'POST');
});

test('createService returns { alreadyExists: true } on 409', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_errResp(409, { error: { message: 'already exists', status: 'ALREADY_EXISTS' } }));

  const result = await svc.createService('sgtm-abc123-tag', {});
  assert.deepEqual(result, { alreadyExists: true });
});

test('createService throws on non-409 errors', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_errResp(403, { error: { message: 'permission denied', status: 'PERMISSION_DENIED' } }));

  await assert.rejects(
    () => svc.createService('svc', {}),
    (err) => {
      assert.equal(err.status, 403);
      assert.ok(err.message.includes('permission denied'));
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateService
// ═══════════════════════════════════════════════════════════════════════════════

test('updateService PATCHes the correct URL', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_okResp({ name: 'operations/update-op-1', done: false }));

  await svc.updateService('sgtm-abc123-tag', {});
  assert.equal(_fetchSpy[1].method, 'PATCH');
  assert.ok(_fetchSpy[1].url.endsWith('/services/sgtm-abc123-tag'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// getService
// ═══════════════════════════════════════════════════════════════════════════════

test('getService returns normalized fields', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  const raw = { uri: 'https://svc-xxx.run.app', terminalCondition: { type: 'Ready' }, latestReadyRevision: 'svc-00001' };
  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_okResp(raw));

  const result = await svc.getService('sgtm-abc123-tag');
  assert.equal(result.uri, 'https://svc-xxx.run.app');
  assert.deepEqual(result.terminalCondition, { type: 'Ready' });
  assert.equal(result.latestReadyRevision, 'svc-00001');
});

// ═══════════════════════════════════════════════════════════════════════════════
// deleteService
// ═══════════════════════════════════════════════════════════════════════════════

test('deleteService sends DELETE to the service URL', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_okResp({ name: 'operations/delete-op-1' }));

  await svc.deleteService('sgtm-abc123-tag');
  assert.equal(_fetchSpy[1].method, 'DELETE');
  assert.ok(_fetchSpy[1].url.endsWith('/services/sgtm-abc123-tag'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// setPublicInvoker
// ═══════════════════════════════════════════════════════════════════════════════

test('setPublicInvoker posts correct IAM binding', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_okResp({ version: 1 }));

  await svc.setPublicInvoker('sgtm-abc123-tag');
  assert.ok(_fetchSpy[1].url.endsWith(':setIamPolicy'));
  const body = JSON.parse(_fetchSpy[1].body);
  assert.deepEqual(body.policy.bindings, [{ role: 'roles/run.invoker', members: ['allUsers'] }]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// waitForOperation
// ═══════════════════════════════════════════════════════════════════════════════

test('waitForOperation polls until done and returns response', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  const ticks = [];
  // Token + 2 in-progress polls + 1 done poll
  _fetchQueue.push(_tokenResp()); // token
  _fetchQueue.push(_okResp({ done: false }));  // poll 1
  _fetchQueue.push(_tokenResp()); // token refresh attempt (new _token() call each poll)
  _fetchQueue.push(_okResp({ done: true, response: { uri: 'https://svc.run.app' } }));

  const result = await svc.waitForOperation('operations/create-op-1', {
    timeoutMs: 30_000,
    onTick: (t) => ticks.push(t),
  });

  assert.equal(result.uri, 'https://svc.run.app');
  assert.ok(ticks.length >= 1);
});

test('waitForOperation throws when operation errors', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  _fetchQueue.push(_tokenResp());
  _fetchQueue.push(_okResp({ done: true, error: { code: 7, message: 'PERMISSION_DENIED' } }));

  await assert.rejects(
    () => svc.waitForOperation('operations/op-bad', { timeoutMs: 10_000 }),
    (err) => {
      assert.ok(err.message.includes('PERMISSION_DENIED'));
      return true;
    },
  );
});

test('waitForOperation throws on timeout', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  // Supply unlimited token + not-done responses via a repeating factory function
  const notDone = () => _okResp({ done: false });
  const tok     = () => _tokenResp();
  // Interleave: token, poll, token, poll, ... (queue drains FIFO; use repeating push)
  // Easier: override fetch directly for this test
  const saved = globalThis.fetch;
  let callIdx = 0;
  globalThis.fetch = async (url, opts) => {
    callIdx++;
    _fetchSpy.push({ url, method: opts.method || 'GET', body: opts.body });
    // odd calls = token URL, even calls = LRO GET
    if (url.includes('oauth2.googleapis.com')) return _tokenResp();
    return _okResp({ done: false });
  };

  try {
    await assert.rejects(
      () => svc.waitForOperation('operations/op-stall', { timeoutMs: 100 }),
      (err) => {
        assert.equal(err.code, 'DEADLINE_EXCEEDED');
        return true;
      },
    );
  } finally {
    globalThis.fetch = saved;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// pollHealthy
// ═══════════════════════════════════════════════════════════════════════════════

test('pollHealthy returns ok:true when /healthy returns 200', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  const ticks = [];
  _fetchQueue.push({ ok: false, status: 503, text: async () => '' }); // not ready yet
  _fetchQueue.push({ ok: true,  status: 200, text: async () => 'ok' }); // ready

  const result = await svc.pollHealthy('https://svc.run.app', {
    timeoutMs: 30_000,
    onTick: (t) => ticks.push(t),
  });

  assert.equal(result.ok, true);
  assert.ok(result.url.includes('/healthy'));
  assert.ok(ticks.length >= 1);
});

test('pollHealthy throws on timeout', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' });

  try {
    await assert.rejects(
      () => svc.pollHealthy('https://svc.run.app', { timeoutMs: 100 }),
      (err) => {
        assert.equal(err.code, 'HEALTH_TIMEOUT');
        return true;
      },
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test('pollHealthy continues polling through network errors', async () => {
  _reset();
  const { CloudRunService } = loadModule();
  const svc = new CloudRunService(FAKE_SHARD, FAST);

  // Network error first, then 200
  _fetchQueue.push(() => { throw new Error('connect ECONNREFUSED'); });
  _fetchQueue.push({ ok: true, status: 200, text: async () => 'ok' });

  const result = await svc.pollHealthy('https://svc.run.app', { timeoutMs: 30_000 });
  assert.equal(result.ok, true);
});
