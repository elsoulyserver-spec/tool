'use strict';

const firestore = require('../../../firestore-service');

async function run(ctx) {
  const existing = await firestore.getSSConfig(ctx.clientId) || {};
  await firestore.saveSSConfig(ctx.clientId, {
    ...existing,
    provider: 'gcloud-managed',
    serverUrl: ctx.publicServerUrl,
    transportUrlWired: !!(ctx.server && ctx.server.transportWired),
    serverContainerId: ctx.server && ctx.server.gtmServerContainerId || existing.serverContainerId,
    serverPublicId: ctx.server && ctx.server.gtmServerPublicId || existing.serverPublicId,
    serverWorkspaceId: ctx.server && ctx.server.gtmServerWorkspaceId || existing.serverWorkspaceId,
    serverVersionId: ctx.server && ctx.server.gtmServerVersionId || existing.serverVersionId,
    containerConfig: null,
  });

  return {
    status: 'active',
    currentStep: 'finalize',
    activatedAt: new Date().toISOString(),
    publicServerUrl: ctx.publicServerUrl,
    previewPublicUrl: ctx.previewPublicUrl,
  };
}

module.exports = { name: 'finalize', run };
