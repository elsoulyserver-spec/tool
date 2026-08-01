#!/usr/bin/env node
// scripts/provision-test-client.js
//
// Manual E2E launch gate for the managed Cloud Run sGTM provisioning flow.
// NEVER run in CI — this script makes real GCP and GTM API calls, creates
// live Cloud Run services, and consumes GCP quota.
//
// Usage:
//   node scripts/provision-test-client.js [--teardown] [--client-id <id>] [--skip-edge]
//
// Flags:
//   --teardown       Delete services + route + Firestore docs + GTM container
//                    for the client id and exit. No assertions are made.
//   --client-id <id> Use this synthetic client id instead of generating one.
//                    Required for --teardown of an existing run.
//   --skip-edge      Skip the edge health check (useful when the edge router
//                    or wildcard DNS is not configured in staging).
//
// Required env vars (load from .env automatically if present):
//   FIREBASE_SA_KEY_JSON, GTM_SA_KEY_JSON, GTM_ACCOUNT_ID, MASTER_ENCRYPTION_KEY,
//   MANAGED_SHARDS, MANAGED_DEFAULT_SHARD, GCP_SA_KEY_PROD_1, SGTM_BASE_DOMAIN
//
// Exit codes: 0 = pass, 1 = fail

'use strict';

const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');

// ── .env loader (mirrors server.js) ─────────────────────────────────────────
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      if (!line || line.trimStart().startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 1) return;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1);
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    });
  } catch (_) {}
})();

// ── CLI args ─────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const teardown   = args.includes('--teardown');
const skipEdge   = args.includes('--skip-edge');
const cidIdx     = args.indexOf('--client-id');
const clientId   = cidIdx >= 0 && args[cidIdx + 1]
  ? String(args[cidIdx + 1])
  : `e2e-test-${crypto.randomBytes(4).toString('hex')}`;

// ── Service requires ─────────────────────────────────────────────────────────
const firestoreService = require('../firestore-service');
const gtmService       = require('../gtm-service');
const shardRegistry    = require('../lib/shard-registry');
const { slugFor, urlsForSlug } = require('../lib/provision/context');
const { createServer } = require('../lib/provision/create-server');
const runner           = require('../lib/provision/runner');
const { getHostingProvider } = require('../lib/providers');

// ── Output helpers ───────────────────────────────────────────────────────────
const CHK  = '[PASS]';
const FAIL = '[FAIL]';
const INFO = '[INFO]';

function log(tag, msg) {
  process.stdout.write(`${tag} ${msg}\n`);
}

function fail(msg) {
  log(FAIL, msg);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
  log(CHK, msg);
}

// ── HTTP GET health check ────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    const req = transport.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

// ── Teardown helper ──────────────────────────────────────────────────────────
async function runTeardown() {
  log(INFO, `Tearing down client=${clientId}`);

  const slug = slugFor(clientId);
  log(INFO, `  slug=${slug}`);

  // Provider teardown (deletes Cloud Run services)
  const server = await firestoreService.getManagedServer(clientId);
  if (server) {
    const shardId = server.shardId || server.shard;
    if (shardId && shardRegistry.isConfigured()) {
      try {
        const shard = shardRegistry.getShard(shardId);
        const provider = getHostingProvider(shard);
        const ctx = {
          clientId, slug,
          server,
          secrets: { containerConfig: null },
          log: async () => {},
          onTick: async () => {},
        };
        await provider.teardown(ctx);
        log(CHK, 'Cloud Run services deleted');
      } catch (e) {
        log(INFO, `  Cloud Run teardown warning: ${e.message}`);
      }
    }
  } else {
    log(INFO, '  No managed server doc found — skipping Cloud Run teardown');
  }

  // Firestore cleanup
  try { await firestoreService.deleteManagedRoute(slug); log(CHK, 'managed_routes deleted'); }
  catch (e) { log(INFO, `  managed_routes delete: ${e.message}`); }

  // GTM container cleanup
  if (server && server.gtmServerContainerId) {
    try {
      await gtmService.deleteContainer(server.gtmServerContainerId);
      log(CHK, `GTM container ${server.gtmServerContainerId} deleted`);
    } catch (e) {
      log(INFO, `  GTM container delete: ${e.message}`);
    }
  }

  // managed_servers doc — write status:deleted
  try {
    if (server) {
      await firestoreService.saveManagedServer({ ...server, clientId, status: 'deleted' });
      log(CHK, 'managed_servers doc marked deleted');
    }
  } catch (e) {
    log(INFO, `  managed_servers delete: ${e.message}`);
  }

  log(INFO, 'Teardown complete');
}

// ── Main provision + assert flow ─────────────────────────────────────────────
async function runProvisionAndAssert() {
  log(INFO, `Managed sGTM E2E launch gate — client=${clientId}`);

  // 1. Preconditions
  if (!gtmService.isConfigured())    fail('GTM is not configured — set GTM_SA_KEY_JSON + GTM_ACCOUNT_ID');
  if (!firestoreService.isConfigured()) fail('Firestore is not configured — set FIREBASE_SA_KEY_JSON');
  if (!shardRegistry.isConfigured()) fail('Shard registry not configured — set MANAGED_SHARDS + MANAGED_DEFAULT_SHARD');
  log(CHK, 'All services configured');

  const slug = slugFor(clientId);
  const urls = urlsForSlug(slug);
  log(INFO, `  slug=${slug}`);
  log(INFO, `  tagging URL=${urls.publicServerUrl}`);
  log(INFO, `  preview URL=${urls.previewPublicUrl}`);

  // 2. Create managed server job (createServer picks shard + creates Firestore docs)
  let txResult;
  try {
    txResult = await createServer({ clientId, email: 'e2e-test@easytrac.io' });
  } catch (e) {
    fail(`createServer failed: ${e.message}`);
  }
  log(INFO, `  transaction outcome=${txResult.outcome}  jobId=${txResult.jobId}`);

  if (txResult.outcome === 'reuse') {
    log(INFO, '  Server already active — skipping provisioning, asserting health only');
  } else {
    // 3. Run the provision runner synchronously (no Cloud Tasks in E2E)
    log(INFO, `  Running provisioner synchronously for jobId=${txResult.jobId} …`);
    try {
      const result = await runner.run(txResult.jobId);
      assert(result.ok, 'runner returned ok=true');
      assert(!!result.publicServerUrl, `publicServerUrl set: ${result.publicServerUrl}`);
      assert(!result.containerConfig, 'containerConfig NOT in runner result (security)');
    } catch (e) {
      fail(`Runner failed: ${e.message}`);
    }
  }

  // 4. Assert run.app /healthy returns 200
  const serverDoc = await firestoreService.getManagedServer(clientId);
  if (!serverDoc) fail('managed_servers doc not found after provisioning');
  const taggingRunUrl = serverDoc.taggingRunUrl;
  const previewRunUrl = serverDoc.previewRunUrl;
  assert(!!taggingRunUrl, `taggingRunUrl recorded: ${taggingRunUrl}`);
  assert(!!previewRunUrl, `previewRunUrl recorded: ${previewRunUrl}`);
  assert(!taggingRunUrl.includes('sgtm.easytrac.io'), 'taggingRunUrl must be run.app, not wildcard');

  log(INFO, `  Checking run.app health: ${taggingRunUrl}/healthy`);
  try {
    const h = await httpGet(`${taggingRunUrl}/healthy`, 30_000);
    assert(h.status === 200, `run.app tagging /healthy → ${h.status} (want 200)`);
  } catch (e) {
    fail(`run.app health check failed: ${e.message}`);
  }

  // 5. Assert edge /healthy returns 200 (wildcard domain)
  if (skipEdge) {
    log(INFO, '  Edge health check skipped (--skip-edge)');
  } else {
    log(INFO, `  Checking edge health: ${urls.publicServerUrl}/healthy`);
    try {
      const h = await httpGet(`${urls.publicServerUrl}/healthy`, 30_000);
      assert(h.status === 200, `Edge ${urls.publicServerUrl}/healthy → ${h.status} (want 200)`);
    } catch (e) {
      fail(`Edge health check failed: ${e.message} — is the wildcard DNS + edge router configured?`);
    }
  }

  // 6. Assert GTM server container structure — no cvt_ templates, required tags present
  const containerId = serverDoc.gtmServerContainerId;
  if (!containerId) {
    log(INFO, '  Skipping GTM container structure check (no containerId)');
  } else {
    log(INFO, `  Checking GTM server container structure: ${containerId}`);
    try {
      const containerConfig = await gtmService.getContainerConfig(containerId);
      assert(!!containerConfig, 'containerConfig fetched from GTM API');

      let config;
      try { config = JSON.parse(containerConfig); } catch (_) { config = null; }
      assert(!!config, 'containerConfig is valid JSON');

      if (config) {
        // No community (cvt_) templates
        const customTemplates = (config.customTemplates || []).map(t => t.templateId || t.name || '');
        const hasCvt = customTemplates.some(id => String(id).startsWith('cvt_'));
        assert(!hasCvt, `No cvt_ community templates in container (found: [${customTemplates.join(', ')}])`);

        // Required tags present (GA4 MP at minimum)
        const tagNames = ((config.tag || []).concat(config.tags || [])).map(t => t.name || t.type || '');
        const types    = ((config.tag || []).concat(config.tags || [])).map(t => t.type || t.tagType || '');
        log(INFO, `  Container tags: [${tagNames.slice(0, 8).join(', ')}]`);
        log(INFO, `  Container types: [${types.slice(0, 8).join(', ')}]`);
      }
    } catch (e) {
      log(INFO, `  GTM structure check warning: ${e.message} (non-fatal)`);
    }
  }

  // 7. Verify managed_server doc state
  assert(serverDoc.status === 'active', `managed_server.status = active (got: ${serverDoc.status})`);
  assert(!!serverDoc.publicServerUrl, `managed_server.publicServerUrl set`);
  assert(!serverDoc.containerConfig, 'containerConfig NOT in managed_server doc (security)');

  log(INFO, '');
  log(CHK, '══════════════════════════════════════════════');
  log(CHK, ' E2E LAUNCH GATE PASSED');
  log(CHK, `  publicServerUrl: ${serverDoc.publicServerUrl}`);
  log(CHK, `  previewPublicUrl: ${serverDoc.previewPublicUrl}`);
  log(CHK, `  clientId: ${clientId}`);
  log(CHK, `  slug: ${slug}`);
  log(CHK, '══════════════════════════════════════════════');
  log(INFO, '');
  log(INFO, 'To tear down this test server run:');
  log(INFO, `  node scripts/provision-test-client.js --teardown --client-id ${clientId}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  try {
    if (teardown) {
      await runTeardown();
    } else {
      await runProvisionAndAssert();
    }
    process.exit(0);
  } catch (e) {
    fail(`Unhandled error: ${e.stack || e.message}`);
  }
})();
