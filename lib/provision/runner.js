'use strict';

const firestore = require('../../firestore-service');
const shardRegistry = require('../shard-registry');
const { getHostingProvider } = require('../providers');
const defaultSteps = require('./steps');
const { slugFor, urlsForSlug } = require('./context');

function publicError(err) {
  return {
    message: err && err.message || String(err),
    code: err && err.code || null,
    status: err && err.status || null,
  };
}

function sanitizeResult(server) {
  return {
    ok: true,
    publicServerUrl: server.publicServerUrl || null,
    previewPublicUrl: server.previewPublicUrl || null,
    gtmServerPublicId: server.gtmServerPublicId || null,
    transportWired: !!server.transportWired,
  };
}

async function run(jobId, opts = {}) {
  if (!jobId) throw new Error('runner.run: jobId is required');

  const steps = opts.steps || defaultSteps;
  const job = await firestore.getJob(jobId);
  if (!job) {
    const err = new Error(`Provisioning job not found: ${jobId}`);
    err.code = 'JOB_NOT_FOUND';
    throw err;
  }

  const clientId = job.clientId;
  if (!clientId) throw new Error('runner.run: job.clientId is required');

  let server = await firestore.getManagedServer(clientId);
  if (!server) throw new Error(`Managed server not found for client: ${clientId}`);

  const shardId = server.shardId || server.shard || job.shardId || job.shard;
  const shard = opts.shard || shardRegistry.getShard(shardId);
  const provider = opts.provider || getHostingProvider(shard);
  const slug = server.slug || job.slug || slugFor(clientId);
  const urls = urlsForSlug(slug);

  const deployment = await firestore.createDeployment({
    clientId,
    jobId,
    serverId: clientId,
    shard: shard.id,
    trigger: job.trigger || (server.status === 'failed' ? 'retry' : 'create-server'),
    status: 'running',
    containerConfigHash: server.containerConfigHash || null,
    publicServerUrl: server.publicServerUrl || urls.publicServerUrl,
  });

  const ctx = {
    jobId,
    deploymentId: deployment.id,
    clientId,
    email: job.email || server.email || null,
    job,
    shard,
    provider,
    server,
    slug,
    publicServerUrl: server.publicServerUrl || urls.publicServerUrl,
    previewPublicUrl: server.previewPublicUrl || urls.previewPublicUrl,
    secrets: { containerConfig: null },
    async log(level, message, extra = {}) {
      await firestore.appendDeploymentLog(deployment.id, {
        step: extra.step || ctx.currentStep || null,
        level,
        message,
      });
    },
    async onTick() {
      await firestore.saveJob(jobId, { status: 'running', heartbeatAt: new Date().toISOString() });
    },
    _testOpts: opts._testOpts || null,
  };

  try {
    await firestore.saveJob(jobId, { status: 'running', stage: 'starting' });

    for (const step of steps) {
      ctx.currentStep = step.name;
      await firestore.saveJob(jobId, { status: 'running', stage: step.name });
      await ctx.log('info', `starting ${step.name}`, { step: step.name });

      const patch = await step.run(ctx);
      if (patch && Object.keys(patch).length) {
        await firestore.saveManagedServer({
          ...ctx.server,
          ...patch,
          clientId,
          shardId: shard.id,
          currentStep: step.name,
          jobId,
          lastDeploymentId: deployment.id,
        });
        ctx.server = await firestore.getManagedServer(clientId);
        ctx.publicServerUrl = ctx.server.publicServerUrl || ctx.publicServerUrl;
        ctx.previewPublicUrl = ctx.server.previewPublicUrl || ctx.previewPublicUrl;
      } else {
        await firestore.saveManagedServer({
          ...ctx.server,
          clientId,
          shardId: shard.id,
          currentStep: step.name,
          jobId,
          lastDeploymentId: deployment.id,
        });
        ctx.server = await firestore.getManagedServer(clientId);
      }

      await ctx.log('info', `completed ${step.name}`, { step: step.name });
    }

    await firestore.finalizeDeployment(deployment.id, {
      status: 'succeeded',
      cloudRunRevision: ctx.server.cloudRunRevision || null,
      containerConfigHash: ctx.server.containerConfigHash || null,
      publicServerUrl: ctx.server.publicServerUrl || ctx.publicServerUrl,
    });
    await firestore.saveJob(jobId, { status: 'completed', stage: 'done', result: sanitizeResult(ctx.server) });
    try {
      await firestore.saveAudit({
        type: 'managed_server_provisioned',
        clientId,
        email: ctx.email,
        jobId,
        deploymentId: deployment.id,
        publicServerUrl: ctx.server.publicServerUrl || ctx.publicServerUrl,
      });
    } catch (_) {}
    return sanitizeResult(ctx.server);
  } catch (err) {
    const exposed = publicError(err);
    await firestore.saveManagedServer({
      ...ctx.server,
      clientId,
      shardId: shard.id,
      status: 'failed',
      errorMessage: exposed.message,
      currentStep: ctx.currentStep || 'failed',
      jobId,
      lastDeploymentId: deployment.id,
    });
    await firestore.finalizeDeployment(deployment.id, {
      status: 'failed',
      errorMessage: exposed.message,
      errorCode: exposed.code,
    });
    await firestore.saveJob(jobId, { status: 'failed', stage: ctx.currentStep || 'failed', error: exposed });
    throw err;
  }
}

module.exports = { run, sanitizeResult, publicError };
