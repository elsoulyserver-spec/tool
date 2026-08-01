'use strict';

const { sha256 } = require('../context');
const gtmService = require('../../../gtm-service');
const firestore = require('../../../firestore-service');

async function run(ctx) {
  const existingId = ctx.server && ctx.server.gtmServerContainerId;
  let serverContainerId = existingId;
  let serverPublicId = ctx.server && ctx.server.gtmServerPublicId;
  let serverWorkspaceId = ctx.server && ctx.server.gtmServerWorkspaceId;
  let serverVersionId = ctx.server && ctx.server.gtmServerVersionId;

  if (!serverContainerId) {
    const ss = await firestore.getSSConfig(ctx.clientId);
    if (ss && ss.serverContainerId) {
      serverContainerId = ss.serverContainerId;
      serverPublicId = ss.serverPublicId || serverPublicId;
      serverWorkspaceId = ss.serverWorkspaceId || serverWorkspaceId;
      serverVersionId = ss.serverVersionId || serverVersionId;
    }
  }

  if (!serverContainerId) {
    const provisioned = await gtmService.provisionServerOnly({
      projectName: ctx.server && ctx.server.projectName || ctx.email || ctx.clientId,
      serverConfigJson: ctx.job && ctx.job.serverConfigJson,
      onProgress: ctx.onTick,
    });
    serverContainerId = provisioned.containerId;
    serverPublicId = provisioned.publicId;
    serverWorkspaceId = provisioned.workspaceId;
    serverVersionId = provisioned.versionId;
    ctx.secrets.containerConfig = provisioned.containerConfig;
  } else {
    ctx.secrets.containerConfig = await gtmService.getContainerConfig(serverContainerId);
  }

  if (!ctx.secrets.containerConfig) {
    const err = new Error('GTM server container config is not ready');
    err.code = 'CONFIG_NOT_READY';
    throw err;
  }

  return {
    gtmAccountId: gtmService.getAccountId ? gtmService.getAccountId() : undefined,
    gtmServerContainerId: serverContainerId,
    gtmServerPublicId: serverPublicId || null,
    gtmServerWorkspaceId: serverWorkspaceId || null,
    gtmServerVersionId: serverVersionId || null,
    containerConfigHash: sha256(ctx.secrets.containerConfig),
  };
}

module.exports = { name: 'create_gtm', run };
