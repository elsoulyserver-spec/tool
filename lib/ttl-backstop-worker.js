'use strict';

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const COLLECTIONS = ['event_agg_shards', 'event_failure_samples', 'event_agg_daily'];
let _running = false;
let _collectionIndex = 0;
const _cursors = new Map();

async function tick(firestoreService, now = new Date()) {
  if (_running) return { deleted: 0, skipped: true };
  _running = true;
  try {
    const collection = COLLECTIONS[_collectionIndex];
    const cursor = _cursors.get(collection) || null;
    const result = await firestoreService.deleteExpiredEventObservability(collection, now, BATCH_SIZE, cursor);
    if (result.nextCursor) _cursors.set(collection, result.nextCursor);
    else {
      _cursors.delete(collection);
      _collectionIndex = (_collectionIndex + 1) % COLLECTIONS.length;
    }
    return { collection, deleted: result.deleted, nextCursor: result.nextCursor || null };
  } finally { _running = false; }
}

function start(firestoreService, intervalMs = INTERVAL_MS) {
  setTimeout(() => tick(firestoreService).catch(e => console.error('[ttl-backstop] initial sweep error:', e.message)), 5000);
  return setInterval(() => tick(firestoreService).catch(e => console.error('[ttl-backstop] sweep error:', e.message)), intervalMs);
}

function _resetForTests() { _running = false; _collectionIndex = 0; _cursors.clear(); }

module.exports = { start, tick, _resetForTests, INTERVAL_MS, BATCH_SIZE, COLLECTIONS };
