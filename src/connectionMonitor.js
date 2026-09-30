// connectionMonitor.js
// Phase 7 — Hardening & Deployment. See
// .kiro/specs/hardening-deployment/design.md "Connection Monitor
// (`connectionMonitor.js`)" for the full design context.
//
// Responsibilities:
//   - Track whether the WhatsApp connection is currently up or down and
//     for how long it has been continuously down (Requirement 2.1).
//   - Raise exactly one Offline_Alert per continuous outage, once
//     continuous downtime reaches a configured threshold, always recorded
//     to a local alert log (Requirements 2.2, 2.3).
//   - On reconnection, send a recovery notice to a configured
//     Fallback_Number ONLY for outages that actually crossed the alert
//     threshold (Requirements 2.4, 2.5, 2.7), logging and swallowing any
//     send failure without retrying (Requirement 2.6).
//
// Deliberately takes explicit `at` timestamps on every method (defaulting
// to `new Date()`) rather than owning a real timer internally — this
// mirrors decisionProcessor.js/pendingStore.js's pattern of accepting
// timestamps as data rather than calling Date.now() deep inside logic, so
// every acceptance criterion is testable with plain function calls and
// controlled timestamps. The actual "is it time to check yet" polling loop
// lives in index.js (a setInterval calling checkAndMaybeAlert()
// periodically), not here — this module owns no timer/interval itself.

const { appendAuditLog } = require('./auditLog');

const DEFAULT_ALERT_LOG_PATH = './data/connection-alerts.log';

/**
 * Render the recovery notice text sent to the Fallback_Number once the
 * connection is restored after an alerted outage, per design.md's exact
 * template.
 *
 * @param {number} downtimeMs
 * @returns {string}
 */
function recoveryNoticeText(downtimeMs) {
  const minutes = Math.round(downtimeMs / 60000);
  return `⚠️ The expense bot was offline for about ${minutes} minute(s) and has now reconnected.`;
}

/**
 * Factory for the Connection Monitor, per design.md "Module boundaries" —
 * mirrors the `createApprovalEngine(deps)`/`createSheetsWriter(deps)`/
 * `createResponder(deps)`/`createCommandHandler(deps)` pattern already
 * established in this codebase.
 *
 * @param {object} deps
 * @param {number} deps.thresholdMs - Continuous-downtime duration (in
 *   milliseconds) after which an Offline_Alert is raised.
 * @param {string} [deps.alertLogPath] - Defaults to
 *   `./data/connection-alerts.log`.
 * @param {string | null} [deps.fallbackNumber] - The configured
 *   Fallback_Number JID, or `null`/falsy if none is configured
 *   (Requirement 2.5).
 * @returns {{
 *   onDisconnected: (at?: Date) => void,
 *   checkAndMaybeAlert: (at?: Date) => Promise<boolean>,
 *   onReconnected: (options: {sendMessage: (jid: string, content: any) => Promise<any>, at?: Date}) => Promise<void>,
 * }}
 */
function createConnectionMonitor(deps) {
  const { thresholdMs, alertLogPath = DEFAULT_ALERT_LOG_PATH, fallbackNumber } = deps || {};

  let disconnectedAt = null;
  let alerted = false;

  /**
   * Record the moment the connection became unavailable, per Requirement
   * 2.1. Resets `alerted` to `false` — a fresh outage has not yet crossed
   * the threshold (Requirement 2.2).
   *
   * @param {Date} [at]
   */
  function onDisconnected(at = new Date()) {
    disconnectedAt = at;
    alerted = false;
  }

  /**
   * Check whether the current continuous outage (if any) has crossed the
   * configured threshold, and if so — and only the first time this
   * becomes true for this outage — append an Offline_Alert entry to the
   * local alert log (Requirements 2.2, 2.3).
   *
   * Safe to call repeatedly and frequently (e.g. from a periodic
   * `setInterval` in `index.js`): a call that finds `alerted` already
   * `true`, or finds no current outage, does nothing beyond returning the
   * current alerted state.
   *
   * @param {Date} [at]
   * @returns {Promise<boolean>} Whether this outage has been alerted
   *   (either just now or previously).
   */
  async function checkAndMaybeAlert(at = new Date()) {
    if (disconnectedAt && !alerted && at.getTime() - disconnectedAt.getTime() >= thresholdMs) {
      alerted = true; // Req 2.2 — never alert twice for the same outage
      await appendAuditLog(alertLogPath, {
        event: 'connection_offline_alert',
        disconnectedAt: disconnectedAt.toISOString(),
        at: at.toISOString(),
      }); // Req 2.3 — always logged, regardless of fallbackNumber
    }
    return alerted;
  }

  /**
   * Handle the connection being re-established, per Requirements 2.4,
   * 2.5, 2.6, 2.7.
   *
   * - If the outage that just ended was never alerted (never crossed the
   *   threshold), does nothing — no recovery notice, no log entry
   *   (Requirement 2.7).
   * - If it was alerted, always appends a `connection_recovered` log
   *   entry, then — only if `fallbackNumber` is configured — attempts to
   *   send a recovery notice, logging and swallowing (never rethrowing,
   *   never retrying) any send failure.
   *
   * Always clears the outage state before returning, so the next
   * `onDisconnected` call starts a fresh outage.
   *
   * @param {{sendMessage: (jid: string, content: any) => Promise<any>, at?: Date}} options
   * @returns {Promise<void>}
   */
  async function onReconnected({ sendMessage, at = new Date() }) {
    const wasAlerted = alerted;
    const since = disconnectedAt;

    disconnectedAt = null;
    alerted = false;

    if (!wasAlerted || !since) {
      return; // Req 2.7 — never crossed threshold, no recovery notice
    }

    const downtimeMs = at.getTime() - since.getTime();

    await appendAuditLog(alertLogPath, {
      event: 'connection_recovered',
      downtimeMs,
      at: at.toISOString(),
    });

    if (!fallbackNumber) {
      return; // Req 2.5
    }

    try {
      await sendMessage(fallbackNumber, { text: recoveryNoticeText(downtimeMs) });
    } catch (err) {
      console.error('Connection monitor: failed to send recovery notice', {
        fallbackNumber,
        error: err && err.message ? err.message : String(err),
      });
      // Req 2.6 — logged, swallowed, never retried.
    }
  }

  return {
    onDisconnected,
    checkAndMaybeAlert,
    onReconnected,
  };
}

module.exports = {
  createConnectionMonitor,
  recoveryNoticeText,
};
