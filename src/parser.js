// parser.js
// Phase 2 — turns a raw WhatsApp message into a structured, validated expense
// entry. Regex pass first (free, instant); LLM fallback only when the regex
// pass isn't confident. See doc/prd.md FR1 and doc/trd.md §2.
//
// LLM fallback goes through OpenRouter (https://openrouter.ai) rather than
// calling Anthropic directly. OpenRouter exposes an OpenAI-compatible REST
// endpoint, so this uses Node's built-in fetch — no extra SDK dependency
// needed.
//
// This module never throws. parseExpenseMessage always resolves to either
// { ok: true, entry } or { ok: false, reason }.

const chrono = require('chrono-node');
const { expenseSchema } = require('./schema');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// OpenRouter's slug for the same underlying model, per openrouter.ai/models.
const LLM_MODEL = 'anthropic/claude-haiku-4.5';

// ---------------------------------------------------------------------------
// Regex pass
// ---------------------------------------------------------------------------

// Matches a plain number, a comma-grouped number ("20,000"), or either of
// those immediately followed by a "k" shorthand ("20k" -> 20,000).
const AMOUNT_REGEX = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k\b)?/i;

// Recipient: text after "to", stopping before a known trailing keyword,
// punctuation, or end of string.
const RECIPIENT_REGEX = /\bto\s+(.+?)(?=\s+\b(on|by|yesterday|today|tomorrow)\b|[.,!]|$)/i;

// Payer: text after "by", stopping before punctuation or end of string.
const PAYER_REGEX = /\bby\s+(.+?)(?=[.,!]|$)/i;

function extractAmount(text) {
  const match = text.match(AMOUNT_REGEX);
  if (!match) return null;

  const numStr = match[1].replace(/,/g, '');
  let amount = parseFloat(numStr);
  if (Number.isNaN(amount)) return null;

  const hasK = Boolean(match[2]);
  if (hasK) amount *= 1000;

  return amount;
}

function extractRecipient(text) {
  const match = text.match(RECIPIENT_REGEX);
  if (!match) return null;
  const recipient = match[1].trim();
  return recipient.length > 0 ? recipient : null;
}

function extractPayer(text) {
  const match = text.match(PAYER_REGEX);
  if (!match) return null;
  const payer = match[1].trim();
  return payer.length > 0 ? payer : null;
}

/**
 * Converts a JS Date to an ISO date string (YYYY-MM-DD) using local date
 * components, avoiding UTC day-shift issues.
 */
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Finds a date mentioned anywhere in the text using chrono-node, anchored to
 * messageTimestamp as the reference date (needed for relative dates like
 * "yesterday" and for resolving day/month without an explicit year).
 *
 * Deliberately conservative: only trusts a chrono result if the day
 * component is explicitly certain (not an implied default). This avoids a
 * bare number that happens to look like a year (e.g. "3000" in "gave rs 3000
 * to the flower guy") being misread as a date.
 */
function extractDate(text, referenceDate) {
  let results;
  try {
    results = chrono.parse(text, referenceDate);
  } catch {
    results = [];
  }

  if (results.length === 0) return null;

  const first = results[0];
  if (!first.start.isCertain('day')) return null;

  return toISODate(first.start.date());
}

/**
 * Regex-only extraction pass.
 * "Confident" requires both an amount and a recipient to have been found.
 */
function regexPass(text, { senderName, messageTimestamp }) {
  const amount = extractAmount(text);
  const given_to = extractRecipient(text);
  const payerFromText = extractPayer(text);
  const date = extractDate(text, messageTimestamp) || toISODate(messageTimestamp);

  const confident = amount !== null && given_to !== null;

  return {
    confident,
    result: {
      amount,
      given_to,
      date,
      paid_by: payerFromText || senderName,
      raw_message: text,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM fallback
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You extract structured expense data from a short WhatsApp message.

Return ONLY a raw JSON object. No markdown code fences, no preamble, no explanation — just the JSON object itself.

The JSON object must use exactly these field names:
- "amount": number (positive). Required.
- "given_to": string, the recipient of the money as written in the message. Required.
- "date": string in YYYY-MM-DD format if a date is explicitly mentioned in the message, otherwise null.
- "paid_by": string, the name of the person who actually paid, ONLY if the message explicitly names a payer (e.g. after "by"). Otherwise null.
- "party": string, only if the message clearly mentions a side/party/group this expense belongs to. Otherwise null.
- "notes": string, any other relevant descriptive detail from the message. Otherwise null.

If you genuinely cannot determine both an amount and a recipient from the message, return exactly:
{"unparseable": true}

Do not guess an amount or recipient that isn't actually present in the text.`;

function stripCodeFences(raw) {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Calls the OpenRouter chat completions API to extract expense fields from
 * text that the regex pass couldn't confidently parse. Never throws —
 * returns null on any failure (missing API key, network error, non-2xx
 * response, malformed JSON, etc.) so the caller can fall back to a
 * clarification response.
 */
async function llmPass(text) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    console.warn('LLM_API_KEY not set — skipping LLM fallback.');
    return null;
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;

    const cleaned = stripCodeFences(raw);
    const parsed = JSON.parse(cleaned);

    if (parsed && parsed.unparseable === true) {
      return { unparseable: true };
    }

    return parsed;
  } catch (err) {
    console.error('LLM fallback call failed:', err.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a raw WhatsApp expense message into a structured, validated entry.
 *
 * @param {string} text - Raw message text.
 * @param {object} context
 * @param {string} context.senderName - Sender's pushName, falling back to
 *   their JID. Used as the default paid_by when the text names no payer.
 *   NOTE: this is never treated as submitted_by inside this module — the
 *   caller owns submitted_by entirely, since it's WhatsApp metadata, not
 *   parsed text.
 * @param {Date} context.messageTimestamp - The WhatsApp message's own
 *   timestamp, used as chrono's reference date and as the date fallback.
 * @returns {Promise<{ok: true, entry: object} | {ok: false, reason: string}>}
 */
async function parseExpenseMessage(text, { senderName, messageTimestamp } = {}) {
  try {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, reason: 'Empty message.' };
    }

    const referenceDate = messageTimestamp instanceof Date ? messageTimestamp : new Date();
    const effectiveSenderName = senderName || 'unknown';

    const { confident, result } = regexPass(text, {
      senderName: effectiveSenderName,
      messageTimestamp: referenceDate,
    });

    let candidate;

    if (confident) {
      candidate = result;
    } else {
      const llmResult = await llmPass(text);

      if (!llmResult || llmResult.unparseable) {
        return {
          ok: false,
          reason: llmResult
            ? 'Could not identify an amount and recipient in the message.'
            : 'Could not confidently parse the message and the LLM fallback was unavailable or failed.',
        };
      }

      const amount = typeof llmResult.amount === 'number' ? llmResult.amount : null;
      const given_to = typeof llmResult.given_to === 'string' && llmResult.given_to.trim()
        ? llmResult.given_to.trim()
        : null;

      if (amount === null || given_to === null) {
        return {
          ok: false,
          reason: 'Could not identify an amount and recipient in the message.',
        };
      }

      const date = typeof llmResult.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(llmResult.date)
        ? llmResult.date
        : toISODate(referenceDate);

      const paid_by = typeof llmResult.paid_by === 'string' && llmResult.paid_by.trim()
        ? llmResult.paid_by.trim()
        : effectiveSenderName;

      candidate = {
        amount,
        given_to,
        date,
        paid_by,
        raw_message: text,
      };

      if (typeof llmResult.party === 'string' && llmResult.party.trim()) {
        candidate.party = llmResult.party.trim();
      }
      if (typeof llmResult.notes === 'string' && llmResult.notes.trim()) {
        candidate.notes = llmResult.notes.trim();
      }
    }

    candidate.raw_message = text;

    const parsedResult = expenseSchema.safeParse(candidate);
    if (!parsedResult.success) {
      const firstIssue = parsedResult.error.issues[0];
      return {
        ok: false,
        reason: `Parsed data failed validation: ${firstIssue?.path?.join('.')} — ${firstIssue?.message}`,
      };
    }

    return { ok: true, entry: parsedResult.data };
  } catch (err) {
    return {
      ok: false,
      reason: `Unexpected error while parsing: ${err?.message || String(err)}`,
    };
  }
}

module.exports = {
  parseExpenseMessage,
};
