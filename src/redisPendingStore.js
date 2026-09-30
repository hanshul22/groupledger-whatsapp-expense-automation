// redisPendingStore.js
// v1.2 — Durable Job Queue (additive). Redis-backed Pending_Store.
//
// Responsibilities:
//   - Implement EXACTLY the same public interface AND SYNCHRONOUS-READ
//     CONTRACT as pendingStore.js's `createPendingStore`, so
//     approvalEngine.js needs ZERO changes to use this store instead —
//     it is passed in as a drop-in replacement, selected by
//     STATE_STORE=redis|file (Part A6). See index.js's queue wiring for
//     the selection logic.
//
//     Concretely, approvalEngine.js calls `pendingStore.getAllIds()`
//     (submitEntry) and `pendingStore.getById(entryId)` (handleTextMessage)
//     WITHOUT awaiting them — mirroring pendingStore.js's own synchronous
//     Map-backed reads. This store therefore follows the EXACT SAME
//     architecture pendingStore.js uses: an in-memory Map is the
//     synchronous source of truth for every read; Redis is written
//     through to on every mutation purely for durability (surviving a
//     Render restart, Part A6), and read back wholesale exactly once, in
//     `init()`, to repopulate that Map — the same "startup load, then
//     in-memory index" shape as pendingStore.js's own
//     `loadStoreFromDisk`/`entriesMap`, just backed by Redis instead of a
//     JSON file.
//
//   - Persist Pending_Entry records in Redis (Upstash), so a Render
//     redeploy/restart (no persistent disk) never loses an in-flight
//     approval — Part A6: "Render has no persistent disk" is exactly why
//     this store exists.
//   - Also persist the normalized entry + meta on every Pending_Entry
//     (already part of the Pending_Entry shape pendingStore.js defines —
//     this store doesn't change that shape at all, only where it's
//     stored), so approval never re-calls the LLM even across a process
//     restart (Part A6).
//
// Redis key layout (prefixed "wq:pending:" — distinct from the job
// queue's own "wq:job:"/"wq:ready" etc. keys in redisStore.js, and from
// authState.js's "baileys:auth:" keys):
//   wq:pending:entry:<entryId>              STRING  JSON-serialized Pending_Entry
//   wq:pending:ids                          SET     every entryId ever added
//   wq:pending:notif:<notificationMsgId>    STRING  entryId (reverse index)
//
// Concurrency: first-response-wins is enforced by an in-memory per-
// entryId promise-chain lock, identical in spirit to pendingStore.js's
// `withEntryLock` — sufficient because this process is the only writer
// of Pending_Entry records (Baileys is single-connection; only one Node
// process ever runs this bot against one WhatsApp session at a time).

const KEY_PREFIX = 'wq:pending:';
const ENTRY_KEY_PREFIX = `${KEY_PREFIX}entry:`;
const IDS_KEY = `${KEY_PREFIX}ids`;
const NOTIF_KEY_PREFIX = `${KEY_PREFIX}notif:`;

function entryKey(entryId) {
  return `${ENTRY_KEY_PREFIX}${entryId}`;
}

function notifKey(messageId) {
  return `${NOTIF_KEY_PREFIX}${messageId}`;
}

/**
 * Rebuild the notification-message-id -> entryId reverse index from an
 * entries Map, mirroring pendingStore.js's `rebuildNotificationIndex`.
 *
 * @param {Map<string, object>} entriesMap
 * @returns {Map<string, string>}
 */
function rebuildNotificationIndex(entriesMap) {
  const index = new Map();
  for (const [entryId, entry] of entriesMap.entries()) {
    for (const messageId of (entry && entry.notificationMessageIds) || []) {
      index.set(messageId, entryId);
    }
  }
  return index;
}

/**
 * Create a Redis-backed Pending_Store, per this file's header doc.
 *
 * @param {object} deps
 * @param {import('ioredis')} deps.redis - A connected (or lazily-
 *   connecting) ioredis-compatible client — the SAME client the job
 *   queue uses (see queue/setup.js), reusing the connection per Rule 4.
 * @returns {object} The exact same interface AND synchronous-read
 *   contract as pendingStore.js's `createPendingStore` return value.
 */
function createRedisPendingStore({ redis }) {
  if (!redis) {
    throw new Error('createRedisPendingStore requires a redis client.');
  }

  // In-memory source of truth for every entry this store instance knows
  // about (both pending and resolved — unlike pendingStore.js's on-disk
  // file, which only ever persists pending entries, keeping resolved
  // ones in memory here is harmless and lets getAllIds/getById stay
  // simple single-Map reads). Populated wholesale by `init()` and kept
  // current by every `add`/`update`/`resolveIfPending` call.
  let entriesMap = new Map();
  let notificationIndex = new Map();

  const entryLockChains = new Map();
  function withEntryLock(entryId, fn) {
    const previous = entryLockChains.get(entryId) || Promise.resolve();
    const run = previous.then(fn);
    entryLockChains.set(
      entryId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async function persist(pendingEntry) {
    const pipeline = redis.pipeline();
    pipeline.set(entryKey(pendingEntry.entryId), JSON.stringify(pendingEntry));
    pipeline.sadd(IDS_KEY, pendingEntry.entryId);
    for (const messageId of pendingEntry.notificationMessageIds || []) {
      pipeline.set(notifKey(messageId), pendingEntry.entryId);
    }
    await pipeline.exec();
  }

  return {
    /**
     * Load every known entryId from Redis, fetch each full record, and
     * populate the in-memory `entriesMap`/`notificationIndex` — the
     * "startup load" step, mirroring pendingStore.js's `init()` (which
     * loads its on-disk file into the same shape).
     *
     * @returns {Promise<void>}
     */
    async init() {
      const ids = await redis.smembers(IDS_KEY);
      if (ids.length === 0) return;

      const keys = ids.map(entryKey);
      const raws = await redis.mget(...keys);

      const freshMap = new Map();
      raws.forEach((raw, i) => {
        if (raw) {
          const entry = JSON.parse(raw);
          freshMap.set(ids[i], entry);
        }
      });
      entriesMap = freshMap;
      notificationIndex = rebuildNotificationIndex(entriesMap);
    },

    /**
     * Add a brand-new pending entry: update the in-memory index first
     * (so a synchronous `getAllIds()`/`getById()` immediately after this
     * resolves sees it), then persist to Redis for durability.
     *
     * @param {object} pendingEntry
     */
    async add(pendingEntry) {
      entriesMap.set(pendingEntry.entryId, pendingEntry);
      notificationIndex = rebuildNotificationIndex(entriesMap);
      await persist(pendingEntry);
    },

    /**
     * Persist updated fields on an existing pending entry (e.g. after
     * notifying admins) — same shape as pendingStore.js's `update`.
     *
     * @param {object} pendingEntry
     */
    async update(pendingEntry) {
      entriesMap.set(pendingEntry.entryId, pendingEntry);
      notificationIndex = rebuildNotificationIndex(entriesMap);
      await persist(pendingEntry);
    },

    /**
     * SYNCHRONOUS, matching pendingStore.js's exact contract —
     * approvalEngine.js's `handleTextMessage` calls
     * `const pendingEntry = pendingStore.getById(entryId);` without an
     * `await`.
     *
     * @param {string} entryId
     * @returns {object|undefined}
     */
    getById(entryId) {
      return entriesMap.get(entryId);
    },

    /**
     * SYNCHRONOUS, matching pendingStore.js's exact contract —
     * approvalEngine.js's `submitEntry` calls
     * `const existingIds = pendingStore.getAllIds();` without an
     * `await` and feeds the result straight into entryId.js's
     * synchronous `new Set(existingIds)`.
     *
     * @returns {string[]}
     */
    getAllIds() {
      return Array.from(entriesMap.keys());
    },

    /**
     * SYNCHRONOUS, matching pendingStore.js's exact contract —
     * approvalEngine.js's `handleTextMessage`/`handleReaction` call this
     * without an `await` too.
     *
     * @param {string} messageId
     * @returns {object|undefined}
     */
    findByNotificationMessageId(messageId) {
      const entryId = notificationIndex.get(messageId);
      return entryId ? entriesMap.get(entryId) : undefined;
    },

    /**
     * The single atomicity point for first-response-wins, matching
     * pendingStore.js's `resolveIfPending` contract exactly (same return
     * shape: `{outcome: 'already_resolved', ...}` or
     * `{outcome: 'newly_resolved', record}`). Mutates the in-memory
     * record synchronously inside the lock, then persists — if the
     * persist fails, rolls back the in-memory mutation and rethrows,
     * mirroring pendingStore.js's own rollback-on-persist-failure
     * behavior.
     *
     * @param {string} entryId
     * @param {{status: 'approved'|'rejected', resolvedBy: string, resolvedAt: string}} fields
     * @returns {Promise<object>}
     */
    resolveIfPending(entryId, fields) {
      return withEntryLock(entryId, async () => {
        const record = entriesMap.get(entryId);
        if (!record || record.status !== 'pending') {
          return {
            outcome: 'already_resolved',
            resolvedBy: record ? record.resolvedBy : undefined,
            status: record ? record.status : undefined,
          };
        }

        const previousStatus = record.status;
        const previousResolvedBy = record.resolvedBy;
        const previousResolvedAt = record.resolvedAt;

        record.status = fields.status;
        record.resolvedBy = fields.resolvedBy;
        record.resolvedAt = fields.resolvedAt;

        try {
          await persist(record);
        } catch (err) {
          record.status = previousStatus;
          record.resolvedBy = previousResolvedBy;
          record.resolvedAt = previousResolvedAt;
          throw err;
        }

        return { outcome: 'newly_resolved', record };
      });
    },
  };
}

module.exports = {
  createRedisPendingStore,
  KEY_PREFIX,
  ENTRY_KEY_PREFIX,
  IDS_KEY,
  NOTIF_KEY_PREFIX,
};
