'use strict';

const os = require('os');

const firestoreService = require('../firestore-service');
const diagnosticRules  = require('./diagnostic-rules');

// Stable per-instance identifier — unique per container / pod / dyno.
const _OWNER_ID = (os.hostname() || '') + ':' + process.pid;

const _HEARTBEAT_INTERVAL_MS = 5  * 60 * 1000;  // extend lease every 5 minutes
const _HEARTBEAT_EXTEND_MS   = 10 * 60 * 1000;  // each extension buys 10 more minutes

async function _evaluateClient(clientDoc, platformHealth) {
  const client = { id: clientDoc.id, ...clientDoc.data() };
  const [containers, ssConfig, eventsSeen] = await Promise.all([
    firestoreService.listContainersByClient(client.id),
    firestoreService.getSSConfig(client.id),
    firestoreService.listEventTypeLastSeen(client.id),
  ]);
  const result     = diagnosticRules.evaluate({ client, containers, ssConfig, eventsSeen, platformHealth });
  const issueCount = Object.values(result.rules)
    .filter(r => r.status !== 'ok' && r.status !== 'skip').length;
  await Promise.all([
    firestoreService.saveDiagnosticResult(client.id, result),
    firestoreService.saveHealthCache(client.id, {
      healthStatus: result.overallStatus,
      openIssues:   issueCount,
    }),
  ]);
}

async function runHealthJob() {
  if (!firestoreService.isConfigured()) return;

  let acquired = false;
  try {
    acquired = await firestoreService.acquireHealthJobLock(_OWNER_ID);
  } catch (e) {
    console.error('[health-job] lock acquisition failed:', e.message);
    return;
  }
  if (!acquired) return;

  // Heartbeat keeps the lease alive during long multi-page scans.
  const heartbeat = setInterval(() => {
    firestoreService.extendHealthJobLock(_HEARTBEAT_EXTEND_MS)
      .catch(e => console.error('[health-job] heartbeat extend failed:', e.message));
  }, _HEARTBEAT_INTERVAL_MS);

  try {
    const platformHealth = await firestoreService.getPlatformHealth();
    let cursor = null;
    let total  = 0;

    while (true) {
      const docs = await firestoreService.listActiveClients(cursor, 100);
      if (!docs.length) break;
      cursor = docs[docs.length - 1];  // QueryDocumentSnapshot for startAfter()

      for (const doc of docs) {
        try {
          await _evaluateClient(doc, platformHealth);
          total++;
        } catch (e) {
          console.error('[health-job] client ' + doc.id + ' failed:', e.message);
        }
      }
    }

    console.log('[health-job] completed — evaluated ' + total + ' clients');
  } catch (e) {
    console.error('[health-job] job error:', e.message);
  } finally {
    clearInterval(heartbeat);
    firestoreService.releaseHealthJobLock()
      .catch(e => console.error('[health-job] lock release failed:', e.message));
  }
}

module.exports = { runHealthJob };
