// redisPendingStore.test.js
// Tests for src/redisPendingStore.js — the Redis-backed Pending_Store
// that implements the exact same interface as pendingStore.js's
// createPendingStore, per Part A6 (STATE_STORE=redis). Uses the queue's
// FakeRedis in-memory fake (tests/queue/fakeRedis.js) — no real Redis
// connection.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createRedisPendingStore } = require('../src/redisPendingStore');
const { FakeRedis } = require('./queue/fakeRedis');

function makeStore() {
  const redis = new FakeRedis();
  return createRedisPendingStore({ redis });
}

const pendingEntryArb = fc.record({
  entryId: fc.stringMatching(/^[a-z0-9]{5}$/),
  amount: fc.double({ min: 0.01, max: 1000000, noNaN: true, noDefaultInfinity: true }).filter((n) => n > 0),
  given_to: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  paid_by: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  submittedBy: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  date: fc
    .tuple(
      fc.integer({ min: 2020, max: 2030 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
    )
    .map(
      ([y, m, d]) =>
        `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    ),
  submittedByJid: fc.string({ minLength: 1, maxLength: 30 }),
  submittedAt: fc
    .date({ min: new Date(2020, 0, 1), max: new Date(2030, 0, 1), noInvalidDate: true })
    .map((d) => d.toISOString()),
});

function buildEntry(fields) {
  return {
    entryId: fields.entryId,
    status: 'pending',
    parsedEntry: {
      amount: fields.amount,
      given_to: fields.given_to,
      date: fields.date,
      paid_by: fields.paid_by,
      raw_message: 'raw message text',
    },
    submittedBy: fields.submittedBy,
    submittedByJid: fields.submittedByJid,
    submittedAt: fields.submittedAt,
    notified: true,
    notificationMessageIds: [],
    normalizerMeta: null,
  };
}

test('add() then getById() round-trips a Pending_Entry exactly, matching pendingStore.js\'s contract', async () => {
  await fc.assert(
    fc.asyncProperty(pendingEntryArb, async (fields) => {
      const store = makeStore();
      await store.init();
      const entry = buildEntry(fields);

      await store.add(entry);
      const fetched = await store.getById(entry.entryId);

      assert.deepStrictEqual(fetched, entry);
    }),
    { numRuns: 100 },
  );
});

test('a store instance freshly constructed against the same Redis sees a prior instance\'s writes (restart-survival)', async () => {
  const redis = new FakeRedis();
  const first = createRedisPendingStore({ redis });
  await first.init();

  const entry = buildEntry({
    entryId: 'ab12c',
    amount: 5000,
    given_to: 'Sita',
    paid_by: 'Alice',
    submittedBy: 'Alice',
    date: '2026-08-22',
    submittedByJid: '111@s.whatsapp.net',
    submittedAt: new Date().toISOString(),
  });
  await first.add(entry);

  // Simulate a process restart: a brand-new store instance against the
  // same underlying Redis.
  const second = createRedisPendingStore({ redis });
  await second.init();
  const reloaded = await second.getById('ab12c');

  assert.deepStrictEqual(reloaded, entry);
});

test('resolveIfPending returns newly_resolved exactly once, then already_resolved on every subsequent call (first-response-wins)', async () => {
  const store = makeStore();
  await store.init();
  const entry = buildEntry({
    entryId: 'xy99z',
    amount: 1000,
    given_to: 'Bob',
    paid_by: 'Carol',
    submittedBy: 'Carol',
    date: '2026-01-01',
    submittedByJid: '222@s.whatsapp.net',
    submittedAt: new Date().toISOString(),
  });
  await store.add(entry);

  const first = await store.resolveIfPending('xy99z', {
    status: 'approved',
    resolvedBy: 'AdminA',
    resolvedAt: new Date().toISOString(),
  });
  assert.strictEqual(first.outcome, 'newly_resolved');
  assert.strictEqual(first.record.status, 'approved');
  assert.strictEqual(first.record.resolvedBy, 'AdminA');

  const second = await store.resolveIfPending('xy99z', {
    status: 'rejected',
    resolvedBy: 'AdminB',
    resolvedAt: new Date().toISOString(),
  });
  assert.strictEqual(second.outcome, 'already_resolved');
  assert.strictEqual(second.resolvedBy, 'AdminA');
  assert.strictEqual(second.status, 'approved');
});

test('resolveIfPending on an unknown entryId returns already_resolved with undefined fields, never throws', async () => {
  const store = makeStore();
  await store.init();
  const result = await store.resolveIfPending('doesnotexist', {
    status: 'approved',
    resolvedBy: 'AdminA',
    resolvedAt: new Date().toISOString(),
  });
  assert.strictEqual(result.outcome, 'already_resolved');
  assert.strictEqual(result.resolvedBy, undefined);
  assert.strictEqual(result.status, undefined);
});

test('concurrent resolveIfPending calls for the same entryId are serialized: exactly one newly_resolved outcome', async () => {
  const store = makeStore();
  await store.init();
  const entry = buildEntry({
    entryId: 'cc111',
    amount: 2000,
    given_to: 'Dave',
    paid_by: 'Eve',
    submittedBy: 'Eve',
    date: '2026-02-02',
    submittedByJid: '333@s.whatsapp.net',
    submittedAt: new Date().toISOString(),
  });
  await store.add(entry);

  const results = await Promise.all([
    store.resolveIfPending('cc111', { status: 'approved', resolvedBy: 'AdminA', resolvedAt: new Date().toISOString() }),
    store.resolveIfPending('cc111', { status: 'rejected', resolvedBy: 'AdminB', resolvedAt: new Date().toISOString() }),
  ]);

  const newlyResolvedCount = results.filter((r) => r.outcome === 'newly_resolved').length;
  assert.strictEqual(newlyResolvedCount, 1);
});

test('findByNotificationMessageId resolves via the reverse index set by add()/update()', async () => {
  const store = makeStore();
  await store.init();
  const entry = buildEntry({
    entryId: 'nn222',
    amount: 3000,
    given_to: 'Frank',
    paid_by: 'Grace',
    submittedBy: 'Grace',
    date: '2026-03-03',
    submittedByJid: '444@s.whatsapp.net',
    submittedAt: new Date().toISOString(),
  });
  entry.notificationMessageIds = ['notif-msg-1'];
  await store.add(entry);

  const found = await store.findByNotificationMessageId('notif-msg-1');
  assert.deepStrictEqual(found, entry);

  const notFound = await store.findByNotificationMessageId('nonexistent');
  assert.strictEqual(notFound, undefined);
});

test('getAllIds reflects every entryId ever added', async () => {
  const store = makeStore();
  await store.init();
  await store.add(buildEntry({ entryId: 'aaaaa', amount: 1, given_to: 'A', paid_by: 'A', submittedBy: 'A', date: '2026-01-01', submittedByJid: 'a@x', submittedAt: new Date().toISOString() }));
  await store.add(buildEntry({ entryId: 'bbbbb', amount: 2, given_to: 'B', paid_by: 'B', submittedBy: 'B', date: '2026-01-01', submittedByJid: 'b@x', submittedAt: new Date().toISOString() }));

  const ids = await store.getAllIds();
  assert.deepStrictEqual(new Set(ids), new Set(['aaaaa', 'bbbbb']));
});
