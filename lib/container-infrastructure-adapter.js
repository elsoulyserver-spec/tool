'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// CONTAINER INFRASTRUCTURE ADAPTER
//
// Task-owned seam between the container-deletion service and the managed-hosting
// infrastructure. It exposes only the minimal interface the deletion service
// needs and depends ONLY on committed firestore APIs — it never statically or
// lazily require()s any untracked/WIP module. The app and all admin routes load
// with no dependency on the managed-hosting WIP.
//
// The Cloud Run teardown is provided by an OPTIONAL, runtime-injected provider
// (setCloudRunProvider). When no provider is injected — e.g. before the
// managed-hosting modules are committed — Cloud Run deletion reports
// `provider_unavailable` and NOTHING is destroyed. A future commit that adds the
// real provider calls setCloudRunProvider(fn); this file does not change.
//
// Interface:
//   resolveClientInfrastructure(clientId) -> { resources:[{type,id,payload}], providerAvailable }
//   deleteCloudRunService(resource)       -> { ok, reason?, error? }
//   deleteManagedRoute(resource)          -> { ok }
//   markManagedContainerDeleted(resource) -> { ok }
//   setCloudRunProvider(fn) / isCloudRunProviderAvailable()
// ══════════════════════════════════════════════════════════════════════════════

const firestore = require('../firestore-service');

// Optional, runtime-injected Cloud Run teardown provider: async (payload) => void.
let _cloudRunProvider = null;
function setCloudRunProvider(fn) { _cloudRunProvider = (typeof fn === 'function') ? fn : null; }
function isCloudRunProviderAvailable() { return typeof _cloudRunProvider === 'function'; }

// Best-effort hostname for the edge route tied to a managed server.
function _routeHostname(server) {
  if (!server) return null;
  if (server.hostname) return String(server.hostname).trim().toLowerCase();
  if (server.routeHostname) return String(server.routeHostname).trim().toLowerCase();
  const url = server.publicServerUrl || server.taggingRunUrl;
  if (url) { try { return new URL(url).hostname.toLowerCase(); } catch (_) { /* ignore */ } }
  return null;
}

// Read-only: list the client's managed resources using committed firestore APIs.
async function resolveClientInfrastructure(clientId) {
  const servers    = (await firestore.listManagedServersByClient(clientId)) || [];
  const containers = (await firestore.listContainersByClient(clientId)) || [];
  const resources = [];
  const seen = new Set();
  const push = (type, id, payload) => {
    if (!id) return;
    const key = type + ':' + id;
    if (seen.has(key)) return;
    seen.add(key);
    resources.push({ type, id, payload });
  };
  for (const s of servers) {
    push('cloud_run', s.taggingServiceName || s.serviceName, s);
    push('managed_route', _routeHostname(s), s);
    push('managed_server', s.id || s.clientId, s);
  }
  for (const c of containers) push('managed_container', c.gtmPublicId, c);
  return { resources, providerAvailable: isCloudRunProviderAvailable() };
}

// Destructive ops — each returns a controlled result; never throws for a missing
// provider (honest, non-destructive).
async function deleteCloudRunService(resource) {
  if (!_cloudRunProvider) return { ok: false, reason: 'provider_unavailable' };
  try { await _cloudRunProvider(resource && resource.payload ? resource.payload : resource); return { ok: true }; }
  catch (e) { return { ok: false, reason: 'provider_error', error: e.message || String(e) }; }
}

async function deleteManagedRoute(resource) {
  await firestore.deleteManagedRoute(resource.id);
  return { ok: true };
}

async function markManagedContainerDeleted(resource) {
  if (resource.type === 'managed_server') await firestore.markManagedServerDeleted(resource.id);
  else await firestore.markContainerDeleted(resource.id);
  return { ok: true };
}

module.exports = {
  resolveClientInfrastructure,
  deleteCloudRunService,
  deleteManagedRoute,
  markManagedContainerDeleted,
  setCloudRunProvider,
  isCloudRunProviderAvailable,
  _routeHostname,
};
