// ═══════════════════════════��══════════════════════════════════════════════════
// lib/providers/legacy-stape.js
// LegacyStapeProvider — dormant rollback provider.
//
// Only reachable when MANAGED_DEPLOY_PROVIDER=stape. All methods throw a
// clear error: the Stape-managed flow lives in server.js _runManagedProvisionJob
// and is NOT routed through the new provision engine (lib/provision/). This
// wrapper satisfies the HostingProvider interface contract so the factory can
// return it; any attempt to use it for a managed server provision will fail fast
// with a clear message rather than silently misconfiguring.
// ═══════════════���═════════════════════════════════���════════════════════════════

'use strict';

const { HostingProvider } = require('./hosting-provider');

class LegacyStapeProvider extends HostingProvider {
  _notSupported(method) {
    const err = new Error(
      `LegacyStapeProvider.${method}() is not supported. ` +
      'Set MANAGED_DEPLOY_PROVIDER=cloudrun to use the new Cloud Run flow.',
    );
    err.code = 'LEGACY_PROVIDER_NOT_SUPPORTED';
    return err;
  }

  async deployPreview(_ctx)        { throw this._notSupported('deployPreview'); }
  async deployTagging(_ctx)        { throw this._notSupported('deployTagging'); }
  async waitHealthy(_url, _opts)   { throw this._notSupported('waitHealthy'); }
  async getStatus(_ctx)            { throw this._notSupported('getStatus'); }
  async teardown(_ctx)             { throw this._notSupported('teardown'); }
}

module.exports = { LegacyStapeProvider };
