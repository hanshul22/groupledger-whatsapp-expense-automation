// gracefulShutdown.test.js
// Integration test for the SIGTERM handling logic index.js wires around
// jobQueue.stop() (Part A6): stop claiming, let in-flight jobs finish (up
// to ~20s), release the rest back to Redis untouched (via lease expiry,
// not a special "release" call — see jobQueue.js's stop() doc comment).
//
// Rather than send a real OS signal (unreliable to test portably,
// especially on Windows, where SIGTERM isn't a true POSIX signal), this
// test replicates index.js's exact shutdown sequence directly against a
// real createJobQueue + FakeRedis, exercising the same code paths
// index.js's `handleShutdownSignal` calls.

const { test } = require('node:test');
const assert = require('node:assert');

const { createJobQueue } = require('../../src/queue/jobQueue');
const { createRedisJobStore } = require('../../src/queue/redisStore');
const { FakeRedis } = require('./fakeRedis');

test('stop() lets an in-flight job finish within the grace period, and it is acked as done', async () => {
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({ store, sweepIntervalSeconds: 3600 });

  let handlerFinished = false;
  queue.registerHandler('inbound_message', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    handlerFinished = true;
  });

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.start();
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the handler actually start

  await queue.stop({ graceMs: 20000 }); // same grace period index.js uses

  assert.strictEqual(handlerFinished, true, 'the in-flight handler should have been allowed to finish');
  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.state, 'done');
});

test('stop() does not wait indefinitely for a handler that exceeds the grace period', async () => {
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({ store, sweepIntervalSeconds: 3600 });

  queue.registerHandler('inbound_message', () => new Promise(() => {})); // never resolves

  await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.start();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const start = Date.now();
  await queue.stop({ graceMs: 100 }); // short grace period for a fast test
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `stop() should return promptly once the grace period elapses, took ${elapsed}ms`);
});

test('a job still inflight after the grace period is left untouched in Redis and is reclaimed by the next process\'s startup', async () => {
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({ store, sweepIntervalSeconds: 3600, leaseSeconds: 1 }); // short lease

  queue.registerHandler('inbound_message', () => new Promise(() => {})); // never resolves — simulates a stuck/slow handler

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.start();
  await new Promise((resolve) => setTimeout(resolve, 10));

  await queue.stop({ graceMs: 50 }); // process "shuts down" while the job is still inflight

  // "Release the rest back to Redis untouched" — no special release call
  // is made; the job record is left exactly as it was (state:
  // 'processing', still in the inflight ZSET) and its lease will simply
  // expire.
  let stored = await store.getJob(job.id);
  assert.strictEqual(stored.state, 'processing');

  // Simulate time passing past the 1s lease, then a fresh "process 2"
  // starting up (Part A6 — "On startup: reclaim expired leases, load
  // ready jobs, resume").
  const inflightZset = redis.zsets.get('wq:inflight');
  inflightZset.set(job.id, Date.now() - 1000);

  const store2 = createRedisJobStore({ redis });
  const reclaimed = await store2.reclaimExpiredLeases();
  assert.deepStrictEqual(reclaimed, [job.id]);

  const [reClaimed] = await store2.claimReady({ limit: 1, leaseSeconds: 120 });
  assert.ok(reClaimed, 'the next process should be able to re-claim the job that was left inflight at shutdown');
});

test('stop() clears the sweep interval so it never fires again after shutdown', async () => {
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  let reclaimCallsAfterStop = 0;
  const spyStore = {
    ...store,
    reclaimExpiredLeases: async (...args) => {
      const result = await store.reclaimExpiredLeases(...args);
      if (stoppedFlag) reclaimCallsAfterStop += 1;
      return result;
    },
  };
  let stoppedFlag = false;
  const queue = createJobQueue({ store: spyStore, sweepIntervalSeconds: 0.05 }); // 50ms sweep

  queue.registerHandler('inbound_message', async () => {});
  await queue.start();
  await new Promise((resolve) => setTimeout(resolve, 120)); // let at least one sweep fire

  await queue.stop({ graceMs: 0 });
  stoppedFlag = true;
  await new Promise((resolve) => setTimeout(resolve, 200)); // would catch a leaked interval

  assert.strictEqual(reclaimCallsAfterStop, 0, 'no sweep-driven reclaim call should happen after stop()');
});
