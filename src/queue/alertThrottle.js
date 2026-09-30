// alertThrottle.js
// v1.2 — Durable Job Queue (additive). Alert rate-limiting, per Part A7:
// "Alert when: a job is dead-lettered, a blocker is detected, oldest job
// age > QUEUE_ALERT_OLDEST_MINUTES, or queue depth is unusually high" —
// and Part A5: "alert once per blocker per hour".
//
// Responsibilities:
//   - Wrap a raw `onAlert(message)` callback so repeated alerts for the
//     SAME underlying condition (identified by a caller-supplied `key`)
//     are collapsed to at most one delivery per hour, while alerts for
//     DIFFERENT keys are never throttled against each other (a blocked
//     OpenRouter key and a blocked Google credential are independent
//     conditions and both deserve their own alert).
//   - Reset a key's throttle the moment its condition is explicitly
//     cleared (`clear(key)`), so recovery is never silently suppressed
//     by a stale cooldown — the NEXT time that same condition recurs
//     after being cleared, it alerts immediately rather than waiting out
//     the hour.
//
// Pure in-memory, process-local — mirrors normalizer.js's own
// consecutive-failure/alerted-flag pattern (scoped per created instance,
// not global), and needs no persistence: an alert that would have fired
// during a brief process restart is not a correctness issue (the
// underlying condition, e.g. a dead-lettered job or a blocked key, is
// still visible via /queue and GET /health regardless of whether a
// WhatsApp alert about it was ever sent).

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour, per Part A5/A7

/**
 * @param {object} [options]
 * @param {(message: string) => void} options.onAlert - The real alert
 *   delivery function (e.g. index.js's queue onAlert, routed to
 *   BOT_ADMIN_FALLBACK_NUMBER).
 * @param {number} [options.cooldownMs] - Defaults to 1 hour.
 * @param {() => number} [options.now] - Injectable clock for tests.
 * @returns {{
 *   alert: (key: string, message: string) => void,
 *   clear: (key: string) => void,
 * }}
 */
function createAlertThrottle({ onAlert, cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  const lastAlertedAtByKey = new Map();

  /**
   * Deliver `message` via `onAlert`, unless a previous `alert()` call
   * for this exact `key` fired within the last `cooldownMs`.
   *
   * @param {string} key - Identifies the underlying condition (e.g.
   *   `"blocked:sheet_write"`, `"dead_letter:<jobId>"`,
   *   `"oldest_job_age"`, `"queue_depth"`).
   * @param {string} message
   */
  function alert(key, message) {
    const last = lastAlertedAtByKey.get(key);
    const nowMs = now();
    if (last !== undefined && nowMs - last < cooldownMs) {
      return; // throttled — same condition alerted within the cooldown window
    }
    lastAlertedAtByKey.set(key, nowMs);
    try {
      onAlert(message);
    } catch (err) {
      // Never let a failed alert delivery affect queue processing.
      console.error('Alert throttle: onAlert threw:', err && err.message ? err.message : String(err));
    }
  }

  /**
   * Clear a key's throttle state — call when the underlying condition is
   * confirmed resolved (e.g. a blocked job finally succeeds), so the
   * NEXT occurrence of that condition alerts immediately rather than
   * waiting out a stale cooldown from before the fix.
   *
   * @param {string} key
   */
  function clear(key) {
    lastAlertedAtByKey.delete(key);
  }

  return { alert, clear };
}

module.exports = {
  createAlertThrottle,
  DEFAULT_COOLDOWN_MS,
};
