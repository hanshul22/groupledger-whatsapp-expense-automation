// schema.js
// Zod schema for a parsed expense entry (Phase 2 — Message Parser).
//
// Field notes (see doc/prd.md FR1 and the Phase 2 prompt's schema clarification):
//   - submitted_by is NOT part of this schema. It comes from WhatsApp message
//     metadata (sender pushName/JID) and is attached by the caller, not parsed
//     from text. Keeping it out of this schema keeps the parser honest about
//     what it can and cannot know from the message text alone.
//   - paid_by IS part of this schema — it's parsed from text (e.g. "...by
//     x person"), and the caller defaults it to the sender's name when the
//     text names no payer. Do not collapse paid_by and submitted_by into one
//     field; they can legitimately differ (someone logging on behalf of
//     someone else).

const { z } = require('zod');

/**
 * @typedef {object} ParsedExpenseEntry
 * @property {number} amount - Positive number, the expense amount.
 * @property {string} given_to - Recipient name as written (no fuzzy contact matching).
 * @property {string} date - ISO date string (YYYY-MM-DD). Falls back to the
 *   WhatsApp message's own timestamp if no date is mentioned in the text.
 * @property {string} paid_by - Who actually paid, parsed from text; defaults
 *   to submitted_by (the sender) if the text names no payer.
 * @property {string} [party] - Optional; omitted entirely when not mentioned
 *   (never defaulted to an empty string).
 * @property {string} [notes] - Optional; any leftover descriptive text.
 * @property {string} raw_message - The original, unmodified message text.
 */

const expenseSchema = z.object({
  amount: z.number().positive(),
  given_to: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be an ISO date string (YYYY-MM-DD)'),
  paid_by: z.string().min(1),
  party: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  raw_message: z.string().min(1),
});

// ---------------------------------------------------------------------------
// v1.1 — LLM normalization layer (normalizer.js). See doc/trd.md §8.3.
//
// Deliberately has NO `status`, `approved_by`, `approved_at`, `entry_id` or
// `submitted_by` fields — those stay under deterministic code (FR13). The
// LLM's raw output is validated against this schema (guard G1 in
// normalizer.js) before anything else about it is trusted.
// ---------------------------------------------------------------------------
const normalizedEntrySchema = z
  .object({
    is_expense: z.boolean(),
    multiple_entries: z.boolean(),
    amount: z.number().positive().finite().nullable(),
    given_to: z.string().trim().min(1).max(80).nullable(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be an ISO date string (YYYY-MM-DD)')
      .nullable(),
    description: z.string().trim().max(120),
    party: z.string().trim().max(60).nullable(),
    confidence: z.number().min(0).max(1),
    notes: z.string().max(200),
  })
  .strict();

module.exports = {
  expenseSchema,
  normalizedEntrySchema,
};
