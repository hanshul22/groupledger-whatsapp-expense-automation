// entryHash.test.js
// Unit tests for src/queue/entryHash.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { deriveEntryHash } = require('../../src/queue/entryHash');

test('deriveEntryHash is deterministic: same input always produces the same output', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (waMessageId) => {
      const a = deriveEntryHash(waMessageId);
      const b = deriveEntryHash(waMessageId);
      assert.strictEqual(a, b);
    }),
    { numRuns: 200 },
  );
});

test('deriveEntryHash produces a 16-character lowercase hex string', () => {
  const hash = deriveEntryHash('3EB0C767D6D1D1F1A1B1');
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test('deriveEntryHash produces different hashes for different message ids (no accidental collisions in practice)', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `wamid-${i}`);
  const hashes = new Set(ids.map(deriveEntryHash));
  assert.strictEqual(hashes.size, ids.length);
});
