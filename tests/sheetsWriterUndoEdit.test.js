// sheetsWriterUndoEdit.test.js
// Phase 6 — tests for src/sheetsWriter.js's new Last_Written_Entry
// tracking, `undoLastEntry`, and `editEntryField` (Tasks 1-3 of
// .kiro/specs/responder-commands/tasks.md). See
// .kiro/specs/responder-commands/design.md for design context.
//
// No real Google API calls are made — every test injects a fake
// `sheetsClient` exposing `spreadsheets.values.append`,
// `spreadsheets.values.update`, `spreadsheets.get`, and
// `spreadsheets.batchUpdate` as configurable async functions.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  createSheetsWriter,
  extractRowNumber,
  sanitizeSheetText,
  FIELD_COLUMNS,
} = require('../src/sheetsWriter');

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

/**
 * Build a fake Sheets client supporting append (with a configurable
 * updatedRange), get (tab-name -> sheetId lookup), batchUpdate, and
 * values.update — each independently configurable to fail.
 */
function makeFullFakeClient({
  updatedRange = 'Entries!A5:K5',
  sheetId = 0,
  tabName = 'Entries',
  batchUpdateFails = false,
  valuesUpdateFails = false,
  getFails = false,
} = {}) {
  const calls = { append: [], batchUpdate: [], valuesUpdate: [], get: [] };

  return {
    calls,
    client: {
      spreadsheets: {
        values: {
          append: async (request) => {
            calls.append.push(request);
            return { data: { updates: { updatedRange } } };
          },
          update: async (request) => {
            calls.valuesUpdate.push(request);
            if (valuesUpdateFails) throw new Error('simulated values.update failure');
            return { data: {} };
          },
        },
        get: async (request) => {
          calls.get.push(request);
          if (getFails) throw new Error('simulated spreadsheets.get failure');
          return { data: { sheets: [{ properties: { title: tabName, sheetId } }] } };
        },
        batchUpdate: async (request) => {
          calls.batchUpdate.push(request);
          if (batchUpdateFails) throw new Error('simulated batchUpdate failure');
          return { data: {} };
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Task 1.2 — extractRowNumber unit tests
// ---------------------------------------------------------------------------

test('extractRowNumber: parses simple and quoted-sheet-name ranges, returns null for unparseable input', () => {
  assert.strictEqual(extractRowNumber('Entries!A5:K5'), 5);
  assert.strictEqual(extractRowNumber("'My Sheet'!B12:K12"), 12);
  assert.strictEqual(extractRowNumber(undefined), null);
  assert.strictEqual(extractRowNumber(null), null);
  assert.strictEqual(extractRowNumber(''), null);
  assert.strictEqual(extractRowNumber('not a range'), null);
});

// ---------------------------------------------------------------------------
// Task 1.1 — writeResolution tracks Last_Written_Entry on Entries-tab
// success only
// ---------------------------------------------------------------------------

test('writeResolution tracks Last_Written_Entry on a successful Entries-tab write', async () => {
  const { client } = makeFullFakeClient({ updatedRange: 'Entries!A7:K7' });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

  const resolution = {
    status: 'approved',
    entryId: 'ab12c',
    entry: fixedResolutionEntry(),
    submittedBy: 'Alice',
    approved_by: 'Admin',
    approved_at: '2026-08-20T10:00:00.000Z',
  };

  assert.strictEqual(writer.getLastWrittenEntry(), null);
  await writer.writeResolution(resolution);

  const tracked = writer.getLastWrittenEntry();
  assert.ok(tracked);
  assert.strictEqual(tracked.rowNumber, 7);
  assert.strictEqual(tracked.resolution.entryId, 'ab12c');
});

test('writeResolution does NOT track a Rejected-tab write', async () => {
  const { client } = makeFullFakeClient({ updatedRange: 'Rejected!A3:K3' });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

  const resolution = {
    status: 'rejected',
    entryId: 'zz111',
    entry: fixedResolutionEntry(),
    submittedBy: 'Carol',
    rejected_by: 'Admin',
    rejected_at: '2026-08-20T12:00:00.000Z',
  };

  await writer.writeResolution(resolution);
  assert.strictEqual(writer.getLastWrittenEntry(), null);
});

test('writeResolution skips tracking (no throw) when updatedRange is unparseable', async () => {
  // Destructuring defaults apply even when a key is explicitly set to
  // `undefined`, so an unparseable-but-defined string is used here to
  // genuinely exercise extractRowNumber's null-return path rather than
  // falling back to makeFullFakeClient's own default `updatedRange`.
  const { client } = makeFullFakeClient({ updatedRange: 'not a range' });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

  const resolution = {
    status: 'auto_approved',
    entry: fixedResolutionEntry(),
    submittedBy: 'Dave',
    approved_by: 'Dave',
    approved_at: '2026-08-20T10:00:00.000Z',
  };

  await assert.doesNotReject(writer.writeResolution(resolution));
  assert.strictEqual(writer.getLastWrittenEntry(), null);
});

test('writeResolution tracking overwrites a previously tracked entry', async () => {
  const { client } = makeFullFakeClient({ updatedRange: 'Entries!A5:K5' });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

  await writer.writeResolution({
    status: 'approved',
    entryId: 'first',
    entry: fixedResolutionEntry(),
    submittedBy: 'Alice',
    approved_by: 'Admin',
    approved_at: '2026-08-20T10:00:00.000Z',
  });
  assert.strictEqual(writer.getLastWrittenEntry().resolution.entryId, 'first');

  client.spreadsheets.values.append = async () => ({ data: { updates: { updatedRange: 'Entries!A6:K6' } } });

  await writer.writeResolution({
    status: 'approved',
    entryId: 'second',
    entry: fixedResolutionEntry(),
    submittedBy: 'Bob',
    approved_by: 'Admin',
    approved_at: '2026-08-20T11:00:00.000Z',
  });

  const tracked = writer.getLastWrittenEntry();
  assert.strictEqual(tracked.resolution.entryId, 'second');
  assert.strictEqual(tracked.rowNumber, 6);
});

// ---------------------------------------------------------------------------
// Task 2.2 — Property 4 (sheetsWriter-level): undoLastEntry targets exactly
// the tracked row and clears tracking only on success
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 4: '/undo' by a current Admin removes exactly the tracked row and clears tracking only on success
test('Property 4 (sheetsWriter level): undoLastEntry targets exactly the tracked row and clears tracking only on success', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 500 }), // tracked rowNumber
      fc.boolean(), // whether the batchUpdate call should fail
      async (rowNumber, shouldFail) => {
        const { client, calls } = makeFullFakeClient({
          updatedRange: `Entries!A${rowNumber}:K${rowNumber}`,
          sheetId: 42,
          batchUpdateFails: shouldFail,
        });
        const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

        await writer.writeResolution({
          status: 'approved',
          entryId: 'tracked1',
          entry: fixedResolutionEntry(),
          submittedBy: 'Alice',
          approved_by: 'Admin',
          approved_at: '2026-08-20T10:00:00.000Z',
        });

        assert.ok(writer.getLastWrittenEntry());

        const result = await writer.undoLastEntry();

        assert.strictEqual(calls.batchUpdate.length, 1);
        const req = calls.batchUpdate[0].requestBody.requests[0].deleteDimension;
        assert.strictEqual(req.range.sheetId, 42);
        assert.strictEqual(req.range.dimension, 'ROWS');
        assert.strictEqual(req.range.startIndex, rowNumber - 1);
        assert.strictEqual(req.range.endIndex, rowNumber);

        if (shouldFail) {
          assert.strictEqual(result.ok, false);
          assert.ok(writer.getLastWrittenEntry(), 'tracking left unchanged on failure');
        } else {
          assert.strictEqual(result.ok, true);
          assert.strictEqual(result.resolution.entryId, 'tracked1');
          assert.strictEqual(writer.getLastWrittenEntry(), null, 'tracking cleared only on success');
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Task 2.3 — unit test for the no-tracked-entry case
// ---------------------------------------------------------------------------

test('undoLastEntry returns ok:false and makes no batchUpdate call when nothing is tracked', async () => {
  const { client, calls } = makeFullFakeClient();
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

  const result = await writer.undoLastEntry();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(calls.batchUpdate.length, 0);
  assert.strictEqual(calls.get.length, 0);
});

test('undoLastEntry propagates a spreadsheets.get (sheetId lookup) failure as ok:false without clearing tracking', async () => {
  const { client } = makeFullFakeClient({ getFails: true });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

  await writer.writeResolution({
    status: 'approved',
    entryId: 'trackedX',
    entry: fixedResolutionEntry(),
    submittedBy: 'Alice',
    approved_by: 'Admin',
    approved_at: '2026-08-20T10:00:00.000Z',
  });

  const result = await writer.undoLastEntry();
  assert.strictEqual(result.ok, false);
  assert.ok(writer.getLastWrittenEntry());
});

// ---------------------------------------------------------------------------
// Task 3.2 — Property 7 (sheetsWriter-level): editEntryField addresses
// exactly the targeted cell
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 7: '/edit' by a current Admin with a valid row/field/value updates exactly the targeted cell
test('Property 7 (sheetsWriter level): editEntryField addresses exactly the targeted cell', async () => {
  const fieldArb = fc.constantFrom(...Object.keys(FIELD_COLUMNS));

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 500 }),
      fieldArb,
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.boolean(),
      async (rowNumber, field, value, shouldFail) => {
        const { client, calls } = makeFullFakeClient({ valuesUpdateFails: shouldFail });
        const writer = createSheetsWriter({ spreadsheetId: 'sheet-1', sheetsClient: client });

        const result = await writer.editEntryField(rowNumber, field, value);

        assert.strictEqual(calls.valuesUpdate.length, 1);
        const req = calls.valuesUpdate[0];
        assert.strictEqual(req.range, `Entries!${FIELD_COLUMNS[field]}${rowNumber}`);
        assert.strictEqual(req.valueInputOption, 'USER_ENTERED');
        // editEntryField runs the value through sanitizeSheetText first
        // (formula-injection guard — a leading =/+/-/@ gets a leading
        // single-quote so Sheets renders it as literal text, not a
        // formula); the written value should match that, not the raw
        // generated string, whenever the generator happens to produce
        // one of those prefixes.
        assert.deepStrictEqual(req.requestBody.values, [[sanitizeSheetText(value)]]);

        assert.strictEqual(result.ok, !shouldFail);
      }
    ),
    { numRuns: 100 }
  );
});
