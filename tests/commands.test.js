// commands.test.js
// Property-based and unit tests for src/commands.js (Phase 6 — Command
// Handler). See .kiro/specs/responder-commands/design.md "Correctness
// Properties" for design context.
//
// No real Baileys socket or Sheets API client is used anywhere in this
// file — every test injects a fake `isGroupAdmin`, `sendMessage`, and a
// fake `sheetsWriter` exposing `getLastWrittenEntry`/`undoLastEntry`/
// `editEntryField` as configurable functions.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createCommandHandler, EDITABLE_FIELDS } = require('../src/commands');

function fixedTrackedEntry(overrides = {}) {
  return {
    rowNumber: 5,
    resolution: {
      entryId: 'ab12c',
      entry: { amount: 20000, given_to: 'Ram', date: '2026-08-20' },
      submittedBy: 'Alice',
    },
    ...overrides,
  };
}

function makeHandler({ isAdmin, sheetsWriterOverrides = {} } = {}) {
  const sendCalls = [];
  const sendMessage = async (jid, content) => {
    sendCalls.push({ jid, content });
  };

  const adminCalls = [];
  const isGroupAdmin = async (sock, groupId, jid) => {
    adminCalls.push(jid);
    return isAdmin;
  };

  const sheetsWriterCalls = { getLastWrittenEntry: 0, undoLastEntry: 0, editEntryField: [] };
  const sheetsWriter = {
    getLastWrittenEntry: () => {
      sheetsWriterCalls.getLastWrittenEntry += 1;
      return sheetsWriterOverrides.tracked !== undefined ? sheetsWriterOverrides.tracked : fixedTrackedEntry();
    },
    undoLastEntry: async () => {
      sheetsWriterCalls.undoLastEntry += 1;
      if (sheetsWriterOverrides.undoResult) return sheetsWriterOverrides.undoResult;
      return { ok: true, resolution: fixedTrackedEntry().resolution };
    },
    editEntryField: async (rowNumber, field, value) => {
      sheetsWriterCalls.editEntryField.push({ rowNumber, field, value });
      if (sheetsWriterOverrides.editResult) return sheetsWriterOverrides.editResult;
      return { ok: true };
    },
  };

  const handler = createCommandHandler({
    sock: {},
    groupId: 'group-1',
    isGroupAdmin,
    sendMessage,
    sheetsWriter,
  });

  return { handler, sendCalls, adminCalls, sheetsWriterCalls };
}

// ---------------------------------------------------------------------------
// Property 4 (commands.js-level): '/undo' by a current Admin removes
// exactly the tracked row and clears tracking only on success
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 4: '/undo' by a current Admin removes exactly the tracked row and clears tracking only on success
test('Property 4 (commands.js level): /undo by a current Admin calls undoLastEntry when tracked, respecting outcome', async () => {
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.constantFrom(' ', '  ', ''), async (undoSucceeds, whitespace) => {
      const { handler, sendCalls, sheetsWriterCalls } = makeHandler({
        isAdmin: true,
        sheetsWriterOverrides: {
          undoResult: undoSucceeds
            ? { ok: true, resolution: fixedTrackedEntry().resolution }
            : { ok: false, error: new Error('boom') },
        },
      });

      const result = await handler.handleCommand({ text: `${whitespace}/undo${whitespace}`, senderJid: 'admin@s.whatsapp.net' });

      assert.strictEqual(result, true);
      assert.strictEqual(sheetsWriterCalls.undoLastEntry, 1);
      assert.strictEqual(sendCalls.length, 1);
      assert.strictEqual(sendCalls[0].jid, 'group-1');
      if (undoSucceeds) {
        assert.ok(sendCalls[0].content.text.includes('Removed entry'));
      } else {
        assert.ok(sendCalls[0].content.text.includes('failed'));
      }
    }),
    { numRuns: 100 }
  );
});

test('/undo is matched case-insensitively with surrounding whitespace', async () => {
  const { handler, sheetsWriterCalls } = makeHandler({ isAdmin: true });

  for (const text of ['/undo', '/UNDO', '  /undo  ', '/UnDo']) {
    await handler.handleCommand({ text, senderJid: 'admin@s.whatsapp.net' });
  }

  assert.strictEqual(sheetsWriterCalls.undoLastEntry, 4);
});

// ---------------------------------------------------------------------------
// Property 5: '/undo' with no tracked entry never attempts a Sheets write
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 5: '/undo' with no tracked entry never attempts a Sheets write
test('Property 5: /undo with no tracked entry never attempts a Sheets write', async () => {
  const { handler, sendCalls, sheetsWriterCalls } = makeHandler({
    isAdmin: true,
    sheetsWriterOverrides: { tracked: null },
  });

  const result = await handler.handleCommand({ text: '/undo', senderJid: 'admin@s.whatsapp.net' });

  assert.strictEqual(result, true);
  assert.strictEqual(sheetsWriterCalls.undoLastEntry, 0);
  assert.strictEqual(sendCalls.length, 1);
  assert.ok(sendCalls[0].content.text.toLowerCase().includes('nothing to undo'));
});

// ---------------------------------------------------------------------------
// Property 6: '/undo' by a non-Admin never removes anything
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 6: '/undo' by a non-Admin never removes anything
test('Property 6: /undo by a non-Admin never removes anything', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (senderJid) => {
      const { handler, sendCalls, adminCalls, sheetsWriterCalls } = makeHandler({ isAdmin: false });

      const result = await handler.handleCommand({ text: '/undo', senderJid });

      assert.strictEqual(result, true);
      assert.strictEqual(sheetsWriterCalls.getLastWrittenEntry, 0);
      assert.strictEqual(sheetsWriterCalls.undoLastEntry, 0);
      assert.deepStrictEqual(adminCalls, [senderJid]);
      assert.strictEqual(sendCalls.length, 1);
      assert.strictEqual(sendCalls[0].jid, senderJid);
      assert.ok(sendCalls[0].content.text.toLowerCase().includes('not authorized'));
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 7 (commands.js-level): '/edit' by a current Admin with a valid
// row/field/value updates exactly the targeted cell
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 7: '/edit' by a current Admin with a valid row/field/value updates exactly the targeted cell
test('Property 7 (commands.js level): /edit by a current Admin calls editEntryField with exactly the parsed row/field/value', async () => {
  const nonAmountFields = EDITABLE_FIELDS.filter((f) => f !== 'amount');

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 1000 }),
      fc.constantFrom(...nonAmountFields),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      async (row, field, rawValue) => {
        const { handler, sheetsWriterCalls, sendCalls } = makeHandler({ isAdmin: true });

        const text = `/edit ${row} ${field} ${rawValue}`;
        const result = await handler.handleCommand({ text, senderJid: 'admin@s.whatsapp.net' });

        assert.strictEqual(result, true);
        assert.strictEqual(sheetsWriterCalls.editEntryField.length, 1);
        const call = sheetsWriterCalls.editEntryField[0];
        assert.strictEqual(call.rowNumber, row);
        assert.strictEqual(call.field, field);
        assert.strictEqual(call.value, rawValue.trim());
        assert.ok(sendCalls[0].content.text.includes('Updated row'));
      }
    ),
    { numRuns: 100 }
  );
});

test('Property 7 (amount field): valid numeric amount updates exactly the targeted cell', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 1000 }),
      fc.integer({ min: 1, max: 1000000 }),
      async (row, amount) => {
        const { handler, sheetsWriterCalls } = makeHandler({ isAdmin: true });

        const text = `/edit ${row} amount ${amount}`;
        await handler.handleCommand({ text, senderJid: 'admin@s.whatsapp.net' });

        assert.strictEqual(sheetsWriterCalls.editEntryField.length, 1);
        const call = sheetsWriterCalls.editEntryField[0];
        assert.strictEqual(call.rowNumber, row);
        assert.strictEqual(call.field, 'amount');
        assert.strictEqual(call.value, String(amount));
      }
    ),
    { numRuns: 100 }
  );
});

test('/edit field matching is case-insensitive for the command and field name', async () => {
  const { handler, sheetsWriterCalls } = makeHandler({ isAdmin: true });

  await handler.handleCommand({ text: '/EDIT 5 GIVEN_TO Shyam', senderJid: 'admin@s.whatsapp.net' });

  assert.strictEqual(sheetsWriterCalls.editEntryField.length, 1);
  assert.strictEqual(sheetsWriterCalls.editEntryField[0].field, 'given_to');
  assert.strictEqual(sheetsWriterCalls.editEntryField[0].value, 'Shyam');
});

test('/edit value captures multi-word remainder including internal spaces', async () => {
  const { handler, sheetsWriterCalls } = makeHandler({ isAdmin: true });

  await handler.handleCommand({ text: '/edit 5 description some longer note here', senderJid: 'admin@s.whatsapp.net' });

  assert.strictEqual(sheetsWriterCalls.editEntryField[0].value, 'some longer note here');
});

// ---------------------------------------------------------------------------
// Property 8: '/edit' rejects invalid field, row, or amount before any
// Sheets write
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 8: '/edit' rejects invalid field, row, or amount before any Sheets write
test('Property 8: /edit rejects an unknown field before any Sheets write', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => !EDITABLE_FIELDS.includes(s.toLowerCase()) && /^\S+$/.test(s)),
      async (badField) => {
        const { handler, sheetsWriterCalls, sendCalls } = makeHandler({ isAdmin: true });

        const result = await handler.handleCommand({ text: `/edit 5 ${badField} somevalue`, senderJid: 'admin@s.whatsapp.net' });

        assert.strictEqual(result, true);
        assert.strictEqual(sheetsWriterCalls.editEntryField.length, 0);
        assert.ok(sendCalls[0].content.text.includes('not an editable field'));
      }
    ),
    { numRuns: 100 }
  );
});

test('Property 8: /edit rejects row <= 1 before any Sheets write', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(0, 1), async (badRow) => {
      const { handler, sheetsWriterCalls, sendCalls } = makeHandler({ isAdmin: true });

      const result = await handler.handleCommand({ text: `/edit ${badRow} date 2026-08-20`, senderJid: 'admin@s.whatsapp.net' });

      assert.strictEqual(result, true);
      assert.strictEqual(sheetsWriterCalls.editEntryField.length, 0);
      assert.ok(sendCalls[0].content.text.toLowerCase().includes('row number'));
    }),
    { numRuns: 10 }
  );
});

test('Property 8: /edit rejects a non-numeric amount before any Sheets write', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !Number.isFinite(Number(s)) || Number(s) <= 0),
      async (badAmount) => {
        const { handler, sheetsWriterCalls, sendCalls } = makeHandler({ isAdmin: true });

        const result = await handler.handleCommand({ text: `/edit 5 amount ${badAmount}`, senderJid: 'admin@s.whatsapp.net' });

        assert.strictEqual(result, true);
        assert.strictEqual(sheetsWriterCalls.editEntryField.length, 0);
        assert.ok(sendCalls[0].content.text.toLowerCase().includes('amount'));
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 9: '/edit' by a non-Admin never updates anything
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 9: '/edit' by a non-Admin never updates anything
test('Property 9: /edit by a non-Admin never updates anything', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 100 }),
      fc.constantFrom(...EDITABLE_FIELDS),
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
      async (row, field, value) => {
        const { handler, sendCalls, sheetsWriterCalls } = makeHandler({ isAdmin: false });

        const result = await handler.handleCommand({ text: `/edit ${row} ${field} ${value}`, senderJid: 'member@s.whatsapp.net' });

        assert.strictEqual(result, true);
        assert.strictEqual(sheetsWriterCalls.editEntryField.length, 0);
        assert.strictEqual(sendCalls.length, 1);
        assert.strictEqual(sendCalls[0].jid, 'member@s.whatsapp.net');
        assert.ok(sendCalls[0].content.text.toLowerCase().includes('not authorized'));
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 10: Non-command text is always disregarded and falls through
// unhandled
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 10: Non-command text is always disregarded and falls through unhandled
test('Property 10: Non-command text is always disregarded and falls through unhandled', async () => {
  const nearMisses = ['/undox', '/edit abc field value', 'undo', '', '/edit 5', '/edit 5 date', 'just a regular message'];

  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.constantFrom(...nearMisses),
        fc.string({ maxLength: 30 }).filter((s) => !/^\s*\/undo\s*$/i.test(s) && !/^\s*\/edit\s+\d+\s+\S+\s+[\s\S]+?\s*$/i.test(s))
      ),
      async (text) => {
        const { handler, adminCalls, sheetsWriterCalls, sendCalls } = makeHandler({ isAdmin: true });

        const result = await handler.handleCommand({ text, senderJid: 'someone@s.whatsapp.net' });

        assert.strictEqual(result, false);
        assert.strictEqual(adminCalls.length, 0, 'isGroupAdmin must never be called');
        assert.strictEqual(sheetsWriterCalls.getLastWrittenEntry, 0);
        assert.strictEqual(sheetsWriterCalls.undoLastEntry, 0);
        assert.strictEqual(sheetsWriterCalls.editEntryField.length, 0);
        assert.strictEqual(sendCalls.length, 0);
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Requirement 6.2 (structural): commands.js has no direct Sheets API access
// ---------------------------------------------------------------------------

test('Requirement 6.2 (structural): commands.js has no direct Sheets API access', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../src/commands.js'), 'utf8');

  assert.ok(!/googleapis/.test(source), 'must not reference googleapis');
  assert.ok(!/google\.auth/.test(source), 'must not reference google.auth');
  assert.ok(!/spreadsheets\./.test(source), 'must not directly call a spreadsheets. API method');
});
