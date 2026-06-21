// ══════════════════════════════════════════════════════════════════════════════
// lib/provision-queue.js
// Global in-process concurrency limiter + bounded FIFO queue for the managed-
// provisioning IN-PROCESS fallback (local / Railway, where Cloud Tasks isn't
// wired).
//
// WHY: a burst of provision requests would otherwise fan out into one background
// runner each — hundreds of parallel GTM import sequences hammering a ~25 writes/
// min quota → 429 storms, collective backoff, and unbounded memory. This caps how
// many runners execute at once (MANAGED_MAX_CONCURRENCY, default 5) and bounds the
// waiting queue (MANAGED_QUEUE_MAX, default 1000; 0 = unlimited).
//
// It changes ONLY how many provisions run concurrently — never the provision logic
// itself, never the per-request retry/backoff. No accepted job is dropped; when the
// queue is saturated isFull() lets the caller reject NEW work (503) instead of
// growing memory without limit. Because each runner re-reads the feature flag at
// EXECUTION time, a still-queued job honors a mid-flight rollback.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

function createLimiter(max, queueMax) {
  const cap  = Math.max(1, parseInt(max, 10) || 1);
  const qMax = Math.max(0, parseInt(queueMax, 10) || 0);   // 0 = unlimited
  let   active = 0;
  const queue  = [];

  function pump() {
    while (active < cap && queue.length) {
      const job = queue.shift();           // FIFO: oldest waiter starts next
      active++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)     // settle the caller's promise
        .finally(() => { active--; pump(); }); // ALWAYS free the slot + backfill
    }
  }

  // True when the waiting queue is at its bound. Synchronous — check it immediately
  // before run() (same tick, no TOCTOU race) to apply backpressure.
  function isFull() { return qMax > 0 && queue.length >= qMax; }

  // Schedule fn() to run when a slot is free. Returns a promise that settles with
  // fn's result/error. Queuing itself never rejects — only fn's own outcome does.
  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }

  function stats() { return { active, queued: queue.length, max: cap, queueMax: qMax }; }

  return { run, stats, isFull };
}

const limiter = createLimiter(
  process.env.MANAGED_MAX_CONCURRENCY || '5',
  process.env.MANAGED_QUEUE_MAX || '1000',
);
limiter.createLimiter = createLimiter;       // exposed for unit tests
module.exports = limiter;
