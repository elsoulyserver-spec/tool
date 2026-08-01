'use strict';

async function run(ctx) {
  const url = ctx.server && ctx.server.taggingRunUrl;
  if (!url) {
    const err = new Error('taggingRunUrl is required before health-check');
    err.code = 'MISSING_TAGGING_RUN_URL';
    throw err;
  }
  await ctx.provider.waitHealthy(url, { timeoutMs: 5 * 60 * 1000, onTick: ctx.onTick });
  return { healthCheckedAt: new Date().toISOString() };
}

module.exports = { name: 'health_check', run };
