'use strict';

const firestoreService = require('../firestore-service');

// Returns the full ClientProfileResponse bundle.
// Fetches in parallel: client doc, SS config (redacted), containers, health cache, platform health.
// Email comes from Firebase Auth; stats/diagnostics are Phase 2.
async function getBundle(clientId, isAdmin) {
  const [
    client,
    ssCfg,
    containers,
    healthCache,
    platformHealth,
    authUser,
  ] = await Promise.all([
    firestoreService.getClient(clientId),
    firestoreService.getSSConfigPublic(clientId),
    firestoreService.listContainersByClient(clientId),
    firestoreService.getHealthCache(clientId),
    firestoreService.getPlatformHealth(),
    firestoreService.getAuthUser(clientId),
  ]);

  if (!client) return null;

  const activeContainers = (containers || []).map(c => ({
    gtmPublicId:           c.gtmPublicId           || null,
    serverPublicId:        c.serverPublicId         || null,
    mode:                  c.mode                   || 'client',
    platforms:             c.platforms              || [],
    events:                c.events                 || [],
    published:             c.published              || false,
    transportUrlWired:     c.transportUrlWired      || false,
    createdAt:             _toIso(c.createdAt),
    updatedAt:             _toIso(c.updatedAt),
  }));

  const profile = {
    clientId,
    email:         authUser ? authUser.email : null,
    name:          client.name           || null,
    company:       client.company        || null,
    timezone:      client.timezone       || null,
    plan:          client.plan           || null,
    status:        client.status         || null,
    country:       client.country        || null,
    whatsapp:      client.whatsapp       || null,
    notes:         isAdmin ? (client.notes || null) : undefined,
    createdAt:     _toIso(client.createdAt),
    updatedAt:     _toIso(client.updatedAt),
  };

  const tracking = {
    serverSide: ssCfg ? {
      provider:  ssCfg.provider    || null,
      serverUrl: ssCfg.serverUrl   || null,
      platforms: ssCfg.platforms   || [],
    } : null,
    containers: activeContainers,
  };

  const health = {
    status:             healthCache ? (healthCache.healthStatus ?? healthCache.overallStatus ?? 'unknown') : 'unknown',
    lastEventAt:        healthCache ? _toIso(healthCache.lastEventAt) : null,
    activeIntegrations: healthCache ? (healthCache.activeIntegrations || 0) : 0,
    openIssues:         healthCache ? (healthCache.openIssues ?? healthCache.issueCount ?? 0) : 0,
    computedAt:         healthCache ? _toIso(healthCache.computedAt) : null,
    platformHealth:     platformHealth || {},
  };

  return {
    ok: true,
    profile,
    tracking,
    health,
    stats:       null,  // Phase 2
    diagnostics: [],    // Phase 2
  };
}

function _toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

module.exports = { getBundle };
