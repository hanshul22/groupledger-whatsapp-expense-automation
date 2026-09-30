// decisionProcessor.test.js
// Tests for src/decisionProcessor.js's processDecision(...), plus its
// notice-builder helpers (notAuthorizedNotice, alreadyResolvedNotice,
// buildResolution). See .kiro/specs/approval-engine/design.md "Decision
// Processor" and "Correctness Properties" for design context.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { processDecision, formatResponderIdentity } = require('../src/decisionProcessor');
const { createPendingStore } = require('../src/pendingStore');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decision-processor-test-'));
}

function readAuditLines(auditLogPath) {
  if (!fs.existsSync(auditLogPath)) return [];
  const content = fs.readFileSync(auditLogPath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function makePendingEntry(overrides = {}) {
  return {
    entryId: 'abcde',
    status: 'pending',
    parsedEntry: {
      amount: 100,
      given_to: 'Caterer',
      date: '2024-01-01',
      paid_by: 'Someone',
      raw_message: 'raw',
    },
    submittedBy: 'Submitter',
    submittedByJid: 'submitter@s.whatsapp.net',
    submittedAt: '2024-01-01T00:00:00.000Z',
    notified: true,
    notificationMessageIds: [],
    ...overrides,
  };
}

describe('processDecision', () => {
  // Feature: approval-engine, Property 8: Every candidate decision is re-verified live, and non-admin responders never change state
  test('Property 8: non-admin responders never change state and are logged/notified', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('APPROVE', 'REJECT'),
        fc.string(),
        async (verb, responderJid) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            const store = createPendingStore({ storePath, auditLogPath });
            await store.init();

            const pendingEntry = makePendingEntry();
            await store.add(pendingEntry);

            const isGroupAdmin = async () => false; // always non-admin for this property

            const sendMessageCalls = [];
            const sendMessage = async (jid, content) => {
              sendMessageCalls.push({ jid, content });
            };

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            await processDecision({
              sock: {},
              groupId: 'g',
              isGroupAdmin,
              sendMessage,
              pendingStore: store,
              onResolution,
              auditLogPath,
              pendingEntry,
              verb,
              responderJid,
            });

            // onResolution was never called
            assert.strictEqual(onResolutionCalls.length, 0);

            // sendMessage called exactly once, targeting responderJid (the
            // not-authorized notice)
            assert.strictEqual(sendMessageCalls.length, 1);
            assert.strictEqual(sendMessageCalls[0].jid, responderJid);

            // entry status in the store remains unchanged ('pending')
            const stored = store.getById(pendingEntry.entryId);
            assert.strictEqual(stored.status, 'pending');

            // audit log contains a matching decision_rejected_not_admin entry
            const auditEntries = readAuditLines(auditLogPath);
            const match = auditEntries.find(
              (entry) =>
                entry.event === 'decision_rejected_not_admin' &&
                entry.entryId === pendingEntry.entryId &&
                entry.responderJid === responderJid
            );
            assert.ok(
              match,
              `expected an audit log entry for decision_rejected_not_admin, entryId=${pendingEntry.entryId}, responderJid=${responderJid}, got ${JSON.stringify(auditEntries)}`
            );
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: approval-engine, Property 9: First-response-wins holds under both sequential and concurrent decisions
  test('Property 9: first-response-wins holds under both sequential and concurrent decisions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }).chain((n) =>
          fc.record({
            // Deduplicate by the *cleaned* identity (formatResponderIdentity's
            // fallback: everything before '@'), not just the raw string —
            // two distinct JIDs that clean to the same identity would make
            // `winnerIndex` lookups below ambiguous.
            responderJids: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
              minLength: n,
              maxLength: n,
              selector: (jid) => formatResponderIdentity(undefined, jid),
            }),
            verbs: fc.array(fc.constantFrom('APPROVE', 'REJECT'), {
              minLength: n,
              maxLength: n,
            }),
            sequential: fc.boolean(),
          })
        ),
        async ({ responderJids, verbs, sequential }) => {
          const n = responderJids.length;
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            const store = createPendingStore({ storePath, auditLogPath });
            await store.init();

            const pendingEntry = makePendingEntry();
            await store.add(pendingEntry);

            const isGroupAdmin = async () => true; // every responder is admin

            const sendMessageCalls = [];
            const sendMessage = async (jid, content) => {
              sendMessageCalls.push({ jid, content });
            };

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            const makeCall = (i) =>
              processDecision({
                sock: {},
                groupId: 'g',
                isGroupAdmin,
                sendMessage,
                pendingStore: store,
                onResolution,
                auditLogPath,
                pendingEntry,
                verb: verbs[i],
                responderJid: responderJids[i],
              });

            if (sequential) {
              for (let i = 0; i < n; i += 1) {
                // eslint-disable-next-line no-await-in-loop
                await makeCall(i);
              }
            } else {
              await Promise.all(responderJids.map((_, i) => makeCall(i)));
            }

            // onResolution called exactly once across all N attempts
            assert.strictEqual(onResolutionCalls.length, 1);

            const resolution = onResolutionCalls[0];
            assert.ok(['approved', 'rejected'].includes(resolution.status));

            const winningResolvedBy =
              resolution.status === 'approved' ? resolution.approved_by : resolution.rejected_by;
            // No responderName was supplied to any call, so each
            // candidate's recorded identity is formatResponderIdentity's
            // fallback (a cleaned-up id derived from the JID), not the
            // raw JID itself. Map back to find which JID actually won —
            // `sendMessage` (checked below) is still addressed to the raw
            // JID, unaffected by this formatting.
            const expectedIdentities = responderJids.map((jid) => formatResponderIdentity(undefined, jid));
            assert.ok(expectedIdentities.includes(winningResolvedBy));

            const winnerIndex = expectedIdentities.indexOf(winningResolvedBy);
            const winningJid = responderJids[winnerIndex];
            const expectedStatus = verbs[winnerIndex] === 'APPROVE' ? 'approved' : 'rejected';
            assert.strictEqual(resolution.status, expectedStatus);

            // final status in the store matches the winning resolution
            const stored = store.getById(pendingEntry.entryId);
            assert.strictEqual(stored.status, resolution.status);
            assert.strictEqual(stored.resolvedBy, winningResolvedBy);

            // exactly N-1 losing attempts should have sent an
            // already-resolved notice (sendMessage is only invoked on the
            // already-resolved path in this scenario, since every
            // responder is an admin)
            assert.strictEqual(sendMessageCalls.length, n - 1);

            const notifiedJids = sendMessageCalls.map((call) => call.jid).sort();
            const expectedLoserJids = responderJids
              .filter((jid) => jid !== winningJid)
              .sort();
            assert.deepStrictEqual(notifiedJids, expectedLoserJids);
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  // Feature: approval-engine, Property 10: Resolution content is correct for both approved and rejected outcomes
  test('Property 10: Resolution content is correct for both approved and rejected outcomes', async () => {
    const isoDateArb = fc
      .date({
        min: new Date('2000-01-01T00:00:00.000Z'),
        max: new Date('2100-12-31T00:00:00.000Z'),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString().slice(0, 10));

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amount: fc.double({ min: 0.01, max: 100000, noNaN: true }),
          given_to: fc.string({ minLength: 1, maxLength: 20 }),
          date: isoDateArb,
          paid_by: fc.string({ minLength: 1, maxLength: 20 }),
          party: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
          notes: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
          raw_message: fc.string({ minLength: 1, maxLength: 50 }),
          submittedBy: fc.string({ minLength: 1, maxLength: 20 }),
          submittedByJid: fc.string({ minLength: 1, maxLength: 30 }),
          verb: fc.constantFrom('APPROVE', 'REJECT'),
          responderJid: fc.string({ minLength: 1, maxLength: 30 }),
        }),
        async ({
          amount,
          given_to,
          date,
          paid_by,
          party,
          notes,
          raw_message,
          submittedBy,
          submittedByJid,
          verb,
          responderJid,
        }) => {
          const tmpDir = makeTmpDir();
          try {
            const storePath = path.join(tmpDir, 'pending-store.json');
            const auditLogPath = path.join(tmpDir, 'audit.log');

            const store = createPendingStore({ storePath, auditLogPath });
            await store.init();

            const parsedEntry = {
              amount,
              given_to,
              date,
              paid_by,
              raw_message,
              ...(party !== undefined ? { party } : {}),
              ...(notes !== undefined ? { notes } : {}),
            };

            const pendingEntry = makePendingEntry({
              parsedEntry,
              submittedBy,
              submittedByJid,
            });
            await store.add(pendingEntry);

            const isGroupAdmin = async () => true; // always admin for this property

            const sendMessage = async () => {};

            const onResolutionCalls = [];
            const onResolution = async (resolution) => {
              onResolutionCalls.push(resolution);
            };

            await processDecision({
              sock: {},
              groupId: 'g',
              isGroupAdmin,
              sendMessage,
              pendingStore: store,
              onResolution,
              auditLogPath,
              pendingEntry,
              verb,
              responderJid,
            });

            // onResolution called exactly once
            assert.strictEqual(onResolutionCalls.length, 1);

            const resolution = onResolutionCalls[0];
            const expectedStatus = verb === 'APPROVE' ? 'approved' : 'rejected';

            assert.strictEqual(resolution.status, expectedStatus);
            assert.strictEqual(resolution.entryId, pendingEntry.entryId);
            assert.deepStrictEqual(resolution.entry, pendingEntry.parsedEntry);
            assert.strictEqual(resolution.submittedBy, pendingEntry.submittedBy);
            assert.strictEqual(resolution.submittedByJid, pendingEntry.submittedByJid);

            const isValidIsoTimestamp = (value) =>
              typeof value === 'string' && !Number.isNaN(Date.parse(value));

            // No responderName was passed to processDecision above, so
            // the recorded identity is formatResponderIdentity's fallback
            // (a cleaned-up id derived from the JID), not the raw JID.
            const expectedResolvedBy = formatResponderIdentity(undefined, responderJid);

            if (expectedStatus === 'approved') {
              assert.strictEqual(resolution.approved_by, expectedResolvedBy);
              assert.ok(
                isValidIsoTimestamp(resolution.approved_at),
                `expected approved_at to be a valid ISO timestamp, got ${resolution.approved_at}`
              );
              assert.strictEqual(resolution.rejected_by, undefined);
              assert.strictEqual(resolution.rejected_at, undefined);
            } else {
              assert.strictEqual(resolution.rejected_by, expectedResolvedBy);
              assert.ok(
                isValidIsoTimestamp(resolution.rejected_at),
                `expected rejected_at to be a valid ISO timestamp, got ${resolution.rejected_at}`
              );
              assert.strictEqual(resolution.approved_by, undefined);
              assert.strictEqual(resolution.approved_at, undefined);
            }
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
