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

// Word/phrase synonyms accepted in place of the literal APPROVE/REJECT
// verbs, so an admin can respond however feels natural ("admin should be
// able to approve a bill without typing the exact word APPROVE") rather
// than needing to remember one exact keyword. Every entry here is
// normalized (trimmed, collapsed whitespace, lowercased) before matching
// — see `buildSynonymAlternation` — so phrases with internal spaces
// ("theek hai") work the same as single words. Kept as a plain array
// (not a Set) since each one also needs regex-escaping and
// alternation-joining in a fixed, readable order.
//
// Deliberately includes common Hindi/Hinglish phrasing alongside English,
// since the group this bot runs in mixes both.
const APPROVE_SYNONYMS = [
  'approve',
  'approved',
  'yes',
  'yep',
  'yeah',
  'ok',
  'okay',
  'k',
  'done',
  'confirm',
  'confirmed',
  'correct',
  'right',
  'good',
  'fine',
  'haan',
  'ha',
  'theek hai',
  'thik hai',
  'sahi hai',
  'sahi',
];

const REJECT_SYNONYMS = [
  'reject',
  'rejected',
  'no',
  'nope',
  'nah',
  'cancel',
  'cancelled',
  'canceled',
  'wrong',
  'incorrect',
  'invalid',
  'nahi',
  'nahin',
  'galat',
  'galat hai',
];

/**
 * Escape a string for literal use inside a RegExp, then collapse any
 * internal whitespace into a `\s+` match so a multi-word synonym (e.g.
 * "theek hai") still matches regardless of exactly how many spaces the
 * sender typed between words.
 *
 * @param {string} phrase
 * @returns {string}
 */
function synonymToPattern(phrase) {
  return phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
}

/**
 * Build a single non-capturing alternation group matching any synonym in
 * `synonyms`, longest-first so a longer multi-word phrase (e.g. "theek
 * hai") is never shadowed by a shorter prefix alternative appearing
 * earlier in the list.
 *
 * @param {string[]} synonyms
 * @returns {string} A `(?:...)` regex fragment (no anchors, no flags).
 */
function buildSynonymAlternation(synonyms) {
  const sorted = [...synonyms].sort((a, b) => b.length - a.length);
  return `(?:${sorted.map(synonymToPattern).join('|')})`;
}

const APPROVE_PATTERN = buildSynonymAlternation(APPROVE_SYNONYMS);
const REJECT_PATTERN = buildSynonymAlternation(REJECT_SYNONYMS);

// Decision-matching pattern for inbound group text messages, per
// design.md "Entry_Id Generator and Matcher — Matching" (Requirements 3.1,
// 3.2, 3.4, 9.2), extended to accept any APPROVE_SYNONYMS/REJECT_SYNONYMS
// word/phrase in place of the literal verb. Defined once at module scope
// rather than inline per call. Capture group 1 holds whichever synonym
// actually matched — callers normalize it to 'APPROVE'/'REJECT' via
// `classifyVerb` rather than branching on the raw matched text.
const DECISION_REGEX = new RegExp(`^\\s*(${APPROVE_PATTERN}|${REJECT_PATTERN})\\s+([A-Za-z0-9]{4,6})\\s*$`, 'i');

// Bare decision pattern (no Entry_Id) for a group reply that quotes the
// Notification_Message directly — the quoted message identifies the
// entry, so the verb alone is enough (Requirement: "admin can reply to
// the message and just write approve", extended to any accepted
// synonym). No word-boundary risk here since the entire trimmed string
// must match, not a substring.
const BARE_DECISION_REGEX = new RegExp(`^\\s*(${APPROVE_PATTERN}|${REJECT_PATTERN})\\s*$`, 'i');

/**
 * Classify a matched verb/synonym string as the canonical 'APPROVE' or
 * 'REJECT' decision, by testing it against the same synonym lists used
 * to build the regexes above.
 *
 * @param {string} matchedVerb - The raw text captured by DECISION_REGEX/
 *   BARE_DECISION_REGEX's first capture group (any casing/whitespace).
 * @returns {'APPROVE'|'REJECT'}
 */
function classifyVerb(matchedVerb) {
  const normalized = matchedVerb.trim().toLowerCase().replace(/\s+/g, ' ');
  const isApprove = APPROVE_SYNONYMS.some((syn) => syn.replace(/\s+/g, ' ') === normalized);
  return isApprove ? 'APPROVE' : 'REJECT';
}

// Reaction emoji accepted in place of the original ✅/❌, per the same
// "don't require one exact symbol" extension as the text synonyms above.
// 👍/👌/🙆 read as approval; 👎/🙅 read as rejection, alongside the
// original ✅/❌.
const APPROVE_EMOJI = new Set(['✅', '👍', '👌', '🙆']);
const REJECT_EMOJI = new Set(['❌', '👎', '🙅']);

/**
 * Classify a reaction emoji as an APPROVE/REJECT decision, or `null` if
 * it's not one of the recognized emoji at all (Requirement 4.3 —
 * disregard any other reaction).
 *
 * @param {string} emoji
 * @returns {'APPROVE'|'REJECT'|null}
 */
function classifyReactionEmoji(emoji) {
  if (APPROVE_EMOJI.has(emoji)) return 'APPROVE';
  if (REJECT_EMOJI.has(emoji)) return 'REJECT';
  return null;
}

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
    // TEMP DIAGNOSTIC — see index.js's GET /debug-logs route. Defaults to
    // a no-op so every existing caller/test is unaffected. Remove this
    // param and its three call sites in handleReaction once the
    // "reaction isn't resolving" issue is confirmed fixed.
    onDebugLog = () => {},
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

    await notifyAdmins({ sock, groupId, sendMessage, pendingStore, pendingEntry, onDebugLog });
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
          verb: classifyVerb(bareMatch[1]),
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

    const verb = classifyVerb(match[1]);
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
  async function handleReaction({ emoji, reactorJid, reactedMessageId, responderName, debugListPendingNotificationIds }) {
    const verb = classifyReactionEmoji(emoji);
    if (!verb) {
      // TEMP DIAGNOSTIC — see index.js's GET /debug-logs route.
      onDebugLog('handleReaction: emoji not recognized', { emoji });
      return; // disregarded — Req 4.3
    }

    let pendingEntry = pendingStore.findByNotificationMessageId(reactedMessageId);

    if (!pendingEntry && debugListPendingNotificationIds) {
      // TEMP DIAGNOSTIC (deeper) — dump every currently-pending entry's
      // tracked notification message id(s) side-by-side with the id the
      // reaction actually reported, so a near-miss (off-by-a-character,
      // wrong case, etc.) is visible directly rather than inferred.
      const allPendingIds = pendingStore.getAllIds();
      const dump = allPendingIds
        .map((id) => pendingStore.getById(id))
        .filter((e) => e && e.status === 'pending')
        .map((e) => ({ entryId: e.entryId, notificationMessageIds: e.notificationMessageIds, submittedAt: e.submittedAt }));
      onDebugLog('handleReaction: exact match failed — dumping all tracked notification ids for comparison', {
        reactedMessageId,
        trackedEntries: dump,
      });
    }

    if (!pendingEntry) {
      // ponytail: WhatsApp/Baileys has a known quirk (WhiskeySockets/
      // Baileys#656 and others) where a group reaction event's
      // key.id does not always match the id of the message that was
      // actually reacted to, specifically for participants on a @lid
      // (linked/companion device) identity. This is a protocol/library-
      // level inconsistency, not something fixable by changing how we
      // store/look up notification message ids. Fallback: if the exact
      // id isn't tracked but there is EXACTLY ONE still-pending entry
      // right now, treat the reaction as being for that entry — safe
      // specifically because it's unambiguous (only one candidate it
      // could possibly mean); falls back to disregarding the reaction
      // (as before) whenever 0 or 2+ entries are pending, rather than
      // ever guessing among multiple candidates. Ceiling: this breaks
      // down if there are ever 2+ simultaneous pending approvals and the
      // id mismatch bug fires — upgrade path is matching Baileys'
      // getLIDForPN-based resolution (see the upstream fix referenced in
      // the investigation) once a library version ships it, or asking
      // admins to reply with text (APPROVE/REJECT <id>) instead of
      // reacting when more than one entry is pending at once.
      const pendingIds = pendingStore.getAllIds().filter((id) => pendingStore.getById(id)?.status === 'pending');
      if (pendingIds.length === 1) {
        pendingEntry = pendingStore.getById(pendingIds[0]);
        onDebugLog('handleReaction: reactedMessageId not tracked, falling back to the single pending entry', {
          reactedMessageId,
          entryId: pendingEntry.entryId,
        });
      } else {
        // TEMP DIAGNOSTIC — see index.js's GET /debug-logs route.
        onDebugLog('handleReaction: no pending entry found for reactedMessageId', {
          reactedMessageId,
          pendingCount: pendingIds.length,
        });
        return; // disregarded — Req 4.3
      }
    }
    if (pendingEntry.status !== 'pending') {
      // TEMP DIAGNOSTIC — see index.js's GET /debug-logs route.
      onDebugLog('handleReaction: entry found but not pending', { status: pendingEntry.status, entryId: pendingEntry.entryId });
      return; // disregarded — Req 4.3
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
  APPROVE_SYNONYMS,
  REJECT_SYNONYMS,
  APPROVE_EMOJI,
  REJECT_EMOJI,
  classifyVerb,
  classifyReactionEmoji,
};
