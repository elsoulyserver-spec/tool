// tests/managed-registry.test.js
// Unit tests for managed sGTM hosting registry helpers in firestore-service.js
// Run: node --test tests/managed-registry.test.js

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let store;
let counter;
let servicePath;
let adminPath;
let originalAdminCache;

class FakeSnap {
  constructor(id, data) {
    this.id = id;
    this._data = data;
    this.exists = data !== undefined;
  }
  data() { return this._data; }
}

class FakeQuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
  forEach(fn) { this.docs.forEach(fn); }
}

class FakeDocRef {
  constructor(collectionName, id) {
    this.collectionName = collectionName;
    this.id = id || `auto-${++counter}`;
  }
  async set(data, opts = {}) {
    const coll = store[this.collectionName] || (store[this.collectionName] = new Map());
    const prev = opts.merge ? (coll.get(this.id) || {}) : {};
    coll.set(this.id, { ...prev, ...data });
  }
  async get() {
    const coll = store[this.collectionName] || new Map();
    return new FakeSnap(this.id, coll.get(this.id));
  }
  async update(data) {
    const coll = store[this.collectionName] || (store[this.collectionName] = new Map());
    const prev = coll.get(this.id);
    if (!prev) throw new Error(`missing doc: ${this.id}`);
    coll.set(this.id, { ...prev, ...data });
  }
  async delete() {
    const coll = store[this.collectionName] || new Map();
    coll.delete(this.id);
  }
}

class FakeQuery {
  constructor(collectionName, filters = [], order = null, size = null) {
    this.collectionName = collectionName;
    this.filters = filters;
    this.order = order;
    this.size = size;
  }
  where(field, op, value) {
    return new FakeQuery(this.collectionName, this.filters.concat({ field, op, value }), this.order, this.size);
  }
  orderBy(field, dir) {
    return new FakeQuery(this.collectionName, this.filters, { field, dir }, this.size);
  }
  limit(size) {
    return new FakeQuery(this.collectionName, this.filters, this.order, size);
  }
  async get() {
    const coll = store[this.collectionName] || new Map();
    let rows = Array.from(coll.entries()).map(([id, data]) => new FakeSnap(id, data));
    for (const f of this.filters) {
      rows = rows.filter(s => {
        const actual = s.data()[f.field];
        if (f.op === '==') return actual === f.value;
        if (f.op === '!=') return actual !== f.value;
        throw new Error(`unsupported op: ${f.op}`);
      });
    }
    if (this.order) {
      const { field, dir } = this.order;
      rows.sort((a, b) => {
        const av = a.data()[field];
        const bv = b.data()[field];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (dir === 'desc' ? -1 : 1);
      });
    }
    if (this.size) rows = rows.slice(0, this.size);
    return new FakeQuerySnap(rows);
  }
}

class FakeCollection extends FakeQuery {
  constructor(name) {
    super(name);
    this.name = name;
  }
  doc(id) { return new FakeDocRef(this.name, id); }
  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

function makeFakeAdmin() {
  function firestore() { return fakeDb; }
  const fakeDb = {
    collection(name) { return new FakeCollection(name); },
    settings() {},
    async runTransaction(fn) {
      const tx = {
        get: ref => ref.get(),
        set: (ref, data, opts) => ref.set(data, opts),
        update: (ref, data) => ref.update(data),
      };
      return fn(tx);
    },
  };
  firestore.FieldValue = { serverTimestamp: () => SERVER_TS };
  firestore.Timestamp = { fromMillis: ms => ({ __timestamp: ms, toMillis: () => ms }) };
  return {
    apps: [],
    credential: { cert: () => ({}) },
    initializeApp() { this.apps.push({}); },
    firestore,
  };
}

const SERVER_TS = { __serverTimestamp: true };

function loadService() {
  delete require.cache[servicePath];
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: makeFakeAdmin(),
  };
  process.env.FIREBASE_SA_KEY_JSON = JSON.stringify({ project_id: 'p', private_key: 'pk' });
  const svc = require('../firestore-service');
  svc._fakeStore = store;
  return svc;
}

beforeEach(() => {
  store = {};
  counter = 0;
  servicePath = require.resolve('../firestore-service');
  adminPath = require.resolve('firebase-admin');
  originalAdminCache = require.cache[adminPath];
  delete require.cache[servicePath];
});

afterEach(() => {
  delete require.cache[servicePath];
  if (originalAdminCache) require.cache[adminPath] = originalAdminCache;
  else delete require.cache[adminPath];
  delete process.env.FIREBASE_SA_KEY_JSON;
});

test('saveManagedServer stores tenant to shard and Cloud Run service metadata', async () => {
  const svc = loadService();
  const saved = await svc.saveManagedServer({
    clientId: 'client-1',
    shardId: 'prod-1',
    serviceSlug: 'abc123def456',
    taggingServiceName: 'sgtm-abc123def456-tag',
    previewServiceName: 'sgtm-abc123def456-prev',
    publicUrl: 'https://abc123def456.sgtm.easytrac.io',
  });

  assert.equal(saved.id, 'client-1');
  assert.equal(saved.status, 'provisioning');
  const loaded = await svc.getManagedServer('client-1');
  assert.equal(loaded.shardId, 'prod-1');
  assert.equal(loaded.taggingServiceName, 'sgtm-abc123def456-tag');
});

test('listManagedServersByClient excludes deleted servers by default', async () => {
  const svc = loadService();
  await svc.saveManagedServer({ clientId: 'client-1', shardId: 'prod-1', status: 'active' });
  await svc.saveManagedServer({ clientId: 'client-2', shardId: 'prod-1', status: 'deleted' });

  const active = await svc.listManagedServersByClient('client-2');
  assert.equal(active.length, 0);
  const all = await svc.listManagedServersByClient('client-2', { includeDeleted: true });
  assert.equal(all.length, 1);
});

test('_managedServerTransition rejects invalid deleted to active transition', () => {
  const svc = loadService();
  assert.throws(
    () => svc._managedServerTransition({ status: 'deleted' }, { status: 'active' }),
    (err) => {
      assert.equal(err.code, 'INVALID_SERVER_TRANSITION');
      return true;
    },
  );
});

test('createManagedServerJobTx creates one provisioning server and job doc', async () => {
  const svc = loadService();
  const result = await svc.createManagedServerJobTx({
    clientId: 'client-1',
    email: 'owner@example.com',
    jobId: 'job-1',
    shardId: 'prod-1',
    server: { slug: 'abc123def456' },
  });

  assert.equal(result.outcome, 'created');
  assert.equal(result.jobId, 'job-1');
  assert.equal(store.managed_servers.get('client-1').status, 'provisioning');
  assert.equal(store.managed_servers.get('client-1').jobId, 'job-1');
  assert.equal(store.provisioning_jobs.get('job-1').jobType, 'managed_server');
});

test('createManagedServerJobTx reuses an active managed server', async () => {
  const svc = loadService();
  await svc.saveManagedServer({
    clientId: 'client-1',
    shardId: 'prod-1',
    status: 'active',
    publicServerUrl: 'https://abc.sgtm.easytrac.io',
  });

  const result = await svc.createManagedServerJobTx({
    clientId: 'client-1',
    jobId: 'job-2',
    shardId: 'prod-1',
  });

  assert.equal(result.outcome, 'reuse');
  assert.equal(result.publicServerUrl, 'https://abc.sgtm.easytrac.io');
  assert.equal(store.provisioning_jobs, undefined);
});

test('createManagedServerJobTx attaches to a fresh in-flight job', async () => {
  const svc = loadService();
  await svc.saveManagedServer({
    clientId: 'client-1',
    shardId: 'prod-1',
    status: 'provisioning',
    jobId: 'job-existing',
  });
  store.managed_servers.get('client-1').updatedAt = { toMillis: () => Date.now() };

  const result = await svc.createManagedServerJobTx({
    clientId: 'client-1',
    jobId: 'job-new',
    shardId: 'prod-1',
  });

  assert.equal(result.outcome, 'attach');
  assert.equal(result.jobId, 'job-existing');
  assert.equal(store.provisioning_jobs, undefined);
});

test('saveManagedRoute normalizes hostnames and maps them to clients', async () => {
  const svc = loadService();
  await svc.saveManagedRoute({
    hostname: 'Store.Example.COM ',
    clientId: 'client-1',
    serverId: 'client-1',
    routeType: 'custom_domain',
  });

  const route = await svc.getManagedRoute('store.example.com');
  assert.equal(route.hostname, 'store.example.com');
  assert.equal(route.clientId, 'client-1');
  assert.equal(route.status, 'active');
});

test('deleteManagedRoute removes the route document', async () => {
  const svc = loadService();
  await svc.saveManagedRoute({ hostname: 'abc.sgtm.easytrac.io', clientId: 'client-1' });
  assert.ok(await svc.getManagedRoute('abc.sgtm.easytrac.io'));
  await svc.deleteManagedRoute('abc.sgtm.easytrac.io');
  assert.equal(await svc.getManagedRoute('abc.sgtm.easytrac.io'), null);
});

test('saveManagedDeployment creates queued deployment records', async () => {
  const svc = loadService();
  const dep = await svc.saveManagedDeployment({
    clientId: 'client-1',
    serverId: 'client-1',
    shardId: 'prod-1',
    reason: 'initial_provision',
  });

  assert.equal(dep.id, 'auto-1');
  assert.equal(dep.status, 'queued');
  const loaded = await svc.getManagedDeployment(dep.id);
  assert.equal(loaded.clientId, 'client-1');
});

test('createDeployment opens running append-only deployment history record', async () => {
  const svc = loadService();
  const dep = await svc.createDeployment({
    clientId: 'client-1',
    jobId: 'job-1',
    shard: 'prod-1',
    trigger: 'create-server',
  });

  assert.equal(dep.status, 'running');
  assert.equal(dep.deploymentId, dep.id);
  assert.deepEqual(dep.logs, []);
});

test('appendDeploymentLog caps logs at 50 and strips oversized messages', async () => {
  const svc = loadService();
  const dep = await svc.createDeployment({ clientId: 'client-1' });
  for (let i = 0; i < 55; i++) {
    await svc.appendDeploymentLog(dep.id, { step: 's', message: 'x'.repeat(600), level: 'info' });
  }

  const loaded = await svc.getManagedDeployment(dep.id);
  assert.equal(loaded.logs.length, 50);
  assert.equal(loaded.logs[0].message.length, 500);
});

test('finalizeDeployment marks deployment succeeded by default', async () => {
  const svc = loadService();
  const dep = await svc.createDeployment({ clientId: 'client-1' });
  const finalPatch = await svc.finalizeDeployment(dep.id, {
    publicServerUrl: 'https://abc.sgtm.easytrac.io',
  });

  assert.equal(finalPatch.status, 'succeeded');
  const loaded = await svc.getManagedDeployment(dep.id);
  assert.equal(loaded.status, 'succeeded');
  assert.equal(loaded.publicServerUrl, 'https://abc.sgtm.easytrac.io');
});

test('transitionManagedDeployment atomically advances allowed states', async () => {
  const svc = loadService();
  const dep = await svc.saveManagedDeployment({
    clientId: 'client-1',
    serverId: 'client-1',
    shardId: 'prod-1',
  });

  const next = await svc.transitionManagedDeployment(dep.id, 'deploying_preview', {
    previewServiceName: 'sgtm-abc-prev',
  });

  assert.equal(next.status, 'deploying_preview');
  assert.equal(next.previewServiceName, 'sgtm-abc-prev');
  const loaded = await svc.getManagedDeployment(dep.id);
  assert.equal(loaded.status, 'deploying_preview');
  assert.equal(loaded.previewServiceName, 'sgtm-abc-prev');
});

test('transitionManagedDeployment rejects invalid state jumps', async () => {
  const svc = loadService();
  const dep = await svc.saveManagedDeployment({
    clientId: 'client-1',
    serverId: 'client-1',
    shardId: 'prod-1',
  });

  await assert.rejects(
    () => svc.transitionManagedDeployment(dep.id, 'active'),
    (err) => {
      assert.equal(err.code, 'INVALID_STATE_TRANSITION');
      assert.equal(err.from, 'queued');
      assert.equal(err.to, 'active');
      return true;
    },
  );
});

test('listManagedDeployments returns most recent deployments first', async () => {
  const svc = loadService();
  await svc.saveManagedDeployment({
    id: 'dep-old',
    clientId: 'client-1',
    serverId: 'client-1',
    shardId: 'prod-1',
    createdAt: 1,
  });
  await svc.saveManagedDeployment({
    id: 'dep-new',
    clientId: 'client-1',
    serverId: 'client-1',
    shardId: 'prod-1',
    createdAt: 2,
  });

  const rows = await svc.listManagedDeployments('client-1');
  assert.deepEqual(rows.map(r => r.id), ['dep-new', 'dep-old']);
});

test('listDeployments returns deployment history ordered by startedAt', async () => {
  const svc = loadService();
  await svc.createDeployment({
    deploymentId: 'dep-old',
    clientId: 'client-1',
    startedAt: 1,
  });
  await svc.createDeployment({
    deploymentId: 'dep-new',
    clientId: 'client-1',
    startedAt: 2,
  });

  const rows = await svc.listDeployments('client-1');
  assert.deepEqual(rows.map(r => r.id), ['dep-new', 'dep-old']);
});
