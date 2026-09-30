// messagePipeline.test.js
// Unit tests for src/messagePipeline.js — the extracted, unchanged v1.0/
// v1.1 inbound-group-message pipeline (see that file's header comment).
//
// These tests exercise handleGroupMessage() directly, with fake
// commandHandler/approvalEngine/normalizer/sock collaborators, to confirm
// the extraction preserved every branch that was previously inline in
// index.js's onGroupMessage: command-priority, decision-priority,
// clarification replies, confirmation + submitEntry on a successful
// parse, and the "couldn't parse" fallback reply.

const { test } = require('node:test');
const assert = require('node:assert');

const { createMessagePipeline } = require('../src/messagePipeline');
const { createPushNameCache } = require('../src/pushNameCache');

function makeSock({ groupMetadata } = {}) {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: 'sent-msg-id' } };
    },
    groupMetadata: groupMetadata || (async () => ({ participants: [] })),
  };
}

function makeMsg({ text, senderJid = '111@s.whatsapp.net', pushName = 'Alice', timestampSec } = {}) {
  return {
    key: { participant: senderJid, remoteJid: 'group@g.us', id: 'wamid-1' },
    message: { conversation: text },
    pushName,
    messageTimestamp: timestampSec,
  };
}

function makePipeline(overrides = {}) {
  const normalizer = overrides.normalizer || {
    normalize: async ({ parsed }) => ({ status: 'passthrough', entry: parsed, meta: { changed: false } }),
  };
  const commandHandler = overrides.commandHandler;
  const approvalEngine = overrides.approvalEngine;
  const pushNameCache = overrides.pushNameCache || createPushNameCache();

  const pipeline = createMessagePipeline({
    normalizer,
    commandHandler,
    approvalEngine,
    pushNameCache,
    allowedParties: overrides.allowedParties || [],
    checkAndMarkSubmitted: overrides.checkAndMarkSubmitted,
  });
  return { pipeline, pushNameCache };
}

test('a message with no text content is a no-op', async () => {
  const { pipeline } = makePipeline();
  const sock = makeSock();
  const msg = { key: {}, message: {} };
  await pipeline.handleGroupMessage(sock, msg);
  assert.strictEqual(sock.sentMessages.length, 0);
});

test('command-matching takes priority: a handled command never reaches the parser/normalizer', async () => {
  let commandCalls = 0;
  const commandHandler = {
    handleCommand: async () => {
      commandCalls += 1;
      return true; // handled
    },
  };
  let normalizeCalls = 0;
  const normalizer = { normalize: async () => { normalizeCalls += 1; return { status: 'passthrough', entry: null, meta: {} }; } };

  const { pipeline } = makePipeline({ commandHandler, normalizer });
  const sock = makeSock();
  await pipeline.handleGroupMessage(sock, makeMsg({ text: '/undo' }));

  assert.strictEqual(commandCalls, 1);
  assert.strictEqual(normalizeCalls, 0);
});

test('decision-matching takes priority over parse-as-new-expense', async () => {
  const commandHandler = { handleCommand: async () => false };
  let decisionCalls = 0;
  const approvalEngine = {
    handleTextMessage: async () => {
      decisionCalls += 1;
      return true; // handled as a decision
    },
  };
  let normalizeCalls = 0;
  const normalizer = { normalize: async () => { normalizeCalls += 1; return { status: 'passthrough', entry: null, meta: {} }; } };

  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer });
  const sock = makeSock();
  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'APPROVE ab12c' }));

  assert.strictEqual(decisionCalls, 1);
  assert.strictEqual(normalizeCalls, 0);
});

test('a needs_clarification normalizer result replies with the clarification reason and never calls submitEntry', async () => {
  const commandHandler = { handleCommand: async () => false };
  let submitCalls = 0;
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async () => { submitCalls += 1; },
  };
  const normalizer = {
    normalize: async () => ({ status: 'needs_clarification', reason: 'please rephrase' }),
  };

  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'gave 5000 to Sita on 22 Aug' }));

  assert.strictEqual(submitCalls, 0);
  assert.ok(sock.sentMessages.some((m) => m.content.text.includes('please rephrase')));
});

test('a normalized/passthrough entry sends a confirmation and calls submitEntry with the entry and submission meta', async () => {
  const commandHandler = { handleCommand: async () => false };
  const submitCalls = [];
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async (entry, meta) => { submitCalls.push({ entry, meta }); },
  };
  const entry = { amount: 5000, given_to: 'Sita', date: '2026-08-22', paid_by: 'Alice', raw_message: 'gave 5000 to Sita on 22 Aug' };
  const normalizer = {
    normalize: async () => ({ status: 'passthrough', entry, meta: { changed: false } }),
  };

  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'gave 5000 to Sita on 22 Aug', senderJid: '222@s.whatsapp.net' }));

  assert.strictEqual(submitCalls.length, 1);
  assert.deepStrictEqual(submitCalls[0].entry, entry);
  assert.strictEqual(submitCalls[0].meta.submittedByJid, '222@s.whatsapp.net');
  assert.ok(sock.sentMessages.some((m) => m.content.text.includes('₹5000')));
});

test('a message the parser cannot parse and the normalizer returns no entry for gets the "could not parse" fallback reply', async () => {
  const commandHandler = { handleCommand: async () => false };
  const approvalEngine = { handleTextMessage: async () => false, submitEntry: async () => {} };
  const normalizer = { normalize: async () => ({ status: 'passthrough', entry: null, meta: {} }) };

  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'hey how is everyone doing' }));

  assert.ok(sock.sentMessages.some((m) => m.content.text.includes("couldn't quite catch that")));
});

test('normalizer throwing unexpectedly falls back to v1.0 passthrough behavior rather than crashing the pipeline', async () => {
  const commandHandler = { handleCommand: async () => false };
  const submitCalls = [];
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async (entry) => { submitCalls.push(entry); },
  };
  const normalizer = { normalize: async () => { throw new Error('boom'); } };

  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'gave 5000 to Sita on 22 Aug' }));

  // v1.0 regex parser should have found amount+recipient, so despite the
  // normalizer throwing, the fallback passthrough still carries the
  // parsed entry through to submitEntry.
  assert.strictEqual(submitCalls.length, 1);
  assert.strictEqual(submitCalls[0].amount, 5000);
});

test('pushNameCache is refreshed with the sender JID and pushName on every message', async () => {
  const commandHandler = { handleCommand: async () => true };
  const { pipeline, pushNameCache } = makePipeline({ commandHandler });
  const sock = makeSock();

  await pipeline.handleGroupMessage(sock, makeMsg({ text: '/undo', senderJid: '333@s.whatsapp.net', pushName: 'Bob' }));

  assert.strictEqual(pushNameCache.get('333@s.whatsapp.net'), 'Bob');
});

// ---------------------------------------------------------------------------
// v1.2 — checkAndMarkSubmitted (queue retry idempotency guard)
// ---------------------------------------------------------------------------

test('without checkAndMarkSubmitted (the default), submitEntry is called on every invocation — v1.0/v1.1 behavior unchanged', async () => {
  const commandHandler = { handleCommand: async () => false };
  const submitCalls = [];
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async (entry) => submitCalls.push(entry),
  };
  const normalizer = {
    normalize: async ({ parsed }) => ({ status: 'passthrough', entry: parsed, meta: { changed: false } }),
  };
  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  const msg = makeMsg({ text: 'gave 5000 to Sita on 22 Aug' });
  await pipeline.handleGroupMessage(sock, msg);
  await pipeline.handleGroupMessage(sock, msg); // simulate calling it twice directly

  assert.strictEqual(submitCalls.length, 2, 'with no guard supplied, every call submits — this is the pre-v1.2 contract');
});

test('checkAndMarkSubmitted returning true allows submitEntry to run', async () => {
  const commandHandler = { handleCommand: async () => false };
  const submitCalls = [];
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async (entry) => submitCalls.push(entry),
  };
  const normalizer = {
    normalize: async ({ parsed }) => ({ status: 'passthrough', entry: parsed, meta: { changed: false } }),
  };
  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer, checkAndMarkSubmitted: async () => true });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'gave 5000 to Sita on 22 Aug' }));

  assert.strictEqual(submitCalls.length, 1);
});

test('checkAndMarkSubmitted returning false skips submitEntry (retry-safety for the queue path)', async () => {
  const commandHandler = { handleCommand: async () => false };
  const submitCalls = [];
  const approvalEngine = {
    handleTextMessage: async () => false,
    submitEntry: async (entry) => submitCalls.push(entry),
  };
  const normalizer = {
    normalize: async ({ parsed }) => ({ status: 'passthrough', entry: parsed, meta: { changed: false } }),
  };
  const { pipeline } = makePipeline({ commandHandler, approvalEngine, normalizer, checkAndMarkSubmitted: async () => false });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  await pipeline.handleGroupMessage(sock, makeMsg({ text: 'gave 5000 to Sita on 22 Aug' }));

  assert.strictEqual(submitCalls.length, 0, 'submitEntry must never be called when checkAndMarkSubmitted reports this message was already submitted');
});

test('checkAndMarkSubmitted is called with the WhatsApp message id (msg.key.id)', async () => {
  const commandHandler = { handleCommand: async () => false };
  const approvalEngine = { handleTextMessage: async () => false, submitEntry: async () => {} };
  const normalizer = { normalize: async ({ parsed }) => ({ status: 'passthrough', entry: parsed, meta: {} }) };
  const seenKeys = [];
  const { pipeline } = makePipeline({
    commandHandler,
    approvalEngine,
    normalizer,
    checkAndMarkSubmitted: async (key) => { seenKeys.push(key); return true; },
  });
  const sock = makeSock();
  process.env.WHATSAPP_GROUP_ID = 'group@g.us';

  const msg = makeMsg({ text: 'gave 5000 to Sita on 22 Aug' });
  msg.key.id = 'wamid-specific-id';
  await pipeline.handleGroupMessage(sock, msg);

  assert.deepStrictEqual(seenKeys, ['wamid-specific-id']);
});
