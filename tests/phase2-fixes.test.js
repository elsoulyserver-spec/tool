// tests/phase2-fixes.test.js
// Verifies the two BLOCKER fixes applied in the Phase 2 review:
//   F1 — health-service writes healthStatus + openIssues (not overallStatus / issueCount)
//   F2 — beacon endpoint enforces _BEACON_VALID_EVENTS allowlist sourced from BEACON_EVENTS
//
// Run: node --test tests/phase2-fixes.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ── F2 part A: BEACON_EVENTS export ──────────────────────────────────────────

test('firestore-service exports BEACON_EVENTS array', () => {
  // firestore-service uses lazy Firebase init (db() is called inside functions).
  // The BEACON_EVENTS array is module-level and requires no Firebase connection,
  // so we can require the module safely without any service account env var.
  const svc = require('../firestore-service');
  assert.ok(Array.isArray(svc.BEACON_EVENTS), 'BEACON_EVENTS must be an array');
  assert.equal(svc.BEACON_EVENTS.length, 8, 'must export exactly 8 beacon event names');
});

test('BEACON_EVENTS contains exactly the expected 8 event names', () => {
  const { BEACON_EVENTS } = require('../firestore-service');
  const expected = [
    'page_view', 'view_item', 'add_to_cart', 'begin_checkout',
    'purchase', 'generate_lead', 'sign_up', 'search',
  ];
  assert.deepEqual(BEACON_EVENTS, expected);
});

// ── F2 part B: server.js allowlist guard (source verification) ────────────────

test('server.js builds _BEACON_VALID_EVENTS from firestoreService.BEACON_EVENTS', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(
    src.includes('const _BEACON_VALID_EVENTS = new Set(firestoreService.BEACON_EVENTS)'),
    'server.js must construct _BEACON_VALID_EVENTS from the single canonical source',
  );
});

test('server.js allowlist guard appears after auth check and before dedup', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  const authCheck  = src.indexOf("sendJSON(res, 401, { error: 'authentication required' })");
  const allowlist  = src.indexOf('_BEACON_VALID_EVENTS.has(bEvent)');
  // Use _beaconCache.get(ck) — the in-handler dedup read, NOT the constant definition.
  const dedup      = src.indexOf('_beaconCache.get(ck)');

  assert.ok(authCheck  !== -1, 'authentication required guard must exist');
  assert.ok(allowlist  !== -1, '_BEACON_VALID_EVENTS.has(bEvent) guard must exist');
  assert.ok(dedup      !== -1, '_beaconCache.get(ck) dedup read must exist');

  assert.ok(
    authCheck < allowlist,
    'allowlist guard must come AFTER the auth check (unauthenticated requests rejected first)',
  );
  assert.ok(
    allowlist < dedup,
    'allowlist guard must come BEFORE the dedup code (invalid events rejected before Firestore write)',
  );
});

test('server.js returns HTTP 400 for unknown event type', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // Verify the guard sends 400, not 401/403/500
  const guardBlock = src.slice(
    src.indexOf('_BEACON_VALID_EVENTS.has(bEvent)'),
    src.indexOf('_BEACON_VALID_EVENTS.has(bEvent)') + 200,
  );
  assert.ok(guardBlock.includes('400'), 'guard must respond with HTTP 400');
  assert.ok(guardBlock.includes("unknown event type"), 'guard must include descriptive error message');
});

// ── F1: health-service field names (behavioral test via require.cache mock) ───

test('health-service writes healthStatus + openIssues to saveHealthCache', async () => {
  const firestorePath  = require.resolve('../firestore-service');
  const diagnosticPath = require.resolve('../lib/diagnostic-rules');
  const healthPath     = require.resolve('../lib/health-service');

  // Clear any previously-loaded versions so our mocks take effect.
  delete require.cache[firestorePath];
  delete require.cache[diagnosticPath];
  delete require.cache[healthPath];

  let capturedId   = null;
  let capturedData = null;
  let callCount    = 0;

  const fakeDoc = {
    id: 'client-test-1',
    data() { return { status: 'active', name: 'Test Client' }; },
  };

  const mockFirestore = {
    isConfigured:          () => true,
    acquireHealthJobLock:  async () => true,
    extendHealthJobLock:   async () => {},
    releaseHealthJobLock:  async () => {},
    getPlatformHealth:     async () => ({}),
    listActiveClients:     async () => {
      // First call returns one document, second signals end-of-page.
      callCount++;
      return callCount === 1 ? [fakeDoc] : [];
    },
    listContainersByClient: async () => [],
    getSSConfig:            async () => null,
    listEventTypeLastSeen:  async () => [],
    saveDiagnosticResult:   async () => {},
    saveHealthCache:        async (id, data) => { capturedId = id; capturedData = data; },
    BEACON_EVENTS: [
      'page_view', 'view_item', 'add_to_cart', 'begin_checkout',
      'purchase', 'generate_lead', 'sign_up', 'search',
    ],
  };

  // One non-ok rule → issueCount should be 1.
  const mockDiagnosticRules = {
    evaluate: () => ({
      rules: { container_active: { status: 'error' } },
      overallStatus: 'error',
    }),
  };

  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true,
    exports: mockFirestore,
  };
  require.cache[diagnosticPath] = {
    id: diagnosticPath, filename: diagnosticPath, loaded: true,
    exports: mockDiagnosticRules,
  };

  const { runHealthJob } = require('../lib/health-service');
  await runHealthJob();

  // Cleanup before assertions so a failure doesn't poison other tests.
  delete require.cache[firestorePath];
  delete require.cache[diagnosticPath];
  delete require.cache[healthPath];

  assert.ok(capturedData !== null,           'saveHealthCache must have been called');
  assert.equal(capturedId, 'client-test-1', 'must pass the correct clientId');

  // ── F1 core assertion ──────────────────────────────────────────────────────
  assert.ok('healthStatus' in capturedData,  'F1: must write healthStatus field');
  assert.ok('openIssues'   in capturedData,  'F1: must write openIssues field');
  assert.ok(!('overallStatus' in capturedData), 'F1: must NOT write overallStatus (old wrong field)');
  assert.ok(!('issueCount'    in capturedData), 'F1: must NOT write issueCount (old wrong field)');

  assert.equal(capturedData.healthStatus, 'error', 'healthStatus must equal the overallStatus from evaluate()');
  assert.equal(capturedData.openIssues,   1,       'openIssues must equal count of non-ok / non-skip rules');
});

test('BEACON_EVENTS in firestore-service matches _BEACON_VALID_EVENTS source in server.js', () => {
  // Structural guarantee: server.js must reference firestoreService.BEACON_EVENTS directly,
  // not a hardcoded literal — so the two can never drift out of sync.
  const { BEACON_EVENTS } = require('../firestore-service');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // The set is built from the export, not from a local copy.
  assert.ok(
    serverSrc.includes('firestoreService.BEACON_EVENTS'),
    'server.js must use firestoreService.BEACON_EVENTS, not a hardcoded list',
  );

  // Cross-check: the Set in server.js would contain exactly these events.
  const setInServer = new Set(BEACON_EVENTS);
  assert.equal(setInServer.size, 8, 'Set must have 8 entries');
  for (const ev of BEACON_EVENTS) {
    assert.ok(setInServer.has(ev), `${ev} must be in the allowlist Set`);
  }
});
