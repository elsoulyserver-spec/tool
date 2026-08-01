'use strict';

async function run(ctx) {
  if (ctx.server && ctx.server.taggingServiceName && ctx.server.taggingRunUrl) {
    return {};
  }
  return ctx.provider.deployTagging(ctx);
}

module.exports = { name: 'deploy_cloudrun', run };
