// failureClassifier.js
// v1.2 — Durable Job Queue (additive). Real failure classification, per
// Part A5.
//
// Responsibilities:
//   - Classify every error a job handler throws into exactly one of
//     three classes: transient, blocked, or permanent (Part A5).
//   - Recognize the specific error shapes this codebase's own
//     dependencies actually produce:
//       * OpenRouter (normalizer.js's fetch calls) — network/timeout/5xx
//         are transient; 401/402 (bad key / no credit) are blocked; 429
//         (rate limit) is transient per Part A5's explicit list
//         ("transient (network, timeout, 5xx, 429)").
//       * Google Sheets API (googleapis errors, thrown by
//         sheetsWriter.js's appendRow/writeResolution after its own
//         single retry) — 401/403/404 (bad credentials, sheet not
//         shared, wrong sheet id) are blocked; 429/5xx are transient.
//       * Everything else (schema violations, TypeErrors from a bad
//         payload, "no handler registered", explicit validation errors)
//         is permanent — a code/data bug, not something a retry or a
//         wait will fix.
//   - Never throw itself — classification always resolves to one of the
//     three FAILURE_CLASS values, defaulting to `transient` for any
//     error shape it doesn't recognize (the safest default: an unknown
//     error might be a transient blip, and treating it as such costs
//     only bounded retries up to QUEUE_MAX_AGE_HOURS before dead-
//     lettering, whereas wrongly treating a real bug as `blocked` would
//     retry it forever every 15 minutes without ever giving up).

const { FAILURE_CLASS } = require('./jobTypes');

// HTTP status codes that mean "the request itself was bad or the
// credentials/quota behind it are bad", not "try again shortly" — Part
// A5's blocked list: "OpenRouter 401/402, Google 401/403/404, wrong sheet
// id, sheet not shared".
const BLOCKED_HTTP_STATUSES = new Set([401, 402, 403, 404]);

// Explicit transient set per Part A5: "network, timeout, 5xx, 429".
function isTransientHttpStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Best-effort extraction of an HTTP status code from an error thrown by
 * this codebase's dependencies. Handles:
 *   - A plain `{ status }` shape (normalizer.js's own internal call
 *     results aren't thrown directly, but a caller wrapping one in an
 *     Error may attach `.status`).
 *   - `googleapis`' error shape: `err.code` (a number) or
 *     `err.response.status`.
 *   - A message string containing a 3-digit HTTP status, as a last
 *     resort (some errors only expose it in `.message`, e.g.
 *     "Request failed with status code 429").
 *
 * @param {Error} err
 * @returns {number|null}
 */
function extractHttpStatus(err) {
  if (!err) return null;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.code === 'number') return err.code;
  if (err.response && typeof err.response.status === 'number') return err.response.status;

  const message = err.message || String(err);
  const match = /\b(40[0-9]|429|5\d{2})\b/.exec(message);
  return match ? Number(match[1]) : null;
}

// Recognized permanent-failure signatures — thrown deliberately by this
// codebase's own code for a bad payload/config/programmer error, never
// for a network/credentials condition.
const PERMANENT_MESSAGE_PATTERNS = [
  /no handler registered/i,
  /schema violation/i,
  /schema validation/i,
  /requires resolution\.entryId/i,
  /requires a redis client/i,
  /is required to initialize/i,
  /^GOOGLE_SHEET_ID/i,
  /^REDIS_URL/i,
];

/**
 * Classify a job handler's thrown error into transient | blocked |
 * permanent, per Part A5.
 *
 * @param {Error} err
 * @returns {'transient'|'blocked'|'permanent'}
 */
function classifyError(err) {
  try {
    const message = (err && err.message) || String(err);

    for (const pattern of PERMANENT_MESSAGE_PATTERNS) {
      if (pattern.test(message)) return FAILURE_CLASS.PERMANENT;
    }

    const status = extractHttpStatus(err);
    if (status !== null) {
      if (BLOCKED_HTTP_STATUSES.has(status)) return FAILURE_CLASS.BLOCKED;
      if (isTransientHttpStatus(status)) return FAILURE_CLASS.TRANSIENT;
      // Any other 4xx (e.g. 400 Bad Request) is a malformed
      // request/payload, not a network condition — treat as permanent
      // rather than retrying forever on something a retry can never fix.
      if (status >= 400 && status < 500) return FAILURE_CLASS.PERMANENT;
    }

    // Network-level failures (DNS, connection refused/reset, abort/
    // timeout) — Node's fetch/http throw these with recognizable
    // `.code`/`.name` values, never an HTTP status (the request never
    // got a response at all).
    const networkCodes = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
    ]);
    if (err && networkCodes.has(err.code)) return FAILURE_CLASS.TRANSIENT;
    if (err && (err.name === 'AbortError' || /timeout/i.test(message))) return FAILURE_CLASS.TRANSIENT;

    // Default: transient. See header comment for the rationale — an
    // unrecognized error shape is safer to retry-then-eventually-dead-
    // letter than to either retry forever (blocked) or give up
    // immediately (permanent).
    return FAILURE_CLASS.TRANSIENT;
  } catch {
    // classifyError must never itself throw — a classification bug must
    // never prevent a job from being retried at all.
    return FAILURE_CLASS.TRANSIENT;
  }
}

module.exports = {
  classifyError,
  extractHttpStatus,
  BLOCKED_HTTP_STATUSES,
  isTransientHttpStatus,
};
