// sheetsWriter.js
// Phase 5 — Sheets Writer. See .kiro/specs/sheets-writer/design.md for the
// full design context (Architecture, Components and Interfaces, Data
// Models, Error Handling).
//
// Responsibilities (per design.md "Module boundary" and Overview):
//   - Authenticate to the Google Sheets API v4 as a Service Account.
//   - Accept a Resolution object (exactly the shape the Approval Engine's
//     Resolution_Callback already delivers) and map it to a spreadsheet
//     row.
//   - Append that row to the Entries tab (auto_approved/approved) or the
//     Rejected tab (rejected), retrying once on failure, logging and
//     surfacing any failure that survives the retry.
//   - Never perform an update/delete/full-range overwrite — append-only,
//     addressed by tab name, in this phase.
//
// This module has no dependency on, and is never depended on by, the
// Approval Engine or WA_Connector — the only contact point is the
// Resolution_Callback function signature (`writeResolution`).

const { google } = require('googleapis');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// 11-column layout, per trd.md §3 and design.md "Data Models — Entries/
// Rejected row". Exported for documentation/test purposes; not otherwise
// consumed programmatically (mapToRow returns a plain array in this order).
const COLUMNS = [
  'entry_id',
  'date',
  'description',
  'amount',
  'given_to',
  'submitted_by',
  'party',
  'status',
  'approved_by',
  'approved_at',
  'raw_message',
  // v1.1 — append-only columns L-N, per doc/trd.md §8.6. Existing columns
  // A-K keep their position/meaning, so existing SUMIF/QUERY ranges over
  // A:K are unaffected. Blank when the normalizer layer was off or fell
  // back for a given entry (mapToRow always sends 14 values either way).
  'normalized_by',
  'llm_confidence',
  'normalization_notes',
];

const SHEET_ROW_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SHEET_ROW_ID_LENGTH = 5;
const SHEET_ROW_ID_PREFIX = 'auto-';

// Fixed field-name -> column-letter map for `/edit`, per COLUMNS' index
// order above (entry_id=A, date=B, description=C, amount=D, given_to=E,
// submitted_by=F, party=G, status=H, approved_by=I, approved_at=J,
// raw_message=K). Deliberately excludes system/audit-trail columns
// (entry_id, submitted_by, status, approved_by, approved_at, raw_message)
// per .kiro/specs/responder-commands/requirements.md's Editable_Field
// definition — Phase 6 (`commands.js`) is the caller that enforces this
// restriction, but the map itself only ever knows about editable fields.
const FIELD_COLUMNS = {
  date: 'B',
  description: 'C',
  amount: 'D',
  given_to: 'E',
  party: 'G',
};

/**
 * Generate a display/audit-convenience row id for Resolutions that carry
 * no `entryId` (i.e. `auto_approved`, per design.md Requirement 2.4).
 *
 * Deliberately independent of the Approval Engine's `generateUniqueEntryId`
 * (entryId.js) — it needs no `existingIds` uniqueness coordination, since
 * this id is not a lookup key any other module resolves against. The
 * `auto-` prefix keeps it visibly distinct in format from a genuine
 * Approval Engine Entry_Id (5-char lowercase alphanumeric, no prefix), per
 * design.md's Row mapper and Property 3.
 *
 * @returns {string} e.g. "auto-x7k2q"
 */
function generateSheetRowId() {
  let suffix = '';
  for (let i = 0; i < SHEET_ROW_ID_LENGTH; i += 1) {
    const index = Math.floor(Math.random() * SHEET_ROW_ID_ALPHABET.length);
    suffix += SHEET_ROW_ID_ALPHABET[index];
  }
  return `${SHEET_ROW_ID_PREFIX}${suffix}`;
}

/**
 * Map a Resolution (per approval-engine/design.md "Data Models —
 * Resolution") to the flat 11-value row array described in this design's
 * Data Models section.
 *
 * - `entry_id`: `resolution.entryId` if present, otherwise a freshly
 *   generated `generateSheetRowId()` (Requirement 2.4 — auto_approved
 *   Resolutions carry no entryId).
 * - `description`: `entry.notes` if present, else `''` (never null/
 *   undefined — Error Handling table).
 * - `party`: `entry.party` if present, else `''`.
 * - actor-by/actor-at columns: `rejected_by`/`rejected_at` when
 *   `resolution.status === 'rejected'`, otherwise `approved_by`/
 *   `approved_at` (Requirement 3.2 — shared column positions).
 *
 * @param {object} resolution
 * @returns {(string|number)[]} An 11-element row array in COLUMNS order.
 */
function mapToRow(resolution) {
  const entry = resolution.entry || {};
  const isRejected = resolution.status === 'rejected';

  const entryId = resolution.entryId || generateSheetRowId();
  const description = entry.notes || '';
  const party = entry.party || '';
  const actorBy = isRejected ? resolution.rejected_by : resolution.approved_by;
  const actorAt = formatSheetTimestamp(isRejected ? resolution.rejected_at : resolution.approved_at);

  // v1.1 — columns L-N, per doc/trd.md §8.6. Blank (empty string) when the
  // normalizer was off/unavailable for this entry, never null/undefined.
  const normalizerMeta = resolution.normalizerMeta;
  const normalizedBy = (normalizerMeta && normalizerMeta.model) || '';
  const llmConfidence = normalizerMeta && typeof normalizerMeta.confidence === 'number'
    ? normalizerMeta.confidence
    : '';
  const normalizationNotes = (normalizerMeta && normalizerMeta.notes) || '';

  return [
    entryId,
    entry.date,
    description,
    entry.amount,
    entry.given_to,
    resolution.submittedBy,
    party,
    resolution.status,
    actorBy,
    actorAt,
    entry.raw_message,
    normalizedBy,
    llmConfidence,
    normalizationNotes,
  ];
}

/**
 * Normalize a Service Account private key read from an environment
 * variable: `.env` files store the PEM's newlines as the two literal
 * characters `\` `n`, which must become real newline bytes before the JWT
 * client can parse the key.
 *
 * @param {string} rawKey
 * @returns {string}
 */
function normalizePrivateKey(rawKey) {
  return rawKey.replace(/\\n/g, '\n');
}

// Timezone the `approved_at`/`rejected_at` sheet column is rendered in.
// Defaults to India Standard Time — this project's currency (₹) and every
// sample phone number/date in its docs are India-context — but can be
// overridden via SHEET_TIMEZONE without touching code.
const SHEET_TIMEZONE = process.env.SHEET_TIMEZONE || 'Asia/Kolkata';

/**
 * Render an ISO 8601 UTC timestamp (as produced by
 * `new Date().toISOString()` throughout this codebase — see
 * decisionProcessor.js/approvalEngine.js) as a human-readable string in
 * `SHEET_TIMEZONE`, for the sheet's `approved_at`/`rejected_at` column
 * only. Every other consumer of a Resolution's timestamp (the audit log,
 * `already_resolved` notices, etc.) keeps using the raw ISO string
 * unchanged — this formatting is applied at the very last step, only for
 * what actually gets written into the spreadsheet cell.
 *
 * @param {string|undefined|null} isoTimestamp
 * @returns {string} e.g. `'28 Sep 2026, 12:58 pm'`, or `''` if
 *   `isoTimestamp` is missing/unparseable (never throws).
 */
function formatSheetTimestamp(isoTimestamp) {
  if (!isoTimestamp) return '';

  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp; // unparseable — pass through rather than lose data

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: SHEET_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Build an authenticated Google Sheets API v4 client from Service Account
 * credentials, per design.md "Sheet_Client construction (auth)".
 *
 * Validates both credential values are present before attempting to
 * construct anything (Requirement 1.2) — throws a plain `Error` naming the
 * specific missing variable, never a generic message, so a misconfigured
 * `.env` fails loudly and specifically at startup.
 *
 * @param {{serviceAccountEmail: string, serviceAccountKey: string}} options
 * @returns {import('googleapis').sheets_v4.Sheets}
 */
function buildSheetsClient({ serviceAccountEmail, serviceAccountKey }) {
  if (!serviceAccountEmail) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is required to initialize the Sheets Writer.');
  }
  if (!serviceAccountKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is required to initialize the Sheets Writer.');
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: normalizePrivateKey(serviceAccountKey),
    scopes: [SHEETS_SCOPE],
  });

  return google.sheets({ version: 'v4', auth });
}

/**
 * v1.2 — Durable Job Queue (additive). Check whether a row whose column
 * A (`entry_id`) equals `entryId` already exists in `tabName`, per Part
 * A4's sheet_write dedupe rule: "Before appending, read column A and
 * skip the append if that entry_id already exists. This prevents
 * duplicate rows if the process dies between 'append succeeded' and
 * 'job acked'."
 *
 * A plain `values.get` over the whole column A range — cheap (one Google
 * Sheets API call) and simple; no caching, since this is only ever
 * called from the queue's sheet_write handler (Part A4), not on the
 * v1.0/v1.1 hot path (Rule 2 — flags-off behavior must stay identical,
 * and this function is never called when QUEUE_ENABLED=false).
 *
 * @param {import('googleapis').sheets_v4.Sheets} sheetsClient
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @param {string} entryId
 * @returns {Promise<boolean>} Whether a row with this `entry_id` already
 *   exists in column A of `tabName`.
 */
async function entryIdExistsInColumnA(sheetsClient, spreadsheetId, tabName, entryId) {
  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:A`,
  });
  const values = (response && response.data && response.data.values) || [];
  return values.some((row) => row[0] === entryId);
}

/**
 * Append a single row to a named tab, retrying exactly once on failure,
 * per design.md "Append-with-one-retry".
 *
 * Uses the Sheets API's `append` operation (never `update`/`clear`/
 * `batchUpdate`), which always targets the next free row of the existing
 * table — this structurally satisfies Requirements 2.5/6.1/6.2 (append-
 * only, never overwrites an existing row, addressed by tab name rather
 * than a hardcoded row range).
 *
 * `valueInputOption: 'USER_ENTERED'` (not `RAW`) so a date string like
 * `2026-08-20` is interpreted as an actual Sheets date and the numeric
 * `amount` cell is interpreted as a real number — needed for the
 * manually-configured Summary tab's SUMIF/QUERY formulas (Phase 5 exit
 * criteria) to work correctly.
 *
 * On success, the result also carries `updatedRange` (the raw string from
 * the Google API response, e.g. `"Entries!A5:K5"`) when the (possibly
 * fake, in tests) client's response provides one — Phase 6's
 * Last_Written_Entry tracking (`.kiro/specs/responder-commands/design.md`)
 * reads this to recover the row number a write landed on. This is purely
 * additive: existing callers that only inspect `result.ok`/`result.error`
 * are unaffected.
 *
 * @param {import('googleapis').sheets_v4.Sheets} sheetsClient
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @param {(string|number)[]} row
 * @returns {Promise<{ok: true, updatedRange?: string} | {ok: false, error: Error}>}
 */
async function appendRow(sheetsClient, spreadsheetId, tabName, row) {
  const request = {
    spreadsheetId,
    range: `${tabName}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  };

  try {
    const response = await sheetsClient.spreadsheets.values.append(request);
    return { ok: true, updatedRange: response && response.data && response.data.updates && response.data.updates.updatedRange };
  } catch (err) {
    try {
      const response = await sheetsClient.spreadsheets.values.append(request); // single retry, Req 4.1
      return { ok: true, updatedRange: response && response.data && response.data.updates && response.data.updates.updatedRange };
    } catch (err2) {
      return { ok: false, error: err2 }; // Req 4.2
    }
  }
}

/**
 * Parse a Google Sheets `updatedRange` string (e.g. `"Entries!A5:K5"` or
 * `"'My Sheet'!B12:K12"`) into its 1-indexed starting row number.
 *
 * Returns `null` if `updatedRange` is absent or doesn't match the expected
 * shape — callers treat that as "row number unknown, skip tracking" rather
 * than an error, per design.md's Last_Written_Entry tracking section
 * ("safe by construction": `/undo` then reports nothing-to-undo instead of
 * guessing).
 *
 * @param {string | undefined | null} updatedRange
 * @returns {number | null}
 */
function extractRowNumber(updatedRange) {
  if (!updatedRange || typeof updatedRange !== 'string') return null;
  const match = /![A-Z]+(\d+)/.exec(updatedRange);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Look up a tab's internal grid `sheetId` (distinct from the spreadsheet's
 * own `spreadsheetId`) by its visible tab name, per design.md
 * "undoLastEntry()".
 *
 * Looked up fresh on every call rather than cached — `/undo`/`/edit` are
 * rare, low-frequency admin actions, so the extra API call is immaterial,
 * and this avoids ever using a stale `sheetId` if a tab were deleted and
 * recreated.
 *
 * @param {import('googleapis').sheets_v4.Sheets} sheetsClient
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @returns {Promise<number>}
 * @throws {Error} If no sheet with that title exists.
 */
async function getSheetIdByName(sheetsClient, spreadsheetId, tabName) {
  const response = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const sheets = (response && response.data && response.data.sheets) || [];
  const match = sheets.find((s) => s.properties && s.properties.title === tabName);
  if (!match) {
    throw new Error(`Sheet tab named "${tabName}" was not found in the spreadsheet.`);
  }
  return match.properties.sheetId;
}

/**
 * Factory for the Sheets Writer, per design.md "Module boundary".
 *
 * Mirrors the `createApprovalEngine(deps)` pattern already established in
 * this codebase: a factory over a pre-wired singleton, so tests can inject
 * a fake `sheetsClient` and `index.js` controls construction/wiring order.
 *
 * Validates `spreadsheetId` (Requirement 1.3) and, unless a `sheetsClient`
 * is injected (test seam), builds the real authenticated client via
 * `buildSheetsClient` (Requirement 1.1/1.2) — both synchronously, at
 * construction time, so a misconfigured deployment fails at startup
 * rather than on the first resolved entry (design.md Property 6).
 *
 * @param {object} deps
 * @param {string} deps.spreadsheetId - GOOGLE_SHEET_ID.
 * @param {string} [deps.serviceAccountEmail] - GOOGLE_SERVICE_ACCOUNT_EMAIL.
 *   Required unless `deps.sheetsClient` is supplied.
 * @param {string} [deps.serviceAccountKey] - GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.
 *   Required unless `deps.sheetsClient` is supplied.
 * @param {string} [deps.entriesTabName] - Defaults to 'Entries'.
 * @param {string} [deps.rejectedTabName] - Defaults to 'Rejected'.
 * @param {import('googleapis').sheets_v4.Sheets} [deps.sheetsClient] - Test
 *   seam: a pre-built or fake Sheets client. When supplied, no Service
 *   Account credentials are required or validated.
 * @returns {{writeResolution: (resolution: object) => Promise<void>}}
 */
function createSheetsWriter(deps) {
  const {
    spreadsheetId,
    serviceAccountEmail,
    serviceAccountKey,
    entriesTabName = 'Entries',
    rejectedTabName = 'Rejected',
    sheetsClient,
  } = deps || {};

  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID is required to initialize the Sheets Writer.');
  }

  const client = sheetsClient || buildSheetsClient({ serviceAccountEmail, serviceAccountKey });

  // Phase 6 — Last_Written_Entry tracking (closure-local, this-process-
  // only, never persisted to disk). See
  // .kiro/specs/responder-commands/design.md "Last_Written_Entry tracking"
  // and "Data Models — Last_Written_Entry". Holds at most one entry, since
  // only the *most recent* Entries-tab write is ever relevant to `/undo`.
  let lastWrittenEntry = null;

  /**
   * The Sheets Writer's entire public surface — compatible with the
   * Approval Engine's Resolution_Callback signature
   * (`(resolution) => Promise<void>`), per Requirement 5.1.
   *
   * On failure (both the initial append and its single retry fail),
   * `console.error`s a structured log and then throws/rejects the
   * underlying error — never swallowed (Requirement 4.2). Per the
   * Approval Engine's Resolution_Callback Interface Contract ("No
   * retries"), a thrown/rejected `onResolution` is caught by
   * `invokeCallbackSafely` on the Approval Engine side and logged there
   * too — this module's own single retry (Requirement 4.1) is a lower-
   * level, transient-network-blip retry that composes with, rather than
   * duplicates, that higher-level no-retry policy.
   *
   * Nothing in this function retains state across calls except updating
   * `lastWrittenEntry` on a successful Entries-tab write (Phase 6), so one
   * call's failure has no way to affect any other call (Requirement 4.3).
   *
   * @param {object} resolution
   * @returns {Promise<void>}
   */
  async function writeResolution(resolution) {
    const row = mapToRow(resolution);
    const tabName = resolution.status === 'rejected' ? rejectedTabName : entriesTabName;

    const result = await appendRow(client, spreadsheetId, tabName, row);

    if (!result.ok) {
      console.error('Sheets append failed after retry', {
        status: resolution.status,
        entryId: resolution.entryId,
        submittedBy: resolution.submittedBy,
        error: result.error && result.error.message ? result.error.message : String(result.error),
      });
      throw result.error;
    }

    // Phase 6 — only track Entries-tab writes; Rejected-tab appends are
    // never undo-able targets (see design.md's tracking section).
    if (tabName === entriesTabName) {
      const rowNumber = extractRowNumber(result.updatedRange);
      if (rowNumber) {
        lastWrittenEntry = { rowNumber, resolution };
      }
    }
  }

  /**
   * @returns {{rowNumber: number, resolution: object} | null} The
   *   currently tracked Last_Written_Entry, per design.md "Data Models —
   *   Last_Written_Entry", or `null` if nothing is tracked (either no
   *   Entries-tab write has ever succeeded in this process, or the most
   *   recent one has already been undone).
   */
  function getLastWrittenEntry() {
    return lastWrittenEntry;
  }

  /**
   * Remove the tracked Last_Written_Entry's row from the Entries tab, per
   * design.md "`undoLastEntry()`" (Requirements 3.1, 3.4, 3.5, 3.6).
   *
   * Targets exactly the tracked `rowNumber` via a `deleteDimension`
   * `batchUpdate` request — never infers "the last row" from the sheet's
   * current state — so a row a human has manually added since the
   * tracked write is never at risk (Requirement 3.6).
   *
   * Clears `lastWrittenEntry` only if the delete succeeds (Requirement
   * 3.4); leaves it untouched on failure so the caller can retry
   * (Requirement 3.5).
   *
   * @returns {Promise<{ok: true, resolution: object} | {ok: false, error: Error}>}
   */
  async function undoLastEntry() {
    if (!lastWrittenEntry) {
      return { ok: false, error: new Error('Nothing to undo.') };
    }

    const { rowNumber, resolution } = lastWrittenEntry;

    try {
      const sheetId = await getSheetIdByName(client, spreadsheetId, entriesTabName);
      await client.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: rowNumber - 1,
                  endIndex: rowNumber,
                },
              },
            },
          ],
        },
      });
    } catch (err) {
      console.error('Sheets undo (row delete) failed', {
        rowNumber,
        error: err && err.message ? err.message : String(err),
      });
      return { ok: false, error: err };
    }

    lastWrittenEntry = null; // Req 3.4 — cleared only on success
    return { ok: true, resolution };
  }

  /**
   * Update a single Editable_Field cell on a specific Entries-tab row, per
   * design.md "`editEntryField(rowNumber, field, value)`" (Requirements
   * 4.1, 4.7).
   *
   * Addresses the target cell by an explicit `<column-letter><row-number>`
   * range, mapped from `field` via `FIELD_COLUMNS` — never a cached
   * full-range snapshot — so it structurally cannot affect any row other
   * than the one named. Field/row/value validity is the caller's
   * (`commands.js`'s) responsibility; this function trusts its inputs and
   * performs the write.
   *
   * @param {number} rowNumber - 1-indexed target row.
   * @param {string} field - One of `FIELD_COLUMNS`' keys.
   * @param {string} value - The new cell value.
   * @returns {Promise<{ok: true} | {ok: false, error: Error}>}
   */
  async function editEntryField(rowNumber, field, value) {
    const column = FIELD_COLUMNS[field];
    const range = `${entriesTabName}!${column}${rowNumber}`;

    try {
      await client.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] },
      });
      return { ok: true };
    } catch (err) {
      console.error('Sheets edit (cell update) failed', {
        rowNumber,
        field,
        error: err && err.message ? err.message : String(err),
      });
      return { ok: false, error: err };
    }
  }

  /**
   * v1.2 — Durable Job Queue (additive). Idempotent variant of
   * `writeResolution`, per Part A4: `resolution.entryId` MUST already be
   * the deterministic hash the caller (the sheet_write job handler, see
   * index.js's queue wiring) derived from the originating WhatsApp
   * message id — this function does not generate or alter it. Checks
   * column A first via `entryIdExistsInColumnA`; if a row with this
   * `entry_id` already exists, skips the append entirely (Part A4's
   * crash-recovery guarantee) and returns `{ written: false }` rather
   * than calling `writeResolution` (so `getLastWrittenEntry`/`/undo`
   * tracking is untouched on a skipped, already-done write).
   *
   * Never called from the flags-off (QUEUE_ENABLED=false) path — Rule 2
   * requires that path's behavior stay bit-for-bit identical to v1.0/
   * v1.1, which this function does not touch (it's purely additive,
   * alongside `writeResolution` rather than inside it).
   *
   * @param {object} resolution - Must have a non-empty `entryId` set to
   *   the deterministic hash for this message (never a random id).
   * @returns {Promise<{written: boolean}>}
   */
  async function writeResolutionIdempotent(resolution) {
    if (!resolution.entryId) {
      throw new Error('writeResolutionIdempotent requires resolution.entryId to be set to a deterministic hash.');
    }

    const tabName = resolution.status === 'rejected' ? rejectedTabName : entriesTabName;
    const alreadyExists = await entryIdExistsInColumnA(client, spreadsheetId, tabName, resolution.entryId);
    if (alreadyExists) {
      return { written: false };
    }

    await writeResolution(resolution);
    return { written: true };
  }

  return {
    writeResolution,
    writeResolutionIdempotent,
    getLastWrittenEntry,
    undoLastEntry,
    editEntryField,
  };
}

module.exports = {
  createSheetsWriter,
  mapToRow,
  generateSheetRowId,
  appendRow,
  buildSheetsClient,
  normalizePrivateKey,
  extractRowNumber,
  getSheetIdByName,
  formatSheetTimestamp,
  entryIdExistsInColumnA,
  FIELD_COLUMNS,
  COLUMNS,
};
