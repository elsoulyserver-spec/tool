// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/selfhosted.js
// Self-Hosted sGTM provider — passive validator only.
//
// The user provides their own sGTM URL. This provider validates it is reachable
// but does NOT perform any deployment. Docker Compose setup instructions are
// available in docs/SERVER-SIDE-SETUP.md.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { BaseProvider } = require('./base');

class SelfHostedProvider extends BaseProvider {
  // ── deployContainer ─────────────────────────────────────────────────────────
  // Self-hosted = manual only. Throws a descriptive error.
  async deployContainer(_config) {
    throw new Error(
      'Self-hosted provider requires manual deployment. ' +
      'See docs/SERVER-SIDE-SETUP.md for Docker Compose setup instructions, ' +
      'then paste your server URL in the tool to validate it.'
    );
  }

  // validateUrl, sendTestEvent, getContainerStatus → inherited from base
}

module.exports = { SelfHostedProvider };
