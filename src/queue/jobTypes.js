// jobTypes.js
// v1.2 — Durable Job Queue (additive). See doc/trd.md §9 (once Phase 6
// docs land) for the full design context. This file is pure constants/
// helpers — no I/O — so every other queue module can share one
// definition of the job shape without circular requires.
//
// Responsibilities:
//   - Define the Job model's field names and state enum in one place.
//   - Define the three failure classes (transient|blocked|permanent) and
//     the backoff schedule used by transient retries.
//   - Provide small, pure helper functions (id generation, backoff delay
//     computation with jitter) that both the Redis store and the queue
//     runtime need, kept dependency-free so they're trivially unit
//     testable.
//
// Nothing here talks to Redis, WhatsApp, Sheets, or OpenRouter — see
// redisStore.js (storage) and jobQueue.js (runtime) for those.

// ---------------------------------------------------------------------------
// Job state enum
// ---------------------------------------------------------------------------

const JOB_STATE = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  AWAITING_APPROVAL: 'awaiting_approval',
  DONE: 'done',
  DEAD: 'dead',
});

const JOB_STATES = Object.freeze(Object.values(JOB_STATE));

// ---------------------------------------------------------------------------
// Job types (Part A4). Handlers are registered against these in
// jobQueue.js; this file just names them so every module agrees on the
// spelling.
// ---------------------------------------------------------------------------

const JOB_TYPE = Object.freeze({
  INBOUND_MESSAGE: 'inbound_message',
  SHEET_WRITE: 'sheet_write',
  WA_REPLY: 'wa_reply',
});

// ---------------------------------------------------------------------------
// Failure classification (Part A5). The classifier itself (mapping a raw
// error to one of these) lives in failureClassifier.js (Phase 4) — this
// file only names the three classes and their retry policy constants so
// jobQueue.js's backoff logic has a single source of truth.
// ---------------------------------------------------------------------------

const FAILURE_CLASS = Object.freeze({
  TRANSIENT: 'transient',
  BLOCKED: 'blocked',
  PERMANENT: 'permanent',
});

// Exponential backoff schedule for `transient` failures, per Part A5:
// ~5s, 15s, 45s, 2m, 5m, 15m, cap 30m. Index by (attempts - 1), clamped to
// the last entry once attempts exceed the table length.
const TRANSIENT_BACKOFF_SCHEDULE_MS = Object.freeze([
  5_000,
  15_000,
  45_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000, // cap — every attempt beyond this index reuses 30m
]);

// Fixed retry interval for `blocked` failures (bad/frozen credentials,
// quota exhaustion) — does NOT burn attempts, per Part A5.
const BLOCKED_RETRY_INTERVAL_MS = 15 * 60_000;

/**
 * Compute the next-attempt delay (ms) for a transient failure, with
 * +/-20% jitter so many jobs failing at once don't all retry in
 * lockstep.
 *
 * @param {number} attempts - 1-indexed count of attempts made so far
 *   (i.e. call with the *new* attempts count after incrementing).
 * @param {() => number} [rand] - Injectable RNG in [0,1), for
 *   deterministic tests. Defaults to Math.random.
 * @returns {number} Delay in milliseconds before the next attempt.
 */
function computeTransientBackoffMs(attempts, rand = Math.random) {
  const index = Math.min(Math.max(attempts - 1, 0), TRANSIENT_BACKOFF_SCHEDULE_MS.length - 1);
  const base = TRANSIENT_BACKOFF_SCHEDULE_MS[index];
  const jitterFraction = 0.2; // +/-20%
  const jitter = base * jitterFraction * (rand() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Generate a short, opaque job id. Not required to be cryptographically
 * unguessable — only used as a Redis key suffix and in logs (never
 * exposed to end users) — so a timestamp + random suffix is enough to
 * avoid collisions at wedding-bot volume.
 *
 * @returns {string}
 */
function generateJobId() {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${time}-${rand}`;
}

/**
 * Build a fresh Job record, per Part A2's field list. Callers supply
 * `type`/`payload`/`receivedAt`; every other field is defaulted here so
 * every job created anywhere in the codebase has an identical shape.
 *
 * @param {object} options
 * @param {string} options.type - One of JOB_TYPE's values.
 * @param {object} options.payload - Job-type-specific data. Must never
 *   contain more than the minimal fields named in Part A3 for
 *   inbound_message (raw text, sender JID, WA message id/timestamp,
 *   group id) — enforced by callers, not this constructor.
 * @param {string} [options.id] - Defaults to a freshly generated id.
 * @param {Date} [options.receivedAt] - Defaults to now. For
 *   inbound_message jobs this should be the WhatsApp message's own
 *   timestamp, not processing time (Part A3's date-default rule) — the
 *   caller is responsible for passing that through.
 * @returns {object} A Job record (see JOB_STATE for `state` values).
 */
function createJob({ type, payload, id = generateJobId(), receivedAt = new Date() }) {
  const now = new Date().toISOString();
  return {
    id,
    type,
    payload,
    state: JOB_STATE.QUEUED,
    attempts: 0,
    next_attempt_at: now,
    lease_until: null,
    created_at: now,
    last_error: null,
    received_at: receivedAt instanceof Date ? receivedAt.toISOString() : receivedAt,
  };
}

/**
 * v1.2 — thrown by a job handler to request "reschedule this job without
 * counting an attempt", per Part B's normalizer hold policy: "reschedule
 * the job without counting an attempt, for up to
 * NORMALIZER_MAX_HOLD_MINUTES". Distinct from every FAILURE_CLASS (which
 * all represent a genuine failure that DOES count toward
 * QUEUE_MAX_AGE_HOURS's dead-letter clock via a real attempt) — a HOLD
 * is not a failure at all, just "not ready yet, try again shortly".
 *
 * Generic at the queue level (not normalizer-specific) so any future job
 * type could use the same "wait, don't burn an attempt" mechanism — the
 * normalizer is only the first, and currently only, caller (see
 * messagePipeline.js's `NormalizerHoldError`, which index.js's
 * inbound_message handler re-throws as this class so jobQueue.js only
 * ever needs to recognize ONE hold signal).
 */
class HoldError extends Error {
  /**
   * @param {string} message
   * @param {number} [retryAfterMs] - How long to wait before the next
   *   attempt. Defaults to a short fixed delay (Part B doesn't specify
   *   an exact re-check interval for the hold state itself — only the
   *   overall NORMALIZER_MAX_HOLD_MINUTES ceiling — so this stays short
   *   enough that a recovered LLM is noticed promptly without hammering
   *   OpenRouter).
   */
  constructor(message, retryAfterMs = 15_000) {
    super(message);
    this.name = 'HoldError';
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = {
  JOB_STATE,
  JOB_STATES,
  JOB_TYPE,
  FAILURE_CLASS,
  TRANSIENT_BACKOFF_SCHEDULE_MS,
  BLOCKED_RETRY_INTERVAL_MS,
  computeTransientBackoffMs,
  generateJobId,
  createJob,
  HoldError,
};
