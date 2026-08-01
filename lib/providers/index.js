// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/index.js
// HostingProvider factory — returns the correct provider based on env config.
//
// Steps and the runner only ever call getHostingProvider(); they never import
// CloudRunProvider or LegacyStapeProvider directly.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { CloudRunProvider }    = require('./cloudrun');
const { LegacyStapeProvider } = require('./legacy-stape');

function getHostingProvider(shard) {
  const type = (process.env.MANAGED_DEPLOY_PROVIDER || 'cloudrun').trim().toLowerCase();

  if (type === 'cloudrun') {
    if (!shard) throw new Error('getHostingProvider: shard is required for the cloudrun provider');
    return new CloudRunProvider(shard);
  }

  if (type === 'stape') {
    return new LegacyStapeProvider();
  }

  throw new Error(`Unknown MANAGED_DEPLOY_PROVIDER: "${type}". Expected "cloudrun" or "stape".`);
}

module.exports = { getHostingProvider };
