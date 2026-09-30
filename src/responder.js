// responder.js
// Phase 6 — Responder. See
// .kiro/specs/responder-commands/design.md "Responder (`responder.js`)"
// for the full design context.
//
// Responsibilities (per design.md and Requirement 6.1):
//   - Own outbound Ledger_Confirmation ("✅ ₹... logged...") and
//     Rejection_Notice ("❌ ... rejected...") message copy.
//   - Send exactly one outcome notice per resolved entry, invoked from
//     `src/index.js`'s `onResolution` strictly AFTER
//     `sheetsWriter.writeResolution` has already succeeded for that
//     Resolution (Requirement 1.2 — enforced by call ordering in
//     `index.js`, not by this module).
//   - Never perform Admin checks, pending-entry tracking, decision
//     matching, or Google Sheets writes (Requirement 6.1) — this module's
//     only external effect is calling the injected `sendMessage`.
//   - Swallow (log, never rethrow/retry) any failure sending the notice
//     itself (Requirements 1.3, 2.2), so a failed confirmation/notice send
//     never affects the already-successful sheet write or any other
//     resolution's processing.

/**
 * Render the Ledger_Confirmation text for an `auto_approved`/`approved`
 * Resolution, per design.md's exact template.
 *
 * @param {object} resolution - A Resolution (see
 *   approval-engine/design.md "Data Models — Resolution").
 * @returns {string}
 */
function ledgerConfirmationText(resolution) {
  const entry = resolution.entry || {};
  const partySuffix = entry.party ? `, party: ${entry.party}` : '';
  return `✅ ₹${entry.amount} to ${entry.given_to} logged for ${entry.date}${partySuffix}.`;
}

/**
 * Render the Rejection_Notice text sent to the original Submitter, per
 * design.md's exact template.
 *
 * @param {object} resolution - A Resolution with `status: 'rejected'`.
 * @returns {string}
 */
function rejectionNoticeText(resolution) {
  const entry = resolution.entry || {};
  return `❌ Your submitted expense (₹${entry.amount} to ${entry.given_to}) was rejected by ${resolution.rejected_by}.`;
}

/**
 * Factory for the Responder, per design.md "Module boundaries" — mirrors
 * the `createApprovalEngine(deps)`/`createSheetsWriter(deps)` pattern
 * already established in this codebase.
 *
 * @param {object} deps
 * @param {(jid: string, content: any) => Promise<void>} deps.sendMessage -
 *   Thin wrapper over `sock.sendMessage`.
 * @param {string} deps.groupId - The configured WHATSAPP_GROUP_ID; the
 *   destination for every Ledger_Confirmation.
 * @returns {{notifyOutcome: (resolution: object) => Promise<void>}}
 */
function createResponder(deps) {
  const { sendMessage, groupId } = deps || {};

  /**
   * Send the appropriate outcome notice for a resolved entry, per
   * design.md's `notifyOutcome` pseudocode.
   *
   * - `auto_approved`/`approved`: Ledger_Confirmation to the group
   *   (Requirement 1.1).
   * - `rejected`: Rejection_Notice to `resolution.submittedByJid`
   *   (Requirement 2.1).
   * - Any send failure is logged and swallowed — never rethrown, never
   *   retried (Requirements 1.3, 2.2).
   *
   * @param {object} resolution
   * @returns {Promise<void>}
   */
  async function notifyOutcome(resolution) {
    try {
      if (resolution.status === 'auto_approved' || resolution.status === 'approved') {
        await sendMessage(groupId, { text: ledgerConfirmationText(resolution) });
      } else if (resolution.status === 'rejected') {
        await sendMessage(resolution.submittedByJid, { text: rejectionNoticeText(resolution) });
      }
    } catch (err) {
      console.error('Responder: failed to send outcome notice', {
        status: resolution.status,
        entryId: resolution.entryId,
        error: err && err.message ? err.message : String(err),
      });
      // Req 1.3 / 2.2 — never rethrown, never retried.
    }
  }

  return {
    notifyOutcome,
  };
}

module.exports = {
  createResponder,
  ledgerConfirmationText,
  rejectionNoticeText,
};
