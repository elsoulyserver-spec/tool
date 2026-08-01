'use strict';

async function run(ctx) {
  if (ctx.server && ctx.server.previewServiceName && ctx.server.previewRunUrl) {
    return {};
  }
  return ctx.provider.deployPreview(ctx);
}

module.exports = { name: 'deploy_preview', run };
