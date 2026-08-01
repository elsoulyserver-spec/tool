// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/hosting-provider.js
// Abstract interface for managed sGTM server hosting providers.
//
// CloudRunProvider (default) and LegacyStapeProvider both implement this.
// Steps in lib/provision/ speak only to HostingProvider — never to Cloud Run
// or Stape APIs directly.
//
// Method contracts:
//   deployPreview(ctx)            → { previewServiceName, previewRunUrl }
//   deployTagging(ctx)            → { taggingServiceName, taggingRunUrl, cloudRunRevision }
//   waitHealthy(runUrl, opts)     → resolves when /healthy returns 200
//   getStatus(ctx)                → { status, uri, revision }
//   teardown(ctx)                 → removes both services (best-effort)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

class HostingProvider {
  async deployPreview(_ctx) {
    throw new Error(this.constructor.name + ': deployPreview() is not implemented');
  }

  async deployTagging(_ctx) {
    throw new Error(this.constructor.name + ': deployTagging() is not implemented');
  }

  async waitHealthy(_runUrl, _opts) {
    throw new Error(this.constructor.name + ': waitHealthy() is not implemented');
  }

  async getStatus(_ctx) {
    throw new Error(this.constructor.name + ': getStatus() is not implemented');
  }

  async teardown(_ctx) {
    throw new Error(this.constructor.name + ': teardown() is not implemented');
  }
}

module.exports = { HostingProvider };
