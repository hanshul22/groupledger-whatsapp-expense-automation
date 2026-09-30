// jobContext.test.js
// Unit tests for src/queue/jobContext.js — the AsyncLocalStorage-based
// ambient per-job context bridging inbound_message's entry hash to the
// onResolution callback further down the same call stack.

const { test } = require('node:test');
const assert = require('node:assert');

const { runWithEntryHash, getCurrentEntryHash } = require('../../src/queue/jobContext');

test('getCurrentEntryHash returns undefined outside any runWithEntryHash call', () => {
  assert.strictEqual(getCurrentEntryHash(), undefined);
});

test('getCurrentEntryHash returns the hash set by the enclosing runWithEntryHash, across awaits', async () => {
  const observed = await runWithEntryHash('hash-123', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return getCurrentEntryHash();
  });
  assert.strictEqual(observed, 'hash-123');
});

test('nested/concurrent runWithEntryHash calls do not leak into each other', async () => {
  const [a, b] = await Promise.all([
    runWithEntryHash('hash-A', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getCurrentEntryHash();
    }),
    runWithEntryHash('hash-B', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getCurrentEntryHash();
    }),
  ]);
  assert.strictEqual(a, 'hash-A');
  assert.strictEqual(b, 'hash-B');
});

test('getCurrentEntryHash returns undefined again after runWithEntryHash resolves', async () => {
  await runWithEntryHash('hash-temp', async () => getCurrentEntryHash());
  assert.strictEqual(getCurrentEntryHash(), undefined);
});
