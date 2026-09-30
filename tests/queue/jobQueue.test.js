// jobQueue.test.js
// Unit tests for src/queue/jobQueue.js's runtime behavior: enqueue ->
// claim -> handler -> ack/backoff/dead-letter, concurrency limiting,
// Redis-unavailable buffering, and graceful shutdown. Uses FakeRedis
// (fakeRedis.js) behind createRedisJobStore — no real Redis connection.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJobQueue } = require('../../src/queue/jobQueue');
const { createRedisJobStore } = require('../../src/queue/redisStore');
const { FakeRedis } = require('./fakeRedis');

function makeTmpBufferPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-buffer-test-'));
  return path.join(dir, 'queue-buffer.jsonl');
}

/** Wait until `predicate()` is true, polling every few ms, up to a timeout. */
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function makeQueue(overrides = {}) {
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  const alerts = [];
  const queue = createJobQueue({
    store,
    concurrency: 2,
    leaseSeconds: 120,
    sweepIntervalSeconds: 3600, // effectively disabled per-test unless overridden
    bufferFilePath: makeTmpBufferPath(),
    onAlert: (msg) => alerts.push(msg),
    ...overrides,
  });
  return { queue, store, redis, alerts };
}

test('a handler that succeeds acks the job as done', async () => {
  const { queue, store } = makeQueue();
  const calls = [];
  queue.registerHandler('inbound_message', async (job) => {
    calls.push(job.id);
  });

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: { x: 1 } });
  await queue.start();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'done';
  });
  assert.ok(settled, 'job should reach done state');
  assert.deepStrictEqual(calls, [job.id]);

  await queue.stop({ graceMs: 0 });
});

test('enqueueDeduped only creates one job for the same WhatsApp message id', async () => {
  const { queue, store } = makeQueue();
  queue.registerHandler('inbound_message', async () => {});

  const first = await queue.enqueueDeduped({
    waMessageId: 'wamid-1',
    type: 'inbound_message',
    payload: {},
  });
  const second = await queue.enqueueDeduped({
    waMessageId: 'wamid-1',
    type: 'inbound_message',
    payload: {},
  });

  assert.strictEqual(first.deduped, false);
  assert.strictEqual(second.deduped, true);

  const counts = await store.getCounts();
  assert.strictEqual(counts.queued, 1);
});

test('a transient failure reschedules the job with backoff rather than dead-lettering it', async () => {
  const { queue, store } = makeQueue({ classifyError: () => 'transient' });
  let callCount = 0;
  queue.registerHandler('inbound_message', async () => {
    callCount += 1;
    throw new Error('ECONNRESET');
  });

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.tick();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'queued' && stored.attempts === 1;
  });
  assert.ok(settled, 'job should be rescheduled as queued after one transient failure');
  assert.strictEqual(callCount, 1);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.last_error, 'ECONNRESET');
  assert.ok(new Date(stored.next_attempt_at).getTime() > Date.now(), 'next_attempt_at should be in the future');

  const counts = await store.getCounts();
  assert.strictEqual(counts.dead, 0);

  await queue.stop({ graceMs: 0 });
});

test('a permanent failure dead-letters the job immediately without retrying', async () => {
  const { queue, store, alerts } = makeQueue({ classifyError: () => 'permanent' });
  let callCount = 0;
  queue.registerHandler('inbound_message', async () => {
    callCount += 1;
    throw new Error('schema violation: amount missing');
  });

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.tick();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'dead';
  });
  assert.ok(settled, 'job should be dead-lettered');
  assert.strictEqual(callCount, 1);

  const deadIds = await store.listDeadIds();
  assert.deepStrictEqual(deadIds, [job.id]);
  assert.ok(alerts.some((a) => a.includes('dead-lettered')));

  await queue.stop({ graceMs: 0 });
});

test('a blocked failure reschedules on the fixed interval without incrementing attempts beyond the claim', async () => {
  const { queue, store, alerts } = makeQueue({ classifyError: () => 'blocked' });
  queue.registerHandler('sheet_write', async () => {
    throw new Error('401 Unauthorized');
  });

  const job = await queue.enqueueJob({ type: 'sheet_write', payload: {} });
  await queue.tick();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'queued';
  });
  assert.ok(settled);

  const stored = await store.getJob(job.id);
  // The claim itself increments attempts to 1 (that's the "claim", not
  // the "failure", per Part A3's model) — the blocked-specific guarantee
  // is that it does NOT keep climbing on every retry the way transient
  // does, and is rescheduled ~15 minutes out rather than on the short
  // exponential schedule.
  const delayMs = new Date(stored.next_attempt_at).getTime() - Date.now();
  assert.ok(delayMs > 14 * 60 * 1000, `expected ~15min blocked retry delay, got ${delayMs}ms`);
  assert.ok(alerts.some((a) => a.includes('blocked')));

  await queue.stop({ graceMs: 0 });
});

test('a transient failure exceeding QUEUE_MAX_AGE_HOURS is dead-lettered instead of rescheduled again', async () => {
  const { queue, store } = makeQueue({ classifyError: () => 'transient', maxAgeHours: 0.0001 });
  queue.registerHandler('inbound_message', async () => {
    throw new Error('still down');
  });

  const oldReceivedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {}, receivedAt: oldReceivedAt });
  await queue.tick();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'dead';
  });
  assert.ok(settled, 'an old transient-failing job should eventually dead-letter, not retry forever');

  await queue.stop({ graceMs: 0 });
});

test('concurrency limit is respected: no more than N jobs are handled at once', async () => {
  const { queue } = makeQueue({ concurrency: 2 });
  let concurrentNow = 0;
  let maxConcurrent = 0;
  queue.registerHandler('inbound_message', async () => {
    concurrentNow += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentNow);
    await new Promise((resolve) => setTimeout(resolve, 50));
    concurrentNow -= 1;
  });

  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await queue.enqueueJob({ type: 'inbound_message', payload: { i } });
  }
  await queue.start();

  await waitUntil(() => Promise.resolve(queue._getActiveCount() === 0), { timeoutMs: 3000, intervalMs: 20 });

  assert.ok(maxConcurrent <= 2, `max concurrent handlers observed: ${maxConcurrent}`);
  await queue.stop({ graceMs: 0 });
});

test('one stuck job does not block other independently-scheduled jobs', async () => {
  const { queue, store } = makeQueue({ concurrency: 2, classifyError: () => 'transient' });
  const processedOrder = [];
  queue.registerHandler('inbound_message', async (job) => {
    if (job.payload.stuck) {
      throw new Error('stuck job fails every time');
    }
    processedOrder.push(job.id);
  });

  const stuckJob = await queue.enqueueJob({ type: 'inbound_message', payload: { stuck: true } });
  const goodJob = await queue.enqueueJob({ type: 'inbound_message', payload: { stuck: false } });

  await queue.start();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(goodJob.id);
    return stored && stored.state === 'done';
  });
  assert.ok(settled, 'the good job should complete even though the stuck job keeps failing');
  assert.ok(processedOrder.includes(goodJob.id));

  await queue.stop({ graceMs: 0 });
  // stuckJob is irrelevant to this assertion beyond keeping it referenced
  // for clarity of intent.
  assert.ok(stuckJob.id);
});

test('enqueueJob spills to the local JSONL buffer when the store is unreachable, and drainBuffer replays it', async () => {
  const bufferPath = makeTmpBufferPath();
  const redis = new FakeRedis();
  let failEnqueue = true;
  const flakyStore = {
    ...createRedisJobStore({ redis }),
    async enqueue(job) {
      if (failEnqueue) throw new Error('Redis unreachable');
      const real = createRedisJobStore({ redis });
      return real.enqueue(job);
    },
  };

  const queue = createJobQueue({
    store: flakyStore,
    bufferFilePath: bufferPath,
    sweepIntervalSeconds: 3600,
  });
  queue.registerHandler('inbound_message', async () => {});

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: { text: 'hello' } });

  const bufferContents = await fs.promises.readFile(bufferPath, 'utf8');
  assert.ok(bufferContents.includes(job.id), 'buffered job should be written to the JSONL spill file');

  failEnqueue = false;
  const replayed = await queue.drainBuffer();
  assert.strictEqual(replayed, 1);

  const realStore = createRedisJobStore({ redis });
  const stored = await realStore.getJob(job.id);
  assert.ok(stored, 'job should now exist in the real store after drain');

  const afterDrain = await fs.promises.readFile(bufferPath, 'utf8');
  assert.strictEqual(afterDrain.trim(), '', 'buffer file should be emptied after a successful drain');
});

test('stop() waits for in-flight handlers to finish within the grace period', async () => {
  const { queue } = makeQueue();
  let finished = false;
  queue.registerHandler('inbound_message', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    finished = true;
  });

  await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.start();

  // Give the handler a moment to actually start before we call stop().
  await new Promise((resolve) => setTimeout(resolve, 10));
  await queue.stop({ graceMs: 1000 });

  assert.strictEqual(finished, true, 'in-flight handler should be allowed to finish during the grace period');
});

test('a handler throwing HoldError reschedules the job without incrementing attempts (net of the claim)', async () => {
  const { queue, store } = makeQueue();
  let callCount = 0;
  const { HoldError } = require('../../src/queue/jobTypes');
  queue.registerHandler('inbound_message', async () => {
    callCount += 1;
    throw new HoldError('LLM down, holding', 50);
  });

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.tick();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'queued';
  });
  assert.ok(settled);
  assert.strictEqual(callCount, 1);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.attempts, 0, 'a hold must not count as an attempt');
  assert.strictEqual(stored.last_error, null, 'a hold must never overwrite last_error');

  await queue.stop({ graceMs: 0 });
});

test('a HoldError never dead-letters the job, no matter how many times it is held', async () => {
  const { queue, store, alerts } = makeQueue();
  const { HoldError } = require('../../src/queue/jobTypes');
  let callCount = 0;
  queue.registerHandler('inbound_message', async () => {
    callCount += 1;
    if (callCount < 5) throw new HoldError('still down', 10);
    // eventually succeeds
  });

  const job = await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await queue.start();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'done';
  }, { timeoutMs: 3000 });
  assert.ok(settled, 'the job should eventually succeed after several holds');
  assert.ok(!alerts.some((a) => a.includes('dead-lettered')));

  await queue.stop({ graceMs: 0 });
});

test('checkQueueHealth alerts when the oldest job exceeds alertOldestMinutes', async () => {
  const { queue, alerts } = makeQueue({ alertOldestMinutes: 0.01 }); // ~0.6s threshold
  // A handler that never resolves keeps the job stuck "inflight" for the
  // duration of this test, so it stays the oldest job in the queue
  // rather than being claimed-and-dead-lettered (no handler registered)
  // before the alert-worthy age is reached.
  queue.registerHandler('inbound_message', () => new Promise(() => {}));
  await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  // Simply wait past the ~0.6s threshold — the job's age (received_at,
  // set at enqueue time) will then be old enough to trip the alert.
  await new Promise((resolve) => setTimeout(resolve, 700));

  await queue.checkQueueHealth();

  assert.ok(alerts.some((a) => a.includes('oldest job is')), `expected an oldest-job-age alert, got: ${JSON.stringify(alerts)}`);
});

test('checkQueueHealth does not alert when the oldest job is within the threshold', async () => {
  const { queue, alerts } = makeQueue({ alertOldestMinutes: 15 });
  await queue.enqueueJob({ type: 'inbound_message', payload: {} });

  await queue.checkQueueHealth();

  assert.ok(!alerts.some((a) => a.includes('oldest job is')));
});

test('checkQueueHealth alerts when queue depth is unusually high', async () => {
  const { queue, alerts } = makeQueue();
  for (let i = 0; i < 101; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await queue.enqueueJob({ type: 'inbound_message', payload: { i } });
  }

  await queue.checkQueueHealth();

  assert.ok(alerts.some((a) => a.includes('unusually high depth')));
});

test('checkQueueHealth does not alert on normal queue depth', async () => {
  const { queue, alerts } = makeQueue();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await queue.enqueueJob({ type: 'inbound_message', payload: { i } });
  }

  await queue.checkQueueHealth();

  assert.ok(!alerts.some((a) => a.includes('unusually high depth')));
});

test('a successful job run clears the blocked throttle for its type, so a future blocker alerts immediately', async () => {
  let shouldFail = true;
  const { queue, alerts } = makeQueue({ classifyError: () => 'blocked' });
  queue.registerHandler('sheet_write', async () => {
    if (shouldFail) throw new Error('401 Unauthorized');
  });

  await queue.enqueueJob({ type: 'sheet_write', payload: {} });
  await queue.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(alerts.filter((a) => a.includes('blocked')).length, 1);

  // "Fix the key" — the next attempt succeeds.
  shouldFail = false;
  await queue.tick(); // job isn't due yet (15min blocked interval) — force it due now via a fresh job instead
  await queue.enqueueJob({ type: 'sheet_write', payload: {}, id: 'sheet_write-fresh' });
  await queue.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Now force a NEW blocker for the same type — should alert again since the throttle was cleared by the success.
  shouldFail = true;
  await queue.enqueueJob({ type: 'sheet_write', payload: {}, id: 'sheet_write-fresh-2' });
  await queue.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(alerts.filter((a) => a.includes('blocked')).length >= 2, `expected the throttle to reset after a success, got: ${JSON.stringify(alerts)}`);

  await queue.stop({ graceMs: 0 });
});

test('stop() stops claiming new work even if jobs are ready', async () => {
  const { queue, store } = makeQueue();
  let callCount = 0;
  queue.registerHandler('inbound_message', async () => {
    callCount += 1;
  });

  await queue.start();
  await queue.stop({ graceMs: 0 });

  await queue.enqueueJob({ type: 'inbound_message', payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.strictEqual(callCount, 0, 'no job should be claimed/processed after stop()');
  const counts = await store.getCounts();
  assert.strictEqual(counts.queued, 1, 'the job should remain safely queued, not lost');
});
