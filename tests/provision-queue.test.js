// ════════════════════════════════════════════════════════════════════════════
// tests/provision-queue.test.js
//
// Verifies the global concurrency limiter used for the in-process provisioning
// fallback: the cap is never exceeded, ordering is FIFO, no job is lost, all jobs
// run, and a throwing job frees its slot instead of wedging the queue.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createLimiter } = require('../lib/provision-queue');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('100 jobs never exceed the cap, all complete, none lost', async () => {
  const cap = 5;
  const limiter = createLimiter(cap);
  let active = 0, maxActive = 0, done = 0;

  const jobs = [];
  for (let i = 0; i < 100; i++) {
    jobs.push(limiter.run(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await delay(2);
      active--; done++;
      return i;
    }));
  }
  const results = await Promise.all(jobs);

  assert.equal(results.length, 100);
  assert.equal(done, 100);
  assert.deepEqual([...results].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i));
  assert.ok(maxActive <= cap, `maxActive ${maxActive} must be <= ${cap}`);
  assert.ok(maxActive > 1, 'should actually run jobs concurrently');
});

test('FIFO start order (cap=1 → strict sequence)', async () => {
  const limiter = createLimiter(1);
  const startOrder = [];
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(limiter.run(async () => { startOrder.push(i); await delay(1); }));
  }
  await Promise.all(jobs);
  assert.deepEqual(startOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a throwing job frees its slot and the queue keeps draining', async () => {
  const limiter = createLimiter(1);
  const a = limiter.run(async () => { throw new Error('boom'); });
  const b = limiter.run(async () => 'ok');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
  await delay(5);                       // let the .finally slot-release microtask run
  assert.equal(limiter.stats().active, 0);
});

test('stats expose active / queued / max while jobs are gated', async () => {
  const limiter = createLimiter(2);
  let release;
  const gate = new Promise((r) => { release = r; });
  const running = [limiter.run(() => gate), limiter.run(() => gate), limiter.run(() => gate)];
  await delay(5);
  const s = limiter.stats();
  assert.equal(s.active, 2);
  assert.equal(s.queued, 1);
  assert.equal(s.max, 2);
  release();
  await Promise.all(running);
  await delay(5);                       // let the .finally slot-release microtasks run
  assert.equal(limiter.stats().active, 0);
});

test('isFull() applies backpressure at queueMax (overflow guard)', async () => {
  const limiter = createLimiter(1, 3);   // 1 running + up to 3 waiting
  let release;
  const gate = new Promise((r) => { release = r; });
  const ps = [
    limiter.run(() => gate),             // active
    limiter.run(() => gate),             // queued 1
    limiter.run(() => gate),             // queued 2
    limiter.run(() => gate),             // queued 3 → queue now full
  ];
  assert.equal(limiter.isFull(), true);
  assert.equal(limiter.stats().queued, 3);
  assert.equal(limiter.stats().queueMax, 3);
  release();
  await Promise.all(ps);
  await delay(5);
  assert.equal(limiter.isFull(), false);
  assert.equal(limiter.stats().active, 0);
});

test('queueMax = 0 means unlimited (never full)', () => {
  const limiter = createLimiter(1, 0);
  const gate = new Promise(() => {});     // never resolves
  for (let i = 0; i < 50; i++) limiter.run(() => gate);
  assert.equal(limiter.isFull(), false);
  assert.equal(limiter.stats().queued, 49); // 1 active, 49 queued, still not "full"
});
