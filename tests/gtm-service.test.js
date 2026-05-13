// tests/gtm-service.test.js
// Unit tests for gtm-service.js — mocks the HTTPS layer, no real GTM calls.
// Run: node --test tests/gtm-service.test.js
//
// Coverage:
//   1. importContainerJSON — duplicate variable → PUT update
//   2. importContainerJSON — inline 400 duplicate skipped gracefully
//   3. importContainerJSON — bulk import happy path (1 API call)
//   4. publishVersion      — 404 → fallback to latest version
//   5. publishVersion      — non-404 errors re-thrown
//   6. provisionForClientWithServer — uses opts.serverConfigJson
//   7. provisionForClientWithServer — server container created + published
//   8. buildServerConfig   — picks up pixelIds.ga4 correctly

'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const https     = require('https');
const crypto    = require('crypto');
const EventEmitter = require('events');

// ── Generate a real RSA key pair for JWT signing in tests ────────────────────
const { privateKey: _testPrivKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY = _testPrivKey.export({ type: 'pkcs1', format: 'pem' });

process.env.GTM_SA_KEY_JSON = JSON.stringify({
  client_email: 'test-sa@project.iam.gserviceaccount.com',
  private_key:  TEST_PRIVATE_KEY,
});
process.env.GTM_ACCOUNT_ID = '999000';

// ── HTTP mock infrastructure ──────────────────────────────────────────────────
let _queue = [];
let _calls  = [];   // { method, path }

const _origRequest = https.request;

function _mockHttp(responses) {
  _queue = responses.slice();
  _calls  = [];

  https.request = function (opts, cb) {
    const em = new EventEmitter();
    em.write = () => {};
    em.end = () => {
      const item = _queue.shift() || { statusCode: 200, body: '{}' };
      _calls.push({ method: opts.method, path: opts.path || '' });

      const res = new EventEmitter();
      res.statusCode  = item.statusCode;
      res.setEncoding = () => {};
      process.nextTick(() => {
        const s = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
        res.emit('data', s);
        res.emit('end');
      });
      if (cb) cb(res);
    };
    return em;
  };
}

function _restoreHttp() {
  https.request = _origRequest;
}

// Helper responses
const tokenOK = () => ({ statusCode: 200, body: { access_token: 'fake-tok', expires_in: 3600 } });
const empty   = (key) => ({ statusCode: 200, body: { [key]: [] } });
const ok200   = (body = {}) => ({ statusCode: 200, body });

// ── Fresh module per test (clears cached token + SA state) ───────────────────
function svc() {
  delete require.cache[require.resolve('../gtm-service')];
  return require('../gtm-service');
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. importContainerJSON: duplicate variable → PUT
// ══════════════════════════════════════════════════════════════════════════════
test('importContainerJSON: existing variable triggers PUT (not POST)', async () => {
  _mockHttp([
    tokenOK(),
    // bulk import → 405 not supported
    { statusCode: 405, body: { error: { message: 'Method not allowed' } } },
    // pre-load vars → existing "ET - Test Var"
    ok200({ variable: [{ name: 'ET - Test Var', variableId: '77' }] }),
    // pre-load triggers → empty
    empty('trigger'),
    // PUT to update variable 77
    ok200({ variableId: '77', name: 'ET - Test Var' }),
    // pre-load tags → empty
    empty('tag'),
  ]);

  const g = svc();
  const cfg = {
    containerVersion: {
      variable: [{ name: 'ET - Test Var', type: 'c', parameter: [] }],
      trigger: [], tag: [],
    },
  };

  const result = await g.importContainerJSON('ct1', 'ws1', cfg, null, null);
  assert.equal(result.importedVariableCount, 1);

  // Must have issued a PUT to /variables/77
  const putCall = _calls.find(c => c.method === 'PUT' && c.path.includes('/variables/77'));
  assert.ok(putCall, 'expected PUT to update existing variable');

  // Must NOT have issued a POST for that variable
  const postVarCall = _calls.find(c => c.method === 'POST' && c.path.endsWith('/variables'));
  assert.ok(!postVarCall, 'must not POST a duplicate variable');

  _restoreHttp();
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. importContainerJSON: inline 400 duplicate → skipped
// ══════════════════════════════════════════════════════════════════════════════
test('importContainerJSON: inline 400 duplicate on POST is skipped, no throw', async () => {
  _mockHttp([
    tokenOK(),
    { statusCode: 405, body: { error: { message: 'not allowed' } } },
    empty('variable'),   // pre-load vars (no existing)
    empty('trigger'),
    // POST → 400 duplicate
    { statusCode: 400, body: { error: { message: 'Found entity with duplicate name' } } },
    empty('tag'),
  ]);

  const g = svc();
  const cfg = {
    containerVersion: {
      variable: [{ name: 'Already Exists', type: 'c', parameter: [] }],
      trigger: [], tag: [],
    },
  };

  // Should resolve without throwing
  const r = await g.importContainerJSON('ct1', 'ws1', cfg, null, null);
  assert.equal(r.importedVariableCount, 1);
  _restoreHttp();
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. importContainerJSON: bulk import happy path
// ══════════════════════════════════════════════════════════════════════════════
test('importContainerJSON: bulk import uses 1 API call (token + :import)', async () => {
  _mockHttp([
    tokenOK(),
    ok200({}),   // :import succeeds
  ]);

  const g = svc();
  const cfg = {
    containerVersion: {
      variable: [{ name: 'V1' }, { name: 'V2' }],
      trigger:  [{ name: 'T1' }],
      tag:      [{ name: 'TAG1' }],
    },
  };

  const r = await g.importContainerJSON('ct1', 'ws1', cfg, null, null);
  assert.equal(r.importedVariableCount, 2);
  assert.equal(r.importedTriggerCount,  1);
  assert.equal(r.importedTagCount,      1);

  // Only 2 HTTP calls: token exchange + :import
  assert.equal(_calls.length, 2, `expected 2 calls, got ${_calls.length}`);
  assert.ok(_calls[1].path.includes(':import'), 'second call must be :import');
  _restoreHttp();
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. publishVersion: 404 → fallback to latest version
// ══════════════════════════════════════════════════════════════════════════════
test('publishVersion: 404 on first attempt → publishes latest version instead', async () => {
  _mockHttp([
    tokenOK(),
    // First publish → 404
    { statusCode: 404, body: { error: { message: 'Not found' } } },
    // List versions → v1, v3, v2 (should pick v3 as latest by numeric sort)
    ok200({ containerVersion: [
      { containerVersionId: '1' },
      { containerVersionId: '3' },
      { containerVersionId: '2' },
    ]}),
    // Publish v3 → success
    ok200({ containerVersion: { containerVersionId: '3' } }),
  ]);

  const g = svc();
  await g.publishVersion('ct1', '99');  // 99 doesn't exist → 404

  const fallbackPublish = _calls.find(c =>
    c.method === 'POST' && c.path.includes('versions/3:publish'));
  assert.ok(fallbackPublish, 'should have published version 3 as fallback');
  _restoreHttp();
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. publishVersion: non-404 error is re-thrown
// ══════════════════════════════════════════════════════════════════════════════
test('publishVersion: 403 is re-thrown (not swallowed)', async () => {
  _mockHttp([
    tokenOK(),
    { statusCode: 403, body: { error: { message: 'Forbidden' } } },
  ]);

  const g = svc();
  await assert.rejects(
    () => g.publishVersion('ct1', '1'),
    (err) => {
      assert.ok(/403/.test(err.message), `expected 403 in message, got: ${err.message}`);
      return true;
    },
  );
  _restoreHttp();
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 + 7. provisionForClientWithServer: uses serverConfigJson + server published
// ══════════════════════════════════════════════════════════════════════════════
test('provisionForClientWithServer: uses serverConfigJson and returns containerConfig', async () => {
  const serverCfg = {
    containerVersion: {
      variable: [{ name: 'ET - GA4 Measurement ID', type: 'c',
        parameter: [{ type: 'template', key: 'value', value: 'G-ABCTEST' }] }],
      trigger: [],
      tag: [],
    },
  };
  const webCfg = { containerVersion: { variable: [], trigger: [], tag: [] } };

  _mockHttp([
    tokenOK(),
    // ── WEB ──────────────────────────────────────────────────────────────────
    ok200({ containerId: 'web-ct', publicId: 'GTM-WEBXX', containerConfig: null }),  // createContainer
    ok200({ workspace: [{ workspaceId: 'ws-web' }] }),                               // getDefaultWorkspace
    // webCfg is empty (variable:[], trigger:[], tag:[]) → importContainerJSON skips, 0 HTTP calls
    ok200({ containerVersion: { containerVersionId: 'wv1' } }),                      // createVersion

    // ── SERVER ───────────────────────────────────────────────────────────────
    ok200({ containerId: 'srv-ct', publicId: 'GTM-SRVXX', containerConfig: null }), // createServerContainer
    ok200({ workspace: [{ workspaceId: 'ws-srv' }] }),                              // getDefaultWorkspace
    { statusCode: 405, body: { error: { message: 'n/a' } } },                      // bulk import → fallback
    empty('variable'), empty('trigger'),                                             // pre-loads
    ok200({ variableId: 'v1', name: 'ET - GA4 Measurement ID' }),                  // POST variable
    empty('tag'),                                                                    // pre-load tags
    ok200({ containerVersion: { containerVersionId: 'sv1' } }),                     // createVersion
    ok200({ containerVersion: { containerVersionId: 'sv1' } }),                     // publishVersion
    ok200({ containerId: 'srv-ct', publicId: 'GTM-SRVXX',
            containerConfig: 'CONTAINER_CONFIG_BLOB' }),                            // getContainerConfig
  ]);

  const g = svc();
  const result = await g.provisionForClientWithServer({
    projectName:      'Test Project',
    configJson:       webCfg,
    serverConfigJson: serverCfg,
    publishLive:      false,
    inviteEmail:      null,
    onProgress:       () => {},
  });

  // Web result
  assert.ok(result.web, 'must return web');
  assert.equal(result.web.gtmPublicId, 'GTM-WEBXX');

  // Server result
  assert.ok(result.server, 'must return server');
  assert.equal(result.server.publicId, 'GTM-SRVXX');
  assert.equal(result.server.containerConfig, 'CONTAINER_CONFIG_BLOB',
    'server container must have containerConfig blob');
  assert.equal(result.server.importedVariableCount, 1,
    'server container should have imported 1 variable from serverConfigJson');

  // Verify server's variable was POSTed to ws-srv (not to web workspace)
  const srvVarPost = _calls.find(c =>
    c.method === 'POST' && c.path.includes('ws-srv') && c.path.includes('variables'));
  assert.ok(srvVarPost, 'must POST server variable to server workspace');

  _restoreHttp();
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. buildServerConfig picks up pixelIds.ga4
// ══════════════════════════════════════════════════════════════════════════════
test('buildServerConfig: pixelIds.ga4 is written into ET - GA4 Measurement ID variable', () => {
  const { buildServerConfig } = require('../lib/gtm-config-builder');

  const pixelIds = { ga4: 'G-XYZ99999', meta: '111222333' };
  const ga4Id    = pixelIds.ga4 || '';

  const cfg = buildServerConfig({
    ga4MeasurementId: ga4Id,
    sgtmUrl:          '',
    platforms:        ['meta'],
    events:           ['purchase', 'add_to_cart'],
  });

  const cv   = cfg.containerVersion || cfg;
  const vars = cv.variable || [];
  assert.ok(vars.length > 0, 'server config must have variables');

  const ga4Var = vars.find(v => v.name === 'ET - GA4 Measurement ID');
  assert.ok(ga4Var, 'must have ET - GA4 Measurement ID variable');

  const valParam = (ga4Var.parameter || []).find(p => p.key === 'value');
  assert.equal(valParam && valParam.value, 'G-XYZ99999',
    'GA4 measurement ID must match pixelIds.ga4');
});
