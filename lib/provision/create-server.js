'use strict';

const crypto = require('crypto');
const firestore = require('../../firestore-service');
const shardRegistry = require('../shard-registry');
const { slugFor, urlsForSlug } = require('./context');

function makeJobId(clientId) {
  return `managed-${String(clientId).replace(/[^a-zA-Z0-9_-]/g, '_')}-${crypto.randomBytes(6).toString('hex')}`;
}

async function createServer(input, opts = {}) {
  if (!input || !input.clientId) throw new Error('createServer: clientId is required');
  const clientId = String(input.clientId);
  const shard = input.shard || shardRegistry.pickShardForNewTenant();
  const slug = input.slug || slugFor(clientId);
  const urls = urlsForSlug(slug);
  const jobId = input.jobId || makeJobId(clientId);

  const txResult = await firestore.createManagedServerJobTx({
    clientId,
    userId: input.userId || clientId,
    email: input.email || null,
    jobId,
    shardId: shard.id,
    server: {
      slug,
      shard: shard.id,
      shardId: shard.id,
      gcpProjectId: shard.gcpProjectId,
      region: shard.region,
      publicServerUrl: urls.publicServerUrl,
      previewPublicUrl: urls.previewPublicUrl,
    },
    job: {
      email: input.email || null,
      shardId: shard.id,
      slug,
      publicServerUrl: urls.publicServerUrl,
      previewPublicUrl: urls.previewPublicUrl,
      webContainerId: input.webContainerId || null,
      webWorkspaceId: input.webWorkspaceId || null,
      serverConfigJson: input.serverConfigJson || null,
    },
  });

  if (txResult.outcome === 'created' || txResult.outcome === 'resume') {
    if (opts.dispatch) await opts.dispatch(txResult.jobId || jobId);
  }

  return {
    outcome: txResult.outcome,
    jobId: txResult.jobId || jobId,
    publicServerUrl: txResult.publicServerUrl || urls.publicServerUrl,
    previewPublicUrl: urls.previewPublicUrl,
  };
}

module.exports = { createServer, makeJobId };
