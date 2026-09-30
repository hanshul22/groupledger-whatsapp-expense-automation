// normalizerHold.js
// v1.2 — Durable Job Queue (additive). Normalizer hold policy, per Part
// B's "Queue interaction" section (replaces trd.md §8.7's plain fail-
// open rule when QUEUE_ENABLED=true).
//
// Why this file exists rather than modifying normalizer.js:
//   normalizer.js's normalize() already fails open internally on every
//   technical failure (LLM unreachable, timeout, malformed JSON, schema
//   mismatch, unexpected error) by returning `{status: 'passthrough',
//   entry: parsed, meta: {...}}` — never throwing (FR11, Rule 1 forbids
//   changing this). The queue's hold policy needs to react differently
//   to "the LLM technically failed" than to "the LLM answered and a
//   deterministic guard rejected it" (needs_clarification) or "the
//   normalizer is simply off" (mode: off/shadow) — but `normalize()`'s
//   return shape doesn't structurally distinguish those cases; they're
//   all `status: 'passthrough'` with different `meta.notes` text.
//
//   Rather than change normalizer.js's return shape (which every
//   existing caller/test already depends on), this module recognizes
//   the ONE specific note string normalizer.js's own `evaluate()`
//   function attaches on a technical LLM-call failure —
//   `"LLM call failed (status ...)."` — via `isLlmCallFailure` below.
//   This is a deliberately narrow, single-purpose string match against
//   a note format that is itself part of normalizer.js's stable,
//   already-tested contract (see normalizer.test.js's assertions on
//   this exact string). If normalizer.js's wording ever changes, this
//   module's own test suite will fail loudly and visibly — it is not a
//   silent coupling.
//
// Responsibilities:
//   - Decide, given a normalize() result and how long the job has been
//     waiting, whether to HOLD (reschedule without counting an attempt),
//     PASSTHROUGH (continue with the parsed entry, unnormalized), or
//     PROCEED (use the normalizer's result as-is — needs_clarification,
//     normalized, or a passthrough that wasn't caused by an LLM
//     failure).
//   - Never invent a clarification message just because the system was
//     down (Part B's explicit requirement) — the HOLD/PASSTHROUGH paths
//     never touch `n.reason`.

const LLM_CALL_FAILURE_NOTE_PREFIX = 'LLM call failed (status';

const HOLD_DECISION = Object.freeze({
  HOLD: 'hold',
  PASSTHROUGH: 'passthrough',
  PROCEED: 'proceed',
});

/**
 * @param {object} normalizeResult - The object normalizer.js's
 *   `normalize()` resolved with.
 * @returns {boolean} Whether this passthrough was specifically caused by
 *   a technical LLM-call failure (unreachable, timeout, 5xx, 429, 401,
 *   402) rather than the mode being off/shadow, a missing API key, or a
 *   malformed/schema-invalid LLM response.
 */
function isLlmCallFailure(normalizeResult) {
  if (!normalizeResult || normalizeResult.status !== 'passthrough') return false;
  const notes = (normalizeResult.meta && normalizeResult.meta.notes) || '';
  return notes.startsWith(LLM_CALL_FAILURE_NOTE_PREFIX);
}

/**
 * Decide what the inbound_message job handler should do with a
 * normalize() result, per Part B's hold policy.
 *
 * @param {object} options
 * @param {object} options.normalizeResult - normalizer.js's normalize()
 *   return value.
 * @param {'hold'|'passthrough'} [options.onLlmDown] - NORMALIZER_ON_LLM_DOWN.
 *   Defaults to 'hold'.
 * @param {Date|string} options.receivedAt - The job's `received_at`
 *   (the WhatsApp message's own timestamp, Part A3).
 * @param {number} [options.maxHoldMinutes] - NORMALIZER_MAX_HOLD_MINUTES.
 *   Defaults to 10.
 * @param {boolean} options.parserProducedUsableEntry - Whether the v1.0
 *   parser (independent of the normalizer) produced a usable entry for
 *   this message. When `false` AND the hold window has elapsed, holding
 *   continues (bounded by the job queue's own QUEUE_MAX_AGE_HOURS, not
 *   by this function) per Part B: "If the v1.0 parser ALSO produced
 *   nothing usable, keep holding until QUEUE_MAX_AGE_HOURS."
 * @param {() => number} [options.now] - Injectable clock, for tests.
 * @returns {{decision: 'hold'|'passthrough'|'proceed'}}
 */
function decideNormalizerHold({
  normalizeResult,
  onLlmDown = 'hold',
  receivedAt,
  maxHoldMinutes = 10,
  parserProducedUsableEntry,
  now = () => Date.now(),
}) {
  if (!isLlmCallFailure(normalizeResult)) {
    return { decision: HOLD_DECISION.PROCEED };
  }

  if (onLlmDown === 'passthrough') {
    return { decision: HOLD_DECISION.PASSTHROUGH };
  }

  // onLlmDown === 'hold' (default).
  const receivedAtMs = receivedAt instanceof Date ? receivedAt.getTime() : new Date(receivedAt).getTime();
  const holdWindowMs = maxHoldMinutes * 60 * 1000;
  const withinHoldWindow = now() - receivedAtMs < holdWindowMs;

  if (withinHoldWindow) {
    return { decision: HOLD_DECISION.HOLD };
  }

  // Hold window elapsed. Part B: "After that, continue with the v1.0
  // parsed entry unnormalized (passthrough). If the v1.0 parser ALSO
  // produced nothing usable, keep holding until QUEUE_MAX_AGE_HOURS."
  if (!parserProducedUsableEntry) {
    return { decision: HOLD_DECISION.HOLD };
  }

  return { decision: HOLD_DECISION.PASSTHROUGH };
}

module.exports = {
  decideNormalizerHold,
  isLlmCallFailure,
  HOLD_DECISION,
  LLM_CALL_FAILURE_NOTE_PREFIX,
};
