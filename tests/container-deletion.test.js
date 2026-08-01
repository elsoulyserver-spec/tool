// tests/container-deletion.test.js
// Guards + honest partial-failure + provider-unavailable behavior for the
// container-deletion service, plus the task-owned infrastructure adapter.
// All infra is stubbed via deps.infra — NO real infrastructure is touched, and
// NO managed-hosting WIP module is loaded.
//
// Run: node --test tests/container-deletion.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const { deleteClientContainer, previewCleanup } = require('../lib/container-deletion-service');

delete process.env.TRIAL_LAUNCH_AT; // fixtures derive purely from created_at

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-20T00:00:00Z');
const EXPIRED_UNPAID = { id: 'c1', created_at: new Date(NOW.getTime() - 10 * DAY) };

// Build a stub adapter + deps recording all side effects.
function makeDeps(o = {}) {
  const audit = [];
  const state = { containerPatch: null };
  const calls = { cloudRun: [], route: [], server: [], container: [] };
  const providerAvailable = o.providerAvailable !== false; // default true

  function resources() {
    const out = [];
    for (const s of (o.servers || [])) {
      if (s.taggingServiceName) out.push({ type: 'cloud_run', id: s.taggingServiceName, payload: s });
      if (s.hostname)           out.push({ type: 'managed_route', id: s.hostname, payload: s });
      out.push({ type: 'managed_server', id: s.id, payload: s });
    }
    for (const c of (o.containers || [])) out.push({ type: 'managed_container', id: c.gtmPublicId, payload: c });
    return out;
  }

  const infra = {
    async resolveClientInfrastructure() { return { resources: resources(), providerAvailable }; },
    async deleteCloudRunService(r) {
      calls.cloudRun.push(r.id);
      if (o.cloudRunFails) return { ok: false, reason: 'provider_error', error: 'boom' };
      return { ok: true };
    },
    async deleteManagedRoute(r) { calls.route.push(r.id); return { ok: true }; },
    async markManagedContainerDeleted(r) {
      (r.type === 'managed_server' ? calls.server : calls.container).push(r.id);
      return { ok: true };
    },
  };

  const deps = {
    now: () => NOW,
    adminId: 'super-admin',
    getClient: async () => o.client === undefined ? EXPIRED_UNPAID : o.client,
    updateClientContainerStatus: async (uid, patch) => { state.containerPatch = { uid, patch }; },
    saveAuditLog: async (rec) => { audit.push(rec); },
    infra,
  };
  return { deps, audit, state, calls };
}

// ── Guards ──────────────────────────────────────────────────────────────────
test('rejects before the trial has expired', async () => {
  const { deps, calls } = makeDeps({ client: { id: 'c1', created_at: new Date(NOW.getTime() - 2 * DAY) },
    servers: [{ id: 's1', taggingServiceName: 'svc', hostname: 'h' }] });
  const r = await deleteClientContainer({ clientId: 'c1' }, deps);
  assert.equal(r.status, 'rejected'); assert.equal(r.code, 'not_expired');
  assert.equal(calls.cloudRun.length, 0);
});

test('rejects for a paid client', async () => {
  const { deps } = makeDeps({ client: { id: 'c1', created_at: new Date(NOW.getTime() - 10 * DAY), paidAt: new Date(NOW.getTime() - DAY) } });
  const r = await deleteClientContainer({ clientId: 'c1' }, deps);
  assert.equal(r.status, 'rejected'); assert.equal(r.code, 'paid');
});

test('rejects when client not found', async () => {
  const { deps } = makeDeps({ client: null });
  const r = await deleteClientContainer({ clientId: 'ghost' }, deps);
  assert.equal(r.status, 'rejected'); assert.equal(r.code, 'not_found');
});

test('already-deleted is idempotent success (no side effects)', async () => {
  const { deps, calls, state } = makeDeps({ client: { id: 'c1', created_at: new Date(NOW.getTime() - 10 * DAY), containerStatus: 'deleted' } });
  const r = await deleteClientContainer({ clientId: 'c1' }, deps);
  assert.equal(r.ok, true); assert.equal(r.status, 'already_deleted');
  assert.equal(calls.cloudRun.length, 0); assert.equal(state.containerPatch, null);
});

// ── Happy path + failures ──────────────────────────────────────────────────
test('happy path: deletes all resources and marks the client deleted', async () => {
  const { deps, calls, state, audit } = makeDeps({
    client: EXPIRED_UNPAID,
    servers: [{ id: 's1', taggingServiceName: 'svc-1', hostname: 'shop.sgtm.easytrac.io' }],
    containers: [{ gtmPublicId: 'GTM-ABC123' }],
  });
  const r = await deleteClientContainer({ clientId: 'c1', adminId: 'super-admin' }, deps);
  assert.equal(r.status, 'deleted');
  assert.deepEqual(calls.cloudRun, ['svc-1']);
  assert.deepEqual(calls.route, ['shop.sgtm.easytrac.io']);
  assert.deepEqual(calls.container, ['GTM-ABC123']);
  assert.deepEqual(calls.server, ['s1']);
  assert.equal(state.containerPatch.patch.containerStatus, 'deleted');
  assert.ok(audit.map(a => a.action).includes('container_delete_completed'));
});

test('no resources → clean success', async () => {
  const { deps, state } = makeDeps({ client: EXPIRED_UNPAID, servers: [], containers: [] });
  const r = await deleteClientContainer({ clientId: 'c1' }, deps);
  assert.equal(r.status, 'deleted');
  assert.equal(state.containerPatch.patch.containerStatus, 'deleted');
});

test('partial failure is honest and does NOT mark the client deleted', async () => {
  const { deps, state, audit } = makeDeps({
    client: EXPIRED_UNPAID,
    servers: [{ id: 's1', taggingServiceName: 'svc-1', hostname: 'h' }],
    containers: [{ gtmPublicId: 'GTM-ABC123' }],
    cloudRunFails: true,
  });
  const r = await deleteClientContainer({ clientId: 'c1' }, deps);
  assert.equal(r.status, 'partial_failure');
  assert.ok(r.failures.some(f => f.resource === 'cloud_run'));
  assert.equal(state.containerPatch, null);
  assert.ok(audit.map(a => a.action).includes('container_delete_failed'));
});

// ── Provider unavailable (Decision 1) ──────────────────────────────────────────
test('provider unavailable + cloud_run present → non-destructive abort, nothing marked', async () => {
  const { deps, calls, state, audit } = makeDeps({
    client: EXPIRED_UNPAID,
    servers: [{ id: 's1', taggingServiceName: 'svc-1', hostname: 'h' }],
    containers: [{ gtmPublicId: 'GTM-ABC123' }],
    providerAvailable: false,
  });
  const r = await deleteClientContainer({ clientId: 'c1' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'provider_unavailable');
  // NOTHING deleted, client NOT marked deleted.
  assert.equal(calls.cloudRun.length, 0);
  assert.equal(calls.route.length, 0);
  assert.equal(calls.container.length, 0);
  assert.equal(state.containerPatch, null);
  assert.ok(audit.map(a => a.action).includes('container_delete_failed'));
});

// ── Preview (read-only, works with or without provider) ─────────────────────────
test('preview: eligible, read-only, no writes; works with provider UNAVAILABLE', async () => {
  const { deps, state, calls, audit } = makeDeps({
    client: EXPIRED_UNPAID,
    servers: [{ id: 's1', taggingServiceName: 'svc-1', hostname: 'h' }],
    containers: [{ gtmPublicId: 'GTM-ABC123' }],
    providerAvailable: false,
  });
  const r = await previewCleanup({ clientId: 'c1' }, deps);
  assert.equal(r.eligible, true);
  assert.equal(r.providerAvailable, false);
  assert.ok(r.resources.length >= 3);
  // read-only
  assert.equal(calls.cloudRun.length, 0);
  assert.equal(state.containerPatch, null);
  assert.equal(audit.length, 0);
});

test('preview: never leaks secrets; resources expose only type/id/exists', async () => {
  const { deps } = makeDeps({
    client: EXPIRED_UNPAID,
    servers: [{ id: 's1', taggingServiceName: 'svc-1', hostname: 'h',
      saKeyJson: 'SUPER_SECRET_PEM', accessToken: 'ya29.SECRET', authHeader: 'GTM_AUTH_SECRET' }],
    containers: [{ gtmPublicId: 'GTM-ABC123' }],
  });
  const r = await previewCleanup({ clientId: 'c1' }, deps);
  const blob = JSON.stringify(r);
  for (const s of ['SUPER_SECRET_PEM', 'ya29.SECRET', 'GTM_AUTH_SECRET', 'saKeyJson', 'accessToken']) {
    assert.ok(!blob.includes(s), `leaked ${s}`);
  }
  for (const res of r.resources) assert.deepEqual(Object.keys(res).sort(), ['exists', 'id', 'type']);
});

test('preview: reasons mirror the real guards', async () => {
  const a = await previewCleanup({ clientId: 'c1' }, makeDeps({ client: { id: 'c1', created_at: new Date(NOW.getTime() - 2 * DAY) } }).deps);
  assert.deepEqual([a.eligible, a.reason], [false, 'trial_not_expired']);
  const p = await previewCleanup({ clientId: 'c1' }, makeDeps({ client: { id: 'c1', created_at: new Date(NOW.getTime() - 10 * DAY), paidAt: new Date() } }).deps);
  assert.deepEqual([p.eligible, p.reason], [false, 'paid_customer']);
  const g = await previewCleanup({ clientId: 'c1' }, makeDeps({ client: { id: 'c1', created_at: new Date(NOW.getTime() - 10 * DAY), containerStatus: 'deleted' } }).deps);
  assert.deepEqual([g.eligible, g.reason], [false, 'already_deleted']);
});

// ── Adapter: no WIP dependency; provider injection ──────────────────────────────
test('adapter + deletion service require NO managed-hosting WIP module', () => {
  const root = path.resolve(__dirname, '..');
  const srcs = ['lib/container-infrastructure-adapter.js', 'lib/container-deletion-service.js']
    .map(f => fs.readFileSync(path.join(root, f), 'utf8'));
  for (const src of srcs) {
    assert.ok(!/require\(['"][^'"]*shard-registry['"]\)/.test(src), 'must not require shard-registry');
    assert.ok(!/require\(['"][^'"]*cloud-run-service['"]\)/.test(src), 'must not require cloud-run-service');
    assert.ok(!/require\(['"][^'"]*provision[^'"]*['"]\)/.test(src), 'must not require provision/* WIP');
  }
});

test('adapter loads standalone and defaults to provider_unavailable', async () => {
  const adapter = require('../lib/container-infrastructure-adapter');
  assert.equal(adapter.isCloudRunProviderAvailable(), false);
  assert.deepEqual(await adapter.deleteCloudRunService({ id: 'svc' }), { ok: false, reason: 'provider_unavailable' });
  // Injection works (used by a future managed-hosting commit).
  let called = null;
  adapter.setCloudRunProvider(async (p) => { called = p; });
  assert.equal(adapter.isCloudRunProviderAvailable(), true);
  assert.deepEqual(await adapter.deleteCloudRunService({ id: 'svc', payload: { taggingServiceName: 'svc' } }), { ok: true });
  assert.deepEqual(called, { taggingServiceName: 'svc' });
  adapter.setCloudRunProvider(null); // reset for other tests
  assert.equal(adapter.isCloudRunProviderAvailable(), false);
});
