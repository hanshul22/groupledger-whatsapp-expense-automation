// entryHash.js
// v1.2 — Durable Job Queue (additive). Deterministic id derivation.
//
// Responsibilities:
//   - Derive a short, deterministic, filesystem/Redis/Sheets-cell-safe id
//     from a WhatsApp message id, per Part A4: "entry_id is generated
//     deterministically at enqueue time (e.g. short hash of the WhatsApp
//     message id) and reused on every retry."
//   - This is the ONE id shared by: the sheet_write job's own job id (so
//     retrying the same sheet_write job is naturally the same Redis key,
//     see redisStore.js's `wq:job:<id>`), the Entries-tab `entry_id`
//     column value the Approval Engine assigns to non-admin submissions
//     (via the existing entryId.js generator — kept separate, see note
//     below), and the "have I already submitted this message" Redis
//     marker the inbound_message handler checks before calling
//     approvalEngine.submitEntry (see index.js's queue wiring).
//
// Deliberately NOT used as the Approval Engine's own Entry_Id (the
// 5-char lowercase id from entryId.js, used in "APPROVE <id>" replies) —
// that id must stay short and typeable by a human. This hash is only
// ever used as an internal key (Redis, sheet_write job id), never shown
// to a WhatsApp user, so it can be longer and never needs to be
// "memorable".

const crypto = require('crypto');

const HASH_LENGTH = 16; // hex chars — 64 bits, ample for wedding-bot volume

/**
 * Derive a short, deterministic hex id from a WhatsApp message id (Part
 * A4). Pure function — same input always produces the same output, which
 * is exactly the point: every retry of the same inbound message computes
 * the same hash, so a job/marker keyed by it is naturally deduplicated.
 *
 * @param {string} waMessageId - `msg.key.id` from Baileys.
 * @returns {string} A 16-character lowercase hex string.
 */
function deriveEntryHash(waMessageId) {
  return crypto.createHash('sha256').update(String(waMessageId)).digest('hex').slice(0, HASH_LENGTH);
}

module.exports = {
  deriveEntryHash,
  HASH_LENGTH,
};
