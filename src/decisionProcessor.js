// decisionProcessor.js
// Phase 4 — Approval Engine internal module. See
// .kiro/specs/approval-engine/design.md "Decision Processor" for the full
// design context.
//
// Responsibilities (this file, Task 7.1 only):
//   - Re-verify, live, that a responder attempting to approve/reject a
//     Pending_Entry is still a current Admin at the moment the decision is
//     processed (Requirement 5.1).
//   - If the responder is not a current Admin: record the rejected
//     decision attempt in the audit log and notify the responder, without
//     mutating any Pending_Entry (Requirement 5.2).
//   - If the responder is a current Admin: delegate to
//     `pendingStore.resolveIfPending` (Task 4.3) — the single atomicity
//     point for first-response-wins (Requirements 6.1, 6.2, 6.3) — and
//     either notify the responder that the entry was already resolved, or
//     build the Resolution and hand it off via `invokeCallbackSafely`
//     (Requirements 7.1, 7.2).
//
// This module is standalone: it is not yet wired into `approvalEngine.js`.
// Later tasks (8.1 `handleTextMessage`, 8.5 `handleReaction`, 9.1 the
// `createApprovalEngine` factory assembly) will import and call
// `processDecision` from here.

const { appendAuditLog } = require('./auditLog');
const { invokeCallbackSafely } = require('./resolutionCallback');

/**
 * Render a human-readable identity for the Resolution's
 * approved_by/rejected_by field: the responder's WhatsApp display name if
 * one is available, otherwise a cleaned-up phone number/id rather than
 * the raw JID (e.g. `919166983560` instead of
 * `919166983560@s.whatsapp.net`, or the bare `@lid` id if that's all
 * that's available for a linked-device identifier).
 *
 * @param {string|null|undefined} responderName - The responder's
 *   WhatsApp pushName, if the caller had one available.
 * @param {string} responderJid
 * @returns {string}
 */
function formatResponderIdentity(responderName, responderJid) {
  if (responderName && responderName.trim()) {
    return responderName.trim();
  }
  return responderJid.split('@')[0];
}

/**
 * Build the not-authorized notice text sent to a responder whose live
 * admin check failed at decision time (Requirement 5.2).
 *
 * @param {string} entryId
 * @returns {string}
 */
function notAuthorizedNotice(entryId) {
  return (
    `You are not authorized to approve or reject entry ${entryId}. ` +
    'Only current group Admins can approve or reject pending entries.'
  );
}

/**
 * Build the already-resolved notice text sent to a responder whose
 * decision arrived after the entry was already resolved by another Admin
 * (Requirement 6.2).
 *
 * @param {string} entryId
 * @param {string} resolvedBy - JID/identity of the Admin who resolved it.
 * @param {string} status - The entry's actual resolved status
 *   (`'approved'` or `'rejected'`).
 * @returns {string}
 */
function alreadyResolvedNotice(entryId, resolvedBy, status) {
  return (
    `Entry ${entryId} was already ${status} by ${resolvedBy}. ` +
    'Your decision was not applied.'
  );
}

/**
 * Build the Resolution object handed to `invokeCallbackSafely` for a
 * newly-resolved Pending_Entry, per design.md "Data Models — Resolution".
 *
 * @param {object} record - The now-mutated Pending_Entry
 *   (`resolved.record` from `pendingStore.resolveIfPending`), with
 *   `status` already set to `'approved'`/`'rejected'` and
 *   `resolvedBy`/`resolvedAt` populated.
 * @returns {object}
 */
function buildResolution(record) {
  const resolution = {
    status: record.status,
    entryId: record.entryId,
    entry: record.parsedEntry,
    submittedBy: record.submittedBy,
    submittedByJid: record.submittedByJid,
    // v1.1 — carried through from the Pending_Entry untouched, per
    // doc/trd.md §8.2/§8.6. null when the normalizer was off/unavailable.
    normalizerMeta: record.normalizerMeta || null,
  };

  if (record.status === 'approved') {
    resolution.approved_by = record.resolvedBy;
    resolution.approved_at = record.resolvedAt;
  } else {
    resolution.rejected_by = record.resolvedBy;
    resolution.rejected_at = record.resolvedAt;
  }

  return resolution;
}

/**
 * Process an Admin decision (approve/reject) against a Pending_Entry, per
 * design.md "Decision Processor". Shared by both the text-reply matcher
 * (Task 8.1) and the reaction matcher (Task 8.5).
 *
 * @param {object} options
 * @param {import('@whiskeysockets/baileys').WASocket} options.sock - Baileys
 *   socket, passed through to the live admin lookup.
 * @param {string} options.groupId - The configured WHATSAPP_GROUP_ID.
 * @param {(sock: any, groupId: string, participantJid: string) => Promise<boolean>} options.isGroupAdmin -
 *   Live admin lookup, from waConnector.js.
 * @param {(jid: string, content: any) => Promise<void>} options.sendMessage -
 *   Thin wrapper over sock.sendMessage.
 * @param {ReturnType<import('./pendingStore').createPendingStore>} options.pendingStore -
 *   The Pending_Store instance (Task 4), used for `resolveIfPending`.
 * @param {(resolution: object) => Promise<void> | void} options.onResolution -
 *   The caller-supplied Resolution_Callback.
 * @param {string} options.auditLogPath - Path to the audit log file.
 * @param {object} options.pendingEntry - The candidate Pending_Entry the
 *   decision was matched against (by text or reaction).
 * @param {'APPROVE'|'REJECT'} options.verb - The decision verb.
 * @param {string} options.responderJid - JID of the Admin attempting the
 *   decision.
 * @param {string} [options.responderName] - The responder's WhatsApp
 *   display name (e.g. a text reply's `msg.pushName`), if available.
 *   Recorded as the human-readable `approved_by`/`rejected_by` identity
 *   instead of the raw JID; falls back to a cleaned-up id derived from
 *   `responderJid` when not supplied (e.g. reactions, which carry no
 *   display name in Baileys' event shape).
 * @returns {Promise<void>}
 */
async function processDecision({
  sock,
  groupId,
  isGroupAdmin,
  sendMessage,
  pendingStore,
  onResolution,
  auditLogPath,
  pendingEntry,
  verb,
  responderJid,
  responderName,
}) {
  const isAdmin = await isGroupAdmin(sock, groupId, responderJid); // live, Req 5.1

  if (!isAdmin) {
    await appendAuditLog(auditLogPath, {
      event: 'decision_rejected_not_admin',
      entryId: pendingEntry.entryId,
      responderJid,
      at: new Date().toISOString(),
    });
    await sendMessage(responderJid, { text: notAuthorizedNotice(pendingEntry.entryId) });
    return;
  }

  const status = verb === 'APPROVE' ? 'approved' : 'rejected';
  const resolvedByIdentity = formatResponderIdentity(responderName, responderJid);

  const resolved = await pendingStore.resolveIfPending(pendingEntry.entryId, {
    status,
    resolvedBy: resolvedByIdentity,
    resolvedAt: new Date().toISOString(),
  });

  if (resolved.outcome === 'already_resolved') {
    await sendMessage(responderJid, {
      text: alreadyResolvedNotice(pendingEntry.entryId, resolved.resolvedBy, resolved.status),
    });
    return;
  }

  // resolved.outcome === 'newly_resolved' — this call is the authoritative
  // one; build the Resolution and hand it off exactly once.
  const resolution = buildResolution(resolved.record);
  await invokeCallbackSafely(onResolution, resolution, auditLogPath);
}

module.exports = {
  processDecision,
  notAuthorizedNotice,
  alreadyResolvedNotice,
  buildResolution,
  formatResponderIdentity,
};
