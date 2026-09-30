// entryId.js
// Phase 4 — Approval Engine internal module. See
// .kiro/specs/approval-engine/design.md "Entry_Id Generator and Matcher —
// Generation" for the full design context.
//
// Responsibilities:
//   - Generate a short, lowercase alphanumeric Entry_Id that does not
//     collide with any id in a caller-supplied set of existing ids
//     (Requirements 9.1, 2.2).
//   - Give up after a bounded number of attempts rather than looping
//     forever if the id space is exhausted (practically unreachable at
//     wedding-scale pending counts, but defended against anyway).

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LENGTH = 5;
const MAX_ATTEMPTS = 20;

/**
 * Generate a single random candidate id: `LENGTH` characters drawn from
 * `ALPHABET`.
 *
 * @returns {string}
 */
function randomCandidate() {
  let candidate = '';
  for (let i = 0; i < LENGTH; i += 1) {
    const index = Math.floor(Math.random() * ALPHABET.length);
    candidate += ALPHABET[index];
  }
  return candidate;
}

/**
 * Generate an Entry_Id that does not already appear in `existingIds`.
 *
 * Matching elsewhere in the Approval Engine is case-insensitive
 * (Requirement 9.2), so `existingIds` is expected to already contain
 * lowercase ids; generation always produces lowercase candidates, so no
 * extra normalization is needed here.
 *
 * Retries up to `MAX_ATTEMPTS` (20) times against `existingIds`. If every
 * attempt collides, throws an `Error` rather than looping forever.
 *
 * @param {Iterable<string>|Set<string>} existingIds - Ids already in use
 *   (e.g. the in-memory index of currently-pending entries).
 * @returns {string} A 5-character lowercase alphanumeric id not present in
 *   `existingIds`.
 * @throws {Error} If no unique candidate is found within `MAX_ATTEMPTS`
 *   attempts.
 */
function generateUniqueEntryId(existingIds) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = randomCandidate();
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Entry_Id space exhausted');
}

module.exports = {
  generateUniqueEntryId,
  ALPHABET,
  LENGTH,
};
