// notifier.test.js
// Tests for src/notifier.js (Approval Engine Notifier).
// See .kiro/specs/approval-engine/design.md "Notifier" for design context
// as amended: the Notification_Message is now posted once to the group
// itself (so any current admin can act on it there), rather than fanned
// out to every admin's private 1:1 chat.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { notifyAdmins, notificationText } = require('../src/notifier');

// Property: exactly one Notification_Message is posted to the group on a
// successful send, and its message id is the only one tracked.
test('Property: a successful send posts exactly once, to the group, and tracks its message id', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        amount: fc.integer({ min: 1, max: 100000 }),
        given_to: fc.string({ minLength: 1, maxLength: 20 }),
        date: fc.constant('2024-01-15'),
        paid_by: fc.string({ minLength: 1, maxLength: 20 }),
      }),
      async (parsedEntry) => {
        const entryId = 'abc12';
        const groupId = 'fake-group';

        const pendingEntry = {
          entryId,
          parsedEntry,
          notificationMessageIds: [],
          notified: false,
        };

        const sendCalls = [];
        const sendMessage = async (jid, content) => {
          sendCalls.push({ jid, content });
          return { key: { id: 'msg-1' }, content };
        };

        const updateCalls = [];
        const pendingStore = {
          update: async (entry) => {
            updateCalls.push({
              notificationMessageIds: [...entry.notificationMessageIds],
              notified: entry.notified,
            });
          },
        };

        await notifyAdmins({ sock: {}, groupId, sendMessage, pendingStore, pendingEntry });

        // Exactly one send, targeting the group (not any per-admin JID).
        assert.strictEqual(sendCalls.length, 1);
        assert.strictEqual(sendCalls[0].jid, groupId);

        assert.deepStrictEqual(pendingEntry.notificationMessageIds, ['msg-1']);
        assert.strictEqual(pendingEntry.notified, true);

        assert.strictEqual(updateCalls.length, 1);
        assert.deepStrictEqual(updateCalls[0].notificationMessageIds, ['msg-1']);
        assert.strictEqual(updateCalls[0].notified, true);

        // The notification text contains the Entry_Id and the
        // amount/given_to/date/paid_by fields.
        const text = notificationText(pendingEntry);
        assert.ok(text.includes(entryId));
        assert.ok(text.includes(String(parsedEntry.amount)));
        assert.ok(text.includes(parsedEntry.given_to));
        assert.ok(text.includes(parsedEntry.date));
        assert.ok(text.includes(parsedEntry.paid_by));
      }
    ),
    { numRuns: 100 }
  );
});

// Boundary case: a failed send must not throw, and must leave the
// Pending_Entry recorded as un-notified rather than aborting entry
// creation.
test('a failed send is logged and swallowed: notified stays false, no message id recorded', async () => {
  const sendMessage = async () => {
    throw new Error('simulated send failure');
  };

  let updateCalls = 0;
  const pendingStore = {
    update: async () => {
      updateCalls += 1;
    },
  };

  const pendingEntry = {
    entryId: 'zero1',
    parsedEntry: {
      amount: 100,
      given_to: 'Vendor',
      date: '2024-01-15',
      paid_by: 'Alice',
    },
    notificationMessageIds: [],
    notified: false,
  };

  await assert.doesNotReject(
    notifyAdmins({ sock: {}, groupId: 'g', sendMessage, pendingStore, pendingEntry })
  );

  assert.strictEqual(pendingEntry.notified, false);
  assert.deepStrictEqual(pendingEntry.notificationMessageIds, []);
  assert.strictEqual(updateCalls, 1, 'pendingStore.update must be called exactly once');
});

// notificationText must instruct that ANY admin can reply APPROVE/REJECT
// (with or without the Entry_Id) or react, since the message is now
// group-visible rather than addressed to one specific admin.
test('notificationText instructs a bare or explicit APPROVE/REJECT reply, or a reaction', () => {
  const pendingEntry = {
    entryId: 'xy12z',
    parsedEntry: {
      amount: 500,
      given_to: 'Sita',
      date: '2024-08-22',
      paid_by: 'Ravi',
    },
  };

  const text = notificationText(pendingEntry);
  assert.ok(text.includes('APPROVE'));
  assert.ok(text.includes('REJECT'));
  assert.ok(text.includes(pendingEntry.entryId));
  assert.ok(text.includes('✅'));
  assert.ok(text.includes('❌'));
});
