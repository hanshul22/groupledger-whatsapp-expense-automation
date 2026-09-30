// normalizerHoldIntegration.test.js
// Integration test for Part B's normalizer hold policy wired end-to-end
// through messagePipeline.js + jobQueue.js: a job whose normalizer call
// fails technically is held (rescheduled without an attempt) rather than
// producing a clarification message, and eventually falls back to
// passthrough once the hold window elapses — using the real
// createJobQueue/createRedisJobStore against FakeRedis. No real network
// or Redis connection.

const { test } = require('node:test');
const assert = require('node:assert');

const { createJobQueue } = require('../../src/queue/jobQueue');
const { createRedisJobStore } = require('../../src/queue/redisStore');
const { createMessagePipeline, NormalizerHoldError } = require('../../src/messagePipeline');
const { decideNormalizerHold } = require('../../src/queue/normalizerHold');
const { HoldError } = require('../../src/queue/jobTypes');
const { createPushNameCache } = require('../../src/pushNameCache');
const { FakeRedis } = require('./fakeRedis');

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function makeSock() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: 'sent-1' } };
    },
    groupMetadata: async () => ({ participants: [] }),
  };
}

function makeMsg({ text, waMessageId = 'wamid-hold-test', timestampSec }) {
  return {
    key: { participant: '111@s.whatsapp.net', remoteJid: 'group@g.us', id: waMessageId },
    message: { conversation: text },
    pushName: 'Alice',
    messageTimestamp: timestampSec,
  };
}

test('an LLM-down normalizer failure holds the inbound_message job (rescheduled without an attempt), sending no clarification', async () => {
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({ store, sweepIntervalSeconds: 3600 });

  let normalizeCallCount = 0;
  const normalizer = {
    normalize: async ({ parsed }) => {
      normalizeCallCount += 1;
      return { status: 'passthrough', entry: parsed, meta: { changed: false, notes: 'LLM call failed (status 500).' } };
    },
  };
  const commandHandler = { handleCommand: async () => false };
  const approvalEngine = { handleTextMessage: async () => false, submitEntry: async () => {} };
  const pipeline = createMessagePipeline({
    normalizer,
    commandHandler,
    approvalEngine,
    pushNameCache: createPushNameCache(),
    allowedParties: [],
    normalizerHoldPolicy: ({ normalizeResult, receivedAt, parserProducedUsableEntry }) =>
      decideNormalizerHold({ normalizeResult, onLlmDown: 'hold', receivedAt, maxHoldMinutes: 10, parserProducedUsableEntry }),
  });

  const sock = makeSock();
  queue.registerHandler('inbound_message', async (job) => {
    try {
      await pipeline.handleGroupMessage(sock, job.payload.msg, { jobReceivedAt: new Date(job.received_at) });
    } catch (err) {
      if (err instanceof NormalizerHoldError) throw new HoldError(err.message);
      throw err;
    }
  });

  const msg = makeMsg({ text: 'gave 5000 to Sita on 22 Aug' }); // regex-parseable, so parserProducedUsableEntry=true
  const job = await queue.enqueueJob({ type: 'inbound_message', payload: { msg, entryHash: 'fixed-hash' }, receivedAt: new Date() });
  await queue.tick();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'queued';
  });
  assert.ok(settled, 'the job should be rescheduled (held), not dead-lettered or stuck processing');
  assert.ok(normalizeCallCount >= 1);

  const stored = await store.getJob(job.id);
  assert.strictEqual(stored.attempts, 0, 'a hold must not count as an attempt');
  assert.strictEqual(sock.sentMessages.length, 0, 'no clarification/reply should ever be sent just because the LLM was down');

  await queue.stop({ graceMs: 0 });
});

test('after the hold window elapses, the job falls back to passthrough and proceeds with the parsed entry', async () => {
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';
  const redis = new FakeRedis();
  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({ store, sweepIntervalSeconds: 3600 });

  const normalizer = {
    // Mirrors normalizer.js's REAL contract: passthroughResult(parsed,
    // ...) always carries the v1.0 parser's own entry through unchanged
    // on ANY passthrough (including an LLM-call-failure passthrough) —
    // never null. This mock previously (incorrectly) returned entry:
    // null here, which doesn't match the real module's behavior and
    // caused this test to exercise the wrong code path.
    normalize: async ({ parsed }) => ({
      status: 'passthrough',
      entry: parsed,
      meta: { changed: false, notes: 'LLM call failed (status 500).' },
    }),
  };
  const commandHandler = { handleCommand: async () => false };
  const submittedEntries = [];
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async (entry) => submittedEntries.push(entry),
  };
  const pipeline = createMessagePipeline({
    normalizer,
    commandHandler,
    approvalEngine,
    pushNameCache: createPushNameCache(),
    allowedParties: [],
    normalizerHoldPolicy: ({ normalizeResult, receivedAt, parserProducedUsableEntry }) =>
      decideNormalizerHold({ normalizeResult, onLlmDown: 'hold', receivedAt, maxHoldMinutes: 0.001, parserProducedUsableEntry }), // ~60ms window
  });

  const sock = makeSock();
  queue.registerHandler('inbound_message', async (job) => {
    try {
      await pipeline.handleGroupMessage(sock, job.payload.msg, { jobReceivedAt: new Date(job.received_at) });
    } catch (err) {
      if (err instanceof NormalizerHoldError) throw new HoldError(err.message, 20);
      throw err;
    }
  });

  const msg = makeMsg({ text: 'gave 5000 to Sita on 22 Aug' });
  const receivedAt = new Date(Date.now() - 100); // already 100ms old — past the ~60ms window immediately
  const job = await queue.enqueueJob({ type: 'inbound_message', payload: { msg, entryHash: 'fixed-hash-2' }, receivedAt });
  await queue.start();

  const settled = await waitUntil(async () => {
    const stored = await store.getJob(job.id);
    return stored && stored.state === 'done';
  });
  assert.ok(settled, 'once the hold window has elapsed, the job should proceed (passthrough) and complete');
  assert.strictEqual(submittedEntries.length, 1);
  assert.strictEqual(submittedEntries[0].amount, 5000, 'the v1.0 regex-parsed entry should be used, unnormalized');

  await queue.stop({ graceMs: 0 });
});
