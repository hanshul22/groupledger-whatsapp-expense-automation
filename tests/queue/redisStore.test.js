// redisStore.test.js
// Unit tests for src/queue/redisStore.js against the FakeRedis in-memory
// fake (see fakeRedis.js) — no real Redis connection used anywhere here.

const { test } = require('node:test');
const assert = require('node:assert');

const { createRedisJobStore } = require('../../src/queue/redisStore');
const { createJob } = require('../../src/queue/jobTypes');
const { FakeRedis } = require('./fakeRedis');

function makeStore() {
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  return { redis, store };
}

test('enqueue persists the job and makes it visible via getJob', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: { a: 1 } });

  await store.enqueue(job);

  const fetched = await store.getJob(job.id);
  assert.deepStrictEqual(fetched, job);
});

test('claimReady returns nothing before next_attempt_at has arrived', async () => {
  const { store } = makeStore();
  const future = new Date(Date.now() + 60_000).toISOString();
  const job = createJob({ type: 'inbound_message', payload: {} });
  job.next_attempt_at = future;
  await store.enqueue(job);

  const claimed = await store.claimReady({ limit: 5, leaseSeconds: 120 });
  assert.deepStrictEqual(claimed, []);
});

test('claimReady claims a due job exactly once, incrementing attempts and setting a lease', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job);

  const claimed = await store.claimReady({ limit: 5, leaseSeconds: 120 });
  assert.strictEqual(claimed.length, 1);
  assert.strictEqual(claimed[0].id, job.id);
  assert.strictEqual(claimed[0].state, 'processing');
  assert.strictEqual(claimed[0].attempts, 1);
  assert.ok(claimed[0].lease_until);

  // A second immediate claim must not re-claim the same job (it's now
  // inflight, not ready) — this is the atomicity guarantee Part A3 asks
  // for ("Claim jobs atomically ... with a lease").
  const claimedAgain = await store.claimReady({ limit: 5, leaseSeconds: 120 });
  assert.deepStrictEqual(claimedAgain, []);
});

test('claimReady respects the limit (QUEUE_CONCURRENCY) across many due jobs', async () => {
  const { store } = makeStore();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.enqueue(createJob({ type: 'inbound_message', payload: { i } }));
  }

  const claimed = await store.claimReady({ limit: 2, leaseSeconds: 120 });
  assert.strictEqual(claimed.length, 2);
});

test('reclaimExpiredLeases moves an inflight job whose lease has expired back to ready', async () => {
  const { store, redis } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job);
  await store.claimReady({ limit: 1, leaseSeconds: 1 }); // 1s lease

  // Simulate time passing past the lease by directly rewriting the
  // inflight score to the past (equivalent to "1 second later").
  const inflightZset = redis.zsets.get('wq:inflight');
  inflightZset.set(job.id, Date.now() - 1000);

  const reclaimed = await store.reclaimExpiredLeases();
  assert.deepStrictEqual(reclaimed, [job.id]);

  // Now it should be claimable again.
  const claimed = await store.claimReady({ limit: 1, leaseSeconds: 120 });
  assert.strictEqual(claimed.length, 1);
  assert.strictEqual(claimed[0].id, job.id);
});

test('reclaimExpiredLeases does not touch a lease that has not expired yet', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job);
  await store.claimReady({ limit: 1, leaseSeconds: 120 }); // long lease

  const reclaimed = await store.reclaimExpiredLeases();
  assert.deepStrictEqual(reclaimed, []);
});

test('ack removes the job from inflight/ready and persists it as done', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'sheet_write', payload: {} });
  await store.enqueue(job);
  const [claimed] = await store.claimReady({ limit: 1, leaseSeconds: 120 });

  await store.ack(claimed);

  const counts = await store.getCounts();
  assert.strictEqual(counts.queued, 0);
  assert.strictEqual(counts.inflight, 0);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.state, 'done');
});

test('reschedule moves a job back to ready at the new next_attempt_at and out of inflight', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job);
  const [claimed] = await store.claimReady({ limit: 1, leaseSeconds: 120 });

  const future = new Date(Date.now() + 5000).toISOString();
  const updated = { ...claimed, state: 'queued', next_attempt_at: future, last_error: 'network blip' };
  await store.reschedule(updated);

  const counts = await store.getCounts();
  assert.strictEqual(counts.inflight, 0);
  assert.strictEqual(counts.queued, 1);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.last_error, 'network blip');
});

test('markDead adds the job to the dead set and persists it, never deleting the record', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job);
  const [claimed] = await store.claimReady({ limit: 1, leaseSeconds: 120 });

  await store.markDead({ ...claimed, last_error: 'bad payload' });

  const deadIds = await store.listDeadIds();
  assert.deepStrictEqual(deadIds, [job.id]);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.state, 'dead');
  assert.strictEqual(stored.last_error, 'bad payload');
});

test('requeueDead moves every dead job back to ready with attempts reset to 0', async () => {
  const { store } = makeStore();
  const job = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job);
  const [claimed] = await store.claimReady({ limit: 1, leaseSeconds: 120 });
  await store.markDead({ ...claimed, last_error: 'bad payload' });

  const count = await store.requeueDead();
  assert.strictEqual(count, 1);

  const deadIds = await store.listDeadIds();
  assert.deepStrictEqual(deadIds, []);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.state, 'queued');
  assert.strictEqual(stored.attempts, 0);
  assert.strictEqual(stored.last_error, null);

  const counts = await store.getCounts();
  assert.strictEqual(counts.queued, 1);
});

test('dedupeCheckAndSet returns true only the first time a WhatsApp message id is seen', async () => {
  const { store } = makeStore();
  const first = await store.dedupeCheckAndSet('wamid-123');
  const second = await store.dedupeCheckAndSet('wamid-123');
  const other = await store.dedupeCheckAndSet('wamid-456');

  assert.strictEqual(first, true);
  assert.strictEqual(second, false);
  assert.strictEqual(other, true);
});

test('getCounts reports queued/inflight/dead counts and oldest-job ages', async () => {
  const { store } = makeStore();
  const job1 = createJob({ type: 'inbound_message', payload: {} });
  const job2 = createJob({ type: 'inbound_message', payload: {} });
  await store.enqueue(job1);
  await store.enqueue(job2);
  await store.claimReady({ limit: 1, leaseSeconds: 120 });

  const counts = await store.getCounts();
  assert.strictEqual(counts.queued, 1);
  assert.strictEqual(counts.inflight, 1);
  assert.strictEqual(counts.dead, 0);
  assert.ok(counts.oldestReadyAgeMs !== null);
  assert.ok(counts.oldestInflightAgeMs !== null);
});

test('getCounts reports zero/null cleanly on an empty queue', async () => {
  const { store } = makeStore();
  const counts = await store.getCounts();
  assert.strictEqual(counts.queued, 0);
  assert.strictEqual(counts.inflight, 0);
  assert.strictEqual(counts.dead, 0);
  assert.strictEqual(counts.oldestReadyAgeMs, null);
  assert.strictEqual(counts.oldestInflightAgeMs, null);
});
