// auditLog.js
// Phase 4 — Approval Engine internal module. See
// .kiro/specs/approval-engine/design.md "Data Models — Audit log entry" and
// "Persistence Strategy" for the full design context.
//
// Responsibilities:
//   - Append one JSON object per line (JSON-lines format) to the configured
//     audit log file, creating the file/directory if absent.
//   - Never swallow errors: callers (e.g. the store-corruption crash-on-
//     log-failure path, Requirement 8.5) depend on being able to detect a
//     failed audit log write and react accordingly (typically by crashing).

const fs = require('fs');
const path = require('path');

/**
 * Append a single audit log entry to `auditLogPath`, one JSON object per
 * line. Creates the target directory and/or file if they don't yet exist.
 *
 * Entry shape (per design.md "Data Models — Audit log entry"):
 *   {
 *     event: string,
 *     entryId?: string,
 *     responderJid?: string,
 *     at: string,      // ISO 8601
 *     detail?: string,
 *   }
 *
 * This function does not swallow errors — if creating the directory or
 * appending to the file fails, the returned promise rejects so callers can
 * detect and act on the failure (e.g. crash on unlogged data corruption,
 * per Requirement 8.5).
 *
 * @param {string} auditLogPath - Path to the audit log file (e.g.
 *   `./data/audit.log`).
 * @param {{
 *   event: string,
 *   entryId?: string,
 *   responderJid?: string,
 *   at: string,
 *   detail?: string,
 * }} entry
 * @returns {Promise<void>}
 */
async function appendAuditLog(auditLogPath, entry) {
  const dir = path.dirname(auditLogPath);
  await fs.promises.mkdir(dir, { recursive: true });

  const line = `${JSON.stringify(entry)}\n`;
  await fs.promises.appendFile(auditLogPath, line, { encoding: 'utf8' });
}

module.exports = {
  appendAuditLog,
};
