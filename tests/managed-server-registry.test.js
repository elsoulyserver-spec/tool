// tests/managed-server-registry.test.js
// Unit tests for the managed sGTM hosting registry helpers in firestore-service.js
//
// Coverage:
//   1. _managedServerTransition — pure function, all valid + invalid transitions
//   2. createManagedServerJobTx — reuse / attach / created / resume outcomes
//   3. saveManagedServer — field defaults applied
//   4. appendDeploymentLog — log cap at 50 entries
//
// Run: node --test tests/managed-server-registry.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Minimal Firebase admin mock ───────────────────────────────────────────────
// Replaces require('firebase-admin') before firestore-service.js is loaded so
// all Firestore calls go through our in-memory stubs.

function _ts(ms) {
  const t = ms || Date.now();
  return { toMillis: () => t, _isTimestamp: true };
}

const _serverTimestamp = Symbol('serverTimestamp');

const _mockFieldValue = {
  serverTimestamp: () => _serverTimestamp,
};

const _mockTimestamp = {
  fromMillis: (ms) => _ts(ms),
  fromDate:   (d)  => _ts(d.getTime()),
};

// Per-test in-memory Firestore state
let _docs = {};   // { 'collection/docId': data }
let _txLog = [];  // track all tx operations: { op, ref, data }

function _docPath(ref) { return ref.__path; }

function _makeRef(collectionName, docId) {
  const path = `${collectionName}/${docId}`;
  const ref = {
    __path: path,
    id:     docId,
    set:    async (data, opts) => {
      _docs[path] = opts && opts.merge ? { ...(_docs[path] || {}), ...data } : { ...data };
    },
    get:    async () => {
      const data = _docs[path];
      return { exists: !!data, id: docId, data: () => data ? { ...data } : undefined, ref };
    },
    update: async (data) => {
      if (!_docs[path]) throw Object.assign(new Error('doc not found'), { code: 'NOT_FOUND' });
      _docs[path] = { ..._docs[path], ...data };
    },
    delete: async () => { delete _docs[path]; },
  };
  return ref;
}

function _makeCollection(collectionName) {
  return {
    doc: (id) => _makeRef(collectionName, id || String(Date.now() + Math.random())),
    add: async (data) => {
      const id  = String(Date.now() + Math.random());
      const ref = _makeRef(collectionName, id);
      await ref.set(data);
      return ref;
    },
  };
}

function _runTransaction(fn) {
  _txLog = [];
  const tx = {
    get: async (ref) => {
      const data = _docs[_docPath(ref)];
      return { exists: !!data, id: ref.id, data: () => data ? { ...data } : undefined, ref };
    },
    set: (ref, data, opts) => {
      _txLog.push({ op: 'set', path: _docPath(ref), data, opts });
      _docs[_docPath(ref)] = opts && opts.merge ? { ...(_docs[_docPath(ref)] || {}), ...data } : { ...data };
    },
    update: (ref, data) => {
      _txLog.push({ op: 'update', path: _docPath(ref), data });
      _docs[_docPath(ref)] = { ..._docs[_docPath(ref)], ...data };
    },
  };
  return fn(tx);
}

const _mockAdmin = {
  apps: [],
  initializeApp: () => {},
  firestore: () => {
    const _db = {
      collection:     (name)  => _makeCollection(name),
      runTransaction: _runTransaction,
      batch:          ()      => ({
        update: () => {},
        commit: async () => {},
      }),
      settings: () => {},
    };
    _db.settings = () => {};
    return _db;
  },
};

_mockAdmin.firestore.FieldValue = _mockFieldValue;
_mockAdmin.firestore.Timestamp  = _mockTimestamp;
_mockAdmin.auth = () => ({});

function _credential() {}
_mockAdmin.credential = { cert: _credential };

// Install the mock before loading firestore-service
function loadFirestoreService() {
  // Clear any cached module
  for (const k of Object.keys(require.cache)) {
    if (k.includes('firestore-service') || k.includes('firebase-admin')) delete require.cache[k];
  }
  // Inject the mock
  require.cache[require.resolve('firebase-admin')] = { id: 'firebase-admin', filename: 'firebase-admin', exports: _mockAdmin };
  process.env.FIREBASE_SA_KEY_JSON = JSON.stringify({ type: 'service_account', project_id: 'test-proj', private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n', client_email: 'test@test.iam.gserviceaccount.com' });
  return require('../firestore-service');
}

function resetDocs() { _docs = {}; _txLog = []; }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. _managedServerTransition — pure function
// ═══════════════════════════════════════════════════════════════════════════════

test('_managedServerTransition: new → provisioning (null current state)', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition(null, { status: 'provisioning', clientId: 'c1' });
  assert.equal(result.status, 'provisioning');
  assert.equal(result.clientId, 'c1');
});

test('_managedServerTransition: null → active is valid (entitlement check)', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition(null, { status: 'active' });
  assert.equal(result.status, 'active');
});

test('_managedServerTransition: provisioning → active', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition({ status: 'provisioning' }, { status: 'active' });
  assert.equal(result.status, 'active');
});

test('_managedServerTransition: provisioning → failed', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition({ status: 'provisioning' }, { status: 'failed' });
  assert.equal(result.status, 'failed');
});

test('_managedServerTransition: failed → provisioning (resume after failure)', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition({ status: 'failed' }, { status: 'provisioning' });
  assert.equal(result.status, 'provisioning');
});

test('_managedServerTransition: active → provisioning (update/republish)', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition({ status: 'active' }, { status: 'provisioning' });
  assert.equal(result.status, 'provisioning');
});

test('_managedServerTransition: active → suspended', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const result = _managedServerTransition({ status: 'active' }, { status: 'suspended' });
  assert.equal(result.status, 'suspended');
});

test('_managedServerTransition: patch fields merged onto current', () => {
  const { _managedServerTransition } = loadFirestoreService();
  const current = { status: 'provisioning', clientId: 'c1', slug: 'abc123' };
  const result = _managedServerTransition(current, { status: 'active', publicServerUrl: 'https://abc123.sgtm.easytrac.io' });
  assert.equal(result.clientId, 'c1');
  assert.equal(result.slug, 'abc123');
  assert.equal(result.publicServerUrl, 'https://abc123.sgtm.easytrac.io');
});

test('_managedServerTransition: throws INVALID_SERVER_TRANSITION for deleted → provisioning', () => {
  const { _managedServerTransition } = loadFirestoreService();
  assert.throws(
    () => _managedServerTransition({ status: 'deleted' }, { status: 'provisioning' }),
    (err) => {
      assert.equal(err.code, 'INVALID_SERVER_TRANSITION');
      assert.equal(err.from, 'deleted');
      return true;
    },
  );
});

test('_managedServerTransition: throws for unknown → unknown', () => {
  const { _managedServerTransition } = loadFirestoreService();
  assert.throws(
    () => _managedServerTransition({ status: 'active' }, { status: 'deleted' }),
    // active → deleted is currently NOT allowed per the transition map
    (err) => {
      assert.ok(err.code === 'INVALID_SERVER_TRANSITION' || err.message.includes('invalid'));
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. createManagedServerJobTx — transaction outcomes
// ═══════════════════════════════════════════════════════════════════════════════

test('createManagedServerJobTx: outcome=created when no doc exists', async () => {
  resetDocs();
  const { createManagedServerJobTx } = loadFirestoreService();

  const result = await createManagedServerJobTx({
    clientId: 'client-new',
    jobId:    'job-001',
    userId:   'client-new',
    email:    'new@test.com',
    shardId:  'prod-1',
  });

  assert.equal(result.outcome, 'created');
  assert.equal(result.jobId, 'job-001');
  assert.ok(result.server, 'server record must be returned');
  assert.equal(result.server.status, 'provisioning');

  // Verify the doc was written to Firestore
  const serverDoc = _docs['managed_servers/client-new'];
  assert.ok(serverDoc, 'managed_servers doc must be written');
  assert.equal(serverDoc.status, 'provisioning');
  assert.equal(serverDoc.jobId, 'job-001');

  const jobDoc = _docs['provisioning_jobs/job-001'];
  assert.ok(jobDoc, 'provisioning_jobs doc must be written');
  assert.equal(jobDoc.status, 'pending');
});

test('createManagedServerJobTx: outcome=reuse when status=active', async () => {
  resetDocs();
  _docs['managed_servers/client-active'] = {
    clientId:       'client-active',
    status:         'active',
    publicServerUrl: 'https://existing.sgtm.easytrac.io',
    updatedAt:      _ts(Date.now() - 1000),
  };

  const { createManagedServerJobTx } = loadFirestoreService();
  const result = await createManagedServerJobTx({
    clientId: 'client-active',
    jobId:    'job-002',
  });

  assert.equal(result.outcome, 'reuse');
  assert.equal(result.publicServerUrl, 'https://existing.sgtm.easytrac.io');
  // No new job doc should be written
  assert.ok(!_docs['provisioning_jobs/job-002'], 'no job doc should be written on reuse');
});

test('createManagedServerJobTx: outcome=attach when provisioning within attach window', async () => {
  resetDocs();
  const existingJobId = 'job-existing';
  _docs['managed_servers/client-inprogress'] = {
    clientId:  'client-inprogress',
    status:    'provisioning',
    jobId:     existingJobId,
    updatedAt: _ts(Date.now() - 5_000),  // 5s ago — within 35-min window
  };

  const { createManagedServerJobTx } = loadFirestoreService();
  const result = await createManagedServerJobTx({
    clientId: 'client-inprogress',
    jobId:    'job-003',
  });

  assert.equal(result.outcome, 'attach');
  assert.equal(result.jobId, existingJobId, 'must return the existing in-progress jobId');
});

test('createManagedServerJobTx: outcome=resume when provisioning past attach window', async () => {
  resetDocs();
  _docs['managed_servers/client-stale'] = {
    clientId:  'client-stale',
    status:    'provisioning',
    jobId:     'job-old',
    updatedAt: _ts(Date.now() - 40 * 60 * 1000),  // 40 min ago — past 35-min window
  };

  const { createManagedServerJobTx } = loadFirestoreService();
  const result = await createManagedServerJobTx({
    clientId: 'client-stale',
    jobId:    'job-004',
    shardId:  'prod-1',
  });

  assert.equal(result.outcome, 'resume');
  assert.equal(result.jobId, 'job-004', 'new jobId is used for the resumed attempt');
  const serverDoc = _docs['managed_servers/client-stale'];
  assert.ok(serverDoc.status === 'provisioning');
  assert.equal(serverDoc.jobId, 'job-004');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. saveManagedServer — defaults applied
// ═══════════════════════════════════════════════════════════════════════════════

test('saveManagedServer: sets status=provisioning and updatedAt by default', async () => {
  resetDocs();
  const { saveManagedServer } = loadFirestoreService();

  const record = await saveManagedServer({
    clientId: 'client-save',
    shardId:  'prod-1',
    slug:     'aabbccdd1122',
  });

  assert.equal(record.status, 'provisioning');
  assert.ok(record.updatedAt, 'updatedAt must be set');
  assert.equal(_docs['managed_servers/client-save'].slug, 'aabbccdd1122');
});

test('saveManagedServer: throws when clientId is missing', async () => {
  resetDocs();
  const { saveManagedServer } = loadFirestoreService();
  await assert.rejects(
    () => saveManagedServer({ shardId: 'prod-1' }),
    /clientId is required/,
  );
});

test('saveManagedServer: throws when shardId is missing', async () => {
  resetDocs();
  const { saveManagedServer } = loadFirestoreService();
  await assert.rejects(
    () => saveManagedServer({ clientId: 'c1' }),
    /shardId is required/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. appendDeploymentLog — log capped at 50 entries
// ═══════════════════════════════════════════════════════════════════════════════

test('appendDeploymentLog: adds entry to logs array', async () => {
  resetDocs();
  const { appendDeploymentLog } = loadFirestoreService();
  const depId = 'dep-001';
  _docs[`managed_deployments/${depId}`] = {
    clientId: 'c1',
    logs: [],
    status: 'running',
  };

  const logs = await appendDeploymentLog(depId, { step: 'create-gtm', level: 'info', message: 'GTM container created' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'GTM container created');
  assert.equal(logs[0].step, 'create-gtm');
});

test('appendDeploymentLog: keeps only last 50 entries', async () => {
  resetDocs();
  const { appendDeploymentLog } = loadFirestoreService();
  const depId = 'dep-cap';
  // Pre-fill 50 entries
  _docs[`managed_deployments/${depId}`] = {
    clientId: 'c1',
    logs: Array.from({ length: 50 }, (_, i) => ({ step: 'step', level: 'info', message: `entry ${i}` })),
    status: 'running',
  };

  const logs = await appendDeploymentLog(depId, { message: 'entry 51' });
  assert.equal(logs.length, 50, 'log array must be capped at 50');
  assert.equal(logs[logs.length - 1].message, 'entry 51', 'newest entry must be last');
  assert.equal(logs[0].message, 'entry 1', 'oldest entry (entry 0) must be dropped');
});

test('appendDeploymentLog: throws NOT_FOUND when deployment does not exist', async () => {
  resetDocs();
  const { appendDeploymentLog } = loadFirestoreService();
  await assert.rejects(
    () => appendDeploymentLog('nonexistent-dep', { message: 'hi' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});
