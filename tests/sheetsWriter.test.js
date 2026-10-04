// sheetsWriter.test.js
// Property-based and unit tests for src/sheetsWriter.js (Phase 5 — Sheets
// Writer). See .kiro/specs/sheets-writer/design.md "Correctness
// Properties" for design context.
//
// No real Google API calls are made anywhere in this file — every test
// injects a fake `sheetsClient` exposing `spreadsheets.values.append` as a
// configurable async function, per design.md's Testing Strategy.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  createSheetsWriter,
  mapToRow,
  generateSheetRowId,
  appendRow,
  formatSheetTimestamp,
  sanitizeSheetText,
} = require('../src/sheetsWriter');

// ---------------------------------------------------------------------------
// Fake sheets client helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Sheets client whose `spreadsheets.values.append` fails its
 * first `failCount` calls (per distinct call) and succeeds thereafter.
 * Records every call's `range` for assertions.
 */
function makeFakeClient({ failCount = 0, alwaysFail = false, errorMessage = 'simulated failure' } = {}) {
  const calls = [];
  let callIndex = 0;

  return {
    calls,
    client: {
      spreadsheets: {
        values: {
          append: async (request) => {
            calls.push(request);
            callIndex += 1;
            if (alwaysFail || callIndex <= failCount) {
              throw new Error(errorMessage);
            }
            return { data: {} };
          },
        },
      },
    },
  };
}

function fixedResolutionEntry(overrides = {}) {
  return {
    amount: 20000,
    given_to: 'Ram',
    date: '2026-08-20',
    paid_by: 'X Person',
    raw_message: 'given 20000 to ram on 20 aug by x person',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Approved/auto-approved Resolutions always produce exactly one
// Entries-tab append with correctly mapped columns
// ---------------------------------------------------------------------------

// Feature: sheets-writer, Property 1: Approved/auto-approved Resolutions always produce exactly one Entries-tab append with correctly mapped columns
test('Property 1: Approved/auto-approved Resolutions always produce exactly one Entries-tab append with correctly mapped columns', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('auto_approved', 'approved'),
      fc.record({
        amount: fc.integer({ min: 1, max: 1000000 }),
        given_to: fc.string({ minLength: 1, maxLength: 20 }),
        date: fc.constant('2026-08-20'),
        raw_message: fc.string({ minLength: 1, maxLength: 50 }),
        party: fc.option(fc.string({ minLength: 1, maxLength: 15 }), { nil: undefined }),
        notes: fc.option(fc.string({ minLength: 1, maxLength: 15 }), { nil: undefined }),
      }),
      fc.string({ minLength: 1, maxLength: 15 }), // submittedBy
      fc.string({ minLength: 1, maxLength: 15 }), // approved_by
      async (status, entry, submittedBy, approvedBy) => {
        const { calls, client } = makeFakeClient();

        const resolution = {
          status,
          entryId: status === 'approved' ? 'ab12c' : undefined,
          entry,
          submittedBy,
          submittedByJid: 'jid@s.whatsapp.net',
          approved_by: approvedBy,
          approved_at: '2026-08-20T10:00:00.000Z',
        };

        const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });
        await writer.writeResolution(resolution);

        assert.strictEqual(calls.length, 1, 'exactly one append call');
        assert.strictEqual(calls[0].range, 'Entries!A:A');

        const row = calls[0].requestBody.values[0];
        // v1.1 — 11 original columns (A-K) + 3 append-only normalizer
        // columns (L-N, doc/trd.md §8.6), blank here since this
        // resolution carries no normalizerMeta.
        assert.strictEqual(row.length, 14);

        const [
          entryId,
          date,
          description,
          amount,
          givenTo,
          subBy,
          party,
          rowStatus,
          actorBy,
          actorAt,
          rawMsg,
          normalizedBy,
          llmConfidence,
          normalizationNotes,
        ] = row;

        if (status === 'approved') {
          assert.strictEqual(entryId, 'ab12c');
        } else {
          assert.ok(typeof entryId === 'string' && entryId.startsWith('auto-'));
        }
        // Free-text columns are run through sanitizeSheetText (formula-
        // injection guard — see sheetsWriter.js) before landing in the
        // row, so arbitrary generated strings starting with =/+/-/@
        // come out with a leading single-quote rather than verbatim.
        assert.strictEqual(date, entry.date);
        assert.strictEqual(description, sanitizeSheetText(entry.notes || ''));
        assert.strictEqual(amount, entry.amount);
        assert.strictEqual(givenTo, sanitizeSheetText(entry.given_to));
        assert.strictEqual(subBy, sanitizeSheetText(submittedBy));
        assert.strictEqual(party, sanitizeSheetText(entry.party || ''));
        assert.strictEqual(rowStatus, status);
        assert.strictEqual(actorBy, sanitizeSheetText(approvedBy));
        // The sheet column renders a human-readable, timezone-formatted
        // string rather than the raw ISO timestamp — see
        // sheetsWriter.js's formatSheetTimestamp.
        assert.strictEqual(actorAt, formatSheetTimestamp(resolution.approved_at));
        assert.strictEqual(rawMsg, sanitizeSheetText(entry.raw_message));
        // v1.1 — blank when the resolution carries no normalizerMeta.
        assert.strictEqual(normalizedBy, '');
        assert.strictEqual(llmConfidence, '');
        assert.strictEqual(normalizationNotes, '');
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 2: Rejected Resolutions always produce exactly one Rejected-tab
// append with correctly mapped columns
// ---------------------------------------------------------------------------

// Feature: sheets-writer, Property 2: Rejected Resolutions always produce exactly one Rejected-tab append with correctly mapped columns
test('Property 2: Rejected Resolutions always produce exactly one Rejected-tab append with correctly mapped columns', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        amount: fc.integer({ min: 1, max: 1000000 }),
        given_to: fc.string({ minLength: 1, maxLength: 20 }),
        date: fc.constant('2026-08-20'),
        raw_message: fc.string({ minLength: 1, maxLength: 50 }),
      }),
      fc.string({ minLength: 1, maxLength: 15 }), // submittedBy
      fc.string({ minLength: 1, maxLength: 15 }), // rejected_by
      fc.string({ minLength: 4, maxLength: 6 }), // entryId
      async (entry, submittedBy, rejectedBy, entryId) => {
        const { calls, client } = makeFakeClient();

        const resolution = {
          status: 'rejected',
          entryId,
          entry,
          submittedBy,
          submittedByJid: 'jid@s.whatsapp.net',
          rejected_by: rejectedBy,
          rejected_at: '2026-08-20T11:00:00.000Z',
        };

        const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });
        await writer.writeResolution(resolution);

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].range, 'Rejected!A:A');

        const row = calls[0].requestBody.values[0];
        const [rowEntryId, , , , , , , rowStatus, actorBy, actorAt] = row;

        assert.strictEqual(rowEntryId, entryId);
        assert.strictEqual(rowStatus, 'rejected');
        assert.strictEqual(actorBy, sanitizeSheetText(rejectedBy));
        assert.strictEqual(actorAt, formatSheetTimestamp(resolution.rejected_at));
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 3: auto_approved Resolutions always receive a generated row id
// distinguishable from Approval Engine Entry_Ids
// ---------------------------------------------------------------------------

const APPROVAL_ENGINE_ENTRY_ID_REGEX = /^[a-z0-9]{5}$/;

// Feature: sheets-writer, Property 3: auto_approved Resolutions always receive a generated row id distinguishable from Approval Engine Entry_Ids
test('Property 3: auto_approved Resolutions always receive a generated row id distinguishable from Approval Engine Entry_Ids', () => {
  fc.assert(
    fc.property(fc.constant(null), () => {
      const id = generateSheetRowId();
      assert.ok(id.length > 0);
      assert.ok(id.startsWith('auto-'), 'must carry a distinguishing prefix');
      // Never confusable with a bare Approval Engine Entry_Id format.
      assert.ok(!APPROVAL_ENGINE_ENTRY_ID_REGEX.test(id));
    }),
    { numRuns: 100 }
  );

  // mapToRow itself must invoke this path when entryId is absent.
  const row = mapToRow({
    status: 'auto_approved',
    entry: fixedResolutionEntry(),
    submittedBy: 'Alice',
    approved_by: 'Alice',
    approved_at: '2026-08-20T10:00:00.000Z',
  });
  assert.ok(typeof row[0] === 'string' && row[0].startsWith('auto-'));
});

// ---------------------------------------------------------------------------
// Property 4: A failing append is retried exactly once, and only a failure
// of both attempts is surfaced
// ---------------------------------------------------------------------------

// Feature: sheets-writer, Property 4: A failing append is retried exactly once, and only a failure of both attempts is surfaced
test('Property 4: A failing append is retried exactly once, and only a failure of both attempts is surfaced', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (failCount) => {
      const { calls, client } = makeFakeClient({ failCount });

      const result = await appendRow(client, 'sheet-1', 'Entries', ['a', 'b']);

      const expectedCallCount = Math.min(failCount + 1, 2);
      assert.strictEqual(calls.length, expectedCallCount);
      assert.ok(calls.length <= 2, 'underlying client is never called more than twice');

      if (failCount === 0 || failCount === 1) {
        assert.strictEqual(result.ok, true);
      } else {
        assert.strictEqual(result.ok, false);
        assert.ok(result.error instanceof Error);
      }
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 5: Write failures are independent across Resolutions
// ---------------------------------------------------------------------------

// Feature: sheets-writer, Property 5: Write failures are independent across Resolutions
test('Property 5: Write failures are independent across Resolutions', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }), // shouldFail per resolution
      async (shouldFailFlags) => {
        // One client per resolution, since each Resolution's write is
        // independent — but the property under test is about
        // writeResolution's per-call behavior not being affected by prior
        // calls' outcomes, so drive several `writeResolution` calls against
        // clients whose failure behavior varies independently.
        for (let i = 0; i < shouldFailFlags.length; i += 1) {
          const shouldFail = shouldFailFlags[i];
          const { client } = makeFakeClient({ alwaysFail: shouldFail });
          const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

          const resolution = {
            status: 'approved',
            entryId: `id${i}`,
            entry: fixedResolutionEntry(),
            submittedBy: 'Bob',
            approved_by: 'Admin',
            approved_at: '2026-08-20T10:00:00.000Z',
          };

          if (shouldFail) {
            await assert.rejects(writer.writeResolution(resolution));
          } else {
            await assert.doesNotReject(writer.writeResolution(resolution));
          }
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 6: Missing required auth/config env values fail construction,
// not first use
// ---------------------------------------------------------------------------

// Feature: sheets-writer, Property 6: Missing required auth/config env values fail construction, not first use
test('Property 6: Missing required auth/config env values fail construction, not first use', () => {
  const full = {
    spreadsheetId: 'sheet-1',
    serviceAccountEmail: 'bot@example.iam.gserviceaccount.com',
    serviceAccountKey: '-----BEGIN PRIVATE KEY-----\\nFAKEKEY\\n-----END PRIVATE KEY-----\\n',
  };

  fc.assert(
    fc.property(
      fc.subarray(['spreadsheetId', 'serviceAccountEmail', 'serviceAccountKey'], { minLength: 1 }),
      (missingKeys) => {
        const deps = { ...full };
        for (const key of missingKeys) {
          deps[key] = undefined;
        }

        assert.throws(() => createSheetsWriter(deps), Error);
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Targeted unit tests
// ---------------------------------------------------------------------------

test('Requirements 1.2/1.3: missing variable errors name the specific variable', () => {
  assert.throws(
    () =>
      createSheetsWriter({
        spreadsheetId: 'sheet-1',
        serviceAccountEmail: undefined,
        serviceAccountKey: 'key',
      }),
    /GOOGLE_SERVICE_ACCOUNT_EMAIL/
  );

  assert.throws(
    () =>
      createSheetsWriter({
        spreadsheetId: 'sheet-1',
        serviceAccountEmail: 'bot@example.iam.gserviceaccount.com',
        serviceAccountKey: undefined,
      }),
    /GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY/
  );

  assert.throws(
    () =>
      createSheetsWriter({
        spreadsheetId: undefined,
        serviceAccountEmail: 'bot@example.iam.gserviceaccount.com',
        serviceAccountKey: 'key',
      }),
    /GOOGLE_SHEET_ID/
  );
});

test('Requirement 3.3: Rejected tab missing — logs and throws rather than crashing or silently dropping', async () => {
  const { client } = makeFakeClient({ alwaysFail: true, errorMessage: 'Unable to parse range: UnknownTab!A:A' });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client, rejectedTabName: 'UnknownTab' });

  const resolution = {
    status: 'rejected',
    entryId: 'zz111',
    entry: fixedResolutionEntry(),
    submittedBy: 'Carol',
    rejected_by: 'Admin',
    rejected_at: '2026-08-20T12:00:00.000Z',
  };

  const originalConsoleError = console.error;
  let loggedCall = null;
  console.error = (...args) => {
    loggedCall = args;
  };

  try {
    await assert.rejects(writer.writeResolution(resolution), /Unable to parse range/);
    assert.ok(loggedCall, 'console.error must be called on failure');
    assert.strictEqual(loggedCall[0], 'Sheets append failed after retry');
  } finally {
    console.error = originalConsoleError;
  }
});

test('mapToRow: description falls back to raw_message-independent blank string when notes is absent', () => {
  const row = mapToRow({
    status: 'approved',
    entryId: 'abc12',
    entry: fixedResolutionEntry(),
    submittedBy: 'Dave',
    approved_by: 'Admin',
    approved_at: '2026-08-20T10:00:00.000Z',
  });

  const [, , description, , , , party] = row;
  assert.strictEqual(description, '');
  assert.strictEqual(party, '');
});

test('sanitizeSheetText: prefixes =/+/-/@ -led strings with a single quote, leaves everything else untouched', () => {
  assert.strictEqual(sanitizeSheetText('=HYPERLINK("http://evil.com")'), '\'=HYPERLINK("http://evil.com")');
  assert.strictEqual(sanitizeSheetText('+1 234'), "'+1 234");
  assert.strictEqual(sanitizeSheetText('-500'), "'-500");
  assert.strictEqual(sanitizeSheetText('@mention'), "'@mention");
  assert.strictEqual(sanitizeSheetText('normal text'), 'normal text');
  assert.strictEqual(sanitizeSheetText(''), '');
  assert.strictEqual(sanitizeSheetText(undefined), undefined);
  assert.strictEqual(sanitizeSheetText(500), 500); // non-string (amount) passes through untouched
});

test('Requirement 5.3 (structural): sheetsWriter.js has no Approval-Engine-owned or Responder-owned concerns', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../src/sheetsWriter.js'), 'utf8');

  assert.ok(!/isGroupAdmin/.test(source), 'must not reference isGroupAdmin');
  assert.ok(!/sock\.sendMessage/.test(source), 'must not directly call sock.sendMessage');
  assert.ok(!/pendingStore/i.test(source), 'must not reference the Pending_Store');
  assert.ok(!/APPROVE\|REJECT/.test(source), 'must not contain the decision-matching regex');
});
