'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// CONTAINER DELETION SERVICE — tears down an EXPIRED + UNPAID client's
// EasyTrac-provisioned managed infrastructure.
//
// Scope (locked): the managed sGTM hosting only — Cloud Run tagging service,
// edge managed_route, and managed_containers docs → 'deleted'. It does NOT
// hard-delete the GTM container via the GTM API, and NEVER deletes the customer
// account / clients doc.
//
// All infrastructure access is delegated to an injected adapter
// (deps.infra, see lib/container-infrastructure-adapter.js) so this service is
// unit-testable and carries NO dependency on managed-hosting WIP modules.
//
// Safety:
//  • Preflight — if any Cloud Run resource exists but the provider is
//    unavailable, we abort with `provider_unavailable` and delete NOTHING.
//  • Honest partial failure — if any resource fails mid-run, the client is NOT
//    marked deleted and the failing resources are reported individually.
// ══════════════════════════════════════════════════════════════════════════════

const { computeTrial } = require('./trial-service');

// Map an adapter resource to its deletion op.
async function _deleteOne(entry, infra) {
  try {
    let r;
    switch (entry.type) {
      case 'cloud_run':        r = await infra.deleteCloudRunService(entry); break;
      case 'managed_route':    r = await infra.deleteManagedRoute(entry); break;
      case 'managed_container':
      case 'managed_server':   r = await infra.markManagedContainerDeleted(entry); break;
      default: throw new Error('unknown resource type: ' + entry.type);
    }
    r = r || { ok: true };
    return { resource: entry.type, id: entry.id, ok: !!r.ok, error: r.ok ? null : (r.reason || r.error || 'failed') };
  } catch (err) {
    return { resource: entry.type, id: entry.id, ok: false, error: err.message || String(err) };
  }
}

async function deleteClientContainer(input, deps) {
  const { clientId, adminId } = input || {};
  const infra = deps && deps.infra;
  const now = (deps && deps.now) || (() => new Date());
  const audit = async (action, success, metadata) => {
    if (!deps || !deps.saveAuditLog) return;
    try {
      await deps.saveAuditLog({
        action, clientId: clientId || null, adminId: adminId || null,
        occurredAt: now().toISOString(), success: !!success, metadata: metadata || {},
      });
    } catch (_) { /* audit must never break the operation */ }
  };

  if (!clientId) return { ok: false, status: 'rejected', code: 'bad_request', message: 'clientId is required' };
  if (!infra)    return { ok: false, status: 'rejected', code: 'adapter_missing', message: 'infrastructure adapter is required' };

  // (1)+(2) Load + verify existence.
  const client = await deps.getClient(clientId);
  if (!client) return { ok: false, status: 'rejected', code: 'not_found', message: 'Client not found', clientId };

  // (3) Idempotency: already torn down.
  if (client.containerStatus === 'deleted') {
    return { ok: true, status: 'already_deleted', clientId, results: [], deletedResources: [] };
  }

  // (4)+(5) Guards.
  const trial = computeTrial(client, now());
  if (trial.paymentStatus !== 'unpaid') return { ok: false, status: 'rejected', code: 'paid', message: 'Client is paid — deletion not allowed', clientId };
  if (trial.trialStatus !== 'expired')  return { ok: false, status: 'rejected', code: 'not_expired', message: 'Trial has not expired', clientId, trialStatus: trial.trialStatus };

  // (6) Resolve resources via the adapter (read-only).
  const { resources, providerAvailable } = await infra.resolveClientInfrastructure(clientId);

  // (7) Non-destructive preflight: refuse to start a teardown we cannot finish.
  const needsProvider = resources.some(r => r.type === 'cloud_run');
  if (needsProvider && !providerAvailable) {
    await audit('container_delete_failed', false, { reason: 'provider_unavailable', resourceCount: resources.length });
    return {
      ok: false, status: 'provider_unavailable', clientId,
      message: 'Cloud Run provider unavailable — no resources were deleted',
      resources: resources.map(r => ({ type: r.type, id: r.id })),
    };
  }

  await audit('container_delete_started', true, { resourceCount: resources.length });

  // (8) Delete each; record individual results.
  const results = [];
  for (const entry of resources) results.push(await _deleteOne(entry, infra));

  const failures = results.filter(r => !r.ok);
  const deletedResources = results.filter(r => r.ok).map(r => ({ resource: r.resource, id: r.id }));

  // (9)+(10) Only a fully-clean run flips the client to 'deleted'.
  if (failures.length === 0) {
    await deps.updateClientContainerStatus(clientId, {
      containerStatus: 'deleted', containerDeletedBy: adminId || null, deletedResources,
    });
    await audit('container_delete_completed', true, { deletedResources });
    return { ok: true, status: 'deleted', clientId, results, deletedResources };
  }

  await audit('container_delete_failed', false, { results, failures });
  return {
    ok: false, status: 'partial_failure', clientId, results, deletedResources, failures,
    message: 'One or more resources failed to delete; client not marked deleted',
  };
}

// Read-only dry run — reports eligibility + the resources a real deletion WOULD
// remove. Performs NO writes and NO infra mutations (adapter resolve is read-only).
// Exposes only type/id/exists — never provider payloads/credentials.
async function previewCleanup(input, deps) {
  const { clientId } = input || {};
  const infra = deps && deps.infra;
  const now = (deps && deps.now) || (() => new Date());
  if (!clientId) return { eligible: false, reason: 'bad_request' };
  if (!infra)    return { eligible: false, reason: 'adapter_missing' };

  const client = await deps.getClient(clientId);
  if (!client) return { eligible: false, reason: 'not_found' };

  const trial = computeTrial(client, now());
  const base = { paymentStatus: trial.paymentStatus, trialStatus: trial.trialStatus, containerStatus: trial.containerStatus };

  if (client.containerStatus === 'deleted') return { eligible: false, reason: 'already_deleted', ...base };
  if (trial.paymentStatus !== 'unpaid')     return { eligible: false, reason: 'paid_customer', ...base };
  if (trial.trialStatus !== 'expired')      return { eligible: false, reason: 'trial_not_expired', ...base };

  const { resources, providerAvailable } = await infra.resolveClientInfrastructure(clientId);
  return {
    eligible: true, reason: null, ...base,
    providerAvailable: !!providerAvailable,
    resources: resources.map(r => ({ type: r.type, id: r.id, exists: true })),
  };
}

module.exports = { deleteClientContainer, previewCleanup };
