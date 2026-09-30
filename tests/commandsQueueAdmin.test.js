// commandsQueueAdmin.test.js
// Unit tests for commands.js's v1.2 (additive) /queue and /queue retry
// admin commands — see that file's handleQueueStatus/handleQueueRetry.
// Kept separate from commands.test.js (left untouched) since this only
// covers the new commands, not /undo or /edit's existing behavior.

const { test } = require('node:test');
const assert = require('node:assert');

const { createCommandHandler } = require('../src/commands');

function makeFakeJobQueue({ counts, retryCount = 0 } = {}) {
  return {
    getCountsCalls: 0,
    retryCalls: 0,
    async getCounts() {
      this.getCountsCalls += 1;
      return counts || { queued: 0, inflight: 0, dead: 0, oldestReadyAgeMs: null, oldestInflightAgeMs: null };
    },
    async retryDead() {
      this.retryCalls += 1;
      return retryCount;
    },
  };
}

function makeDeps({ isAdmin = true, jobQueue } = {}) {
  const sentMessages = [];
  return {
    sock: {},
    groupId: 'group@g.us',
    isGroupAdmin: async () => isAdmin,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
    },
    sheetsWriter: {},
    jobQueue,
    _sentMessages: sentMessages,
  };
}

test('/queue is not handled at all when no jobQueue dependency was supplied (QUEUE_ENABLED=false)', async () => {
  const deps = makeDeps({ jobQueue: undefined });
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/queue', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, false, '/queue must fall through to normal parsing when the queue is off, exactly like any other unrecognized text');
  assert.strictEqual(deps._sentMessages.length, 0);
});

test('/queue retry is not handled at all when no jobQueue dependency was supplied', async () => {
  const deps = makeDeps({ jobQueue: undefined });
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/queue retry', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, false);
});

test('/queue (admin) reports counts by state, oldest job age, and dead count', async () => {
  const jobQueue = makeFakeJobQueue({ counts: { queued: 3, inflight: 1, dead: 2, oldestReadyAgeMs: 5 * 60000, oldestInflightAgeMs: 90000 } });
  const deps = makeDeps({ isAdmin: true, jobQueue });
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/queue', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, true);
  assert.strictEqual(jobQueue.getCountsCalls, 1);
  const sent = deps._sentMessages[0].content.text;
  assert.match(sent, /queued: 3/);
  assert.match(sent, /inflight: 1/);
  assert.match(sent, /dead: 2/);
  assert.match(sent, /oldest ready job age: 5m/);
});

test('/queue (non-admin) is rejected with a not-authorized notice and never calls getCounts', async () => {
  const jobQueue = makeFakeJobQueue();
  const deps = makeDeps({ isAdmin: false, jobQueue });
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/queue', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, true);
  assert.strictEqual(jobQueue.getCountsCalls, 0);
  assert.match(deps._sentMessages[0].content.text, /not authorized/i);
});

test('/queue never includes message text/payload contents in its output', async () => {
  const jobQueue = makeFakeJobQueue({ counts: { queued: 1, inflight: 0, dead: 0, oldestReadyAgeMs: null, oldestInflightAgeMs: null } });
  const deps = makeDeps({ isAdmin: true, jobQueue });
  const handler = createCommandHandler(deps);

  await handler.handleCommand({ text: '/queue', senderJid: '111@s.whatsapp.net' });

  const sent = deps._sentMessages[0].content.text;
  // Only the fixed label lines should appear — never a raw_message,
  // amount, or JID.
  assert.doesNotMatch(sent, /raw_message/);
  assert.doesNotMatch(sent, /@s\.whatsapp\.net/);
});

test('/queue retry (admin) requeues dead jobs and reports the count', async () => {
  const jobQueue = makeFakeJobQueue({ retryCount: 4 });
  const deps = makeDeps({ isAdmin: true, jobQueue });
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/queue retry', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, true);
  assert.strictEqual(jobQueue.retryCalls, 1);
  assert.match(deps._sentMessages[0].content.text, /Requeued 4 dead job\(s\)/);
});

test('/queue retry (non-admin) is rejected and never calls retryDead', async () => {
  const jobQueue = makeFakeJobQueue({ retryCount: 4 });
  const deps = makeDeps({ isAdmin: false, jobQueue });
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/queue retry', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, true);
  assert.strictEqual(jobQueue.retryCalls, 0);
});

test('"/queue retry" is matched as retry, not as a plain /queue status request', async () => {
  const jobQueue = makeFakeJobQueue({ retryCount: 1 });
  const deps = makeDeps({ isAdmin: true, jobQueue });
  const handler = createCommandHandler(deps);

  await handler.handleCommand({ text: '/queue retry', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(jobQueue.retryCalls, 1);
  assert.strictEqual(jobQueue.getCountsCalls, 0);
});

test('/undo and /edit still work unchanged when a jobQueue dependency IS supplied', async () => {
  const jobQueue = makeFakeJobQueue();
  const sheetsWriter = {
    getLastWrittenEntry: () => null,
  };
  const deps = { ...makeDeps({ isAdmin: true, jobQueue }), sheetsWriter };
  const handler = createCommandHandler(deps);

  const handled = await handler.handleCommand({ text: '/undo', senderJid: '111@s.whatsapp.net' });

  assert.strictEqual(handled, true);
  assert.match(deps._sentMessages[deps._sentMessages.length - 1].content.text, /Nothing to undo/);
});
