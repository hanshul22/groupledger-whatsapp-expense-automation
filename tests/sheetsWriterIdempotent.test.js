// sheetsWriterIdempotent.test.js
// Unit tests for src/sheetsWriter.js's v1.2 (additive) idempotent-write
// surface: entryIdExistsInColumnA and writeResolutionIdempotent. Kept in
// a separate file from sheetsWriter.test.js (which covers the pre-v1.2
// writeResolution/undo/edit behavior, left completely untouched) so it's
// clear these are new, additive tests rather than a modification of the
// existing suite.
//
// No real Google API calls are made anywhere in this file — every test
// injects a fake `sheetsClient`.

const { test } = require('node:test');
const assert = require('node:assert');

const { createSheetsWriter, entryIdExistsInColumnA } = require('../src/sheetsWriter');

/**
 * A fake Sheets client whose column A ("Entries!A:A") already contains
 * `existingIds`, and whose `values.append` records every call.
 */
function makeFakeClient({ existingIds = [] } = {}) {
  const appendCalls = [];
  const getCalls = [];
  return {
    appendCalls,
    getCalls,
    client: {
      spreadsheets: {
        values: {
          get: async (request) => {
            getCalls.push(request);
            return { data: { values: existingIds.map((id) => [id]) } };
          },
          append: async (request) => {
            appendCalls.push(request);
            return { data: { updates: { updatedRange: 'Entries!A5:N5' } } };
          },
        },
      },
    },
  };
}

function fixedResolution(overrides = {}) {
  return {
    status: 'auto_approved',
    entryId: 'deadbeef01234567',
    entry: {
      amount: 5000,
      given_to: 'Sita',
      date: '2026-08-22',
      raw_message: 'gave 5000 to Sita on 22 Aug',
    },
    submittedBy: 'Alice',
    approved_by: 'Alice',
    approved_at: new Date().toISOString(),
    ...overrides,
  };
}

test('entryIdExistsInColumnA returns false when column A does not contain the id', async () => {
  const { client } = makeFakeClient({ existingIds: ['abc123', 'def456'] });
  const exists = await entryIdExistsInColumnA(client, 'sheet-id', 'Entries', 'deadbeef01234567');
  assert.strictEqual(exists, false);
});

test('entryIdExistsInColumnA returns true when column A already contains the id', async () => {
  const { client } = makeFakeClient({ existingIds: ['abc123', 'deadbeef01234567', 'def456'] });
  const exists = await entryIdExistsInColumnA(client, 'sheet-id', 'Entries', 'deadbeef01234567');
  assert.strictEqual(exists, true);
});

test('entryIdExistsInColumnA returns false cleanly against an empty/header-only column', async () => {
  const { client } = makeFakeClient({ existingIds: [] });
  const exists = await entryIdExistsInColumnA(client, 'sheet-id', 'Entries', 'deadbeef01234567');
  assert.strictEqual(exists, false);
});

test('writeResolutionIdempotent appends when the entryId does not already exist, and returns written: true', async () => {
  const { client, appendCalls } = makeFakeClient({ existingIds: [] });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient: client });

  const result = await writer.writeResolutionIdempotent(fixedResolution());

  assert.strictEqual(result.written, true);
  assert.strictEqual(appendCalls.length, 1);
});

test('writeResolutionIdempotent skips the append when the entryId already exists in column A, and returns written: false', async () => {
  const { client, appendCalls } = makeFakeClient({ existingIds: ['deadbeef01234567'] });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient: client });

  const result = await writer.writeResolutionIdempotent(fixedResolution());

  assert.strictEqual(result.written, false);
  assert.strictEqual(appendCalls.length, 0, 'append must never be called when the entry is already present — this is the Part A4 crash-recovery guarantee');
});

test('writeResolutionIdempotent throws if resolution.entryId is missing, rather than silently generating a random one', async () => {
  const { client } = makeFakeClient({ existingIds: [] });
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient: client });

  await assert.rejects(
    () => writer.writeResolutionIdempotent(fixedResolution({ entryId: undefined })),
    /entryId/,
  );
});

test('writeResolutionIdempotent checks the Rejected tab column A for a rejected resolution, not Entries', async () => {
  const getCallsSeen = [];
  const client = {
    spreadsheets: {
      values: {
        get: async (request) => {
          getCallsSeen.push(request.range);
          return { data: { values: [] } };
        },
        append: async () => ({ data: { updates: { updatedRange: 'Rejected!A3:N3' } } }),
      },
    },
  };
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient: client });

  await writer.writeResolutionIdempotent(fixedResolution({ status: 'rejected', rejected_by: 'Bob', rejected_at: new Date().toISOString() }));

  assert.ok(getCallsSeen.some((range) => range.startsWith('Rejected!')));
});

test('calling writeResolutionIdempotent twice in a row for the same entryId only appends once (simulated retry)', async () => {
  const existingIds = [];
  const client = {
    spreadsheets: {
      values: {
        get: async () => ({ data: { values: existingIds.map((id) => [id]) } }),
        append: async (request) => {
          existingIds.push(request.requestBody.values[0][0]); // column A is index 0
          return { data: { updates: { updatedRange: 'Entries!A5:N5' } } };
        },
      },
    },
  };
  const writer = createSheetsWriter({ spreadsheetId: 'sheet-id', sheetsClient: client });
  const resolution = fixedResolution();

  const first = await writer.writeResolutionIdempotent(resolution);
  const second = await writer.writeResolutionIdempotent(resolution);

  assert.strictEqual(first.written, true);
  assert.strictEqual(second.written, false);
  assert.strictEqual(existingIds.length, 1, 'exactly one row should exist after two identical write attempts');
});
