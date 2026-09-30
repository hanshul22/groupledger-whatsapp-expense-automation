// jobContext.js
// v1.2 — Durable Job Queue (additive). Ambient per-job context.
//
// Why this file exists: sheet_write's idempotency (Part A4) needs a
// deterministic hash of the WhatsApp message id attached to every
// Resolution before it reaches sheetsWriter.js's writeResolutionIdempotent
// — see that function's doc comment. For the approve/reject path, the
// Pending_Entry (and therefore the Resolution decisionProcessor.js
// builds) already carries a stable `entryId` end-to-end, so no extra
// plumbing is needed there. For the auto_approved (admin-submitted)
// path, approvalEngine.js's `submitEntry` builds a Resolution with NO
// correlating id at all (see sheetsWriter.js's writeResolutionIdempotent
// doc comment for the full explanation) — and Rule 1 forbids changing
// approvalEngine.js's behavior to add one.
//
// This module bridges that gap WITHOUT modifying approvalEngine.js: the
// inbound_message job handler (index.js's queue wiring) sets the current
// job's deterministic hash into this ambient context immediately before
// calling `messagePipeline.handleGroupMessage`, for the duration of that
// one call. `index.js`'s `onResolution` callback — invoked synchronously
// further down the SAME call stack (handleGroupMessage -> submitEntry ->
// invokeCallbackSafely -> onResolution, all within one microtask chain,
// no queued job boundary in between) — reads it back out to stamp
// `resolution.entryId` before handing off to the Sheets Writer, ONLY when
// the resolution doesn't already carry one (i.e. only the auto_approved
// case; the approve/reject case's real entryId is left untouched).
//
// Built on Node's built-in `async_hooks.AsyncLocalStorage` (no new
// dependency, per Rule 4) — the correct primitive for "ambient context
// that follows one call chain through awaits", exactly the shape of this
// problem. Never persisted, never crosses a process/job boundary itself
// (each job run calls `run()` fresh) — this is purely a same-call-stack
// wiring aid, not a durability mechanism.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `entryHash` available to any code further down this same
 * call stack via `getCurrentEntryHash()`.
 *
 * @param {string} entryHash
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function runWithEntryHash(entryHash, fn) {
  return storage.run({ entryHash }, fn);
}

/**
 * @returns {string|undefined} The current call stack's entryHash, if
 *   `runWithEntryHash` is currently active on it; `undefined` outside
 *   any such context (e.g. the QUEUE_ENABLED=false direct path, which
 *   never calls `runWithEntryHash` at all — so `resolution.entryId` is
 *   never stamped there, preserving Rule 2's "identical to today").
 */
function getCurrentEntryHash() {
  const store = storage.getStore();
  return store ? store.entryHash : undefined;
}

module.exports = {
  runWithEntryHash,
  getCurrentEntryHash,
};
