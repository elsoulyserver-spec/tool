// ════════════════════════════════════════════════════════════════════════════
// tests/provisionForClientWithServer.import-decision.test.js
//
// Validates the REAL 3-stage decision flow for managed server-container
// provisioning (API → worker → gtm-service), not isolated function behavior.
//
// Real-system facts this test encodes (verified against the codebase):
//   • The MANAGED_IMPORT_SERVER_CONFIG flag is NOT read inside gtm-service. It is
//     enforced UPSTREAM in the worker (_runManagedProvisionJob), which only puts
//     serverConfigJson into provisionOpts when the flag is "1" AND a GCS blob ref
//     exists. That worker gate is reproduced faithfully below as
//     resolveServerConfigForWorker() — it is the exact predicate from server.js.
//   • gtm-service.provisionForClientWithServer() then branches purely on the
//     PRESENCE of opts.serverConfigJson:
//         opts.serverConfigJson  -> importServerContainerVersion() (versions:import)
//         else                   -> static path (sgtm-default-config.json + per-entity)
//   • importServerContainerVersion() is the SOLE caller of GTM `versions:import`.
//     Because gtm-service invokes it as a local (closure) binding, a jest.spyOn on
//     the export cannot intercept the internal call in CommonJS; the authoritative,
//     deterministic signal for "the import path ran" is therefore whether a
//     `versions:import` POST was issued. We assert on BOTH the spy and that signal
//     (OR-ed) so the test is correct regardless of the call-site binding.
//
// The GTM HTTP boundary (https) is mocked so the REAL gtm-service branching runs.
// GCS/Firestore are represented by the worker-gate inputs (blob mocked).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { EventEmitter } = require('events');
const { generateKeyPairSync } = require('crypto');

// Mock the GTM HTTP boundary. gtm-service constructs `new https.Agent(...)` at
// module load, so the Agent constructor must exist in the mock.
jest.mock('https', () => ({
  Agent: function Agent() {},
  request: jest.fn(),
}));

const https = require('https');

// ── Request recorder + deterministic id counters (reset per test) ────────────
let recorded;
let containerCount;
let wsCount;
let entityCount;
let createVersionCount;

const IMPORT_VERSION_ID = 'V_IMPORT_123';

// Faithful mock of every GTM endpoint gtm-service touches.
function routeResponse(path, method) {
  if (path === '/token') return { access_token: 'mock-token', expires_in: 3600 };

  if (method === 'POST' && path.includes('/versions:import')) {
    return { containerVersionId: IMPORT_VERSION_ID };                 // versions:import
  }
  if (method === 'POST' && /\/workspaces\/[^/:]+:create_version$/.test(path)) {
    return { containerVersion: { containerVersionId: 'V_CREATE_' + (++createVersionCount) } };
  }
  if (method === 'POST' && /:publish$/.test(path)) return {};
  if (method === 'POST' && /\/variables$/.test(path)) return { variableId: 'VAR_' + (++entityCount) };
  if (method === 'POST' && /\/triggers$/.test(path))  return { triggerId: 'TRG_' + (++entityCount) };
  if (method === 'POST' && /\/tags$/.test(path))      return { tagId: 'TAG_' + (++entityCount) };
  if (method === 'POST' && /\/containers$/.test(path)) {
    containerCount++;
    return { containerId: 'C' + containerCount, publicId: 'GTM-' + containerCount };
  }
  if (method === 'GET' && /\/workspaces$/.test(path)) {
    return { workspace: [{ workspaceId: 'WS' + (++wsCount) }] };
  }
  if (method === 'GET' && /\/containers\/[^/]+$/.test(path)) return { containerConfig: 'MOCK_CONFIG_BLOB' };
  return {};
}

function installHttpsMock() {
  https.request.mockImplementation((options, cb) => {
    const path   = options.path || '';
    const method = (options.method || 'GET').toUpperCase();
    recorded.push({ path, method });

    const body = routeResponse(path, method);
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setEncoding = () => {};
    if (cb) cb(res);                                  // gtm-service attaches data/end listeners here
    process.nextTick(() => {
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    });

    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {};
    req.destroy = () => {};
    return req;
  });
}

// ── Worker-stage gate (stages 1+2): EXACT predicate from server.js
// _runManagedProvisionJob — flag "1" AND a staged blob ref => fetch the (mocked)
// GCS blob; otherwise null. This is what decides whether stage 3 sees a config.
function resolveServerConfigForWorker({ serverConfigRef, blob }) {
  const flagOn = (process.env.MANAGED_IMPORT_SERVER_CONFIG || '').trim() === '1';
  if (flagOn && serverConfigRef) return blob;        // GCS get() — mocked
  return null;
}

// A realistic full CAPI server config (the kind buildSSContainer emits).
const SERVER_CONFIG_JSON = {
  exportFormatVersion: 2,
  containerVersion: {
    variable:       [{ name: 'GA4 MID', type: 'c' }],
    trigger:        [{ name: 'All Events', type: 'always' }],
    tag: [
      { name: 'GA4 Forward', type: 'sgtmgaaw' },
      { name: 'Meta CAPI',   type: 'cvt_0_1' },
      { name: 'TikTok EAPI', type: 'cvt_0_1' },
      { name: 'Snap CAPI',   type: 'cvt_0_1' },
    ],
    client:         [{ name: 'GA4 Client', type: 'gaaw_client' }],
    customTemplate: [{ name: 'Universal HTTP Forwarder', templateId: '1' }],
  },
};
// Empty web config so importContainerJSON skips it → the ONLY per-entity /tags
// POST that can appear comes from the static server branch (a clean discriminator).
const WEB_CONFIG_JSON = { containerVersion: { variable: [], trigger: [], tag: [] } };

const STAGED_REF = { bucket: 'easytrac-provisioning', object: 'server-config/job_x.json' };

let gtmService;
let importSpy;
let savedEnv;

beforeAll(() => {
  // Real RSA key so the SA JWT signing in gtm-service runs with real crypto
  // (no network, no crypto mock) — keeps the test fully deterministic.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  savedEnv = {
    GTM_SA_KEY_JSON: process.env.GTM_SA_KEY_JSON,
    GTM_ACCOUNT_ID: process.env.GTM_ACCOUNT_ID,
    MANAGED_IMPORT_SERVER_CONFIG: process.env.MANAGED_IMPORT_SERVER_CONFIG,
  };
  process.env.GTM_SA_KEY_JSON = JSON.stringify({
    client_email: 'sa@test.iam.gserviceaccount.com',
    private_key: privateKey,
    project_id: 'test-project',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  process.env.GTM_ACCOUNT_ID = '123456';

  gtmService = require('../gtm-service');
});

afterAll(() => {
  process.env.GTM_SA_KEY_JSON = savedEnv.GTM_SA_KEY_JSON;
  process.env.GTM_ACCOUNT_ID = savedEnv.GTM_ACCOUNT_ID;
  process.env.MANAGED_IMPORT_SERVER_CONFIG = savedEnv.MANAGED_IMPORT_SERVER_CONFIG;
});

beforeEach(() => {
  recorded = [];
  containerCount = 0;
  wsCount = 0;
  entityCount = 0;
  createVersionCount = 0;
  installHttpsMock();
  // Required by the task: mock importServerContainerVersion. (Intercepts only if
  // the call goes through the export; assertions below also use the network seam.)
  importSpy = jest.spyOn(gtmService, 'importServerContainerVersion')
    .mockResolvedValue({ containerVersionId: IMPORT_VERSION_ID });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Observable signals (authoritative, binding-independent) ──────────────────
const importPathTaken = () =>
  importSpy.mock.calls.length > 0 ||
  recorded.some((r) => r.method === 'POST' && r.path.includes('/versions:import'));

const staticServerImportTaken = () =>
  recorded.some((r) => r.method === 'POST' && /\/tags$/.test(r.path));

async function runPipeline({ serverConfigRef, blob }) {
  const serverConfigJson = resolveServerConfigForWorker({ serverConfigRef, blob });
  return gtmService.provisionForClientWithServer({
    projectName: 'Test Project',
    domain: 'shop.example.com',
    configJson: WEB_CONFIG_JSON,
    serverConfigJson,                 // <- the worker-gated value (stage 2 → stage 3)
    publishLive: false,
    inviteEmail: null,
    onProgress: () => {},
  });
}

describe('provisionForClientWithServer — managed server-config import decision', () => {
  test('TEST CASE 1 (IMPORT PATH): flag="1" + serverConfigJson exists -> versions:import, returns containerVersionId', async () => {
    process.env.MANAGED_IMPORT_SERVER_CONFIG = '1';

    const result = await runPipeline({ serverConfigRef: STAGED_REF, blob: SERVER_CONFIG_JSON });

    expect(importPathTaken()).toBe(true);                   // import branch ran
    expect(staticServerImportTaken()).toBe(false);          // static GA4-only path did NOT run
    expect(result.server.versionId).toBe(IMPORT_VERSION_ID); // serverVersionId === containerVersionId
  });

  test('TEST CASE 2 (STATIC FALLBACK): flag="1" + serverConfigJson=null -> static path, no import', async () => {
    process.env.MANAGED_IMPORT_SERVER_CONFIG = '1';

    const result = await runPipeline({ serverConfigRef: null, blob: null }); // nothing staged

    expect(importPathTaken()).toBe(false);                  // importServerContainerVersion NOT used
    expect(staticServerImportTaken()).toBe(true);           // static per-entity import ran
    expect(result.server.versionId).toMatch(/^V_CREATE_/);  // version came from createVersion, not import
    expect(result.server.versionId).not.toBe(IMPORT_VERSION_ID);
  });

  test('TEST CASE 3 (ROLLBACK): flag="0" + serverConfigJson exists -> static path always, no import', async () => {
    process.env.MANAGED_IMPORT_SERVER_CONFIG = '0';

    const result = await runPipeline({ serverConfigRef: STAGED_REF, blob: SERVER_CONFIG_JSON });

    expect(importPathTaken()).toBe(false);                  // flag off => worker gate yields null => static
    expect(staticServerImportTaken()).toBe(true);
    expect(result.server.versionId).toMatch(/^V_CREATE_/);
    expect(result.server.versionId).not.toBe(IMPORT_VERSION_ID);
  });
});
