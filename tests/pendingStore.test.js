// pendingStore.test.js
// Property-based tests for src/pendingStore.js (Approval Engine
// Pending_Store). See .kiro/specs/approval-engine/design.md "Persistence
// Strategy" and "Correctness Properties — Property 12" for design context.
//
// Validates: Requirements 8.1, 8.2

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPendingStore } = require('../src/pendingStore');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-test-'));
}

// Generator for a Pending_Entry-shaped object with reasonable arbitrary
// field values, per the task's generator spec.
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
  };
}

// Feature: approval-engine, Property 12: Persisted pending entries survive a reload, and removal-before-completion is honored
test('Property 12: persisted pending entries survive a reload, and removal-before-completion is honored', async () => {
  await fc.assert(
    fc.asyncProperty(pendingEntryArb, async (fields) => {
      const tmpDir = makeTmpDir();
      try {
        const storePath = path.join(tmpDir, 'pending-store.json');
        const auditLogPath = path.join(tmpDir, 'audit.log');

        const entry = buildEntry(fields);

        // --- Round-trip: add, then reload with a fresh store instance ---
        const store = createPendingStore({ storePath, auditLogPath });
        await store.init();
        await store.add(entry);

        const freshStore1 = createPendingStore({ storePath, auditLogPath });
        await freshStore1.init();
        const reloaded = freshStore1.getById(entry.entryId);

        assert.deepStrictEqual(reloaded, entry);

        // --- Removal-before-completion: resolve, then reload again ---
        const resolvedAt = new Date().toISOString();
        const result = await store.resolveIfPending(entry.entryId, {
          status: 'approved',
          resolvedBy: 'someAdminJid',
          resolvedAt,
        });

        assert.strictEqual(result.outcome, 'newly_resolved');
        assert.strictEqual(result.record.status, 'approved');
        assert.strictEqual(result.record.resolvedBy, 'someAdminJid');
        assert.strictEqual(result.record.resolvedAt, resolvedAt);

        const freshStore2 = createPendingStore({ storePath, auditLogPath });
        await freshStore2.init();
        const afterResolve = freshStore2.getById(entry.entryId);

        assert.strictEqual(afterResolve, undefined);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }),
    { numRuns: 100 },
  );
});

// Feature: approval-engine, Property 12: Persisted pending entries survive a reload, and removal-before-completion is honored
test('Property 12: forced removal-write failure propagates and rolls back the in-memory status to pending', async () => {
  await fc.assert(
    fc.asyncProperty(pendingEntryArb, async (fields) => {
      const tmpDir = makeTmpDir();
      try {
        const storePath = path.join(tmpDir, 'pending-store.json');
        const auditLogPath = path.join(tmpDir, 'audit.log');

        const entry = buildEntry(fields);

        const store = createPendingStore({ storePath, auditLogPath });
        await store.init();
        await store.add(entry);

        // Force the atomic write's temp-file write to fail: replace the
        // `<storePath>.tmp` path with a directory, so
        // `fs.promises.writeFile(tmpPath, ...)` inside `atomicWriteStore`
        // throws EISDIR on the very next write attempt (the removal write
        // triggered by resolveIfPending below).
        const tmpFilePath = `${storePath}.tmp`;
        fs.mkdirSync(tmpFilePath);

        await assert.rejects(
          store.resolveIfPending(entry.entryId, {
            status: 'approved',
            resolvedBy: 'someAdminJid',
            resolvedAt: new Date().toISOString(),
          }),
        );

        // In-memory rollback: the SAME store instance must still show the
        // entry as pending (not approved), confirming resolveIfPending
        // never durably completed and never invoked the callback path
        // that would follow a 'newly_resolved' outcome.
        const stillPending = store.getById(entry.entryId);
        assert.strictEqual(stillPending.status, 'pending');
        assert.strictEqual(stillPending.resolvedBy, undefined);
        assert.strictEqual(stillPending.resolvedAt, undefined);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }),
    { numRuns: 30 },
  );
});

// Feature: approval-engine, Requirement 8.4: missing store file on startup
// results in zero pending entries and no error.
test('init() with a missing store file: no error, zero pending entries', async () => {
  const tmpDir = makeTmpDir();
  try {
    const storePath = path.join(tmpDir, 'does-not-exist.json');
    const auditLogPath = path.join(tmpDir, 'audit.log');

    const store = createPendingStore({ storePath, auditLogPath });
    await assert.doesNotReject(store.init());
    assert.deepStrictEqual(store.getAllIds(), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Feature: approval-engine, Requirement 8.4: present-but-empty-string store
// file on startup results in zero pending entries and no error.
test('init() with a present-but-empty-string store file: no error, zero pending entries', async () => {
  const tmpDir = makeTmpDir();
  try {
    const storePath = path.join(tmpDir, 'pending-store.json');
    const auditLogPath = path.join(tmpDir, 'audit.log');
    fs.writeFileSync(storePath, '');

    const store = createPendingStore({ storePath, auditLogPath });
    await assert.doesNotReject(store.init());
    assert.deepStrictEqual(store.getAllIds(), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Feature: approval-engine, Requirement 8.5: corrupt JSON with a successful
// audit-log write results in zero pending entries and a
// `store_load_corrupt` audit log entry.
test('init() with corrupt JSON store file: no error, zero pending entries, audit log records store_load_corrupt', async () => {
  const tmpDir = makeTmpDir();
  try {
    const storePath = path.join(tmpDir, 'pending-store.json');
    const auditLogPath = path.join(tmpDir, 'audit.log');
    fs.writeFileSync(storePath, '{not valid json');

    const store = createPendingStore({ storePath, auditLogPath });
    await assert.doesNotReject(store.init());
    assert.deepStrictEqual(store.getAllIds(), []);

    const logContents = fs.readFileSync(auditLogPath, { encoding: 'utf8' });
    const logLines = logContents
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    assert.ok(
      logLines.some((entry) => entry.event === 'store_load_corrupt'),
      'expected audit log to contain a store_load_corrupt entry',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Feature: approval-engine, Requirement 8.5: corrupt JSON where the
// audit-log write itself fails causes init() to throw/crash instead of
// starting.
test('init() with corrupt JSON store file and a failing audit-log write: init() throws', async () => {
  const tmpDir = makeTmpDir();
  try {
    const storePath = path.join(tmpDir, 'pending-store.json');
    fs.writeFileSync(storePath, '{not valid json');

    // Make the audit log's containing directory path actually be a FILE,
    // so `fs.promises.mkdir(dir, { recursive: true })` inside
    // `appendAuditLog` throws ENOTDIR when it tries to create the audit
    // log's parent directory.
    const auditLogDirAsFile = path.join(tmpDir, 'audit-dir-blocker');
    fs.writeFileSync(auditLogDirAsFile, 'i am a file, not a directory');
    const auditLogPath = path.join(auditLogDirAsFile, 'audit.log');

    const store = createPendingStore({ storePath, auditLogPath });
    await assert.rejects(store.init());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
