// approvalEngine.test.js
// Property-based tests for src/approvalEngine.js's createApprovalEngine(...).
// See .kiro/specs/approval-engine/design.md "Classifier" and "Correctness
// Properties — Property 1" for design context.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.5

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApprovalEngine } = require('../src/approvalEngine');
const { createPendingStore } = require('../src/pendingStore');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'approval-engine-test-'));
}

// Generator for arbitrary Parsed_Entry field content, per the task's
// generator spec (amount: positive number; given_to/paid_by/raw_message:
// non-empty strings; date: a fixed valid 'YYYY-MM-DD' string).
const parsedEntryArb = fc.record({
  amount: fc.double({ min: 0.01, max: 1000000, noNaN: true, noDefaultInfinity: true }).filter((n) => n > 0),
  given_to: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  paid_by: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  raw_message: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
}).map((fields) => ({
  amount: fields.amount,
  given_to: fields.given_to,
  date: '2024-06-15',
  paid_by: fields.paid_by,
  raw_message: fields.raw_message,
}));

// Generator for arbitrary submissionMeta (submittedBy/submittedByJid:
// strings; submittedAt: an ISO string or Date).
const submissionMetaArb = fc.record({
  submittedBy: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  submittedByJid: fc.string({ minLength: 1, maxLength: 30 }),
  submittedAt: fc.oneof(
    fc.date({ min: new Date(2020, 0, 1), max: new Date(2030, 0, 1), noInvalidDate: true }).map((d) => d.toISOString()),
    fc.date({ min: new Date(2020, 0, 1), max: new Date(2030, 0, 1), noInvalidDate: true }),
  ),
});

describe('createApprovalEngine', () => {
  // Feature: approval-engine, Property 1: Admin submissions are always auto-approved without a pending record
  test('Property 1: admin submissions are always auto-approved without a pending record', async () => {
    await fc.assert(
      fc.asyncProperty(parsedEntryArb, submissionMetaArb, async (parsedEntry, submissionMeta) => {
        const tmpDir = makeTmpDir();
        try {
          const storePath = path.join(tmpDir, 'pending-store.json');
          const auditLogPath = path.join(tmpDir, 'audit.log');

          const onResolutionCalls = [];
          const onResolution = async (resolution) => {
            onResolutionCalls.push(resolution);
          };

          const engine = createApprovalEngine({
            sock: {},
            groupId: 'g',
            isGroupAdmin: async () => true,
            sendMessage: async () => ({ key: { id: 'x' } }),
            onResolution,
            storePath,
            auditLogPath,
          });

          await engine.init();
          await engine.submitEntry(parsedEntry, submissionMeta);

          // onResolution called exactly once
          assert.strictEqual(onResolutionCalls.length, 1);

          const resolution = onResolutionCalls[0];

          assert.strictEqual(resolution.status, 'auto_approved');
          assert.strictEqual(resolution.approved_by, submissionMeta.submittedBy);

          // approved_at is a valid ISO timestamp string
          assert.strictEqual(typeof resolution.approved_at, 'string');
          assert.ok(
            !Number.isNaN(Date.parse(resolution.approved_at)),
            `expected approved_at to be a valid ISO timestamp, got ${resolution.approved_at}`,
          );
          assert.strictEqual(resolution.approved_at, new Date(resolution.approved_at).toISOString());

          // entry matches the parsedEntry fields passed in
          assert.deepStrictEqual(resolution.entry, parsedEntry);

          // no pending-store file was created / no pending entries exist
          const freshStore = createPendingStore({ storePath, auditLogPath });
          await freshStore.init();
          assert.deepStrictEqual(freshStore.getAllIds(), []);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('createApprovalEngine — callback failure resilience', () => {
  // Feature: approval-engine, Property 2: Callback failure never reverts an auto-approved classification
  test('Property 2: callback failure never reverts an auto-approved classification', async () => {
    await fc.assert(
      fc.asyncProperty(parsedEntryArb, submissionMetaArb, async (parsedEntry, submissionMeta) => {
        const tmpDir = makeTmpDir();
        try {
          const storePath = path.join(tmpDir, 'pending-store.json');
          const auditLogPath = path.join(tmpDir, 'audit.log');

          let onResolutionCallCount = 0;
          const onResolution = async () => {
            onResolutionCallCount += 1;
            throw new Error('callback boom');
          };

          const engine = createApprovalEngine({
            sock: {},
            groupId: 'g',
            isGroupAdmin: async () => true,
            sendMessage: async () => ({ key: { id: 'x' } }),
            onResolution,
            storePath,
            auditLogPath,
          });

          await engine.init();

          // The engine must complete without throwing despite the
          // callback throwing (Requirement 1.4).
          await assert.doesNotReject(async () => {
            await engine.submitEntry(parsedEntry, submissionMeta);
          });

          // The failure must be logged to the audit log.
          const auditLogContent = fs.readFileSync(auditLogPath, 'utf8');
          const auditLines = auditLogContent
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line));
          assert.ok(
            auditLines.some((entry) => entry.event === 'resolution_callback_failed'),
            `expected at least one audit log line with event 'resolution_callback_failed', got ${auditLogContent}`,
          );

          // The callback must only be invoked once — no retry.
          assert.strictEqual(onResolutionCallCount, 1);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('createApprovalEngine — non-admin pending creation', () => {
  // Feature: approval-engine, Property 3: Non-admin submissions create a uniquely-identified pending entry
  test('Property 3: non-admin submissions create a uniquely-identified pending entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }).chain((count) =>
          fc.tuple(
            fc.constant(count),
            fc.array(parsedEntryArb, { minLength: count, maxLength: count }),
            fc.array(submissionMetaArb, { minLength: count, maxLength: count }),
          ),
        ),
        async ([count, parsedEntries, submissionMetas]) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            const engine = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin: async () => false,
              sendMessage: async () => ({ key: { id: 'x' } }),
              onResolution: async () => {},
              storePath,
              auditLogPath,
            });

            await engine.init();

            for (let i = 0; i < count; i += 1) {
              await engine.submitEntry(parsedEntries[i], submissionMetas[i]);
            }

            const freshStore = createPendingStore({ storePath, auditLogPath });
            await freshStore.init();
            const ids = freshStore.getAllIds();

            assert.strictEqual(ids.length, count, `expected ${count} pending entries, got ${ids.length}`);
            assert.strictEqual(new Set(ids).size, count, 'expected all entryIds to be unique');

            for (const id of ids) {
              assert.ok(
                /^[a-z0-9]{4,6}$/.test(id),
                `expected entryId ${JSON.stringify(id)} to be a 4-6 char lowercase alphanumeric string`,
              );
            }
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('createApprovalEngine — decision-regex boundary (unit)', () => {
  // Targeted unit tests (small fixed set of boundary examples) for the
  // DECISION_REGEX non-match boundary, per design.md "Entry_Id Generator
  // and Matcher — Matching" (Requirement 3.4: non-matching text SHALL NOT
  // be treated as a Decision; Requirement 9.1: Entry_Ids are 4-6 chars).
  //
  // Validates: Requirements 3.4, 9.1
  test('"APPROVE" (no id), "APPROVE " (trailing space, no id), "APPROVEabc" (no space), and "APPROVE abcdefg" (7 chars, too long) are all non-matches', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const sendMessageCalls = [];
      const sendMessage = async (...args) => {
        sendMessageCalls.push(args);
      };

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => false,
        sendMessage,
        onResolution: async () => {},
        storePath,
        auditLogPath,
      });

      await engine.init();

      const nonMatchingInputs = [
        'APPROVE', // no id
        'APPROVE ', // trailing space, no id
        'APPROVEabc', // no space between verb and id
        'APPROVE abcdefg', // 7 chars, too long for the 4-6 char id range
      ];

      for (const text of nonMatchingInputs) {
        const result = await engine.handleTextMessage({ text, senderJid: 'someone' });
        assert.strictEqual(
          !!result,
          false,
          `expected handleTextMessage to return falsy for non-matching input ${JSON.stringify(text)}`,
        );
      }

      // None of these inputs should match the regex at all, so no
      // sendMessage side effect (e.g. a not-found notice, which only
      // fires on an actual match against an unknown id) should ever fire.
      assert.strictEqual(
        sendMessageCalls.length,
        0,
        `expected no sendMessage calls for non-matching inputs, got ${sendMessageCalls.length}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createApprovalEngine — restart resumption', () => {
  // Feature: approval-engine, Property 13: Engine restart resumes matching against previously-persisted entries
  test('Property 13: engine restart resumes matching against previously-persisted entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('APPROVE', 'REJECT'),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        async (parsedEntry, submissionMeta, verb, responderJid) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            // Engine instance #1: forces the non-admin pending-creation
            // path, with zero admins so notifyAdmins' zero-admin path
            // runs cleanly.
            const engine1 = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin: async () => false,
              sendMessage: async () => ({ key: { id: 'x' } }),
              onResolution: async () => {},
              storePath,
              auditLogPath,
            });

            await engine1.init();
            await engine1.submitEntry(parsedEntry, submissionMeta);

            // Read back the created entry's entryId from a fresh store
            // handle rather than from engine1 directly.
            const freshStore = createPendingStore({ storePath, auditLogPath });
            await freshStore.init();
            const ids = freshStore.getAllIds();
            assert.strictEqual(ids.length, 1, `expected exactly one pending entry, got ${ids.length}`);
            const entryId = ids[0];

            // "Discard" engine1 — no explicit teardown method exists, so
            // we simply stop using it and create a brand new engine
            // instance #2 pointed at the same store paths.
            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine2 = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin: async () => true,
              sendMessage: async () => ({ key: { id: 'x' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine2.init();

            const text = `${verb} ${entryId}`;
            const result = await engine2.handleTextMessage({ text, senderJid: responderJid });

            assert.strictEqual(!!result, true, 'expected handleTextMessage to return truthy for a matching decision');

            assert.strictEqual(
              onResolutionCalls.length,
              1,
              `expected onResolution to be called exactly once, got ${onResolutionCalls.length}`,
            );

            const resolution = onResolutionCalls[0];
            const expectedStatus = verb === 'APPROVE' ? 'approved' : 'rejected';

            assert.strictEqual(resolution.status, expectedStatus);
            assert.strictEqual(resolution.entryId, entryId);
            assert.deepStrictEqual(resolution.entry, parsedEntry);
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('createApprovalEngine — text decision matching', () => {
  // Casing transforms applied to the verb and entryId to exercise
  // case-insensitive matching, per design.md "Entry_Id Generator and
  // Matcher — Matching" (Requirements 3.1, 3.2, 9.2).
  const CASING_TRANSFORMS = [
    (s) => s.toUpperCase(),
    (s) => s.toLowerCase(),
    (s) => s.split('').map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join(''),
  ];
  const casingArb = fc.constantFrom(...CASING_TRANSFORMS);
  const edgeWhitespaceArb = fc.constantFrom('', ' ', '  ', '\t');
  const middleWhitespaceArb = fc.constantFrom(' ', '  ', '\t', ' \t ');

  // Same pattern as src/approvalEngine.js's DECISION_REGEX, per
  // design.md "Entry_Id Generator and Matcher — Matching" — reproduced
  // here only to generate/filter arbitrary non-matching text for Part B,
  // not to assert anything about the implementation directly.
  const DECISION_REGEX_FOR_FILTERING = /^\s*(APPROVE|REJECT)\s+([A-Za-z0-9]{4,6})\s*$/i;

  // Feature: approval-engine, Property 5: APPROVE/REJECT text is matched case- and whitespace-insensitively, and non-matching text is disregarded
  test('Property 5a: any casing/whitespace variation of APPROVE <id> / REJECT <id> is matched as a Decision', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('APPROVE', 'REJECT'),
        casingArb,
        casingArb,
        edgeWhitespaceArb,
        edgeWhitespaceArb,
        middleWhitespaceArb,
        async (
          parsedEntry,
          submissionMeta,
          verb,
          verbCasing,
          entryIdCasing,
          leadingWhitespace,
          trailingWhitespace,
          middleWhitespace,
        ) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            // Mutable admin flag: false while the entry is submitted (so
            // a Pending_Entry is actually created rather than
            // auto-approved), then flipped to true before the decision
            // text is handled, so processDecision resolves the entry and
            // we get a definitive "it matched" signal via onResolution.
            let adminMode = false;
            const isGroupAdmin = async () => adminMode;

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'x' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            const freshStore = createPendingStore({ storePath, auditLogPath });
            await freshStore.init();
            const ids = freshStore.getAllIds();
            assert.strictEqual(ids.length, 1, `expected exactly one pending entry, got ${ids.length}`);
            const entryId = ids[0];

            adminMode = true;

            const text = `${leadingWhitespace}${verbCasing(verb)}${middleWhitespace}${entryIdCasing(entryId)}${trailingWhitespace}`;

            const result = await engine.handleTextMessage({ text, senderJid: 'admin1' });

            assert.strictEqual(
              !!result,
              true,
              `expected handleTextMessage to return truthy for matching decision text ${JSON.stringify(text)}`,
            );

            assert.strictEqual(
              onResolutionCalls.length,
              1,
              `expected onResolution to be called exactly once, got ${onResolutionCalls.length}`,
            );

            const expectedStatus = verb === 'APPROVE' ? 'approved' : 'rejected';
            assert.strictEqual(onResolutionCalls[0].status, expectedStatus);
            assert.strictEqual(onResolutionCalls[0].entryId, entryId);
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: approval-engine, Property 5: APPROVE/REJECT text is matched case- and whitespace-insensitively, and non-matching text is disregarded
  test('Property 5b: text that does not match the APPROVE/REJECT pattern is disregarded, leaving every Pending_Entry unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.string({ maxLength: 60 }).filter((s) => !DECISION_REGEX_FOR_FILTERING.test(s)),
        async (parsedEntry, submissionMeta, nonMatchingText) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin: async () => false,
              sendMessage: async () => ({ key: { id: 'x' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();
            await engine.submitEntry(parsedEntry, submissionMeta);

            const freshStoreBefore = createPendingStore({ storePath, auditLogPath });
            await freshStoreBefore.init();
            const idsBefore = freshStoreBefore.getAllIds();
            assert.strictEqual(idsBefore.length, 1, `expected exactly one pending entry, got ${idsBefore.length}`);
            const entryId = idsBefore[0];
            const entryBefore = freshStoreBefore.getById(entryId);

            const onResolutionCallCountBefore = onResolutionCalls.length;

            const result = await engine.handleTextMessage({ text: nonMatchingText, senderJid: 'someone' });

            assert.strictEqual(
              !!result,
              false,
              `expected handleTextMessage to return falsy for non-matching text ${JSON.stringify(nonMatchingText)}`,
            );

            assert.strictEqual(
              onResolutionCalls.length,
              onResolutionCallCountBefore,
              'expected no additional onResolution call from non-matching text',
            );

            const freshStoreAfter = createPendingStore({ storePath, auditLogPath });
            await freshStoreAfter.init();
            const entryAfter = freshStoreAfter.getById(entryId);
            assert.deepStrictEqual(entryAfter, entryBefore, 'expected the Pending_Entry to remain unchanged');
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('createApprovalEngine — quoted-reply decision matching (group)', () => {
  // Any admin replying "approve"/"reject" (bare, no Entry_Id) directly to
  // the group Notification_Message must resolve that entry — this is the
  // group-broadcast replacement for the old DM-based notification flow.
  test('a bare APPROVE reply quoting the Notification_Message resolves the correct entry', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      let adminMode = false;
      const isGroupAdmin = async () => adminMode;

      const onResolutionCalls = [];
      const onResolution = async (resolution) => {
        onResolutionCalls.push(resolution);
      };

      const sendMessage = async () => ({ key: { id: 'group-notif-1' } });

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin,
        sendMessage,
        onResolution,
        storePath,
        auditLogPath,
      });

      await engine.init();

      const parsedEntry = {
        amount: 2000,
        given_to: 'Radha',
        date: '2024-08-22',
        paid_by: 'Asha',
        raw_message: 'given 2000 to Radha on 22 Aug',
      };

      adminMode = false; // non-admin submitter -> pending, notified to the group
      await engine.submitEntry(parsedEntry, {
        submittedBy: 'Momo',
        submittedByJid: 'momo@s.whatsapp.net',
        submittedAt: new Date('2024-08-22T00:00:00.000Z'),
      });

      const freshStore = createPendingStore({ storePath, auditLogPath });
      await freshStore.init();
      const [entryId] = freshStore.getAllIds();
      assert.ok(entryId, 'expected a pending entry to have been created');
      const pendingEntryOnDisk = freshStore.getById(entryId);
      assert.deepStrictEqual(
        pendingEntryOnDisk.notificationMessageIds,
        ['group-notif-1'],
        'expected the single group Notification_Message id to be tracked',
      );

      adminMode = true; // any current admin can now resolve it

      const result = await engine.handleTextMessage({
        text: 'approve',
        senderJid: 'anyAdmin@s.whatsapp.net',
        quotedMessageId: 'group-notif-1',
      });

      assert.strictEqual(result, true, 'expected the bare reply to be handled');
      assert.strictEqual(onResolutionCalls.length, 1);
      assert.strictEqual(onResolutionCalls[0].status, 'approved');
      assert.strictEqual(onResolutionCalls[0].entryId, entryId);
      // No responderName was supplied (this call omits it, like a
      // reaction would), so approved_by falls back to a cleaned-up id
      // derived from the JID rather than the raw JID itself.
      assert.strictEqual(onResolutionCalls[0].approved_by, 'anyAdmin');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a bare REJECT reply quoting the Notification_Message rejects the correct entry', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      let adminMode = false;
      const isGroupAdmin = async () => adminMode;
      const onResolutionCalls = [];
      const onResolution = async (resolution) => {
        onResolutionCalls.push(resolution);
      };
      const sendMessage = async () => ({ key: { id: 'group-notif-2' } });

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin,
        sendMessage,
        onResolution,
        storePath,
        auditLogPath,
      });

      await engine.init();

      adminMode = false;
      await engine.submitEntry(
        { amount: 1000, given_to: 'Ram', date: '2024-08-22', paid_by: 'Hanshul', raw_message: 'x' },
        { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
      );

      adminMode = true;
      const result = await engine.handleTextMessage({
        text: '  Reject  ',
        senderJid: 'anyAdmin@s.whatsapp.net',
        quotedMessageId: 'group-notif-2',
      });

      assert.strictEqual(result, true);
      assert.strictEqual(onResolutionCalls.length, 1);
      assert.strictEqual(onResolutionCalls[0].status, 'rejected');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a bare APPROVE reply quoting an unrelated message id falls through to explicit-form/parsing (returns false)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => true,
        sendMessage: async () => ({ key: { id: 'x' } }),
        onResolution: async () => {},
        storePath,
        auditLogPath,
      });

      await engine.init();

      const result = await engine.handleTextMessage({
        text: 'approve',
        senderJid: 'admin@s.whatsapp.net',
        quotedMessageId: 'some-unrelated-message-id',
      });

      assert.strictEqual(result, false, 'expected no tracked entry for this quoted id to fall through');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a bare APPROVE/REJECT with no quotedMessageId is disregarded (falls through), same as before', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => true,
        sendMessage: async () => ({ key: { id: 'x' } }),
        onResolution: async () => {},
        storePath,
        auditLogPath,
      });

      await engine.init();

      const result = await engine.handleTextMessage({
        text: 'approve',
        senderJid: 'admin@s.whatsapp.net',
        // quotedMessageId intentionally omitted (defaults to null)
      });

      assert.strictEqual(result, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createApprovalEngine — exactly-once Resolution_Callback invocation', () => {
  // Feature: approval-engine, Property 11: The Resolution_Callback is invoked exactly once per entry, across every outcome path
  //
  // Scenario A (auto-approval path) is exercised exhaustively — across
  // arbitrary Parsed_Entry/submissionMeta content, numRuns: 100 — by the
  // existing "Property 1: admin submissions are always auto-approved
  // without a pending record" test above, which already asserts
  // `onResolutionCalls.length === 1`. Rather than duplicate that
  // property-based coverage here, this is a single fixed-example unit
  // test confirming the same "exactly once" outcome for the
  // auto-approval path, under the Property 11 tag.
  test('Property 11 / Scenario A: auto-approval invokes onResolution exactly once (single fixed example; see Property 1 for exhaustive coverage)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const onResolutionCalls = [];
      const onResolution = async (resolution) => {
        onResolutionCalls.push(resolution);
      };

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => true,
        sendMessage: async () => ({ key: { id: 'x' } }),
        onResolution,
        storePath,
        auditLogPath,
      });

      await engine.init();
      await engine.submitEntry(
        { amount: 12.5, given_to: 'Caterer', date: '2024-06-15', paid_by: 'Admin One', raw_message: 'paid 12.5 to caterer' },
        { submittedBy: 'Admin One', submittedByJid: 'admin1@s.whatsapp.net', submittedAt: new Date().toISOString() },
      );

      assert.strictEqual(
        onResolutionCalls.length,
        1,
        `expected onResolution to be called exactly once for the auto-approval path, got ${onResolutionCalls.length}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Feature: approval-engine, Property 11: The Resolution_Callback is invoked exactly once per entry, across every outcome path
  test('Property 11 / Scenario B: admin-resolved path (submit non-admin, then decide) invokes onResolution exactly once across the full lifecycle', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('APPROVE', 'REJECT'),
        async (parsedEntry, submissionMeta, verb) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            // Mutable admin flag: false during submission (forces the
            // Pending_Entry / non-admin path, so onResolution must NOT be
            // called from submitEntry itself), then flipped to true
            // before the decision is handled.
            let adminMode = false;
            const isGroupAdmin = async () => adminMode;

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'x' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            // Submission step itself must invoke onResolution zero times
            // — it's the non-admin/pending path, not a completed outcome.
            assert.strictEqual(
              onResolutionCalls.length,
              0,
              `expected onResolution to be called zero times after non-admin submission, got ${onResolutionCalls.length}`,
            );

            const freshStore = createPendingStore({ storePath, auditLogPath });
            await freshStore.init();
            const ids = freshStore.getAllIds();
            assert.strictEqual(ids.length, 1, `expected exactly one pending entry, got ${ids.length}`);
            const entryId = ids[0];

            adminMode = true;
            const result = await engine.handleTextMessage({ text: `${verb} ${entryId}`, senderJid: 'admin1' });
            assert.strictEqual(!!result, true, 'expected handleTextMessage to return truthy for a matching decision');

            // Exactly once, total, across the full submit-then-decide
            // lifecycle for this single entry — never zero, never more
            // than once.
            assert.strictEqual(
              onResolutionCalls.length,
              1,
              `expected onResolution to be called exactly once across the full lifecycle, got ${onResolutionCalls.length}`,
            );
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Feature: approval-engine, Property 11: The Resolution_Callback is invoked exactly once per entry, across every outcome path
  test('Property 11 / Scenario C: an injected Pending_Store write failure during entry creation rejects submitEntry and never invokes onResolution', async () => {
    await fc.assert(
      fc.asyncProperty(parsedEntryArb, submissionMetaArb, async (parsedEntry, submissionMeta) => {
        const tmpDir = makeTmpDir();
        try {
          const storePath = path.join(tmpDir, 'pending-store.json');
          const auditLogPath = path.join(tmpDir, 'audit.log');

          const onResolutionCalls = [];
          const onResolution = async (resolution) => {
            onResolutionCalls.push(resolution);
          };

          const engine = createApprovalEngine({
            sock: { groupMetadata: async () => ({ participants: [] }) },
            groupId: 'g',
            isGroupAdmin: async () => false,
            sendMessage: async () => ({ key: { id: 'x' } }),
            onResolution,
            storePath,
            auditLogPath,
          });

          await engine.init();

          // Force the Pending_Store's atomic write to fail deterministically:
          // create a DIRECTORY at the `<storePath>.tmp` path that
          // `atomicWriteStore` needs to `fs.promises.writeFile` to, so the
          // write throws EISDIR on the very first `store.add` call inside
          // `submitEntry` (same technique used in
          // pendingStore.test.js's "Property 12" forced-write-failure test).
          const tmpFilePath = `${storePath}.tmp`;
          fs.mkdirSync(tmpFilePath);

          // The write failure must propagate out of submitEntry (per
          // design.md's Error Handling table: "Pending_Store write fails
          // during entry creation" -> "Error propagates out of
          // submitEntry; no Notification_Message is sent").
          await assert.rejects(async () => {
            await engine.submitEntry(parsedEntry, submissionMeta);
          });

          // This entry never reached completion (the durable write that
          // Requirement 8.1 requires before a Pending_Entry exists never
          // succeeded), so zero onResolution calls is the CORRECT outcome
          // here — not a violation of "exactly once". Property 11's
          // "never zero times" guarantee applies to entries processed to
          // completion; this assertion instead proves the engine does
          // NOT erroneously invoke the callback despite the failure.
          assert.strictEqual(
            onResolutionCalls.length,
            0,
            `expected onResolution to never be called when the Pending_Store write fails during entry creation, got ${onResolutionCalls.length}`,
          );
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 20 },
    );
  });
});

describe('createApprovalEngine — unmatched Entry_Id handling', () => {
  // Feature: approval-engine, Property 6: Unmatched Entry_Ids produce a not-found notice without side effects
  test('Property 6: unmatched Entry_Ids produce a not-found notice without side effects', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('APPROVE', 'REJECT'),
        fc.stringMatching(/^[a-z0-9]{4,6}$/),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        async (parsedEntry, submissionMeta, verb, fakeEntryIdRaw, senderJid) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const sendMessageCalls = [];
            const sendMessage = async (jid, content) => {
              sendMessageCalls.push({ jid, content });
              return { key: { id: 'x' } };
            };

            const engine = createApprovalEngine({
              sock: { groupMetadata: async () => ({ participants: [] }) },
              groupId: 'g',
              isGroupAdmin: async () => false,
              sendMessage,
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            // Submit one real pending entry (non-admin path) so there is
            // a genuine Pending_Entry in the store to prove "no side
            // effects" against.
            await engine.submitEntry(parsedEntry, submissionMeta);

            const freshStoreBefore = createPendingStore({ storePath, auditLogPath });
            await freshStoreBefore.init();
            const idsBefore = freshStoreBefore.getAllIds();
            assert.strictEqual(idsBefore.length, 1, `expected exactly one pending entry, got ${idsBefore.length}`);
            const realEntryId = idsBefore[0];
            const realEntryBefore = freshStoreBefore.getById(realEntryId);

            // Ensure the fake entryId does not collide with the real one
            // (case-insensitively, since Entry_Ids are matched
            // case-insensitively).
            const fakeEntryId =
              fakeEntryIdRaw.toLowerCase() === realEntryId.toLowerCase()
                ? `${fakeEntryIdRaw}z`.slice(0, 6).padEnd(4, '0')
                : fakeEntryIdRaw;
            // Re-check after the fallback transform; if it still
            // collides (extremely unlikely), skip this run.
            fc.pre(fakeEntryId.toLowerCase() !== realEntryId.toLowerCase());

            const onResolutionCallCountBefore = onResolutionCalls.length;

            // Snapshot sendMessageCalls' length here: `submitEntry` above
            // already triggered one sendMessage call of its own (the
            // Notification_Message posted to the group by notifier.js) —
            // only calls made by the handleTextMessage below are relevant
            // to this assertion.
            const sendMessageCallCountBeforeDecision = sendMessageCalls.length;

            const text = `${verb} ${fakeEntryId}`;
            const result = await engine.handleTextMessage({ text, senderJid });

            assert.strictEqual(
              !!result,
              true,
              `expected handleTextMessage to return truthy for a matching-but-unknown decision text ${JSON.stringify(text)}`,
            );

            const callsFromDecision = sendMessageCalls.slice(sendMessageCallCountBeforeDecision);
            assert.strictEqual(
              callsFromDecision.length,
              1,
              `expected sendMessage to be called exactly once for the decision, got ${callsFromDecision.length}`,
            );

            const [sentCall] = callsFromDecision;
            assert.strictEqual(sentCall.jid, senderJid, 'expected the not-found notice to target the sender');

            const sentText =
              typeof sentCall.content === 'string'
                ? sentCall.content
                : sentCall.content && sentCall.content.text;
            assert.strictEqual(typeof sentText, 'string', 'expected sendMessage content to include a text field');
            assert.ok(
              sentText.toLowerCase().includes(fakeEntryId.toLowerCase()),
              `expected the not-found notice ${JSON.stringify(sentText)} to reference the unknown id ${fakeEntryId}`,
            );

            // The real pending entry must be completely unchanged.
            const freshStoreAfter = createPendingStore({ storePath, auditLogPath });
            await freshStoreAfter.init();
            const realEntryAfter = freshStoreAfter.getById(realEntryId);
            assert.deepStrictEqual(
              realEntryAfter,
              realEntryBefore,
              'expected the real Pending_Entry to remain unchanged',
            );
            assert.deepStrictEqual(
              freshStoreAfter.getAllIds(),
              idsBefore,
              'expected the set of pending entryIds to remain unchanged',
            );

            // onResolution must never be called as a result of this call.
            assert.strictEqual(
              onResolutionCalls.length,
              onResolutionCallCountBefore,
              'expected no additional onResolution call from an unmatched Entry_Id decision',
            );
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('createApprovalEngine — load-then-resume (integration-style unit test)', () => {
  // Feature: approval-engine, Property 13 (concrete example): Engine restart
  // resumes matching against previously-persisted entries. This test
  // complements the randomized Property 13 test above with a single
  // concrete, non-randomized fixture: a Pending_Entry is written directly
  // to a real temporary store file (bypassing submitEntry entirely), a
  // brand new engine instance that never created the entry loads it via
  // init(), and a matching APPROVE decision resolves it.
  //
  // Validates: Requirements 8.3
  test('a fixture Pending_Entry written directly to the store file is loaded by init() and resolved by a matching decision', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const fixtureEntry = {
        entryId: 'fx123',
        status: 'pending',
        parsedEntry: {
          amount: 5000,
          given_to: 'Sita',
          date: '2024-08-22',
          paid_by: 'Ram',
          raw_message: 'given 5000 to Sita on 22 Aug',
        },
        submittedBy: 'Ram',
        submittedByJid: 'ram@s.whatsapp.net',
        submittedAt: '2024-08-22T10:00:00.000Z',
        notified: true,
        notificationMessageIds: [],
      };

      // Write the fixture directly to the store file, bypassing
      // submitEntry entirely — this simulates a store file that already
      // existed on disk from a prior (now-discarded) process.
      fs.writeFileSync(storePath, JSON.stringify({ version: 1, entries: [fixtureEntry] }));

      const onResolutionCalls = [];
      const onResolution = async (resolution) => {
        onResolutionCalls.push(resolution);
      };

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => true,
        sendMessage: async () => ({ key: { id: 'x' } }),
        onResolution,
        storePath,
        auditLogPath,
      });

      // This engine instance never created the fixture entry — init()
      // must load it from disk (Requirement 8.3).
      await engine.init();

      const result = await engine.handleTextMessage({ text: 'APPROVE fx123', senderJid: 'admin1' });

      assert.strictEqual(!!result, true, 'expected handleTextMessage to return truthy for a matching decision');

      assert.strictEqual(
        onResolutionCalls.length,
        1,
        `expected onResolution to be called exactly once, got ${onResolutionCalls.length}`,
      );

      const resolution = onResolutionCalls[0];

      assert.strictEqual(resolution.status, 'approved');
      assert.strictEqual(resolution.entryId, 'fx123');
      assert.deepStrictEqual(resolution.entry, fixtureEntry.parsedEntry);
      assert.strictEqual(resolution.submittedBy, 'Ram');
      assert.strictEqual(resolution.submittedByJid, 'ram@s.whatsapp.net');
      assert.strictEqual(resolution.approved_by, 'admin1');

      assert.strictEqual(typeof resolution.approved_at, 'string');
      assert.ok(
        !Number.isNaN(Date.parse(resolution.approved_at)),
        `expected approved_at to be a valid ISO timestamp, got ${resolution.approved_at}`,
      );
      assert.strictEqual(resolution.approved_at, new Date(resolution.approved_at).toISOString());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createApprovalEngine — reaction matching', () => {
  // Feature: approval-engine, Property 7: Reactions are matched only when they are ✅/❌ on a tracked notification for an unresolved entry
  test('Property 7a: a ✅/❌ reaction on the tracked notification message resolves the entry (matches emoji to status)', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('✅', '❌'),
        async (parsedEntry, submissionMeta, emoji) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            // Mutable admin flag: false while the entry is submitted (so a
            // Pending_Entry is actually created and notifyAdmins runs the
            // real, non-zero-admin send path), then flipped to true before
            // the reaction is handled — mirroring the pattern used by the
            // Property 5a/Property 11 Scenario B tests above.
            let adminMode = false;
            const isGroupAdmin = async () => adminMode;

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: {
                groupMetadata: async () => ({
                  participants: [{ id: 'admin1', admin: 'admin' }],
                }),
              },
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'notif-msg-1' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            const freshStore = createPendingStore({ storePath, auditLogPath });
            await freshStore.init();
            const ids = freshStore.getAllIds();
            assert.strictEqual(ids.length, 1, `expected exactly one pending entry, got ${ids.length}`);
            const entryId = ids[0];
            const pendingEntryOnDisk = freshStore.getById(entryId);
            assert.deepStrictEqual(
              pendingEntryOnDisk.notificationMessageIds,
              ['notif-msg-1'],
              'expected notifyAdmins to have tracked the single admin notification message id',
            );

            adminMode = true;

            await engine.handleReaction({ emoji, reactorJid: 'admin1', reactedMessageId: 'notif-msg-1' });

            assert.strictEqual(
              onResolutionCalls.length,
              1,
              `expected onResolution to be called exactly once, got ${onResolutionCalls.length}`,
            );

            const expectedStatus = emoji === '✅' ? 'approved' : 'rejected';
            assert.strictEqual(onResolutionCalls[0].status, expectedStatus);
            assert.strictEqual(onResolutionCalls[0].entryId, entryId);
            assert.deepStrictEqual(onResolutionCalls[0].entry, parsedEntry);
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Reaction events carry no display name on their own (unlike a text
  // reply) — see index.js's pushNameCache usage. handleReaction must pass
  // a caller-supplied responderName through to the Resolution as the
  // approved_by/rejected_by identity, same as handleTextMessage does.
  test('handleReaction forwards a caller-supplied responderName as the resolved-by identity', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      let adminMode = false;
      const isGroupAdmin = async () => adminMode;
      const onResolutionCalls = [];
      const onResolution = async (resolution) => {
        onResolutionCalls.push(resolution);
      };

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin,
        sendMessage: async () => ({ key: { id: 'notif-msg-name-1' } }),
        onResolution,
        storePath,
        auditLogPath,
      });

      await engine.init();

      adminMode = false;
      await engine.submitEntry(
        { amount: 500, given_to: 'Sabjiwala', date: '2024-08-24', paid_by: 'Asha', raw_message: 'x' },
        { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
      );

      adminMode = true;
      await engine.handleReaction({
        emoji: '✅',
        reactorJid: '157105625559108@lid',
        reactedMessageId: 'notif-msg-name-1',
        responderName: 'Hanshul',
      });

      assert.strictEqual(onResolutionCalls.length, 1);
      assert.strictEqual(onResolutionCalls[0].approved_by, 'Hanshul');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Feature: approval-engine, Property 7: Reactions are matched only when
  // they're a recognized approve/reject emoji (✅/👍/👌/🙆 or ❌/👎/🙅) on a
  // tracked notification for an unresolved entry. 👍/👎 moved out of this
  // "disqualifying" generator and into the recognized sets below, per the
  // "accept more than one exact word/emoji" extension — this property now
  // only covers emoji that are still genuinely unrecognized either way.
  test('Property 7b: a reaction with any unrecognized emoji on the tracked notification message is disregarded', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('😀', '🎉', '❓', '🙏'),
        async (parsedEntry, submissionMeta, emoji) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            let adminMode = false;
            const isGroupAdmin = async () => adminMode;

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: {
                groupMetadata: async () => ({
                  participants: [{ id: 'admin1', admin: 'admin' }],
                }),
              },
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'notif-msg-1' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            const freshStoreBefore = createPendingStore({ storePath, auditLogPath });
            await freshStoreBefore.init();
            const ids = freshStoreBefore.getAllIds();
            assert.strictEqual(ids.length, 1, `expected exactly one pending entry, got ${ids.length}`);
            const entryId = ids[0];
            const entryBefore = freshStoreBefore.getById(entryId);
            assert.deepStrictEqual(entryBefore.notificationMessageIds, ['notif-msg-1']);

            // isGroupAdmin is flipped to true here to prove it's the EMOJI
            // check disregarding the reaction, not an admin check —
            // handleReaction never even calls isGroupAdmin before the
            // emoji short-circuit.
            adminMode = true;

            await engine.handleReaction({ emoji, reactorJid: 'admin1', reactedMessageId: 'notif-msg-1' });

            assert.strictEqual(
              onResolutionCalls.length,
              0,
              `expected onResolution to never be called for a disqualifying emoji ${JSON.stringify(emoji)}, got ${onResolutionCalls.length}`,
            );

            const freshStoreAfter = createPendingStore({ storePath, auditLogPath });
            await freshStoreAfter.init();
            const entryAfter = freshStoreAfter.getById(entryId);
            assert.deepStrictEqual(entryAfter, entryBefore, 'expected the Pending_Entry to remain unchanged');
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  // Feature: approval-engine, Property 7: Reactions are matched only when
  // they are ✅/❌ on a tracked notification for an unresolved entry — AS
  // AMENDED by the single-pending-entry fallback (see
  // src/approvalEngine.js's `handleReaction`, "ponytail:" comment): a
  // reaction whose message id isn't tracked still resolves the one
  // unambiguous candidate when exactly one entry is pending, working
  // around a documented WhatsApp/Baileys quirk where a group reaction
  // event's key.id doesn't always match the reacted-to message's real
  // id for @lid participants (WhiskeySockets/Baileys#656 and others).
  test('Property 7c: a ✅/❌ reaction on an untracked message id resolves the single pending entry (fallback)', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('✅', '❌'),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s !== 'notif-msg-1'),
        async (parsedEntry, submissionMeta, emoji, untrackedMessageId) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            let adminMode = false;
            const isGroupAdmin = async () => adminMode;

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: {
                groupMetadata: async () => ({
                  participants: [{ id: 'admin1', admin: 'admin' }],
                }),
              },
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'notif-msg-1' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            const freshStoreBefore = createPendingStore({ storePath, auditLogPath });
            await freshStoreBefore.init();
            const ids = freshStoreBefore.getAllIds();
            assert.strictEqual(ids.length, 1, `expected exactly one pending entry, got ${ids.length}`);
            const entryId = ids[0];

            adminMode = true;

            await engine.handleReaction({ emoji, reactorJid: 'admin1', reactedMessageId: untrackedMessageId });

            // Exactly one pending entry existed, so the fallback resolves
            // it even though `untrackedMessageId` was never the entry's
            // real notification message id.
            assert.strictEqual(
              onResolutionCalls.length,
              1,
              `expected the single-pending-entry fallback to resolve entry ${entryId} for untracked message id ${JSON.stringify(untrackedMessageId)}`,
            );
            const expectedStatus = emoji === '✅' ? 'approved' : 'rejected';
            assert.strictEqual(onResolutionCalls[0].status, expectedStatus);
            assert.strictEqual(onResolutionCalls[0].entryId, entryId);
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  // Companion to Property 7c: the fallback is deliberately narrow — with
  // ZERO pending entries, there is no unambiguous candidate, so an
  // untracked reaction is still disregarded exactly as before.
  test('Property 7c-zero: a ✅/❌ reaction on an untracked message id is disregarded when there are zero pending entries', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const onResolutionCalls = [];
      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => true,
        sendMessage: async () => ({ key: { id: 'x' } }),
        onResolution: async (r) => onResolutionCalls.push(r),
        storePath,
        auditLogPath,
      });

      await engine.init();

      await engine.handleReaction({ emoji: '✅', reactorJid: 'admin1', reactedMessageId: 'totally-untracked' });

      assert.strictEqual(onResolutionCalls.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Companion to Property 7c: with TWO OR MORE pending entries, the
  // fallback must not guess among them — an untracked reaction is still
  // disregarded, same as before this fallback existed.
  test('Property 7c-multiple: a ✅/❌ reaction on an untracked message id is disregarded when more than one entry is pending', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const onResolutionCalls = [];
      const engine = createApprovalEngine({
        sock: { groupMetadata: async () => ({ participants: [] }) },
        groupId: 'g',
        isGroupAdmin: async () => false,
        sendMessage: async () => ({ key: { id: 'notif-a' } }),
        onResolution: async (r) => onResolutionCalls.push(r),
        storePath,
        auditLogPath,
      });

      await engine.init();

      // Two separate non-admin submissions -> two pending entries.
      await engine.submitEntry(
        { amount: 100, given_to: 'A', date: '2024-06-15', paid_by: 'X', raw_message: 'a' },
        { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
      );
      await engine.submitEntry(
        { amount: 200, given_to: 'B', date: '2024-06-15', paid_by: 'Y', raw_message: 'b' },
        { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
      );

      const freshStore = createPendingStore({ storePath, auditLogPath });
      await freshStore.init();
      assert.strictEqual(freshStore.getAllIds().length, 2, 'expected exactly two pending entries');

      await engine.handleReaction({ emoji: '✅', reactorJid: 'admin1', reactedMessageId: 'totally-untracked' });

      assert.strictEqual(
        onResolutionCalls.length,
        0,
        'expected no resolution — the fallback must not guess among multiple pending entries',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Covers the extended emoji synonym sets (APPROVE_EMOJI/REJECT_EMOJI in
  // src/approvalEngine.js) — a 👍/👌/🙆 reaction resolves exactly like ✅,
  // and 👎/🙅 resolves exactly like ❌.
  test('Property 7d: 👍/👌/🙆 reactions approve, and 👎/🙅 reactions reject, same as ✅/❌', async () => {
    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('✅', '👍', '👌', '🙆'),
        async (parsedEntry, submissionMeta, emoji) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            let adminMode = false;
            const isGroupAdmin = async () => adminMode;
            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: {},
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'notif-msg-approve-emoji' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            adminMode = true;
            await engine.handleReaction({
              emoji,
              reactorJid: 'admin1',
              reactedMessageId: 'notif-msg-approve-emoji',
            });

            assert.strictEqual(onResolutionCalls.length, 1);
            assert.strictEqual(onResolutionCalls[0].status, 'approved');
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 20 },
    );

    await fc.assert(
      fc.asyncProperty(
        parsedEntryArb,
        submissionMetaArb,
        fc.constantFrom('❌', '👎', '🙅'),
        async (parsedEntry, submissionMeta, emoji) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            let adminMode = false;
            const isGroupAdmin = async () => adminMode;
            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const engine = createApprovalEngine({
              sock: {},
              groupId: 'g',
              isGroupAdmin,
              sendMessage: async () => ({ key: { id: 'notif-msg-reject-emoji' } }),
              onResolution,
              storePath,
              auditLogPath,
            });

            await engine.init();

            adminMode = false;
            await engine.submitEntry(parsedEntry, submissionMeta);

            adminMode = true;
            await engine.handleReaction({
              emoji,
              reactorJid: 'admin1',
              reactedMessageId: 'notif-msg-reject-emoji',
            });

            assert.strictEqual(onResolutionCalls.length, 1);
            assert.strictEqual(onResolutionCalls[0].status, 'rejected');
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('createApprovalEngine — text decision synonyms (approve/reject word variants)', () => {
  // Covers the extended word/phrase synonym sets (APPROVE_SYNONYMS/
  // REJECT_SYNONYMS in src/approvalEngine.js) — an admin can respond with
  // a natural word like "done"/"ok"/"theek hai" instead of the literal
  // "APPROVE", both as a bare quoted-reply and as an explicit "<word> <id>".
  test('a bare reply using any approve synonym, quoting the Notification_Message, approves the entry', async () => {
    const { APPROVE_SYNONYMS } = require('../src/approvalEngine');
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      for (const synonym of APPROVE_SYNONYMS) {
        let adminMode = false;
        const isGroupAdmin = async () => adminMode;
        const onResolutionCalls = [];
        const onResolution = async (resolution) => {
          onResolutionCalls.push(resolution);
        };

        const engine = createApprovalEngine({
          sock: {},
          groupId: 'g',
          isGroupAdmin,
          sendMessage: async () => ({ key: { id: `notif-${synonym.replace(/\s+/g, '-')}` } }),
          onResolution,
          storePath: path.join(tmpDir, `store-${synonym.replace(/\s+/g, '-')}.json`),
          auditLogPath,
        });

        await engine.init();

        adminMode = false;
        await engine.submitEntry(
          { amount: 100, given_to: 'X', date: '2024-06-15', paid_by: 'Y', raw_message: 'z' },
          { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
        );

        adminMode = true;
        const result = await engine.handleTextMessage({
          text: synonym,
          senderJid: 'admin1@s.whatsapp.net',
          quotedMessageId: `notif-${synonym.replace(/\s+/g, '-')}`,
        });

        assert.strictEqual(result, true, `expected synonym ${JSON.stringify(synonym)} to be handled`);
        assert.strictEqual(
          onResolutionCalls.length,
          1,
          `expected approve synonym ${JSON.stringify(synonym)} to resolve the entry exactly once`,
        );
        assert.strictEqual(onResolutionCalls[0].status, 'approved');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a bare reply using any reject synonym, quoting the Notification_Message, rejects the entry', async () => {
    const { REJECT_SYNONYMS } = require('../src/approvalEngine');
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      for (const synonym of REJECT_SYNONYMS) {
        let adminMode = false;
        const isGroupAdmin = async () => adminMode;
        const onResolutionCalls = [];
        const onResolution = async (resolution) => {
          onResolutionCalls.push(resolution);
        };

        const engine = createApprovalEngine({
          sock: {},
          groupId: 'g',
          isGroupAdmin,
          sendMessage: async () => ({ key: { id: `notif-${synonym.replace(/\s+/g, '-')}` } }),
          onResolution,
          storePath: path.join(tmpDir, `store-${synonym.replace(/\s+/g, '-')}.json`),
          auditLogPath,
        });

        await engine.init();

        adminMode = false;
        await engine.submitEntry(
          { amount: 100, given_to: 'X', date: '2024-06-15', paid_by: 'Y', raw_message: 'z' },
          { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
        );

        adminMode = true;
        const result = await engine.handleTextMessage({
          text: synonym,
          senderJid: 'admin1@s.whatsapp.net',
          quotedMessageId: `notif-${synonym.replace(/\s+/g, '-')}`,
        });

        assert.strictEqual(result, true, `expected synonym ${JSON.stringify(synonym)} to be handled`);
        assert.strictEqual(
          onResolutionCalls.length,
          1,
          `expected reject synonym ${JSON.stringify(synonym)} to resolve the entry exactly once`,
        );
        assert.strictEqual(onResolutionCalls[0].status, 'rejected');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('explicit "<synonym> <id>" form works for a representative sample of approve/reject synonyms', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const cases = [
        { text: (id) => `done ${id}`, expectedStatus: 'approved' },
        { text: (id) => `OK ${id}`, expectedStatus: 'approved' },
        { text: (id) => `theek hai ${id}`, expectedStatus: 'approved' },
        { text: (id) => `no ${id}`, expectedStatus: 'rejected' },
        { text: (id) => `cancel ${id}`, expectedStatus: 'rejected' },
        { text: (id) => `galat hai ${id}`, expectedStatus: 'rejected' },
      ];

      for (const { text: buildText, expectedStatus } of cases) {
        let adminMode = false;
        const isGroupAdmin = async () => adminMode;
        const onResolutionCalls = [];
        const onResolution = async (resolution) => {
          onResolutionCalls.push(resolution);
        };

        const engine = createApprovalEngine({
          sock: { groupMetadata: async () => ({ participants: [] }) },
          groupId: 'g',
          isGroupAdmin,
          sendMessage: async () => ({ key: { id: 'x' } }),
          onResolution,
          storePath,
          auditLogPath,
        });

        await engine.init();

        adminMode = false;
        await engine.submitEntry(
          { amount: 100, given_to: 'X', date: '2024-06-15', paid_by: 'Y', raw_message: 'z' },
          { submittedBy: 'Momo', submittedByJid: 'momo@s.whatsapp.net', submittedAt: new Date() },
        );

        const freshStore = createPendingStore({ storePath, auditLogPath });
        await freshStore.init();
        const [entryId] = freshStore.getAllIds();
        assert.ok(entryId);

        adminMode = true;
        const result = await engine.handleTextMessage({
          text: buildText(entryId),
          senderJid: 'admin1@s.whatsapp.net',
        });

        assert.strictEqual(result, true, `expected ${JSON.stringify(buildText(entryId))} to be handled`);
        assert.strictEqual(onResolutionCalls.length, 1);
        assert.strictEqual(onResolutionCalls[0].status, expectedStatus);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('ordinary expense-like text containing a synonym word as a substring is NOT treated as a decision (e.g. "done shopping for flowers")', async () => {
    const tmpDir = makeTmpDir();
    try {
      const storePath = path.join(tmpDir, 'pending-store.json');
      const auditLogPath = path.join(tmpDir, 'audit.log');

      const engine = createApprovalEngine({
        sock: {},
        groupId: 'g',
        isGroupAdmin: async () => true,
        sendMessage: async () => ({ key: { id: 'x' } }),
        onResolution: async () => {},
        storePath,
        auditLogPath,
      });

      await engine.init();

      const nonDecisionTexts = [
        'done shopping for flowers today', // "done" present but not the whole message
        '500 paid to caterer, all good', // "good" is a synonym word but message is longer
        'ok i will send the payment later', // "ok" present but not alone
      ];

      for (const text of nonDecisionTexts) {
        const result = await engine.handleTextMessage({ text, senderJid: 'admin1@s.whatsapp.net' });
        assert.strictEqual(
          result,
          false,
          `expected ordinary text containing a synonym word to NOT be treated as a decision: ${JSON.stringify(text)}`,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
