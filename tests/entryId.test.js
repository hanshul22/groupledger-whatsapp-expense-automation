// entryId.test.js
// Property-based tests for src/entryId.js (Approval Engine Entry_Id generator).
// See .kiro/specs/approval-engine/design.md "Entry_Id Generator and Matcher —
// Generation" and "Correctness Properties" for design context.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { generateUniqueEntryId } = require('../src/entryId');

// Feature: approval-engine, Property 14: Generated Entry_Ids always conform to the required format
test('Property 14: generated Entry_Ids always conform to the required format', () => {
  fc.assert(
    fc.property(
      // Keep existingIds arrays reasonably small (well below the ~36^5
      // possible 5-char combinations) so the 20-attempt retry budget is
      // never exhausted here — that exhaustion behavior is task 3.3's
      // concern, not this property's.
      fc.array(fc.string(), { maxLength: 50 }),
      (existingIds) => {
        const id = generateUniqueEntryId(existingIds);

        assert.strictEqual(typeof id, 'string');
        assert.ok(
          id.length >= 4 && id.length <= 6,
          `expected id length between 4 and 6, got ${id.length} ("${id}")`
        );
        assert.ok(
          /^[a-z0-9]+$/.test(id),
          `expected id to be lowercase alphanumeric, got "${id}"`
        );
      }
    ),
    { numRuns: 100 }
  );
});

// Feature: approval-engine, Requirement 2.2 (defensive): Entry_Id generation
// must not loop forever if the id space is exhausted — it must throw after
// a bounded number of attempts.
test('generateUniqueEntryId throws after MAX_ATTEMPTS consecutive collisions', () => {
  const originalRandom = Math.random;

  try {
    // Math.random() always returning 0 makes every character index
    // Math.floor(0 * ALPHABET.length) === 0, so every candidate is
    // 'aaaaa' (ALPHABET[0] repeated LENGTH times). Passing that exact
    // string as the sole existing id guarantees every one of the 20
    // attempts collides deterministically.
    Math.random = () => 0;

    assert.throws(
      () => generateUniqueEntryId(['aaaaa']),
      /Entry_Id space exhausted/
    );
  } finally {
    Math.random = originalRandom;
  }
});
