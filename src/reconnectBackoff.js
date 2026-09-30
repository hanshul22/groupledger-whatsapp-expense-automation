// reconnectBackoff.js
// Phase 7 — Hardening & Deployment. See
// .kiro/specs/hardening-deployment/design.md "Reconnect Backoff
// (`reconnectBackoff.js`)" for the full design context.
//
// Responsibilities:
//   - Compute a reconnect delay that increases with consecutive failed
//     connection attempts, up to a fixed maximum, so a prolonged outage
//     doesn't turn into a rapid reconnect loop (Requirements 1.1, 1.2).
//   - Pure function, no dependencies — `attempt` resetting to zero after a
//     successful connection (Requirement 1.3) is the caller's
//     (`waConnector.js`'s) responsibility, not this module's.

const DEFAULT_BASE_MS = 2000;
const DEFAULT_MAX_MS = 60000;

/**
 * Compute the reconnect delay for a given (0-indexed) consecutive-failure
 * attempt count, per design.md's plain exponential backoff (no jitter —
 * this is a single bot process, not a fleet, so thundering-herd concerns
 * don't apply here).
 *
 * `attempt = 0` is the delay before the *first* reconnect after a fresh
 * connection closes; `attempt = 1` is the delay before the second
 * consecutive reconnect attempt, and so on.
 *
 * @param {number} attempt - 0-indexed consecutive-failure count.
 * @param {{baseMs?: number, maxMs?: number}} [options]
 * @returns {number} Delay in milliseconds, always between `baseMs` and
 *   `maxMs` inclusive.
 */
function computeBackoffDelayMs(attempt, { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS } = {}) {
  const safeAttempt = Math.max(0, attempt);
  const delay = baseMs * 2 ** safeAttempt;
  return Math.min(delay, maxMs);
}

module.exports = {
  computeBackoffDelayMs,
  DEFAULT_BASE_MS,
  DEFAULT_MAX_MS,
};
