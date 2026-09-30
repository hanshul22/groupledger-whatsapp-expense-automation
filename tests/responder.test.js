// responder.test.js
// Property-based and unit tests for src/responder.js (Phase 6 —
// Responder). See .kiro/specs/responder-commands/design.md "Correctness
// Properties" for design context.
//
// No real WhatsApp calls are made anywhere in this file — every test
// injects a fake `sendMessage`.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createResponder, ledgerConfirmationText, rejectionNoticeText } = require('../src/responder');

function fixedEntry(overrides = {}) {
  return {
    amount: 20000,
    given_to: 'Ram',
    date: '2026-08-20',
    raw_message: 'given 20000 to ram on 20 aug by x person',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Successful auto_approved/approved writes always produce
// exactly one in-group Ledger_Confirmation with correct content
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 1: Successful auto_approved/approved writes always produce exactly one in-group Ledger_Confirmation with correct content
test('Property 1: Successful auto_approved/approved writes always produce exactly one in-group Ledger_Confirmation with correct content', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('auto_approved', 'approved'),
      fc.record({
        amount: fc.integer({ min: 1, max: 1000000 }),
        given_to: fc.string({ minLength: 1, maxLength: 20 }),
        date: fc.constant('2026-08-20'),
        party: fc.option(fc.string({ minLength: 1, maxLength: 15 }), { nil: undefined }),
      }),
      async (status, entry) => {
        const calls = [];
        const sendMessage = async (jid, content) => {
          calls.push({ jid, content });
        };

        const responder = createResponder({ sendMessage, groupId: 'group-1' });
        const resolution = { status, entry, submittedBy: 'Alice', approved_by: 'Admin' };

        await responder.notifyOutcome(resolution);

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].jid, 'group-1');
        const text = calls[0].content.text;
        assert.ok(text.includes(String(entry.amount)));
        assert.ok(text.includes(entry.given_to));
        assert.ok(text.includes(entry.date));
        if (entry.party) {
          assert.ok(text.includes(entry.party));
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 2: Rejected resolutions always produce exactly one
// Rejection_Notice to the original submitter with correct content
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 2: Rejected resolutions always produce exactly one Rejection_Notice to the original submitter with correct content
test('Property 2: Rejected resolutions always produce exactly one Rejection_Notice to the original submitter with correct content', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        amount: fc.integer({ min: 1, max: 1000000 }),
        given_to: fc.string({ minLength: 1, maxLength: 20 }),
        date: fc.constant('2026-08-20'),
      }),
      fc.string({ minLength: 1, maxLength: 20 }), // submittedByJid
      fc.string({ minLength: 1, maxLength: 20 }), // rejected_by
      async (entry, submittedByJid, rejectedBy) => {
        const calls = [];
        const sendMessage = async (jid, content) => {
          calls.push({ jid, content });
        };

        const responder = createResponder({ sendMessage, groupId: 'group-1' });
        const resolution = {
          status: 'rejected',
          entry,
          submittedBy: 'Bob',
          submittedByJid,
          rejected_by: rejectedBy,
        };

        await responder.notifyOutcome(resolution);

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].jid, submittedByJid);
        const text = calls[0].content.text;
        assert.ok(text.includes(String(entry.amount)));
        assert.ok(text.includes(entry.given_to));
        assert.ok(text.includes(rejectedBy));
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 3: Outcome-notice send failures are swallowed and never retried
// ---------------------------------------------------------------------------

// Feature: responder-commands, Property 3: Outcome-notice send failures are swallowed and never retried
test('Property 3: Outcome-notice send failures are swallowed and never retried', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('auto_approved', 'approved', 'rejected'),
      async (status) => {
        let callCount = 0;
        const sendMessage = async () => {
          callCount += 1;
          throw new Error('simulated send failure');
        };

        const responder = createResponder({ sendMessage, groupId: 'group-1' });
        const resolution = {
          status,
          entry: fixedEntry(),
          submittedBy: 'Carol',
          submittedByJid: 'carol@s.whatsapp.net',
          approved_by: 'Admin',
          rejected_by: 'Admin',
        };

        const originalConsoleError = console.error;
        console.error = () => {};
        try {
          await assert.doesNotReject(responder.notifyOutcome(resolution));
        } finally {
          console.error = originalConsoleError;
        }

        assert.strictEqual(callCount, 1, 'sendMessage must be attempted exactly once, never retried');
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Targeted unit tests for the text-rendering helpers
// ---------------------------------------------------------------------------

test('ledgerConfirmationText includes party suffix only when party is present', () => {
  const withParty = ledgerConfirmationText({ entry: fixedEntry({ party: "Bride's side" }) });
  assert.ok(withParty.includes("party: Bride's side"));

  const withoutParty = ledgerConfirmationText({ entry: fixedEntry() });
  assert.ok(!withoutParty.includes('party:'));
});

test('rejectionNoticeText names the rejecting admin', () => {
  const text = rejectionNoticeText({ entry: fixedEntry(), rejected_by: 'AdminName' });
  assert.ok(text.includes('AdminName'));
  assert.ok(text.includes('rejected'));
});
