// resolutionCallback.js
// Phase 4 — Approval Engine internal module. See
// .kiro/specs/approval-engine/design.md "Resolution_Callback Invoker" and
// "Resolution_Callback Interface Contract" for the full design context.
//
// Responsibilities (this file, Task 5.1 only):
//   - Provide the *only* place `onResolution` (the caller-supplied
//     Resolution_Callback) is invoked from, so the exactly-once contract
//     (Requirement 7.3) is structural rather than convention.
//   - Guarantee payload immutability (design.md "Resolution_Callback
//     Interface Contract" #5): the `resolution.entry` object handed to the
//     callback is a deep-cloned snapshot, so a callback that mutates it
//     cannot affect the Approval Engine's internal state.
//   - Guarantee no-retry, never-revert failure handling (Requirements 1.4,
//     7.3): if `onResolution` throws or its returned promise rejects, this
//     function logs the failure to the audit log and swallows the error —
//     it never rethrows, never retries, and never undoes whatever
//     classification/resolution already happened before it was called.

const { appendAuditLog } = require('./auditLog');

/**
 * Deep-clone a value for the payload-immutability guarantee described in
 * design.md "Resolution_Callback Interface Contract" #5.
 *
 * Prefers the built-in `structuredClone` (available globally on Node >=20,
 * which this project already requires per `package.json` `engines.node`).
 * Falls back to a JSON round-trip for environments where `structuredClone`
 * is unexpectedly unavailable — sufficient here since `Parsed_Entry`
 * (design.md "Data Models — Pending_Entry.parsedEntry") is a plain object
 * of strings/numbers with no dates, functions, or cycles.
 *
 * @param {*} value
 * @returns {*} A deep clone of `value`.
 */
function deepClone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Invoke `onResolution(resolution)` safely: exactly once, never rethrowing,
 * never retrying, and never reverting prior state — per design.md
 * "Resolution_Callback Invoker" and Requirements 1.4 / 7.3.
 *
 * Before invoking the callback, builds a shallow copy of `resolution` with
 * `entry` replaced by a deep clone of `resolution.entry` (the original
 * `resolution` object passed in by the caller is never mutated), so the
 * callback receives a plain, independent snapshot per the
 * payload-immutability guarantee.
 *
 * On a callback throw/rejection, appends an audit log entry
 * (`event: 'resolution_callback_failed'`) via `appendAuditLog` and then
 * swallows the error — this function itself never throws or rejects due
 * to a callback failure, so every call site (auto-approve path, decision
 * path) can call it unconditionally without its own try/catch.
 *
 * Judgment call (not an explicit design.md requirement): if the
 * `appendAuditLog` call made while handling a callback failure itself
 * fails, that error is intentionally allowed to propagate (thrown/
 * rejected) rather than swallowed. design.md only explicitly mandates
 * crash-on-log-failure for the Pending_Store corruption path (Requirement
 * 8.5, see `pendingStore.js`'s `loadStoreFromDisk`); it does not say what
 * to do if an audit-log write fails on *this* path. Propagating here
 * follows the same "an unlogged failure is worse than a visible crash"
 * reasoning `pendingStore.js` documents for 8.5 — losing the audit trail
 * for a resolution_callback_failed event would hide the fact that a
 * downstream consumer (Sheets Writer/Responder) never received a
 * Resolution, which is worth surfacing loudly rather than silently
 * swallowing. A defensible alternative would be to log to `console.error`
 * as a last resort instead of propagating; this implementation chooses to
 * propagate, but that choice is this file's judgment call, not a
 * requirement.
 *
 * @param {(resolution: object) => Promise<void> | void} onResolution -
 *   The caller-supplied Resolution_Callback.
 * @param {object} resolution - The Resolution to hand off. Expected to
 *   have at least an `entry` field, and optionally `entryId`/`status`
 *   (used only for the audit log entry on failure — `entryId` is
 *   legitimately `undefined` for `auto_approved` resolutions, since no
 *   Pending_Entry ever existed for those, per design.md "Data Models —
 *   Resolution").
 * @param {string} auditLogPath - Path to the audit log file, used only if
 *   `onResolution` throws/rejects.
 * @returns {Promise<void>}
 */
async function invokeCallbackSafely(onResolution, resolution, auditLogPath) {
  const clonedResolution = {
    ...resolution,
    entry: deepClone(resolution.entry),
  };

  try {
    await onResolution(clonedResolution);
  } catch (err) {
    // Req 1.4 / 7.3 — never retried, never reverts prior
    // classification/resolution state. See doc comment above for the
    // judgment call on letting an appendAuditLog failure here propagate.
    await appendAuditLog(auditLogPath, {
      event: 'resolution_callback_failed',
      entryId: resolution.entryId,
      at: new Date().toISOString(),
      detail: err && err.message ? err.message : String(err),
    });
  }
}

module.exports = {
  invokeCallbackSafely,
  deepClone,
};
