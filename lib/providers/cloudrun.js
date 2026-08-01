// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/cloudrun.js
// CloudRunProvider — HostingProvider implementation backed by GCP Cloud Run.
//
// Deployed GTM image:
//   gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable  (overridable via env)
//
// All Cloud Run operations are delegated to CloudRunService (never direct GCP
// API calls from here). CONTAINER_CONFIG lives in ctx.secrets — it is consumed
// inside buildServiceSpec and never written anywhere else.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');
const { HostingProvider }   = require('./hosting-provider');
const { CloudRunService }   = require('../cloud-run-service');

const DEFAULT_IMAGE       = 'gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable';
const CONFIG_SIZE_LIMIT   = 30_000; // 30KB guard; Cloud Run hard limit is 32KiB

function _env(name) { return (process.env[name] || '').trim(); }

function _assertConfig(containerConfig) {
  if (!containerConfig) {
    const err = new Error('CONTAINER_CONFIG is empty or missing');
    err.code  = 'CONFIG_NOT_READY';
    throw err;
  }
  if (Buffer.byteLength(containerConfig, 'utf8') > CONFIG_SIZE_LIMIT) {
    const err = new Error('CONTAINER_CONFIG exceeds 30KB Cloud Run env var limit');
    err.code  = 'CONFIG_TOO_LARGE';
    throw err;
  }
}

class CloudRunProvider extends HostingProvider {
  /**
   * @param {object} shard  resolved shard from shard-registry
   * @param {object} [_testOpts]  test-only: { svcInstance } to inject a mock CloudRunService
   */
  constructor(shard, _testOpts = {}) {
    super();
    this._shard = shard;
    this._svc   = _testOpts.svcInstance || new CloudRunService(shard);
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  static slugFor(clientId) {
    return crypto.createHash('sha256').update(String(clientId)).digest('hex').slice(0, 12);
  }

  static serviceNamesFor(slug) {
    return {
      tagging: `sgtm-${slug}-tag`,
      preview: `sgtm-${slug}-prev`,
    };
  }

  static _image() {
    return _env('SGTM_CLOUD_RUN_IMAGE') || DEFAULT_IMAGE;
  }

  // ── HostingProvider interface ───────────────────────────────────────────────

  async deployPreview(ctx) {
    const { containerConfig } = ctx.secrets;
    _assertConfig(containerConfig);

    const slug    = ctx.slug;
    const names   = CloudRunProvider.serviceNamesFor(slug);
    const image   = CloudRunProvider._image();

    const spec = CloudRunService.buildServiceSpec({
      image,
      env:          { CONTAINER_CONFIG: containerConfig, RUN_AS_PREVIEW_SERVER: 'true' },
      minInstances: 0,
      maxInstances: 1,
      memory:       '512Mi',
    });

    const opOrExists = await this._svc.createService(names.preview, spec);
    if (!opOrExists.alreadyExists && opOrExists.name) {
      await this._svc.waitForOperation(opOrExists.name, {
        timeoutMs: ctx._testOpts && ctx._testOpts.lroTimeoutMs || 8 * 60 * 1000,
        onTick:    ctx.onTick && (() => ctx.onTick()),
      });
    }
    await this._svc.setPublicInvoker(names.preview);

    const svcState = await this._svc.getService(names.preview);
    return {
      previewServiceName: names.preview,
      previewRunUrl:      svcState.uri,
    };
  }

  async deployTagging(ctx) {
    const { containerConfig } = ctx.secrets;
    _assertConfig(containerConfig);

    const slug       = ctx.slug;
    const names      = CloudRunProvider.serviceNamesFor(slug);
    const image      = CloudRunProvider._image();
    const previewUrl = ctx.previewPublicUrl;  // always the public wildcard URL, never run.app

    const spec = CloudRunService.buildServiceSpec({
      image,
      env: {
        CONTAINER_CONFIG:    containerConfig,
        PREVIEW_SERVER_URL:  previewUrl,
      },
      minInstances: 0,
      maxInstances: 3,
      memory:       '512Mi',
    });

    const opOrExists = await this._svc.createService(names.tagging, spec);
    if (!opOrExists.alreadyExists && opOrExists.name) {
      await this._svc.waitForOperation(opOrExists.name, {
        timeoutMs: ctx._testOpts && ctx._testOpts.lroTimeoutMs || 8 * 60 * 1000,
        onTick:    ctx.onTick && (() => ctx.onTick()),
      });
    }
    await this._svc.setPublicInvoker(names.tagging);

    const svcState = await this._svc.getService(names.tagging);
    return {
      taggingServiceName: names.tagging,
      taggingRunUrl:      svcState.uri,
      cloudRunRevision:   svcState.latestReadyRevision,
    };
  }

  async waitHealthy(runUrl, opts) {
    return this._svc.pollHealthy(runUrl, opts);
  }

  async getStatus(ctx) {
    const names    = CloudRunProvider.serviceNamesFor(ctx.slug);
    const svcState = await this._svc.getService(names.tagging);
    const cond     = svcState.terminalCondition;
    return {
      status:   (cond && cond.state === 'CONDITION_SUCCEEDED') ? 'ready' : 'not-ready',
      uri:      svcState.uri,
      revision: svcState.latestReadyRevision,
    };
  }

  async teardown(ctx) {
    const names  = CloudRunProvider.serviceNamesFor(ctx.slug);
    const ignore = (err) => { if (err.status !== 404) throw err; };
    await Promise.all([
      this._svc.deleteService(names.tagging).catch(ignore),
      this._svc.deleteService(names.preview).catch(ignore),
    ]);
  }
}

module.exports = { CloudRunProvider };
