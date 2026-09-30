// approvalEngine.js
// Phase 4 — Approval Engine. See .kiro/specs/approval-engine/design.md for
// the full design (Architecture, Components and Interfaces, Data Models,
// Concurrency Handling, Persistence Strategy).
//
// Responsibilities (per design.md "Module boundary" and Overview):
//   - Classify each submitted Parsed_Entry as auto-approved (Admin
//     submitter) or pending (non-Admin submitter, tracked under a short
//     Entry_Id and persisted to disk).
//   - Match incoming APPROVE/REJECT text replies and ✅/❌ reactions back to
//     the right Pending_Entry, enforcing first-response-wins.
//   - Hand off every final outcome to a caller-supplied Resolution_Callback
//     exactly once per entry — this module never touches Google Sheets and
//     never sends ledger confirmation/rejection messages itself.
//
// This module is fully assembled per design.md's "Module boundary": the
// `createApprovalEngine(deps)` factory wires together the internal
// collaborators built in earlier tasks — the audit log (`auditLog.js`),
// the Entry_Id generator (`entryId.js`), the Pending_Store (`pendingStore.js`),
// the Resolution_Callback invoker (`resolutionCallback.js`), the Notifier
// (`notifier.js`), and the Decision Processor (`decisionProcessor.js`) —
// behind the public API: `init()`, `submitEntry()`, `handleTextMessage()`
// (which also matches a bare APPROVE/REJECT reply quoting the
// Notification_Message, letting any current admin resolve it from the
// group itself), and `handleReaction()`.

const { createPendingStore } = require('./pendingStore');
const { invokeCallbackSafely } = require('./resolutionCallback');
const { generateUniqueEntryId } = require('./entryId');
const { notifyAdmins } = require('./notifier');
const { processDecision } = require('./decisionProcessor');

// Decision-matching pattern for inbound group text messages, per
// design.md "Entry_Id Generator and Matcher — Matching" (Requirements 3.1,
// 3.2, 3.4, 9.2). Defined once at module scope rather than inline per call.
const DECISION_REGEX = /^\s*(APPROVE|REJECT)\s+([A-Za-z0-9]{4,6})\s*$/i;

// Bare decision pattern (no Entry_Id) for a group reply that quotes the
// Notification_Message directly — the quoted message identifies the
// entry, so the verb alone is enough (Requirement: "admin can reply to
// the message and just write approve"). No word-boundary risk here since
// the entire trimmed string must match, not a substring.
const BARE_DECISION_REGEX = /^\s*(APPROVE|REJECT)\s*$/i;

/**
 * Factory for the Approval Engine.
 *
 * @param {object} deps
 * @param {import('@whiskeysockets/baileys').WASocket} deps.sock - Baileys
 *   socket, passed through to WA_Connector calls.
 * @param {string} deps.groupId - The configured WHATSAPP_GROUP_ID.
 * @param {(sock: any, groupId: string, participantJid: string) => Promise<boolean>} deps.isGroupAdmin -
 *   Live admin lookup, from waConnector.js.
 * @param {(jid: string, content: any) => Promise<void>} deps.sendMessage -
 *   Thin wrapper over sock.sendMessage.
 * @param {(resolution: object) => Promise<void> | void} deps.onResolution -
 *   Resolution_Callback, invoked exactly once per submitted entry.
 * @param {string} [deps.storePath] - Defaults to ./data/pending-store.json.
 * @param {string} [deps.auditLogPath] - Defaults to ./data/audit.log.
 * @param {object} [deps.pendingStore] - v1.2 (additive). Pre-built
 *   Pending_Store instance to use instead of constructing the default
 *   file-backed one from `storePath`/`auditLogPath` — see
 *   redisPendingStore.js's `createRedisPendingStore`, which implements
 *   the exact same interface (`init`/`add`/`update`/`getById`/
 *   `getAllIds`/`findByNotificationMessageId`/`resolveIfPending`) against
 *   Redis instead of a local file, selected by index.js's queue wiring
 *   via STATE_STORE=redis|file. When omitted (the default), behavior is
 *   bit-for-bit identical to before this parameter existed — the
 *   original `createPendingStore({storePath, auditLogPath})` is still
 *   constructed exactly as before.
 * @returns {{
 *   init: () => Promise<void>,
 *   submitEntry: (parsedEntry: object, submissionMeta: object) => Promise<void>,
 *   handleTextMessage: (message: object) => Promise<Boolean>,
 *   handleReaction: (reaction: object) => Promise<void>,
 * }}
 */
function createApprovalEngine(deps) {
  const {
    sock,
    groupId,
    isGroupAdmin,
    sendMessage,
    onResolution,
    storePath = './data/pending-store.json',
    auditLogPath = './data/audit.log',
    pendingStore: injectedPendingStore,
  } = deps;

  // Module-scoped Pending_Store instance for this engine instance, per
  // design.md "Persistence Strategy — In-memory index". Every method below
  // reads/writes through this same instance. v1.2 — `injectedPendingStore`
  // (e.g. a Redis-backed store) is used verbatim when supplied; omitting
  // it preserves the exact pre-v1.2 construction (Rule 2).
  const pendingStore = injectedPendingStore || createPendingStore({ storePath, auditLogPath });

  /**
   * Loads the Pending_Store from disk (Requirement 8.3).
   * @returns {Promise<void>}
   */
  async function init() {
    await pendingStore.init();
  }

  /**
   * Classifies a newly parsed entry as auto-approved or pending, per
   * design.md "Classifier".
   *
   * Admin path: re-verifies the submitter's admin status live, builds an
   * `auto_approved` Resolution, and hands it off via `invokeCallbackSafely`
   * — no Pending_Store write occurs on this path (Requirements 1.1, 1.2,
   * 1.3, 1.5).
   *
   * Non-admin path: generates a unique Entry_Id, builds a `pending`
   * Pending_Entry, durably persists it via `pendingStore.add`, and then
   * notifies current Admins via `notifyAdmins` (Requirements 2.1, 2.2,
   * 2.3).
   *
   * @param {object} parsedEntry
   * @param {{submittedBy: string, submittedByJid: string, submittedAt: string, normalizerMeta?: object}} submissionMeta
   *   `normalizerMeta` (v1.1, optional) is the Normalizer's `meta` object
   *   (see normalizer.js) for this entry — carried through untouched to
   *   the Resolution/Pending_Entry so the Notifier (approver-facing
   *   "Original: …" note, FR14) and the Sheets Writer (columns L-N,
   *   doc/trd.md §8.6) can read it later without re-calling the LLM.
   * @returns {Promise<void>}
   */
  async function submitEntry(parsedEntry, submissionMeta) {
    const isAdmin = await isGroupAdmin(sock, groupId, submissionMeta.submittedByJid);

    if (isAdmin) {
      const resolution = {
        status: 'auto_approved',
        entry: parsedEntry,
        submittedBy: submissionMeta.submittedBy,
        submittedByJid: submissionMeta.submittedByJid,
        approved_by: submissionMeta.submittedBy,
        approved_at: new Date().toISOString(),
        normalizerMeta: submissionMeta.normalizerMeta || null,
      };
      await invokeCallbackSafely(onResolution, resolution, auditLogPath);
      return;
    }

    // Non-admin path: generate a unique Entry_Id against the in-memory
    // index, build the Pending_Entry, and durably persist it via
    // `pendingStore.add` — this write must complete before any
    // notification is attempted (Requirements 2.1, 2.2; design.md
    // "Classifier — Persist-before-notify ordering").
    const existingIds = pendingStore.getAllIds();
    const entryId = generateUniqueEntryId(existingIds);

    const submittedAt =
      submissionMeta.submittedAt instanceof Date
        ? submissionMeta.submittedAt.toISOString()
        : submissionMeta.submittedAt;

    const pendingEntry = {
      entryId,
      status: 'pending',
      parsedEntry,
      submittedBy: submissionMeta.submittedBy,
      submittedByJid: submissionMeta.submittedByJid,
      submittedAt,
      notified: false,
      notificationMessageIds: [],
      // v1.1 — persisted so approval never re-calls the LLM and a restart
      // does not lose it (doc/trd.md §8.2). null when the normalizer was
      // off/unavailable for this entry.
      normalizerMeta: submissionMeta.normalizerMeta || null,
    };

    await pendingStore.add(pendingEntry);

    await notifyAdmins({ sock, groupId, sendMessage, pendingStore, pendingEntry });
  }

  /**
   * Matches an inbound group text message against either decision form,
   * per design.md "Entry_Id Generator and Matcher — Matching" as amended
   * to also support a quoted-reply shorthand:
   *
   * 1. Bare `APPROVE`/`REJECT` (any casing/whitespace) that is a WhatsApp
   *    reply quoting a tracked Notification_Message (`quotedMessageId`
   *    matches `pendingStore.findByNotificationMessageId`) — the quoted
   *    message identifies the entry, so no Entry_Id needs to appear in
   *    the text ("any admin can reply to the message and just write
   *    approve"). Checked first since it's unambiguous once a quote is
   *    present.
   * 2. `APPROVE <id>` / `REJECT <id>` — the original explicit form,
   *    unchanged.
   *
   * - No match on either form: returns `false` ("not handled") so the
   *   caller falls through to normal expense parsing (Requirement 3.4).
   * - Bare form, but not a reply, or the quoted message isn't a tracked
   *   Notification_Message: falls through to the explicit-form check
   *   rather than returning early, so e.g. a bare "approve" with no
   *   quote and no match is still just disregarded as ordinary chat text
   *   (`false`).
   * - Explicit form matched but unknown Entry_Id: sends a not-found
   *   notice to the sender and returns `true` ("handled") without
   *   mutating any Pending_Entry (Requirement 3.3).
   * - Match against a known Pending_Entry (either form): dispatches to
   *   `processDecision` — even if the entry is no longer `pending`, since
   *   `processDecision` handles the already-resolved case internally —
   *   and returns `true` (Requirements 3.1, 3.2, 9.2).
   *
   * @param {{text: string, senderJid: string, quotedMessageId?: string|null, responderName?: string}} options
   * @returns {Promise<boolean>} `true` if this message was a decision
   *   (handled here, whether or not the Entry_Id was found), `false`
   *   otherwise.
   */
  async function handleTextMessage({ text, senderJid, quotedMessageId = null, responderName }) {
    const bareMatch = BARE_DECISION_REGEX.exec(text);
    if (bareMatch && quotedMessageId) {
      const quotedEntry = pendingStore.findByNotificationMessageId(quotedMessageId);
      if (quotedEntry) {
        await processDecision({
          sock,
          groupId,
          isGroupAdmin,
          sendMessage,
          pendingStore,
          onResolution,
          auditLogPath,
          pendingEntry: quotedEntry,
          verb: bareMatch[1].toUpperCase(),
          responderJid: senderJid,
          responderName,
        });
        return true;
      }
    }

    const match = DECISION_REGEX.exec(text);
    if (!match) {
      return false; // not handled — fall through to expense parsing (Req 3.4)
    }

    const verb = match[1].toUpperCase();
    const entryId = match[2].toLowerCase(); // case-insensitive matching, Req 9.2

    const pendingEntry = pendingStore.getById(entryId);

    if (!pendingEntry) {
      await sendMessage(senderJid, {
        text: `No pending entry found with id ${entryId}.`,
      });
      return true; // handled — do not fall through to expense parsing
    }

    await processDecision({
      sock,
      groupId,
      isGroupAdmin,
      sendMessage,
      pendingStore,
      onResolution,
      auditLogPath,
      pendingEntry,
      verb,
      responderJid: senderJid,
      responderName,
    });
    return true;
  }

  /**
   * Matches a reaction event against a tracked Notification_Message, per
   * design.md "Reaction Matcher".
   *
   * - Any emoji other than ✅/❌: disregarded, no side effects
   *   (Requirement 4.3).
   * - ✅/❌ whose message id isn't a tracked Notification_Message, or whose
   *   matched Pending_Entry is no longer `pending`: disregarded, no side
   *   effects (Requirement 4.3).
   * - ✅/❌ on a tracked Notification_Message for a still-`pending` entry:
   *   maps to APPROVE/REJECT and dispatches to `processDecision`
   *   (Requirements 4.1, 4.2).
   *
   * @param {{emoji: string, reactorJid: string, reactedMessageId: string, responderName?: string}} options
   * @returns {Promise<void>}
   */
  async function handleReaction({ emoji, reactorJid, reactedMessageId, responderName }) {
    if (emoji !== '✅' && emoji !== '❌') {
      return; // disregarded — Req 4.3
    }

    const pendingEntry = pendingStore.findByNotificationMessageId(reactedMessageId);

    if (!pendingEntry || pendingEntry.status !== 'pending') {
      return; // disregarded — Req 4.3
    }

    const verb = emoji === '✅' ? 'APPROVE' : 'REJECT';

    await processDecision({
      sock,
      groupId,
      isGroupAdmin,
      sendMessage,
      pendingStore,
      onResolution,
      auditLogPath,
      pendingEntry,
      verb,
      responderJid: reactorJid,
      responderName,
    });
  }

  return {
    init,
    submitEntry,
    handleTextMessage,
    handleReaction,
  };
}

module.exports = {
  createApprovalEngine,
};
