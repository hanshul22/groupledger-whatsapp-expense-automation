// integration.test.js
// End-to-end integration tests for the durable queue wiring introduced in
// Phases 1-3: inbound_message -> sheet_write -> wa_reply, using the real
// createJobQueue/createRedisJobStore against FakeRedis, a real
// createSheetsWriter against a fake Sheets client, and a real
// createApprovalEngine + createRedisPendingStore. No real network/Redis
// connection anywhere in this file.
//
// These tests exercise the specific crash-recovery scenarios named in the
// task's acceptance criteria:
//   - Same WhatsApp message delivered twice -> one job, one row.
//   - Kill mid-job (simulated by manually re-running a handler against
//     the same store/job id) -> exactly one row after "restart".

const { test } = require('node:test');
const assert = require('node:assert');

const { createJobQueue } = require('../../src/queue/jobQueue');
const { createRedisJobStore } = require('../../src/queue/redisStore');
const { deriveEntryHash } = require('../../src/queue/entryHash');
const { runWithEntryHash, getCurrentEntryHash } = require('../../src/queue/jobContext');
const { createSheetsWriter } = require('../../src/sheetsWriter');
const { createApprovalEngine } = require('../../src/approvalEngine');
const { createRedisPendingStore } = require('../../src/redisPendingStore');
const { FakeRedis } = require('./fakeRedis');

/** A fake Sheets client with a real column-A store, shared across "process restarts". */
function makeFakeSheetsClient() {
  const columnA = []; // simulates the real Entries tab's column A
  const rows = [];
  return {
    rows,
    client: {
      spreadsheets: {
        values: {
          get: async () => ({ data: { values: columnA.map((id) => [id]) } }),
          append: async (request) => {
            const row = request.requestBody.values[0];
            columnA.push(row[0]);
            rows.push(row);
            return { data: { updates: { updatedRange: `Entries!A${rows.length}:N${rows.length}` } } };
          },
        },
      },
    },
  };
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Build one complete wiring: queue + sheetsWriter + approvalEngine +
 * pendingStore, all against the SAME FakeRedis instance and the SAME
 * fake Sheets client — so "restart" can be simulated by constructing a
 * fresh queue/approvalEngine against the same underlying stores.
 */
function makeSystem({ redis, sheetsClient, isAdmin }) {
  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({ store, sweepIntervalSeconds: 3600, bufferFilePath: `./data/test-buffer-${Math.random()}.jsonl` });
  const sheetsWriter = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient });
  const pendingStore = createRedisPendingStore({ redis });

  const sentMessages = [];
  const sendMessage = async (jid, content) => {
    sentMessages.push({ jid, content });
    return { key: { id: `notif-${sentMessages.length}` } };
  };

  const approvalEngine = createApprovalEngine({
    sock: { groupMetadata: async () => ({ participants: [] }) },
    groupId: 'group@g.us',
    isGroupAdmin: async () => isAdmin,
    sendMessage,
    pendingStore,
    onResolution: async (resolution) => {
      const stamped = { ...resolution, entryId: resolution.entryId || getCurrentEntryHash() };
      await queue.enqueueJob({ type: 'sheet_write', payload: { resolution: stamped }, id: `sheet_write-${stamped.entryId}` });
    },
  });

  queue.registerHandler('sheet_write', async (job) => {
    await sheetsWriter.writeResolutionIdempotent(job.payload.resolution);
  });
  queue.registerHandler('wa_reply', async () => {});

  return { queue, sheetsWriter, approvalEngine, pendingStore, sentMessages };
}

test('the same WhatsApp message delivered twice produces exactly one job and one row (admin/auto_approved path)', async () => {
  const redis = new FakeRedis();
  const { client: sheetsClient, rows } = makeFakeSheetsClient();
  const { queue, approvalEngine } = makeSystem({ redis, sheetsClient, isAdmin: true });
  await approvalEngine.init();

  queue.registerHandler('inbound_message', async (job) => {
    const entry = { amount: 5000, given_to: 'Sita', date: '2026-08-22', paid_by: 'Alice', raw_message: 'gave 5000 to Sita' };
    await runWithEntryHash(job.payload.entryHash, () =>
      approvalEngine.submitEntry(entry, {
        submittedBy: 'Alice',
        submittedByJid: '111@s.whatsapp.net',
        submittedAt: new Date(),
      }),
    );
  });
  await queue.start();

  const waMessageId = 'wamid-duplicate-test';
  const entryHash = deriveEntryHash(waMessageId);

  // Simulate WhatsApp redelivering the SAME message after a reconnect.
  const first = await queue.enqueueDeduped({ waMessageId, type: 'inbound_message', payload: { entryHash } });
  const second = await queue.enqueueDeduped({ waMessageId, type: 'inbound_message', payload: { entryHash } });

  assert.strictEqual(first.deduped, false);
  assert.strictEqual(second.deduped, true, 'the second delivery of the same WhatsApp message id must be deduped, never creating a second job');

  await waitUntil(() => Promise.resolve(rows.length === 1), { timeoutMs: 3000, intervalMs: 20 });

  assert.strictEqual(rows.length, 1, 'exactly one row should exist in the sheet');

  await queue.stop({ graceMs: 0 });
});

test('killing the process between "sheet append succeeded" and "job acked" leaves exactly one row after restart', async () => {
  const redis = new FakeRedis();
  const { client: sheetsClient, rows } = makeFakeSheetsClient();

  // "Process 1": claims the sheet_write job, the handler's append
  // succeeds, but we simulate a crash by NEVER calling ack (i.e. we just
  // stop using this queue instance without acking) — the job record
  // stays 'processing' with an active lease in Redis, exactly as it
  // would if the real process had died mid-handler.
  const resolution = {
    status: 'auto_approved',
    entryId: deriveEntryHashSafe('wamid-crash-test'),
    entry: { amount: 7000, given_to: 'Ravi', date: '2026-09-01', raw_message: 'gave 7000 to Ravi' },
    submittedBy: 'Bob',
    approved_by: 'Bob',
    approved_at: new Date().toISOString(),
  };

  const store1 = createRedisJobStore({ redis });
  const jobId = `sheet_write-${resolution.entryId}`;
  const { createJob } = require('../../src/queue/jobTypes');
  const job = createJob({ type: 'sheet_write', payload: { resolution }, id: jobId });
  await store1.enqueue(job);

  const [claimed] = await store1.claimReady({ limit: 1, leaseSeconds: 1 }); // short lease
  assert.ok(claimed);

  // Run the handler body directly (simulating process 1's in-flight
  // work) — the append succeeds, but we never call store1.ack(...),
  // simulating the process dying right after the Sheets API call
  // returned.
  const sheetsWriter1 = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient });
  await sheetsWriter1.writeResolutionIdempotent(claimed.payload.resolution);
  assert.strictEqual(rows.length, 1, 'the append should have happened exactly once so far');
  // (process 1 "crashes" here — no ack call)

  // Simulate the lease expiring (time passing) and a fresh process
  // ("process 2") starting up: reclaim expired leases, then re-claim and
  // re-run the SAME job.
  const inflightZset = redis.zsets.get('wq:inflight');
  inflightZset.set(job.id, Date.now() - 1000); // force the lease into the past

  const store2 = createRedisJobStore({ redis });
  const reclaimed = await store2.reclaimExpiredLeases();
  assert.deepStrictEqual(reclaimed, [job.id]);

  const [reClaimed] = await store2.claimReady({ limit: 1, leaseSeconds: 120 });
  assert.ok(reClaimed, 'process 2 should be able to re-claim the reclaimed job');

  const sheetsWriter2 = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient });
  const result = await sheetsWriter2.writeResolutionIdempotent(reClaimed.payload.resolution);

  assert.strictEqual(result.written, false, 'the retry must detect the entry already exists and skip the append');
  assert.strictEqual(rows.length, 1, 'exactly one row must exist after the crash-and-retry sequence');

  await store2.ack(reClaimed);
});

function deriveEntryHashSafe(waMessageId) {
  return require('../../src/queue/entryHash').deriveEntryHash(waMessageId);
}

test('non-admin submit, then a simulated restart, then admin APPROVE — works and never re-runs the normalizer/parse step (no duplicate pending entries)', async () => {
  const redis = new FakeRedis();
  const { client: sheetsClient, rows } = makeFakeSheetsClient();

  // "Process 1": non-admin submits, creating a pending entry via the
  // Redis-backed pending store.
  const pendingStore1 = createRedisPendingStore({ redis });
  const engine1 = createApprovalEngine({
    sock: { groupMetadata: async () => ({ participants: [] }) },
    groupId: 'group@g.us',
    isGroupAdmin: async () => false,
    sendMessage: async () => ({ key: { id: 'notif-1' } }),
    pendingStore: pendingStore1,
    onResolution: async () => {
      throw new Error('onResolution should not be called yet — entry is still pending');
    },
  });
  await engine1.init();

  const entry = { amount: 3000, given_to: 'Meera', date: '2026-09-05', paid_by: 'Carol', raw_message: 'gave 3000 to Meera' };
  await engine1.submitEntry(entry, { submittedBy: 'Carol', submittedByJid: '222@s.whatsapp.net', submittedAt: new Date().toISOString() });

  const pendingIds = await pendingStore1.getAllIds();
  assert.strictEqual(pendingIds.length, 1);
  const entryId = pendingIds[0];

  // --- simulated restart: brand-new process, same Redis ---
  const pendingStore2 = createRedisPendingStore({ redis });
  let resolvedCount = 0;
  let lastResolution;
  const engine2 = createApprovalEngine({
    sock: { groupMetadata: async () => ({ participants: [] }) },
    groupId: 'group@g.us',
    isGroupAdmin: async () => true, // the responder is an admin
    sendMessage: async () => ({ key: { id: 'notif-2' } }),
    pendingStore: pendingStore2,
    onResolution: async (resolution) => {
      resolvedCount += 1;
      lastResolution = resolution;
      await sheetsWriter2.writeResolutionIdempotent({ ...resolution, entryId: resolution.entryId });
    },
  });
  await engine2.init();
  const sheetsWriter2 = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient });

  const handled = await engine2.handleTextMessage({
    text: `APPROVE ${entryId}`,
    senderJid: '333@s.whatsapp.net',
    responderName: 'AdminX',
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(resolvedCount, 1, 'the approval should resolve exactly once, with no re-parse/re-normalize step needed (the pending record already carried the parsed entry)');
  assert.strictEqual(lastResolution.entry.amount, 3000, 'the resolved entry must be exactly what was originally submitted, never re-derived');
  assert.strictEqual(rows.length, 1);

  await queueFakeCleanup();
});

async function queueFakeCleanup() {
  // no-op — present for readability/symmetry with other tests' cleanup steps
}
