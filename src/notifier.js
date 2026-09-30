// notifier.js
// Phase 4 — Approval Engine internal module. See
// .kiro/specs/approval-engine/design.md "Notifier" for the full design
// context.
//
// Responsibilities (this file):
//   - Send a single Notification_Message to the group itself, containing
//     the Entry_Id, the entry's amount/given_to/date/paid_by/party/notes
//     fields, and reply/react instructions (Requirement 2.3).
//   - Any current Admin can act on it — by replying `APPROVE`/`REJECT`
//     (with or without the Entry_Id) to that specific message, or by
//     reacting ✅/❌ to it. There is no per-admin fan-out: one message,
//     visible to the whole group, is the single source of truth.
//   - Record whether the send succeeded via `notified`/
//     `notificationMessageIds` rather than treating a failure as fatal
//     (mirrors the old zero-admin boundary — now: zero notifications
//     recorded rather than thrown).
//   - Persist the final `notificationMessageIds`/`notified` state via
//     `pendingStore.update` (Task 4.2) so the Reaction/Reply Matcher can
//     look up the notification message id after this call returns.
//
// Previously (Phase 4 as originally designed) this fanned a Notification_
// Message out to every current Admin's private 1:1 chat individually.
// That meant a reply typed in a DM never reached the group's message
// handler, and only the admin who happened to receive that particular DM
// could act on it by replying inline. Per updated requirements, approval
// now happens in the group, and any current admin (not just whoever
// receives a DM) can resolve it there.

/**
 * Render the plain-text body of a Notification_Message for a given
 * Pending_Entry, per Requirement 2.3: the Entry_Id, the entry's
 * amount/given_to/date/paid_by/party/notes fields (party/notes only when
 * present), and instructions to reply APPROVE/REJECT or react with ✅/❌.
 *
 * Exported (alongside `notifyAdmins`) so later test tasks can assert on
 * its content directly without stubbing a full `sendMessage`.
 *
 * @param {object} pendingEntry - A Pending_Entry (design.md "Data Models
 *   — Pending_Entry"), with `entryId` and `parsedEntry` fields.
 * @returns {string}
 */
function notificationText(pendingEntry) {
  const { entryId, parsedEntry, normalizerMeta } = pendingEntry;
  const { amount, given_to, date, paid_by, party, notes } = parsedEntry || {};

  const lines = [
    'New expense pending approval',
    `Entry_Id: ${entryId}`,
    `Amount: ${amount}`,
    `Given to: ${given_to}`,
    `Date: ${date}`,
    `Paid by: ${paid_by}`,
  ];

  if (party !== undefined && party !== null && party !== '') {
    lines.push(`Party: ${party}`);
  }
  if (notes !== undefined && notes !== null && notes !== '') {
    lines.push(`Notes: ${notes}`);
  }

  // v1.1 — FR14: whenever the normalizer changed something, show the
  // original raw message alongside the formatted entry so a bad reformat
  // can be caught before approval, not after it's in the sheet.
  if (normalizerMeta && normalizerMeta.changed) {
    lines.push(`Original: ${parsedEntry && parsedEntry.raw_message}`);
  }

  lines.push(
    `Any admin: reply APPROVE or REJECT to this message (or APPROVE ${entryId} / REJECT ${entryId}), or react ✅/❌ to it.`
  );

  return lines.join('\n');
}

/**
 * Post a single Notification_Message to the group about a newly created
 * Pending_Entry, per design.md "Notifier" (as amended — group-posted, not
 * DM-fanned-out).
 *
 * Mutates `pendingEntry` in place (`notificationMessageIds`, `notified`)
 * and persists the final state via `pendingStore.update` before returning.
 *
 * - Send failure: logged, `notificationMessageIds = []` and
 *   `notified = false` (Requirement 2.4's boundary, generalized — not
 *   treated as a fatal error) — then persists via `pendingStore.update`
 *   and returns.
 * - Send success: records the single message id in
 *   `notificationMessageIds` (kept as a 1-element array for backward
 *   compatibility with `pendingStore.findByNotificationMessageId`, which
 *   indexes every id in that array) and sets `notified = true`.
 *
 * @param {object} options
 * @param {import('@whiskeysockets/baileys').WASocket} options.sock - Baileys
 *   socket (kept for signature compatibility with callers; unused now
 *   that there is no live admin lookup to perform here).
 * @param {string} options.groupId - The configured WHATSAPP_GROUP_ID —
 *   the Notification_Message's single destination.
 * @param {(jid: string, content: any) => Promise<any>} options.sendMessage -
 *   Thin wrapper over `sock.sendMessage`; expected to resolve with a
 *   Baileys message object (`{ key: { id } }`) on success.
 * @param {{update: (pendingEntry: object) => Promise<void>}} options.pendingStore -
 *   The Pending_Store instance (Task 4.2's `createPendingStore`).
 * @param {object} options.pendingEntry - The Pending_Entry to notify
 *   about; mutated in place and persisted before this function returns.
 * @returns {Promise<void>}
 */
async function notifyAdmins({ sock, groupId, sendMessage, pendingStore, pendingEntry }) {
  try {
    const sendResult = await sendMessage(groupId, { text: notificationText(pendingEntry) });
    const messageId = sendResult && sendResult.key ? sendResult.key.id : undefined;
    pendingEntry.notificationMessageIds = messageId ? [messageId] : [];
    pendingEntry.notified = Boolean(messageId);
  } catch (err) {
    // Logged, never thrown — a failed notification must not abort entry
    // creation (mirrors the old per-admin-send-failure tolerance).
    console.error('Notification send failed', {
      groupId,
      entryId: pendingEntry.entryId,
      err,
    });
    pendingEntry.notificationMessageIds = [];
    pendingEntry.notified = false;
  }

  await pendingStore.update(pendingEntry); // persist message id for reaction/reply matching
}

module.exports = {
  notifyAdmins,
  notificationText,
};
