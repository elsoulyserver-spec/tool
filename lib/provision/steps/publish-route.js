'use strict';

const firestore = require('../../../firestore-service');

async function run(ctx) {
  await firestore.saveManagedRoute({
    hostname: ctx.slug,
    clientId: ctx.clientId,
    serverId: ctx.clientId,
    taggingRunUrl: ctx.server.taggingRunUrl,
    previewRunUrl: ctx.server.previewRunUrl,
    status: 'active',
  });
  await ctx.provider.waitHealthy(ctx.publicServerUrl, {
    timeoutMs: 90 * 1000,
    onTick: ctx.onTick,
  });
  return {
    publicServerUrl: ctx.publicServerUrl,
    previewPublicUrl: ctx.previewPublicUrl,
    routePublished: true,
  };
}

module.exports = { name: 'publish_route', run };
