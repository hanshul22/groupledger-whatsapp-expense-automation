// approvalEnginePendingStoreInjection.test.js
// Unit tests for approvalEngine.js's v1.2 (additive) `pendingStore`
// injection parameter — see that file's doc comment. Kept separate from
// approvalEngine.test.js (left untouched) since this only covers the new
// parameter, not the engine's existing classify/notify/decision logic.

const { test } = require('node:test');
const assert = require('node:assert');

const { createApprovalEngine } = require('../src/approvalEngine');

function makeFakePendingStore() {
  const entries = new Map();
  return {
    initCalled: 0,
    addCalls: [],
    async init() {
      this.initCalled += 1;
    },
    async add(entry) {
      this.addCalls.push(entry);
      entries.set(entry.entryId, entry);
    },
    async update(entry) {
      entries.set(entry.entryId, entry);
    },
    getById(id) {
      return entries.get(id);
    },
    getAllIds() {
      return Array.from(entries.keys());
    },
    findByNotificationMessageId() {
      return undefined;
    },
    async resolveIfPending(entryId, fields) {
      const record = entries.get(entryId);
      if (!record || record.status !== 'pending') {
        return { outcome: 'already_resolved', resolvedBy: record?.resolvedBy, status: record?.status };
      }
      Object.assign(record, { status: fields.status, resolvedBy: fields.resolvedBy, resolvedAt: fields.resolvedAt });
      return { outcome: 'newly_resolved', record };
    },
  };
}

function makeDeps(overrides = {}) {
  const sentMessages = [];
  return {
    sock: { groupMetadata: async () => ({ participants: [] }) },
    groupId: 'group@g.us',
    isGroupAdmin: overrides.isGroupAdmin || (async () => false),
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: 'notif-1' } };
    },
    onResolution: overrides.onResolution || (async () => {}),
    ...overrides,
    _sentMessages: sentMessages,
  };
}

test('init() calls the injected pendingStore\'s init(), not the default file-backed store', async () => {
  const fakeStore = makeFakePendingStore();
  const engine = createApprovalEngine(makeDeps({ pendingStore: fakeStore }));

  await engine.init();

  assert.strictEqual(fakeStore.initCalled, 1);
});

test('submitEntry (non-admin) persists the Pending_Entry into the injected pendingStore', async () => {
  const fakeStore = makeFakePendingStore();
  const engine = createApprovalEngine(makeDeps({ pendingStore: fakeStore, isGroupAdmin: async () => false }));
  await engine.init();

  await engine.submitEntry(
    { amount: 5000, given_to: 'Sita', date: '2026-08-22', paid_by: 'Alice', raw_message: 'gave 5000 to Sita' },
    { submittedBy: 'Alice', submittedByJid: '111@s.whatsapp.net', submittedAt: new Date().toISOString() },
  );

  assert.strictEqual(fakeStore.addCalls.length, 1);
  assert.strictEqual(fakeStore.addCalls[0].status, 'pending');
});

test('omitting pendingStore falls back to the default file-backed store (Rule 2 — unchanged behavior)', async () => {
  // No pendingStore supplied — this must not throw, and must behave
  // exactly like calling createApprovalEngine without the new parameter
  // did before it existed.
  const engine = createApprovalEngine(makeDeps({ isGroupAdmin: async () => true }));
  await engine.init();

  let resolved;
  const engineWithCallback = createApprovalEngine(
    makeDeps({
      isGroupAdmin: async () => true,
      onResolution: async (resolution) => {
        resolved = resolution;
      },
    }),
  );
  await engineWithCallback.init();
  await engineWithCallback.submitEntry(
    { amount: 100, given_to: 'X', date: '2026-01-01', paid_by: 'Y', raw_message: 'gave 100 to X' },
    { submittedBy: 'Admin', submittedByJid: '999@s.whatsapp.net', submittedAt: new Date().toISOString() },
  );

  assert.strictEqual(resolved.status, 'auto_approved');
});
