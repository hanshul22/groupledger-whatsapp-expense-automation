// index.js — Phase 1 entrypoint.
// Starts the HTTP keepalive stub server and the WhatsApp connection.
// No parsing / approval / Sheets logic in this phase — see doc/implementation-plan.md.

require('dotenv').config();

const express = require('express');
const QRCode = require('qrcode');
const { startWhatsApp, isGroupAdmin } = require('./waConnector');
const { createNormalizer } = require('./normalizer');
const { createApprovalEngine } = require('./approvalEngine');
const { createSheetsWriter } = require('./sheetsWriter');
const { createResponder } = require('./responder');
const { createCommandHandler } = require('./commands');
const { createAuthStateFactory } = require('./authState');
const { createConnectionMonitor } = require('./connectionMonitor');
const { createPushNameCache } = require('./pushNameCache');
const { createMessagePipeline, NormalizerHoldError } = require('./messagePipeline');
const { setupQueue } = require('./queue/setup');
const { deriveEntryHash } = require('./queue/entryHash');
const { runWithEntryHash, getCurrentEntryHash } = require('./queue/jobContext');
const { classifyError } = require('./queue/failureClassifier');
const { decideNormalizerHold } = require('./queue/normalizerHold');
const { HoldError } = require('./queue/jobTypes');
const { createRedisPendingStore } = require('./redisPendingStore');
const Redis = require('ioredis'); // only import site for the real Redis client — see authState.js

const PORT = process.env.PORT || 3000;

// Loud, not fatal: WHATSAPP_GROUP_ID is intentionally allowed to start
// empty (discovery mode — see README "On first run"), but a misspelled
// env var name on a host like Render would otherwise deploy "successfully"
// and silently never process a single message, with no sign of trouble
// short of reading every incoming-chat-id log line.
if (!process.env.WHATSAPP_GROUP_ID) {
  console.warn(
    'WARNING: WHATSAPP_GROUP_ID is not set. The bot will log every incoming ' +
      'chat id and will not process any group messages until it is configured.'
  );
}

// v1.2 — Durable Job Queue (additive). QUEUE_ENABLED defaults to false —
// with it unset/false, `queueSetup` is `null` and no Redis client for the
// queue is ever constructed (Rule 2 — behavior identical to today).
// Constructed at module load time, alongside sheetsWriter/getAuthState/
// normalizer below — it has no dependency on the Baileys socket.
const QUEUE_ENABLED = (process.env.QUEUE_ENABLED || 'false').toLowerCase() === 'true';
const queueSetup = setupQueue({
  enabled: QUEUE_ENABLED,
  redisUrl: process.env.REDIS_URL,
  RedisClientCtor: Redis,
  concurrency: Number(process.env.QUEUE_CONCURRENCY) || undefined,
  leaseSeconds: Number(process.env.QUEUE_LEASE_SECONDS) || undefined,
  sweepIntervalSeconds: Number(process.env.QUEUE_SWEEP_INTERVAL_SECONDS) || undefined,
  maxAgeHours: Number(process.env.QUEUE_MAX_AGE_HOURS) || undefined,
  alertOldestMinutes: Number(process.env.QUEUE_ALERT_OLDEST_MINUTES) || undefined,
  classifyError, // v1.2 Phase 4 — real classifier (Part A5)
  onAlert: (message) => {
    console.error(message);
    const fallbackNumber = process.env.BOT_ADMIN_FALLBACK_NUMBER;
    if (fallbackNumber) {
      try {
        global.__sendWhatsAppAlert?.(fallbackNumber, message);
      } catch (err) {
        console.error('Failed to deliver queue alert:', err);
      }
    }
  },
});
const jobQueue = queueSetup ? queueSetup.queue : null;

// v1.2 — STATE_STORE=redis|file (Part A6). Defaults to "file", the exact
// pre-v1.2 behavior (a local JSON file, per pendingStore.js). Only
// meaningful when QUEUE_ENABLED=true and a queue Redis client exists —
// "redis" without a queue Redis client (e.g. QUEUE_ENABLED=false) falls
// back to "file" rather than constructing a second, unrelated Redis
// client just for this, since the pending-approval durability problem
// STATE_STORE=redis solves (Render has no persistent disk) only matters
// once the rest of the durable-queue machinery is also active.
const STATE_STORE = (process.env.STATE_STORE || 'file').toLowerCase();
const redisPendingStore =
  STATE_STORE === 'redis' && queueSetup
    ? createRedisPendingStore({ redis: queueSetup.redis })
    : undefined;

// v1.1 — LLM normalization layer (doc/trd.md §8). Constructed at module
// load time, alongside sheetsWriter/getAuthState below — it has no
// dependency on the Baileys socket. `NORMALIZER_MODE` defaults to `off`,
// which keeps this entire layer inert (no network calls) and v1.0
// behavior unchanged, per FR11.
const normalizer = createNormalizer({
  mode: process.env.NORMALIZER_MODE || 'off',
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL,
  fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || undefined,
  timeoutMs: Number(process.env.NORMALIZER_TIMEOUT_MS) || 8000,
  minConfidence: Number(process.env.NORMALIZER_MIN_CONFIDENCE) || 0.7,
  alertAfterFailures: Number(process.env.NORMALIZER_ALERT_AFTER_FAILURES) || 5,
  onAlert: (message) => {
    console.error(message);
    const fallbackNumber = process.env.BOT_ADMIN_FALLBACK_NUMBER;
    if (fallbackNumber) {
      // Best-effort only — sock may not exist yet at the time of the
      // very first alert; a later alert (counter resets on any success)
      // will succeed once onReady has run. Never let this throw.
      try {
        global.__sendWhatsAppAlert?.(fallbackNumber, message);
      } catch (err) {
        console.error('Failed to deliver normalizer alert:', err);
      }
    }
  },
});

// Parties the normalizer is allowed to tag an entry with (FR12/G7,
// doc/trd.md §8.5). Optional — comma-separated env var; empty list means
// "no party validation" (party passes through as the LLM read it).
const ALLOWED_PARTIES = (process.env.ALLOWED_PARTIES || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

// Phase 5 — construct the Sheets Writer at module load time, outside
// onReady (it has no dependency on the Baileys socket). A misconfigured
// Service Account / spreadsheet ID fails the process at startup rather
// than on the first resolved entry. See
// .kiro/specs/sheets-writer/design.md "Integration with src/index.js".
const sheetsWriter = createSheetsWriter({
  spreadsheetId: process.env.GOOGLE_SHEET_ID,
  serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
});

// Phase 7 — construct the auth-state factory and Connection Monitor at
// module load time, alongside sheetsWriter (neither depends on the
// Baileys socket). Leaving REDIS_URL unset keeps today's local-disk
// session behavior completely unchanged (Requirement 3.5).
const getAuthState = createAuthStateFactory({
  redisUrl: process.env.REDIS_URL,
  RedisClientCtor: Redis,
});

const OFFLINE_ALERT_THRESHOLD_MS =
  (Number(process.env.OFFLINE_ALERT_THRESHOLD_MINUTES) || 10) * 60 * 1000;

const connectionMonitor = createConnectionMonitor({
  thresholdMs: OFFLINE_ALERT_THRESHOLD_MS,
  fallbackNumber: process.env.BOT_ADMIN_FALLBACK_NUMBER || null,
});

// Periodic check for "has the current outage (if any) crossed the alert
// threshold yet" — see connectionMonitor.js; this interval is the only
// owner of that polling cadence.
setInterval(() => {
  connectionMonitor.checkAndMaybeAlert().catch((err) => {
    console.error('Connection monitor: checkAndMaybeAlert failed:', err);
  });
}, 60 * 1000);

// Minimal HTTP server. Exists so a cron job — either Render's own `cron`
// service defined in render.yaml, or an external pinger like cron-job.org
// (per doc/architecture.md §2a) — can ping it periodically to keep the
// Render free-tier web service from spinning down after 15 minutes of no
// inbound HTTP traffic.
//
// `keepaliveStats` tracks ping count and the last-ping timestamp purely
// for operator visibility (surfaced on /keepalive itself and in /health) —
// it has no effect on request handling and is not persisted, since its
// only purpose is "can I see, right now, that the cron is actually
// reaching this process" rather than being a durability or metrics store.
const processStartedAt = new Date();
const keepaliveStats = {
  pingCount: 0,
  lastPingAt: null,
};

const app = express();
app.get('/keepalive', (req, res) => {
  keepaliveStats.pingCount += 1;
  keepaliveStats.lastPingAt = new Date();
  res.status(200).json({
    status: 'OK',
    pingCount: keepaliveStats.pingCount,
    lastPingAt: keepaliveStats.lastPingAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// TEMP DIAGNOSTIC — in-memory ring buffer for debugging the reaction-
// matching flow without depending on Render's dashboard log viewer
// (which has been intermittently stale/unreliable). Capped at
// DEBUG_LOG_MAX_LINES so it can never grow unbounded; never written to
// disk (Render's free-tier filesystem is ephemeral anyway, and this is
// throwaway diagnostic data, not an audit trail — see auditLog.js for
// the real one). Remove this block, pushDebugLog's call sites, and the
// /debug-logs route below once the reaction issue is confirmed fixed.
const DEBUG_LOG_MAX_LINES = 200;
const debugLogBuffer = [];
function pushDebugLog(message, data) {
  debugLogBuffer.push({ at: new Date().toISOString(), message, data });
  if (debugLogBuffer.length > DEBUG_LOG_MAX_LINES) {
    debugLogBuffer.shift();
  }
  console.log(`DEBUG ${message}:`, JSON.stringify(data));
}
app.get('/debug-logs', (req, res) => {
  res.status(200).json({ count: debugLogBuffer.length, logs: debugLogBuffer });
});

// Render's web log viewer prefixes every line with a timestamp, which
// breaks the grid alignment of waConnector.js's terminal-art QR code and
// makes it unscannable even though it prints correctly. This route is a
// fallback for exactly that situation: open it in a browser and scan the
// image directly instead of trying to scan the mangled logs. `latestQr`
// holds only the most recent QR string (Baileys reissues a new one every
// ~20s until scanned) — never persisted, nothing sensitive about it once
// the session is linked (it's meaningless after that point anyway).
let latestQr = null;
app.get('/qr', async (req, res) => {
  if (!latestQr) {
    res.status(200).send('<p>No QR code pending — the bot is either already linked, or hasn\'t started up yet. Refresh in a few seconds.</p>');
    return;
  }
  try {
    const dataUrl = await QRCode.toDataURL(latestQr, { width: 320, margin: 2 });
    res.status(200).send(
      `<!DOCTYPE html><html><body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;">
        <h3>Scan with the bot's WhatsApp number — Linked Devices &rarr; Link a Device</h3>
        <img src="${dataUrl}" alt="WhatsApp QR code" />
        <p>Expires in ~20s — refresh this page if it stops working.</p>
      </body></html>`
    );
  } catch (err) {
    console.error('Failed to render QR code image:', err);
    res.status(500).send('Failed to render QR code.');
  }
});

// v1.2 — Part A7: "Add GET /health returning queue counts only (no
// message data). Leave /keepalive as is." When the queue is off, still
// responds (200, `{queueEnabled: false}`) rather than 404ing — a health
// endpoint that goes away when a feature flag is off is a worse
// monitoring story than one that always answers, honestly, with
// whatever's actually running.
app.get('/health', async (req, res) => {
  const keepalive = {
    pingCount: keepaliveStats.pingCount,
    lastPingAt: keepaliveStats.lastPingAt ? keepaliveStats.lastPingAt.toISOString() : null,
    processStartedAt: processStartedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  };

  if (!jobQueue) {
    res.status(200).json({ queueEnabled: false, keepalive });
    return;
  }
  try {
    const counts = await jobQueue.getCounts();
    res.status(200).json({ queueEnabled: true, ...counts, keepalive });
  } catch (err) {
    console.error('GET /health failed to read queue counts:', err && err.message ? err.message : String(err));
    res.status(503).json({ queueEnabled: true, error: 'queue counts unavailable', keepalive });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`Keepalive server listening on port ${PORT}`);
});

let readyMessageSent = false;
let approvalEngine;
let responder;
let commandHandler;
let queueStarted = false;

// Reaction events carry no display name (see pushNameCache.js) — this
// cache lets handleReaction's APPROVE/REJECT-by-reaction path still
// record a real name, as long as the reactor has sent at least one text
// message in the group since this process started.
const pushNameCache = createPushNameCache();

// v1.2 — the Message Pipeline is the single, unchanged copy of v1.0/v1.1's
// "command -> decision -> parse -> normalize -> reply/submit" logic (see
// messagePipeline.js). `commandHandler`/`approvalEngine` are read lazily
// by the pipeline (they're only constructed later, inside onReady), so
// this object literal can safely reference the not-yet-assigned `let`
// bindings declared above.
// v1.2 — guards a retried inbound_message job from calling
// approvalEngine.submitEntry() a second time for the same WhatsApp
// message (see messagePipeline.js's checkAndMarkSubmitted doc comment).
// A plain Redis SET NX marker, keyed by the WhatsApp message id (not the
// entry hash — using the raw message id directly here is simpler and
// exactly matches the granularity of "has THIS message already been
// submitted", with no need to thread the derived hash through). Only
// constructed when the queue is enabled; `undefined` otherwise, which
// keeps messagePipeline.js's default ("always submit") behavior for the
// QUEUE_ENABLED=false path (Rule 2).
const SUBMITTED_MARKER_TTL_SECONDS = 24 * 60 * 60; // mirrors redisStore.js's DONE_TTL_SECONDS
async function checkAndMarkSubmitted(waMessageId) {
  const result = await queueSetup.redis.set(
    `wq:submitted:${waMessageId}`,
    '1',
    'EX',
    SUBMITTED_MARKER_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

// v1.2 — Part B's normalizer/queue hold policy config. Only consulted
// when the queue is on (see `normalizerHoldPolicy` below) — with
// QUEUE_ENABLED=false these two env vars are read but never used for
// anything (Rule 2).
const NORMALIZER_ON_LLM_DOWN = (process.env.NORMALIZER_ON_LLM_DOWN || 'hold').toLowerCase();
const NORMALIZER_MAX_HOLD_MINUTES = Number(process.env.NORMALIZER_MAX_HOLD_MINUTES) || 10;

const messagePipeline = createMessagePipeline({
  normalizer,
  get commandHandler() {
    return commandHandler;
  },
  get approvalEngine() {
    return approvalEngine;
  },
  pushNameCache,
  allowedParties: ALLOWED_PARTIES,
  checkAndMarkSubmitted: jobQueue ? checkAndMarkSubmitted : undefined,
  // v1.2 — Part B: replaces trd.md §8.7's plain fail-open rule when the
  // queue is on. Omitted entirely (undefined) when QUEUE_ENABLED=false,
  // which is messagePipeline.js's exact pre-v1.2 behavior (Rule 2).
  normalizerHoldPolicy: jobQueue
    ? ({ normalizeResult, receivedAt, parserProducedUsableEntry }) =>
        decideNormalizerHold({
          normalizeResult,
          onLlmDown: NORMALIZER_ON_LLM_DOWN,
          receivedAt,
          maxHoldMinutes: NORMALIZER_MAX_HOLD_MINUTES,
          parserProducedUsableEntry,
        })
    : undefined,
});

// v1.2 — register the inbound_message handler once, at module load time.
// Only ever invoked when QUEUE_ENABLED=true (jobQueue is null otherwise,
// so nothing here runs). `currentSock` is populated inside onReady, once
// Baileys hands us a live socket — the handler closes over the mutable
// holder rather than a socket captured at registration time, since
// registration happens before any socket exists.
const socketHolder = { sock: null };
if (jobQueue) {
  jobQueue.registerHandler('inbound_message', async (job) => {
    if (!socketHolder.sock) {
      // No live socket yet (e.g. still connecting/reconnecting) — throw a
      // retryable error so the queue's transient backoff reschedules this
      // job rather than dropping it (Part A3/A5).
      throw new Error('WhatsApp socket not ready');
    }
    try {
      // v1.2 — make this job's deterministic entry hash available, via
      // ambient context (see queue/jobContext.js), to the onResolution
      // callback further down this exact call stack (only reached for
      // the auto_approved path, which otherwise has no way to correlate
      // back to the originating message — see sheetsWriter.js's
      // writeResolutionIdempotent doc comment for the full rationale).
      await runWithEntryHash(job.payload.entryHash, () =>
        messagePipeline.handleGroupMessage(socketHolder.sock, job.payload.msg, {
          jobReceivedAt: new Date(job.received_at),
        }),
      );
    } catch (err) {
      if (err instanceof NormalizerHoldError) {
        // Part B — reschedule without counting an attempt, bounded by
        // NORMALIZER_MAX_HOLD_MINUTES (enforced by decideNormalizerHold
        // itself re-checking job.received_at on every future attempt;
        // this HoldError only ever covers a single short re-check delay
        // — see queue/jobTypes.js's HoldError default retryAfterMs).
        throw new HoldError(err.message);
      }
      throw err;
    }
  });

  // v1.2 — Part A4: append to the Entries/Rejected tab, idempotently
  // keyed by the deterministic entry hash carried in the job payload.
  // On success, enqueues wa_reply so a missing confirmation can never
  // cause a duplicate sheet write (kept as a separate job, per Part A4).
  jobQueue.registerHandler('sheet_write', async (job) => {
    const { resolution } = job.payload;
    const result = await sheetsWriter.writeResolutionIdempotent(resolution);
    if (result.written) {
      console.log(`Queue: sheet_write wrote entry ${resolution.entryId} (${resolution.status}).`);
    } else {
      console.log(`Queue: sheet_write skipped entry ${resolution.entryId} — already written.`);
    }
    await jobQueue.enqueueJob({
      type: 'wa_reply',
      payload: { resolution },
      id: `wa_reply-${resolution.entryId}`,
    });
  });

  // v1.2 — Part A4: send confirmations/rejection notices. Kept separate
  // from sheet_write so a failed/late WhatsApp send never risks a
  // duplicate sheet write (the sheet write has already happened by the
  // time this job runs). `responder` is only constructed inside onReady
  // (needs a live `sendMessage`), so this handler waits for it exactly
  // like the inbound_message handler waits for `socketHolder.sock`.
  jobQueue.registerHandler('wa_reply', async (job) => {
    if (!responder) {
      throw new Error('Responder not ready');
    }
    await responder.notifyOutcome(job.payload.resolution);
  });
}

startWhatsApp({
  getAuthState,
  onDisconnected: () => connectionMonitor.onDisconnected(),
  onQrCode: (qr) => {
    latestQr = qr;
  },
  onReady: async (sock) => {
    console.log('Bot is ready');
    latestQr = null; // scanned/connected — the /qr fallback has nothing left to show


    // v1.2 — make the live socket available to the inbound_message job
    // handler (registered above, before any socket existed) and start
    // the queue's own runtime (recovers from a prior crash, then begins
    // claiming) the first time a socket is ready. `start()` is a no-op
    // to call again on a reconnect's onReady — guarding with
    // `queueStarted` avoids spinning up a second sweeper interval.
    socketHolder.sock = sock;
    if (jobQueue && !queueStarted) {
      queueStarted = true;
      try {
        await jobQueue.start();
      } catch (err) {
        console.error('Failed to start job queue:', err);
      }
    }

    // Phase 7 — signal the Connection Monitor that the connection is back
    // up. A no-op if the prior outage never crossed the alert threshold
    // (Requirement 2.7); otherwise logs recovery and, if a Fallback_Number
    // is configured, sends it a recovery notice (Requirements 2.4-2.6).
    try {
      await connectionMonitor.onReconnected({
        sendMessage: (jid, content) => sock.sendMessage(jid, content),
      });
    } catch (err) {
      console.error('Connection monitor: onReconnected failed:', err);
    }

    const groupId = process.env.WHATSAPP_GROUP_ID;
    if (groupId && !readyMessageSent) {
      readyMessageSent = true;
      try {
        await sock.sendMessage(groupId, {
          text: 'Bot is online and connected. ✅',
        });
      } catch (err) {
        console.error('Failed to send ready confirmation message:', err);
      }
    }

    // Phase 6 — construct the Responder and Command Handler alongside the
    // Approval Engine, since both need a sendMessage closing over `sock`,
    // which only exists here inside onReady (same reasoning already
    // documented for approvalEngine below).
    const sendMessage = (jid, content) => sock.sendMessage(jid, content);

    // v1.1 — lets the normalizer's onAlert (constructed before onReady,
    // since it has no socket dependency) actually deliver a WhatsApp
    // alert once a socket exists. See normalizer construction above.
    global.__sendWhatsAppAlert = (jid, text) => sendMessage(jid, { text });

    responder = createResponder({
      sendMessage,
      groupId: process.env.WHATSAPP_GROUP_ID,
    });
    commandHandler = createCommandHandler({
      sock,
      groupId: process.env.WHATSAPP_GROUP_ID,
      isGroupAdmin,
      sendMessage,
      sheetsWriter,
      jobQueue: jobQueue || undefined, // v1.2 — enables /queue and /queue retry only when the queue is on
    });

    // Phase 4 — construct and initialize the Approval Engine. Its
    // Resolution_Callback is now backed by the Phase 5 Sheets Writer and
    // the Phase 6 Responder: the engine itself never reaches into Sheets
    // or sends ledger confirmation/rejection messages directly, it only
    // calls onResolution, which writes the row and then (only on a
    // successful write, per Requirement 1.2) notifies the outcome.
    try {
      approvalEngine = createApprovalEngine({
        sock,
        groupId: process.env.WHATSAPP_GROUP_ID,
        isGroupAdmin,
        sendMessage,
        pendingStore: redisPendingStore, // v1.2 — undefined preserves the default file store (Rule 2)
        onDebugLog: pushDebugLog, // TEMP DIAGNOSTIC — see GET /debug-logs
        onResolution: jobQueue
          ? async (resolution) => {
              // v1.2 — QUEUE_ENABLED=true: hand off to the durable
              // sheet_write job instead of writing/replying inline, so a
              // crash between "approved" and "written" can never lose
              // the entry (Part A4). `resolution.entryId` is already the
              // real, stable id for the approve/reject path (carried
              // through from the Pending_Entry); the auto_approved path
              // has none, so it's stamped here from the ambient job
              // context (see queue/jobContext.js) — set by the
              // inbound_message handler for the exact call stack this
              // callback runs on.
              const stamped = {
                ...resolution,
                entryId: resolution.entryId || getCurrentEntryHash(),
              };
              await jobQueue.enqueueJob({
                type: 'sheet_write',
                payload: { resolution: stamped },
                id: `sheet_write-${stamped.entryId}`,
              });
            }
          : async (resolution) => {
              // v1.0/v1.1 behavior, unchanged (Rule 2).
              await sheetsWriter.writeResolution(resolution);
              await responder.notifyOutcome(resolution);
            },
      });
      await approvalEngine.init();
    } catch (err) {
      console.error('Failed to initialize Approval Engine:', err);
    }
  },

  onGroupMessage: async (sock, msg) => {
    // v1.2 — QUEUE_ENABLED=false (the default): call the Message Pipeline
    // directly, synchronously, exactly as index.js did before the queue
    // existed — bit-for-bit identical control flow (Rule 2).
    if (!jobQueue) {
      await messagePipeline.handleGroupMessage(sock, msg);
      return;
    }

    // QUEUE_ENABLED=true: enqueue is the FIRST thing that happens for
    // this message (Part A3) — no groupMetadata call, no parsing, no LLM
    // call before the job is durably stored. Only the minimal fields
    // named in Part A3 are persisted (raw text, sender JID, WhatsApp
    // message id, WhatsApp message timestamp, group id); the full `msg`
    // object is kept too so the Message Pipeline (replayed later, inside
    // the job handler) can call the exact same `extractText`/
    // `extractQuotedMessageId`/pushName logic it already relies on — this
    // is still "raw inbound data", not a derived/enriched record, so it
    // does not violate Part A3's "no other calls before the job is
    // stored" rule (nothing here has made an async call yet).
    const waMessageId = msg.key.id;
    if (!waMessageId) {
      // Extremely defensive — every real Baileys message has a key.id.
      // Fall back to direct handling rather than silently dropping a
      // message we can't dedupe safely.
      await messagePipeline.handleGroupMessage(sock, msg);
      return;
    }

    const rawTimestamp = msg.messageTimestamp;
    const messageTimestamp = rawTimestamp ? new Date(Number(rawTimestamp) * 1000) : new Date();

    // Part A4 — the deterministic hash is derived once, here, at enqueue
    // time, and carried through the job payload (and reused, unchanged,
    // on every retry of this same job — it's a pure function of
    // `waMessageId`, never regenerated).
    const entryHash = deriveEntryHash(waMessageId);

    try {
      await jobQueue.enqueueDeduped({
        waMessageId,
        type: 'inbound_message',
        payload: { msg, entryHash },
        receivedAt: messageTimestamp, // Part A3 — WA timestamp, not processing time
      });
    } catch (err) {
      // enqueueDeduped/enqueueJob already fall back to the local JSONL
      // buffer on a Redis outage (Part A6) and never throw for that case
      // — reaching here means something unexpected happened. Falling
      // back to direct (unqueued) handling is safer than silently
      // dropping the message.
      console.error('Queue: failed to enqueue inbound message, handling directly instead:', err);
      await messagePipeline.handleGroupMessage(sock, msg);
    }
  },

  onReaction: async (sock, reaction) => {
    const reactorJid = reaction.key.participant;
    // TEMP DIAGNOSTIC — remove once the "reaction isn't resolving" issue
    // is confirmed fixed. Logs exactly what Baileys handed us so we can
    // tell whether the event is arriving at all, and with what shape.
    // See GET /debug-logs (defined earlier in this file) to read these
    // back without relying on Render's dashboard log viewer.
    pushDebugLog('reaction received', {
      emoji: reaction?.reaction?.text,
      reactorJid,
      reactedMessageId: reaction?.reaction?.key?.id,
      hasApprovalEngine: Boolean(approvalEngine),
      // TEMP DIAGNOSTIC (deeper) — the FULL raw reaction event, every
      // field Baileys gave us, not just the three we normally read.
      // Looking for any alternate id (e.g. a participantAlt/remoteJidAlt
      // pair, or a second id field) that might be the real match for
      // the originally-sent message, since reaction.reaction.key.id has
      // been observed not matching what we stored at send time.
      rawReaction: reaction,
    });
    await approvalEngine?.handleReaction({
      debugListPendingNotificationIds: true, // see approvalEngine.js's TEMP DIAGNOSTIC handling of this flag
      emoji: reaction.reaction.text,
      reactorJid,
      reactedMessageId: reaction.reaction.key.id,
      // Reaction events carry no display name of their own — look up the
      // last-seen pushName for this JID (see pushNameCache.js) so a
      // reaction-based APPROVE/REJECT still records a real name whenever
      // possible, instead of always falling back to a cleaned JID.
      responderName: pushNameCache.get(reactorJid),
    });
  },
});

// v1.2 — Part A6: "On SIGTERM (Render redeploy, pm2 restart): stop
// claiming, let in-flight jobs finish (up to ~20s), release the rest."
// A no-op when the queue is off (jobQueue is null) — nothing new happens
// on SIGTERM in that case, matching today's existing shutdown behavior
// (whatever the process's default SIGTERM handling already was, which
// this code never touched before v1.2 and still doesn't when the queue
// is disabled).
let shuttingDown = false;
async function handleShutdownSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — starting graceful shutdown.`);

  if (jobQueue) {
    try {
      await jobQueue.stop({ graceMs: 20000 });
      console.log('Queue: stopped claiming; in-flight jobs finished or their leases will be reclaimed on next start.');
    } catch (err) {
      console.error('Queue: error during graceful stop:', err && err.message ? err.message : String(err));
    }
  }

  httpServer.close(() => {
    process.exit(0);
  });
  // Safety net — if the HTTP server somehow never finishes closing
  // (e.g. a stuck keepalive connection), don't hang the process
  // forever past the queue's own grace period.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
