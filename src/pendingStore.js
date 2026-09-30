// pendingStore.js
// Phase 4 — Approval Engine internal module. See
// .kiro/specs/approval-engine/design.md "Persistence Strategy" for the
// full design context.
//
// Responsibilities (this file, Task 4.1 only):
//   - Hold the in-memory index of currently-pending entries
//     (Map<entryId, Pending_Entry>) and a derived reverse index
//     (Map<notificationMessageId, entryId>) used by the Reaction Matcher.
//   - Provide an atomic full-file-replace write primitive: serialize the
//     current pending entries to `<storePath>.tmp` then `fs.rename` it over
//     the real store path, so a crash mid-write never leaves a
//     truncated/corrupt store file on disk.
//
// Task 4.2 (init/add/update) and Task 4.3 (resolveIfPending + per-entry
// locking) build on top of the building blocks exported here — this file
// intentionally does not implement load-from-disk, add/update semantics,
// or locking; it only establishes the in-memory state shape and the atomic
// write primitive those later tasks will call.

const fs = require('fs');
const path = require('path');

const { appendAuditLog } = require('./auditLog');

const STORE_VERSION = 1;

/**
 * Create a fresh, empty Pending_Store in-memory state container.
 *
 * Shape (per design.md "Persistence Strategy — In-memory index"):
 *   - entriesMap: Map<entryId, Pending_Entry> — the source of truth for all
 *     currently-pending entries held in memory. Later tasks (4.2, 4.3)
 *     mutate this map directly (add/update/resolve).
 *   - notificationIndex: Map<notificationMessageId, entryId> — a derived
 *     reverse index used by the Reaction Matcher to find the Pending_Entry
 *     a given WhatsApp message id belongs to. Always rebuildable from
 *     entriesMap via `rebuildNotificationIndex` below — never authoritative
 *     on its own.
 *
 * @returns {{
 *   entriesMap: Map<string, object>,
 *   notificationIndex: Map<string, string>,
 * }}
 */
function createPendingStoreState() {
  return {
    entriesMap: new Map(),
    notificationIndex: new Map(),
  };
}

/**
 * Rebuild the notification-message-id reverse index from `entriesMap`.
 *
 * Iterates every entry's `notificationMessageIds` array and maps each
 * message id back to its owning `entryId`. Intended to be called after any
 * operation that changes `entriesMap` wholesale (e.g. startup load) or an
 * individual entry's `notificationMessageIds` (e.g. after notifying
 * admins) — see design.md "Reaction Matcher" and "Persistence Strategy —
 * In-memory index".
 *
 * @param {Map<string, object>} entriesMap
 * @returns {Map<string, string>} A brand-new notification-message-id ->
 *   entryId map reflecting only the entries currently in `entriesMap`.
 */
function rebuildNotificationIndex(entriesMap) {
  const notificationIndex = new Map();
  for (const [entryId, entry] of entriesMap.entries()) {
    const messageIds = (entry && entry.notificationMessageIds) || [];
    for (const messageId of messageIds) {
      notificationIndex.set(messageId, entryId);
    }
  }
  return notificationIndex;
}

/**
 * Atomically replace the Pending_Store file at `storePath` with the current
 * contents of `entriesMap`.
 *
 * Per design.md "Persistence Strategy — Writes are atomic full-file
 * replaces": the entire current in-memory entry list is serialized to a
 * temp file (`<storePath>.tmp`) and then `fs.rename`d over the real path,
 * which is atomic on the same filesystem/volume. This avoids ever leaving a
 * truncated/corrupt store file behind if the process crashes mid-write.
 *
 * Only entries with `status === 'pending'` are written, per the
 * Pending_Store on-disk shape note in design.md's "Data Models" section:
 * the store only ever holds unresolved entries — resolved entries are
 * removed, not archived, in this store.
 *
 * Creates the containing directory (recursive) if it doesn't already
 * exist, mirroring `appendAuditLog` in `auditLog.js`.
 *
 * @param {string} storePath - Path to the store file (e.g.
 *   `./data/pending-store.json`).
 * @param {Map<string, object>} entriesMap - The in-memory entries to
 *   persist. Only entries with `status === 'pending'` are included in the
 *   written file.
 * @returns {Promise<void>}
 */
async function atomicWriteStore(storePath, entriesMap) {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const pendingEntries = Array.from(entriesMap.values()).filter(
    (entry) => entry && entry.status === 'pending',
  );

  const contents = {
    version: STORE_VERSION,
    entries: pendingEntries,
  };

  const tmpPath = `${storePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(contents, null, 2), {
    encoding: 'utf8',
  });
  await fs.promises.rename(tmpPath, storePath);
}

/**
 * Validate that parsed store file content matches the expected on-disk
 * shape: `{ version, entries: Pending_Entry[] }`.
 *
 * Only checks the minimal shape needed to safely build `entriesMap` —
 * individual `Pending_Entry` field validation is out of scope here (the
 * store is trusted internal state, not external input).
 *
 * @param {*} parsed - The result of `JSON.parse`-ing the store file.
 * @returns {boolean}
 */
function isValidStoreShape(parsed) {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray(parsed.entries)
  );
}

/**
 * Load a Pending_Store from disk into a fresh in-memory state, per
 * design.md "Persistence Strategy — Startup load".
 *
 * Handles every startup edge case described by Requirement 8.4/8.5:
 *   - Missing file: returns a fresh empty state (no error).
 *   - Empty/whitespace-only file: returns a fresh empty state (no error).
 *   - Unparseable JSON, or JSON that doesn't match the expected
 *     `{ version, entries: [...] }` shape: appends a `store_load_corrupt`
 *     audit log entry, then returns a fresh empty state. If the audit log
 *     write itself throws/rejects, that error is NOT caught here — it
 *     propagates up so the process crashes (Requirement 8.5).
 *   - Valid content: builds `entriesMap` keyed by `entryId` and rebuilds
 *     the notification-message-id reverse index from it.
 *
 * @param {string} storePath - Path to the store file.
 * @param {string} auditLogPath - Path to the audit log file, used only on
 *   the corrupt-content path.
 * @returns {Promise<{entriesMap: Map<string, object>, notificationIndex: Map<string, string>}>}
 */
async function loadStoreFromDisk(storePath, auditLogPath) {
  let raw;
  try {
    raw = await fs.promises.readFile(storePath, { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return createPendingStoreState(); // Req 8.4 — missing file
    }
    throw err;
  }

  if (raw.trim().length === 0) {
    return createPendingStoreState(); // Req 8.4 — empty/whitespace file
  }

  let parsed;
  let parseError = null;
  try {
    parsed = JSON.parse(raw);
    if (!isValidStoreShape(parsed)) {
      parseError = new Error('Pending_Store file does not match expected shape');
    }
  } catch (err) {
    parseError = err;
  }

  if (parseError) {
    // Req 8.5 — log the corruption. If this write itself fails, let it
    // propagate uncaught so the process crashes rather than silently
    // continuing with an unlogged data-corruption condition.
    await appendAuditLog(auditLogPath, {
      event: 'store_load_corrupt',
      at: new Date().toISOString(),
      detail: parseError.message,
    });
    return createPendingStoreState();
  }

  const entriesMap = new Map();
  for (const entry of parsed.entries) {
    if (entry && entry.entryId) {
      entriesMap.set(entry.entryId, entry);
    }
  }
  const notificationIndex = rebuildNotificationIndex(entriesMap);

  return { entriesMap, notificationIndex };
}

/**
 * Create a Pending_Store facade wrapping in-memory state plus the disk
 * operations that keep it durable, per design.md "Persistence Strategy"
 * and "Module boundary".
 *
 * Task 4.3 adds `resolveIfPending`, the single atomicity point for
 * first-response-wins (see design.md "Concurrency Handling
 * (First-Response-Wins)"). Its per-`entryId` lock (`withEntryLock`) is
 * scoped to this `createPendingStore` instance (a closure-local Map, not a
 * module-level one) — each store instance manages exactly one on-disk file
 * and one in-memory index, so scoping the lock per-instance is both
 * sufficient (no two calls against the *same* entryId in *this* instance's
 * state can race) and correctly isolated (a second store instance pointed
 * at a different file, e.g. in tests, never shares or contends for locks
 * with this one). A module-global lock map would also "work" for the
 * single-process bot (only one store instance is ever constructed in
 * production, per `index.js` wiring), but instance-scoping avoids any
 * cross-test leakage when multiple stores are created in the same process
 * (as the sanity checks below do) and has no downside here.
 *
 * @param {{storePath: string, auditLogPath: string}} options
 * @returns {{
 *   init: () => Promise<void>,
 *   add: (pendingEntry: object) => Promise<void>,
 *   update: (pendingEntry: object) => Promise<void>,
 *   getById: (entryId: string) => object | undefined,
 *   getAllIds: () => string[],
 *   findByNotificationMessageId: (messageId: string) => object | undefined,
 *   resolveIfPending: (entryId: string, fields: {status: string, resolvedBy: string, resolvedAt: string}) => Promise<object>,
 * }}
 */
function createPendingStore({ storePath, auditLogPath }) {
  let state = createPendingStoreState();

  // Per-entryId promise-chain lock, scoped to this store instance (see
  // rationale in the factory doc comment above). Each entry in this map is
  // the tail promise of the chain of `withEntryLock` calls queued for that
  // entryId; a call for an entryId with no current chain runs immediately.
  const entryLockChains = new Map();

  /**
   * Serialize calls to `fn` per `entryId`: a call for a given `entryId`
   * always awaits the completion (success or failure) of the previous
   * call queued for that same `entryId` before running. Calls for
   * different `entryId`s never wait on each other.
   *
   * @param {string} entryId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  function withEntryLock(entryId, fn) {
    // Chained tails stored in `entryLockChains` are constructed (below) to
    // always resolve, never reject, so `previous` is safe to `.then(fn)`
    // directly regardless of whether the call before it succeeded or
    // threw.
    const previous = entryLockChains.get(entryId) || Promise.resolve();
    const run = previous.then(fn);
    // The tail we store swallows `run`'s outcome (success or failure) so
    // that a rejection never gets "stuck" in the map — otherwise every
    // subsequent call queued for this entryId would fail its own
    // `await previous` before ever invoking its own `fn`. `run` itself
    // still resolves/rejects normally for this call's caller.
    entryLockChains.set(
      entryId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  return {
    /**
     * Load the store from disk (per `loadStoreFromDisk`) and populate the
     * in-memory state. Must be called once before any other method is
     * used meaningfully (mirrors `engine.init()` in design.md).
     */
    async init() {
      state = await loadStoreFromDisk(storePath, auditLogPath);
    },

    /**
     * Add a brand-new pending entry, persisting it durably before
     * returning (Requirement 8.1). Any write failure propagates to the
     * caller.
     *
     * @param {object} pendingEntry - Must have a unique `entryId`.
     */
    async add(pendingEntry) {
      state.entriesMap.set(pendingEntry.entryId, pendingEntry);
      await atomicWriteStore(storePath, state.entriesMap);
      state.notificationIndex = rebuildNotificationIndex(state.entriesMap);
    },

    /**
     * Persist updated fields on an existing pending entry (e.g. after
     * notifying admins, `notificationMessageIds`), refreshing the reverse
     * index afterward. Any write failure propagates to the caller.
     *
     * @param {object} pendingEntry - Replaces the entry currently stored
     *   under `pendingEntry.entryId`.
     */
    async update(pendingEntry) {
      state.entriesMap.set(pendingEntry.entryId, pendingEntry);
      await atomicWriteStore(storePath, state.entriesMap);
      state.notificationIndex = rebuildNotificationIndex(state.entriesMap);
    },

    /**
     * @param {string} entryId
     * @returns {object | undefined}
     */
    getById(entryId) {
      return state.entriesMap.get(entryId);
    },

    /**
     * @returns {string[]} All entryIds currently in memory, used for
     *   uniqueness checks feeding `generateUniqueEntryId` (Task 3).
     */
    getAllIds() {
      return Array.from(state.entriesMap.keys());
    },

    /**
     * @param {string} messageId - A Baileys Notification_Message id.
     * @returns {object | undefined} The Pending_Entry that owns this
     *   notification message id, if any.
     */
    findByNotificationMessageId(messageId) {
      const entryId = state.notificationIndex.get(messageId);
      return entryId ? state.entriesMap.get(entryId) : undefined;
    },

    /**
     * The single atomicity point for first-response-wins (design.md
     * "Concurrency Handling (First-Response-Wins)"). Serializes against
     * any other `resolveIfPending` call for the same `entryId` via
     * `withEntryLock`; calls for different `entryId`s proceed
     * concurrently.
     *
     * - If the entry is missing or already resolved (`status !==
     *   'pending'`), returns `{ outcome: 'already_resolved', resolvedBy,
     *   status }` without mutating anything (Requirement 6.2).
     * - Otherwise mutates the in-memory record's `status`/`resolvedBy`/
     *   `resolvedAt` and persists the removal by re-running the atomic
     *   write (which filters to `status === 'pending'` only, so writing
     *   after the mutation naturally drops this entry from the on-disk
     *   file — "persistRemoval" per design.md). The notification reverse
     *   index is refreshed afterward; leaving stale entries pointing at a
     *   resolved record is harmless since both `handleReaction` and
     *   `processDecision` re-check `status` before acting, but rebuilding
     *   keeps the index consistent with `entriesMap` regardless.
     * - If the persist fails, the in-memory status is rolled back to
     *   `'pending'` and the error is propagated (thrown) rather than
     *   returned, per Requirement 8.2 ("treat the resolution as
     *   incomplete until removal succeeds").
     *
     * @param {string} entryId
     * @param {{status: 'approved'|'rejected', resolvedBy: string, resolvedAt: string}} fields
     * @returns {Promise<
     *   {outcome: 'already_resolved', resolvedBy?: string, status?: string} |
     *   {outcome: 'newly_resolved', record: object}
     * >}
     */
    resolveIfPending(entryId, fields) {
      return withEntryLock(entryId, async () => {
        const record = state.entriesMap.get(entryId);
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
          await atomicWriteStore(storePath, state.entriesMap); // persistRemoval, Req 8.2
        } catch (err) {
          // Roll back — the resolution never durably landed, so treat it
          // as if it never happened in memory either (Requirement 8.2).
          record.status = previousStatus;
          record.resolvedBy = previousResolvedBy;
          record.resolvedAt = previousResolvedAt;
          throw err;
        }

        state.notificationIndex = rebuildNotificationIndex(state.entriesMap);
        return { outcome: 'newly_resolved', record };
      });
    },
  };
}

module.exports = {
  STORE_VERSION,
  createPendingStoreState,
  rebuildNotificationIndex,
  atomicWriteStore,
  loadStoreFromDisk,
  createPendingStore,
};
