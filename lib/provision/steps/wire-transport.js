'use strict';

const gtmService = require('../../../gtm-service');

async function run(ctx) {
  if (ctx.server && ctx.server.transportWired) return {};

  const webContainerId = ctx.server && ctx.server.webContainerId || ctx.job && ctx.job.webContainerId;
  const webWorkspaceId = ctx.server && ctx.server.webWorkspaceId || ctx.job && ctx.job.webWorkspaceId;
  if (!webContainerId || !webWorkspaceId) {
    return { transportWired: false, transportWireSkipped: true };
  }

  const result = await gtmService.setGA4TransportUrl(webContainerId, webWorkspaceId, ctx.publicServerUrl);
  return {
    transportWired: true,
    transportUrlWired: true,
    transportWireResult: {
      tagId: result.tagId || null,
      versionId: result.versionId || null,
    },
  };
}

module.exports = { name: 'wire_transport', run };
