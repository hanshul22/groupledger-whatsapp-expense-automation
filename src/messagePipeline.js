// messagePipeline.js
// v1.2 — Durable Job Queue (additive). Extracted, UNCHANGED v1.0/v1.1
// inbound-group-message pipeline.
//
// Why this file exists: Part A2/A4 of the queue design requires the
// `inbound_message` job handler to run "v1.0's parser -> normalizer ->
// approval engine" exactly as today. Rather than have two copies of that
// logic (one inline in index.js's onGroupMessage for QUEUE_ENABLED=false,
// another inside the queue's job handler for QUEUE_ENABLED=true), this
// module holds ONE copy — `handleGroupMessage` below is a byte-for-byte
// lift of what was previously inline in index.js's `onGroupMessage`
// handler, unchanged in every particular (same call order: pushName
// cache -> commandHandler -> approvalEngine.handleTextMessage -> live
// admin log -> parser -> normalizer -> reply/submit). Both the
// QUEUE_ENABLED=false path (called synchronously from onGroupMessage) and
// the QUEUE_ENABLED=true path (called from the inbound_message job
// handler, see index.js's queue wiring) call this same function, so
// there is exactly one place this logic can ever diverge from v1.0
// behavior.
//
// This module has no dependency on the queue itself — it does not know
// whether it was invoked directly or from inside a job handler. That's a
// deliberate boundary: the queue decides WHEN and HOW OFTEN this runs
// (once, eventually, with retries on failure); this module decides WHAT
// happens for one inbound message, identically either way.

const { extractText, extractQuotedMessageId, isGroupAdmin } = require('./waConnector');
const { parseExpenseMessage } = require('./parser');

/**
 * v1.2 — thrown by handleGroupMessage when the queue's normalizer hold
 * policy (see queue/normalizerHold.js) decides an LLM-down condition
 * should HOLD this job rather than proceed. index.js's inbound_message
 * job handler catches this specific error type and reschedules the job
 * WITHOUT counting an attempt (Part B: "reschedule the job without
 * counting an attempt, for up to NORMALIZER_MAX_HOLD_MINUTES"). Never
 * thrown on the QUEUE_ENABLED=false path (no `normalizerHoldPolicy` is
 * ever supplied there), so v1.0/v1.1 behavior is unaffected.
 */
class NormalizerHoldError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NormalizerHoldError';
  }
}

/**
 * Factory for the Message Pipeline, mirroring this codebase's existing
 * `createXxx(deps)` convention (approvalEngine.js, sheetsWriter.js,
 * responder.js, commands.js).
 *
 * @param {object} deps
 * @param {ReturnType<import('./normalizer').createNormalizer>} deps.normalizer
 * @param {{handleCommand: Function}} [deps.commandHandler] - May be
 *   undefined very early in startup, mirroring index.js's existing
 *   `commandHandler?.handleCommand` optional-chaining (constructed inside
 *   onReady, after the pipeline itself in principle could be built).
 * @param {{handleTextMessage: Function, submitEntry: Function}} [deps.approvalEngine] -
 *   Same optional-chaining rationale as commandHandler.
 * @param {ReturnType<import('./pushNameCache').createPushNameCache>} deps.pushNameCache
 * @param {string[]} deps.allowedParties - ALLOWED_PARTIES, per v1.1.
 * @param {(args: {normalizeResult: object, receivedAt: Date, parserProducedUsableEntry: boolean}) => {decision: 'hold'|'passthrough'|'proceed'}} [deps.normalizerHoldPolicy] -
 *   v1.2 (additive, optional). See queue/normalizerHold.js's
 *   `decideNormalizerHold`. When the decision is `'hold'`, this pipeline
 *   throws `NormalizerHoldError` instead of continuing — index.js's
 *   inbound_message job handler catches it and reschedules without
 *   counting an attempt (Part B). When the decision is `'passthrough'`,
 *   the normalizer's own `entry` (already the parsed entry unnormalized,
 *   since normalize() itself already fails open to passthrough) is used
 *   as-is — no different from the default flow. Omitted entirely on the
 *   QUEUE_ENABLED=false path, which preserves this pipeline's exact
 *   pre-v1.2 behavior (Rule 2) — no hold policy is ever consulted there.
 * @param {(submissionKey: string) => Promise<boolean>} [deps.checkAndMarkSubmitted] -
 *   v1.2 (additive, optional). Called with a caller-supplied
 *   `submissionKey` (index.js's queue wiring passes the deterministic
 *   entry hash) immediately before `approvalEngine.submitEntry` would be
 *   called. Must resolve `true` the FIRST time it's called for a given
 *   key (meaning "not yet submitted — go ahead and submit, and this call
 *   just durably recorded that submission"), and `false` on every
 *   subsequent call for the same key ("already submitted — do not call
 *   submitEntry again"). This exists because a retried inbound_message
 *   job (Part A3's at-least-once delivery) would otherwise call
 *   `submitEntry` twice for the same message, and `submitEntry` itself
 *   is not idempotent (it creates a brand-new Pending_Entry with a fresh
 *   random Entry_Id on every call for a non-admin submitter — see
 *   approvalEngine.js's `submitEntry`). Omitted entirely on the
 *   QUEUE_ENABLED=false path (the default), which preserves this
 *   pipeline's exact pre-v1.2 behavior — no retries are possible there
 *   in the first place, since nothing durable sits in front of it.
 * @returns {{handleGroupMessage: (sock: any, msg: any) => Promise<void>}}
 */
function createMessagePipeline(deps) {
  const { pushNameCache, allowedParties, checkAndMarkSubmitted, normalizerHoldPolicy } = deps;

  // These three are read fresh on every call via getters rather than
  // destructured once, because in the real app they're constructed
  // inside onReady (after this pipeline is itself constructed at module
  // load time, see index.js) — by the time handleGroupMessage first
  // runs they're populated, but destructuring eagerly here would freeze
  // them at their (possibly still-undefined) construction-time value.
  function getNormalizer() {
    return deps.normalizer;
  }
  function getCommandHandler() {
    return deps.commandHandler;
  }
  function getApprovalEngine() {
    return deps.approvalEngine;
  }

  /**
   * Handle exactly one inbound group text message, per v1.0/v1.1's
   * existing pipeline (unchanged): command-matching -> decision-matching
   * -> live-admin logging -> parse -> normalize -> reply + submit.
   *
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {object} msg - A Baileys message object, already filtered by
   *   waConnector.js to the configured WHATSAPP_GROUP_ID and to have text
   *   content (Part A3 — "use exactly v1.0's existing gating").
   * @param {object} [options]
   * @param {Date} [options.jobReceivedAt] - v1.2 (additive, optional).
   *   The queue job's actual `received_at` (Part A3's WhatsApp-
   *   timestamp-based value, unchanged across every retry of the same
   *   job) — used ONLY by the normalizer hold policy to measure how
   *   long this job has actually been waiting. Falls back to this
   *   call's own freshly-derived `messageTimestamp` when omitted (the
   *   QUEUE_ENABLED=false path never supplies it, and never consults
   *   `normalizerHoldPolicy` either, so the fallback is never actually
   *   exercised there).
   * @returns {Promise<void>}
   */
  async function handleGroupMessage(sock, msg, options = {}) {
    const text = extractText(msg);
    if (!text) return;

    const groupId = process.env.WHATSAPP_GROUP_ID;
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const quotedMessageId = extractQuotedMessageId(msg);

    // Refresh the pushName cache on every message so a later reaction
    // from this same JID (which carries no name of its own) can still be
    // recorded under a real name — see pushNameCache.js/onReaction below.
    pushNameCache.remember(senderJid, msg.pushName);

    const commandHandler = getCommandHandler();
    const approvalEngine = getApprovalEngine();
    const normalizer = getNormalizer();

    // Phase 6 — /undo and /edit command-matching takes priority over both
    // decision-matching and parse-as-new-expense — Requirement 5.2. If
    // handled, this was an admin command, so stop here.
    const commandHandled = await commandHandler?.handleCommand({ text, senderJid });
    if (commandHandled) return;

    // Decision-matching (APPROVE/REJECT <id>, or a bare APPROVE/REJECT
    // reply quoting the Notification_Message — see approvalEngine.js's
    // handleTextMessage) takes priority over parse-as-new-expense —
    // Requirement 3.4. If handled, this was a decision reply, not a new
    // expense attempt, so stop here.
    const decisionHandled = await approvalEngine?.handleTextMessage({
      text,
      senderJid,
      quotedMessageId,
      responderName: msg.pushName,
    });
    if (decisionHandled) return;

    // Informational only in this phase — not used to make any parsing or
    // approval decision. Approval logic is Phase 4.
    try {
      const admin = await isGroupAdmin(sock, groupId, senderJid);
      console.log(`Message from ${senderJid} | isGroupAdmin: ${admin}`);
    } catch (err) {
      console.error('Failed to check admin status:', err);
    }

    const senderName = msg.pushName || senderJid;

    // Baileys' messageTimestamp is seconds since epoch (number or Long-like).
    const rawTimestamp = msg.messageTimestamp;
    const messageTimestamp = rawTimestamp
      ? new Date(Number(rawTimestamp) * 1000)
      : new Date();

    const parsed = await parseExpenseMessage(text, { senderName, messageTimestamp });

    // v1.1 — LLM normalization layer, inserted between "message parsed"
    // and "approval / sheet write" (doc/trd.md §8.2). A no-op
    // (`passthrough`, no network call) when NORMALIZER_MODE=off — v1.0
    // behavior below is then bit-for-bit unchanged, since `n.entry` is
    // just `parsed.entry` and `n.meta.changed` is always false.
    let n;
    try {
      n = await normalizer.normalize({
        rawText: text,
        parsed: parsed.ok ? parsed.entry : null,
        messageTimestamp,
        allowedParties,
      });
    } catch (err) {
      // normalizer.normalize() never throws (FR11), but guard anyway so a
      // truly unexpected error still falls back to v1.0 behavior.
      console.error('Normalizer threw unexpectedly — falling back to v1.0 behavior:', err);
      n = { status: 'passthrough', entry: parsed.ok ? parsed.entry : null, meta: { changed: false } };
    }

    // v1.2 — Part B's queue hold policy, consulted only when a policy
    // function was supplied (QUEUE_ENABLED=true). On QUEUE_ENABLED=false
    // this block is skipped entirely (Rule 2).
    //
    // IMPORTANT: the hold window must be measured from the job's actual
    // `received_at` (set once, at enqueue time, from the WhatsApp
    // message's own timestamp — Part A3) — NOT from `messageTimestamp`
    // as recomputed here on every call. Re-deriving "now" from
    // `msg.messageTimestamp` on every retry would make "how long has
    // this been waiting" always read as ~0 (since the message's own
    // timestamp never changes, but re-parsing it fresh each time loses
    // the notion of elapsed real time — see this file's own test suite
    // for the regression this guards against). The queue's job handler
    // (index.js) is the only caller that actually has the job record, so
    // it passes the job's `received_at` through explicitly here.
    if (normalizerHoldPolicy) {
      const { decision } = normalizerHoldPolicy({
        normalizeResult: n,
        receivedAt: options.jobReceivedAt || messageTimestamp,
        parserProducedUsableEntry: Boolean(parsed.ok && parsed.entry),
      });
      if (decision === 'hold') {
        // Never send a "please rephrase" clarification just because the
        // system was down (Part B's explicit requirement) — throw so the
        // caller (index.js's inbound_message handler) reschedules this
        // job without counting an attempt, without sending ANY reply.
        throw new NormalizerHoldError('Normalizer LLM call failed — holding job for retry per NORMALIZER_ON_LLM_DOWN=hold.');
      }
      // decision === 'passthrough' or 'proceed': continue below exactly
      // as today — `n` already holds the right entry/status either way
      // (normalize() itself already computed the passthrough entry).
    }

    try {
      if (n.status === 'needs_clarification') {
        // FR12 — a message that fails a deterministic guard never reaches
        // approval or the sheet; ask the sender to rephrase instead.
        await sock.sendMessage(groupId, { text: `I need a bit more clarity: ${n.reason}` });
      } else if (n.entry) {
        const { entry } = n;
        const partySuffix = entry.party ? `, party: ${entry.party}` : '';
        const paidBySuffix = entry.paid_by ? `, paid by ${entry.paid_by}` : '';
        await sock.sendMessage(groupId, {
          text: `Got it — ₹${entry.amount} to ${entry.given_to}${paidBySuffix}, on ${entry.date}${partySuffix}.`,
        });

        try {
          // v1.2 — guard against a retried job re-submitting the same
          // message a second time (see checkAndMarkSubmitted's doc
          // comment above). `checkAndMarkSubmitted` is undefined on the
          // QUEUE_ENABLED=false path, so `shouldSubmit` is always `true`
          // there — bit-for-bit unchanged v1.0/v1.1 behavior (Rule 2).
          const shouldSubmit = checkAndMarkSubmitted ? await checkAndMarkSubmitted(msg.key.id) : true;
          if (shouldSubmit) {
            await approvalEngine?.submitEntry(entry, {
              submittedBy: senderName,
              submittedByJid: senderJid,
              submittedAt: messageTimestamp,
              normalizerMeta: n.meta || null,
            });
          } else {
            console.log('Message pipeline: submission already recorded for this message — skipping re-submit on retry.');
          }
        } catch (err) {
          console.error('Failed to submit entry to Approval Engine:', err);
        }
      } else {
        console.log(`Parse failed for message "${text}": ${parsed.ok ? 'normalizer found no entry' : parsed.reason}`);
        await sock.sendMessage(groupId, {
          text: "I couldn't quite catch that — could you rephrase, e.g. 'given 5000 to Sita on 22 Aug'?",
        });
      }
    } catch (err) {
      console.error('Failed to send reply message:', err);
    }
  }

  return {
    handleGroupMessage,
  };
}

module.exports = {
  createMessagePipeline,
  NormalizerHoldError,
};
