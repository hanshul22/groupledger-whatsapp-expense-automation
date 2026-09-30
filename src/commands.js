// commands.js
// Phase 6 — Command Handler. See
// .kiro/specs/responder-commands/design.md "Command Handler
// (`commands.js`)" for the full design context.
//
// Responsibilities (per design.md and Requirement 6.2):
//   - Parse `/undo` and `/edit <row> <field> <value>` admin commands out
//     of inbound group text messages.
//   - Re-verify, live, that the sender is a current Admin before applying
//     any change (Requirements 3.3, 4.5) — the same live, uncached lookup
//     pattern used everywhere else in this system.
//   - Validate `/edit`'s field/row/amount before ever calling into Sheets
//     (Requirements 4.2, 4.3, 4.4).
//   - Perform all actual Sheets row removal/update operations through the
//     injected `sheetsWriter` (`getLastWrittenEntry`/`undoLastEntry`/
//     `editEntryField`) — never construct or call a Sheets API client
//     directly (Requirement 6.2).
//   - Disregard, for command-matching purposes, any text that doesn't
//     match `/undo` or `/edit <row> <field> <value>`, returning `false` so
//     the caller (`index.js`) falls through to decision-matching and
//     expense parsing unchanged (Requirement 5.1).

// Command-matching patterns, per design.md "Command Handler" — defined
// once at module scope rather than inline per call, mirroring
// approvalEngine.js's DECISION_REGEX convention.
const UNDO_REGEX = /^\s*\/undo\s*$/i;
const EDIT_REGEX = /^\s*\/edit\s+(\d+)\s+(\S+)\s+([\s\S]+?)\s*$/i;

// v1.2 — Durable Job Queue admin commands (Part A7). Additive: only ever
// matched when the caller supplies a `jobQueue` dependency (i.e.
// QUEUE_ENABLED=true); with no `jobQueue`, these regexes simply never
// get a chance to run (see `handleCommand`'s guard below), so v1.0/v1.1
// behavior is unchanged when the queue is off (Rule 2).
const QUEUE_STATUS_REGEX = /^\s*\/queue\s*$/i;
const QUEUE_RETRY_REGEX = /^\s*\/queue\s+retry\s*$/i;

// The subset of Entries-tab columns `/edit` is permitted to change, per
// requirements.md's Editable_Field glossary entry — deliberately excludes
// system/audit-trail columns (entry_id, submitted_by, status,
// approved_by, approved_at, raw_message).
const EDITABLE_FIELDS = ['date', 'description', 'amount', 'given_to', 'party'];

/**
 * Build the not-authorized notice text sent to a sender whose live admin
 * check failed for a `/undo` or `/edit` attempt.
 *
 * @param {string} command - `'/undo'` or `'/edit'`, for message clarity.
 * @returns {string}
 */
function notAuthorizedNotice(command) {
  return `You are not authorized to use ${command}. Only current group Admins can use this command.`;
}

/**
 * Check whether a raw `/edit` amount value string parses as a valid
 * positive, finite number, per Requirement 4.4. Mirrors `schema.js`'s
 * `amount: z.number().positive()` check, applied here to a raw string
 * (the value hasn't been through schema validation, since it arrives as
 * free text from a WhatsApp command, not a parsed expense entry).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0;
}

/**
 * Factory for the Command Handler, per design.md "Module boundaries" —
 * mirrors the `createApprovalEngine(deps)`/`createSheetsWriter(deps)`/
 * `createResponder(deps)` pattern already established in this codebase.
 *
 * @param {object} deps
 * @param {import('@whiskeysockets/baileys').WASocket} deps.sock - Baileys
 *   socket, passed through to the live admin lookup.
 * @param {string} deps.groupId - The configured WHATSAPP_GROUP_ID.
 * @param {(sock: any, groupId: string, participantJid: string) => Promise<boolean>} deps.isGroupAdmin -
 *   Live admin lookup, from waConnector.js.
 * @param {(jid: string, content: any) => Promise<void>} deps.sendMessage -
 *   Thin wrapper over sock.sendMessage.
 * @param {{
 *   getLastWrittenEntry: () => {rowNumber: number, resolution: object} | null,
 *   undoLastEntry: () => Promise<{ok: true, resolution: object} | {ok: false, error: Error}>,
 *   editEntryField: (rowNumber: number, field: string, value: string) => Promise<{ok: true} | {ok: false, error: Error}>,
 * }} deps.sheetsWriter - The Sheets Writer instance (Phase 5/6), used only
 *   through this narrow interface — never a raw Sheets API client
 *   (Requirement 6.2).
 * @returns {{handleCommand: (message: {text: string, senderJid: string}) => Promise<boolean>}}
 */
function createCommandHandler(deps) {
  const { sock, groupId, isGroupAdmin, sendMessage, sheetsWriter, jobQueue } = deps;

  /**
   * Handle a candidate `/undo` command, per design.md's `handleUndo`
   * pseudocode.
   *
   * @param {string} senderJid
   * @returns {Promise<true>} Always `true` — this message was handled as
   *   a command, whatever the outcome.
   */
  async function handleUndo(senderJid) {
    const isAdmin = await isGroupAdmin(sock, groupId, senderJid); // live, Req 3.3
    if (!isAdmin) {
      await sendMessage(senderJid, { text: notAuthorizedNotice('/undo') });
      return true;
    }

    const tracked = sheetsWriter.getLastWrittenEntry();
    if (!tracked) {
      await sendMessage(groupId, { text: 'Nothing to undo.' }); // Req 3.2
      return true;
    }

    const result = await sheetsWriter.undoLastEntry();
    if (!result.ok) {
      await sendMessage(groupId, {
        text: 'Undo failed — could not remove the last entry from the sheet.',
      }); // Req 3.5
      return true;
    }

    const entry = result.resolution.entry || {};
    await sendMessage(groupId, {
      text: `Removed entry: ₹${entry.amount} to ${entry.given_to} (${entry.date}).`,
    });
    return true;
  }

  /**
   * Handle a candidate `/edit <row> <field> <value>` command, per
   * design.md's `handleEdit` pseudocode.
   *
   * @param {string} senderJid
   * @param {string} rowStr
   * @param {string} fieldRaw
   * @param {string} value
   * @returns {Promise<true>} Always `true` — this message was handled as
   *   a command, whatever the outcome.
   */
  async function handleEdit(senderJid, rowStr, fieldRaw, value) {
    const isAdmin = await isGroupAdmin(sock, groupId, senderJid); // live, Req 4.5
    if (!isAdmin) {
      await sendMessage(senderJid, { text: notAuthorizedNotice('/edit') });
      return true;
    }

    const field = fieldRaw.toLowerCase();
    if (!EDITABLE_FIELDS.includes(field)) {
      await sendMessage(senderJid, {
        text: `"${fieldRaw}" is not an editable field. Valid fields: ${EDITABLE_FIELDS.join(', ')}.`,
      }); // Req 4.2
      return true;
    }

    const rowNumber = parseInt(rowStr, 10);
    if (!(rowNumber > 1)) {
      await sendMessage(senderJid, {
        text: 'Row number must be a positive integer greater than 1 (row 1 is the header).',
      }); // Req 4.3
      return true;
    }

    const trimmedValue = value.trim();

    if (field === 'amount' && !isValidPositiveNumber(trimmedValue)) {
      await sendMessage(senderJid, { text: 'Amount must be a valid positive number.' }); // Req 4.4
      return true;
    }

    const result = await sheetsWriter.editEntryField(rowNumber, field, trimmedValue);
    if (!result.ok) {
      await sendMessage(groupId, { text: `Edit failed — could not update row ${rowNumber}.` }); // Req 4.6
      return true;
    }

    await sendMessage(groupId, { text: `Updated row ${rowNumber}: ${field} = ${trimmedValue}.` });
    return true;
  }

  /**
   * v1.2 — Handle `/queue`: admin-only counts by state, oldest job age,
   * and dead count (Part A7). Never includes message text/payload
   * contents — only the summary `jobQueue.getCounts()` already returns
   * (see redisStore.js's `getCounts` doc comment for why that's safe by
   * construction: it never reads a raw job record's payload).
   *
   * @param {string} senderJid
   * @returns {Promise<true>}
   */
  async function handleQueueStatus(senderJid) {
    const isAdmin = await isGroupAdmin(sock, groupId, senderJid);
    if (!isAdmin) {
      await sendMessage(senderJid, { text: notAuthorizedNotice('/queue') });
      return true;
    }

    const counts = await jobQueue.getCounts();
    const formatAge = (ms) => (ms === null || ms === undefined ? 'n/a' : `${Math.round(ms / 60000)}m`);

    const lines = [
      'Queue status:',
      `queued: ${counts.queued}`,
      `inflight: ${counts.inflight}`,
      `dead: ${counts.dead}`,
      `oldest ready job age: ${formatAge(counts.oldestReadyAgeMs)}`,
      `oldest inflight job age: ${formatAge(counts.oldestInflightAgeMs)}`,
    ];
    await sendMessage(senderJid, { text: lines.join('\n') });
    return true;
  }

  /**
   * v1.2 — Handle `/queue retry`: admin-only, requeues every dead job
   * (Part A7). Never deletes anything — a requeued job's attempts reset
   * to 0 and it becomes immediately ready again (see redisStore.js's
   * `requeueDead`).
   *
   * @param {string} senderJid
   * @returns {Promise<true>}
   */
  async function handleQueueRetry(senderJid) {
    const isAdmin = await isGroupAdmin(sock, groupId, senderJid);
    if (!isAdmin) {
      await sendMessage(senderJid, { text: notAuthorizedNotice('/queue retry') });
      return true;
    }

    const count = await jobQueue.retryDead();
    await sendMessage(senderJid, { text: `Requeued ${count} dead job(s).` });
    return true;
  }

  /**
   * Match and dispatch a group text message against `/undo`,
   * `/edit <row> <field> <value>`, `/queue`, and `/queue retry`, per
   * design.md's `handleCommand` pseudocode (extended additively for
   * v1.2's queue commands, Part A7).
   *
   * - No match: returns `false` ("not handled") so the caller falls
   *   through to decision-matching and expense parsing unchanged
   *   (Requirement 5.1).
   * - Match: dispatches to the relevant handler, which always returns
   *   `true`.
   * - `/queue`/`/queue retry` only ever match when this instance was
   *   constructed with a `jobQueue` dependency (i.e. QUEUE_ENABLED=true)
   *   — with no `jobQueue`, these two regexes are still tested, but any
   *   match on them is skipped so the message falls through unhandled,
   *   preserving v1.0/v1.1 behavior exactly when the queue is off
   *   (Rule 2). This mirrors a plain "/queue" message with the queue off
   *   today being ordinary (unparseable) chat text, not a recognized
   *   command.
   *
   * @param {{text: string, senderJid: string}} message
   * @returns {Promise<boolean>}
   */
  async function handleCommand({ text, senderJid }) {
    if (UNDO_REGEX.test(text)) {
      return handleUndo(senderJid);
    }

    const editMatch = EDIT_REGEX.exec(text);
    if (editMatch) {
      return handleEdit(senderJid, editMatch[1], editMatch[2], editMatch[3]);
    }

    if (jobQueue) {
      if (QUEUE_RETRY_REGEX.test(text)) {
        return handleQueueRetry(senderJid);
      }
      if (QUEUE_STATUS_REGEX.test(text)) {
        return handleQueueStatus(senderJid);
      }
    }

    return false; // not a command — fall through, Req 5.1
  }

  return {
    handleCommand,
  };
}

module.exports = {
  createCommandHandler,
  isValidPositiveNumber,
  notAuthorizedNotice,
  EDITABLE_FIELDS,
  UNDO_REGEX,
  EDIT_REGEX,
  QUEUE_STATUS_REGEX,
  QUEUE_RETRY_REGEX,
};
