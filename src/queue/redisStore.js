// redisStore.js
// v1.2 — Durable Job Queue (additive). Storage layer.
//
// Responsibilities:
//   - Own every Redis key the queue touches, all prefixed "wq:" (Part A1),
//     so the queue's footprint in a shared Redis instance is trivially
//     greppable and never collides with authState.js's "baileys:auth:"
//     keys.
//   - Expose a small, storage-agnostic interface (`createRedisJobStore`)
//     that `jobQueue.js` calls through — no other module ever issues a
//     raw Redis command for queue state. This interface is the seam a
//     future file/SQLite implementation (STATE_STORE-style swap, see
//     pendingStore.js's equivalent local-disk pattern) would need to
//     satisfy identically: `saveJob`, `getJob`, `scheduleReady`,
//     `claimReady`, `ack`, `markDead`, `reclaimExpiredLeases`,
//     `dedupeCheckAndSet`, `getCounts`, `listDead`, `requeueDead`.
//   - Keep the on-the-wire shape simple: one JSON string per job (Part A1
//     suggests "a hash or JSON string per job" — JSON string is chosen
//     here since the whole record is always read/written together, never
//     partially, so a hash's per-field access buys nothing and costs an
//     extra round-trip to reconstruct).
//   - Never log full job payloads (Part 5 — no message text/phone
//     numbers/keys in logs). Callers are responsible for only logging
//     job ids/types/states; this module itself never calls console.*.
//
// Redis key layout (all prefixed "wq:", per Part A1):
//   wq:job:<id>              STRING  JSON-serialized Job record
//   wq:ready                 ZSET    member=jobId, score=next_attempt_at (ms epoch)
//   wq:inflight               ZSET    member=jobId, score=lease_until (ms epoch)
//   wq:dead                   SET     member=jobId
//   wq:seen:<waMessageId>     STRING  "1", short TTL (~7 days) — enqueue dedupe

const crypto = require('crypto');

const WQ_PREFIX = 'wq:';
const JOB_KEY_PREFIX = `${WQ_PREFIX}job:`;
const READY_KEY = `${WQ_PREFIX}ready`;
const INFLIGHT_KEY = `${WQ_PREFIX}inflight`;
const DEAD_KEY = `${WQ_PREFIX}dead`;
const SEEN_KEY_PREFIX = `${WQ_PREFIX}seen:`;

const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60; // ~7 days, Part A3 dedupe window
const DONE_TTL_SECONDS = 24 * 60 * 60; // Part A2 — completed jobs expire after ~24h
const DEAD_TTL_SECONDS = 30 * 24 * 60 * 60; // Part A2 — dead jobs kept >= 30 days

function jobKey(id) {
  return `${JOB_KEY_PREFIX}${id}`;
}

/**
 * Lua script for atomically claiming the due ready jobs, up to `limit`,
 * moving each from the `ready` ZSET into the `inflight` ZSET (scored by
 * the new lease expiry) and marking it `processing` with an incremented
 * lease — all in one round trip, so no two workers (or one worker's two
 * concurrent ticks) can claim the same job (Part A3 "claim jobs
 * atomically").
 *
 * KEYS[1] = ready zset key
 * KEYS[2] = inflight zset key
 * ARGV[1] = now (ms epoch) — only jobs scored <= now are due
 * ARGV[2] = leaseUntil (ms epoch) — new inflight score
 * ARGV[3] = limit — max number of jobs to claim this call
 *
 * Returns: array of claimed job ids (strings).
 */
const CLAIM_SCRIPT = `
local ready = KEYS[1]
local inflight = KEYS[2]
local now = tonumber(ARGV[1])
local leaseUntil = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

local due = redis.call('ZRANGEBYSCORE', ready, '-inf', now, 'LIMIT', 0, limit)
if #due == 0 then
  return {}
end

for i, jobId in ipairs(due) do
  redis.call('ZREM', ready, jobId)
  redis.call('ZADD', inflight, leaseUntil, jobId)
end

return due
`;

/**
 * Lua script for atomically dequeuing every job whose inflight lease has
 * expired, back into `ready` scored "now" (immediately due) — Part A3's
 * "a crashed or frozen worker's job is reclaimed when its lease expires".
 *
 * KEYS[1] = inflight zset key
 * KEYS[2] = ready zset key
 * ARGV[1] = now (ms epoch) — leases scored <= now have expired
 *
 * Returns: array of reclaimed job ids.
 */
const RECLAIM_SCRIPT = `
local inflight = KEYS[1]
local ready = KEYS[2]
local now = tonumber(ARGV[1])

local expired = redis.call('ZRANGEBYSCORE', inflight, '-inf', now)
if #expired == 0 then
  return {}
end

for i, jobId in ipairs(expired) do
  redis.call('ZREM', inflight, jobId)
  redis.call('ZADD', ready, now, jobId)
end

return expired
`;

/**
 * Create the Redis-backed Job Store, per this file's header doc.
 *
 * @param {object} deps
 * @param {import('ioredis')} deps.redis - A connected (or lazily-
 *   connecting) ioredis-compatible client. This module never constructs
 *   its own client — `jobQueue.js` (or `index.js`) owns that lifecycle,
 *   mirroring `authState.js`'s "caller constructs, this module consumes"
 *   pattern.
 * @returns {object} The Job Store interface — see this file's header
 *   comment for the full method list.
 */
function createRedisJobStore({ redis }) {
  if (!redis) {
    throw new Error('createRedisJobStore requires a redis client.');
  }

  /**
   * @param {object} job
   * @returns {Promise<void>}
   */
  async function saveJob(job) {
    await redis.set(jobKey(job.id), JSON.stringify(job));
  }

  /**
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async function getJob(id) {
    const raw = await redis.get(jobKey(id));
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * @param {string[]} ids
   * @returns {Promise<object[]>} Only jobs that still exist (skips any
   *   id whose job record has already expired/been deleted).
   */
  async function getJobs(ids) {
    if (ids.length === 0) return [];
    const keys = ids.map(jobKey);
    const raws = await redis.mget(...keys);
    return raws.filter(Boolean).map((raw) => JSON.parse(raw));
  }

  /**
   * Atomically check-and-set the dedupe marker for a WhatsApp message id
   * (Part A3 — "Dedupe atomically on the WhatsApp message id (SET NX with
   * ~7 day TTL)").
   *
   * @param {string} waMessageId
   * @returns {Promise<boolean>} `true` if this call set the marker (i.e.
   *   this message id has not been seen before — caller should enqueue);
   *   `false` if the marker already existed (a redelivery — caller must
   *   not create a second job).
   */
  async function dedupeCheckAndSet(waMessageId) {
    const result = await redis.set(`${SEEN_KEY_PREFIX}${waMessageId}`, '1', 'EX', SEEN_TTL_SECONDS, 'NX');
    return result === 'OK';
  }

  /**
   * Add a job to the `ready` ZSET scored by `nextAttemptAtMs`, per Part
   * A1 ("a sorted set 'ready' scored by next_attempt_at"). Idempotent —
   * re-scheduling an already-ready job just updates its score.
   *
   * @param {string} jobId
   * @param {number} nextAttemptAtMs
   * @returns {Promise<void>}
   */
  async function scheduleReady(jobId, nextAttemptAtMs) {
    await redis.zadd(READY_KEY, nextAttemptAtMs, jobId);
  }

  /**
   * Enqueue a brand-new job: persist its record and schedule it ready
   * immediately (or at `job.next_attempt_at` if in the future). One
   * round trip via a pipeline, per Part A1's Upstash-command-budget
   * design goal (avoid extra round trips where a pipeline suffices).
   *
   * @param {object} job
   * @returns {Promise<void>}
   */
  async function enqueue(job) {
    const nextAttemptAtMs = new Date(job.next_attempt_at).getTime();
    const pipeline = redis.pipeline();
    pipeline.set(jobKey(job.id), JSON.stringify(job));
    pipeline.zadd(READY_KEY, nextAttemptAtMs, job.id);
    await pipeline.exec();
  }

  /**
   * Atomically claim up to `limit` due jobs from `ready`, moving them
   * into `inflight` with a lease expiring at `leaseUntilMs`, per Part A3
   * ("Claim jobs atomically (Lua script or equivalent) with a lease").
   *
   * Also updates each claimed job's own record (`state: 'processing'`,
   * `attempts += 1`, `lease_until`) — this is a second round trip (the
   * Lua script itself only touches the two ZSETs, to keep the script
   * itself small and side-effect-free on the job hashes it doesn't need
   * to read) but is bounded by `limit` (QUEUE_CONCURRENCY, default 2), so
   * it's a handful of commands per tick, not per message.
   *
   * @param {object} options
   * @param {number} [options.limit] - Max jobs to claim this call.
   *   Defaults to 2 (QUEUE_CONCURRENCY's default).
   * @param {number} [options.leaseSeconds] - Lease duration. Defaults to
   *   120 (QUEUE_LEASE_SECONDS's default).
   * @returns {Promise<object[]>} The claimed Job records, already updated
   *   to `state: 'processing'` with `attempts` incremented and
   *   `lease_until` set.
   */
  async function claimReady({ limit = 2, leaseSeconds = 120 } = {}) {
    const now = Date.now();
    const leaseUntil = now + leaseSeconds * 1000;

    const claimedIds = await redis.eval(CLAIM_SCRIPT, 2, READY_KEY, INFLIGHT_KEY, now, leaseUntil, limit);
    if (!claimedIds || claimedIds.length === 0) return [];

    const jobs = await getJobs(claimedIds);
    const updated = jobs.map((job) => ({
      ...job,
      state: 'processing',
      attempts: job.attempts + 1,
      lease_until: new Date(leaseUntil).toISOString(),
    }));

    if (updated.length > 0) {
      const pipeline = redis.pipeline();
      for (const job of updated) {
        pipeline.set(jobKey(job.id), JSON.stringify(job));
      }
      await pipeline.exec();
    }

    return updated;
  }

  /**
   * Reclaim every inflight job whose lease has expired, moving it back
   * into `ready` (due immediately) — Part A3/A6's crash-recovery
   * guarantee. Safe to call on startup and periodically from the
   * sweeper (Part A1 — "run a slow sweeper ... only for recovery").
   *
   * Does NOT touch the job records' own `state` field here — a reclaimed
   * job is re-claimed via the normal `claimReady` path next tick, which
   * re-sets `state: 'processing'` and increments `attempts` at that
   * point. Between reclaim and re-claim the record's `state` may still
   * read `'processing'` even though it's sitting in `ready` again; this
   * is harmless (no code branches on `state` outside claim/ack/fail) and
   * avoids a third round trip here purely to flip a label.
   *
   * @returns {Promise<string[]>} Ids of jobs that were reclaimed.
   */
  async function reclaimExpiredLeases() {
    const now = Date.now();
    const reclaimed = await redis.eval(RECLAIM_SCRIPT, 2, INFLIGHT_KEY, READY_KEY, now);
    return reclaimed || [];
  }

  /**
   * Mark a job done: remove it from `inflight`, delete it from `ready`
   * (defensive — it should already be absent), and persist the final
   * record with a short TTL (Part A2 — "Completed jobs expire after
   * ~24h") rather than deleting it outright, so a `/queue` inspection or
   * a delayed duplicate-detection check shortly after completion can
   * still see it.
   *
   * @param {object} job - The job record to persist as done (caller sets
   *   `state: 'done'` before calling, or this function does it here).
   * @returns {Promise<void>}
   */
  async function ack(job) {
    const doneJob = { ...job, state: 'done', lease_until: null };
    const pipeline = redis.pipeline();
    pipeline.zrem(INFLIGHT_KEY, job.id);
    pipeline.zrem(READY_KEY, job.id);
    pipeline.set(jobKey(job.id), JSON.stringify(doneJob), 'EX', DONE_TTL_SECONDS);
    await pipeline.exec();
  }

  /**
   * Reschedule a job for a future retry (transient/blocked failure path,
   * Part A5) — moves it back into `ready` scored at the new
   * `next_attempt_at`, persists the updated record (attempts/last_error
   * already reflected by the caller), and removes it from `inflight`.
   *
   * @param {object} job - The updated job record (state should be
   *   'queued' again; caller sets attempts/next_attempt_at/last_error
   *   before calling).
   * @returns {Promise<void>}
   */
  async function reschedule(job) {
    const nextAttemptAtMs = new Date(job.next_attempt_at).getTime();
    const pipeline = redis.pipeline();
    pipeline.zrem(INFLIGHT_KEY, job.id);
    pipeline.zadd(READY_KEY, nextAttemptAtMs, job.id);
    pipeline.set(jobKey(job.id), JSON.stringify(job));
    await pipeline.exec();
  }

  /**
   * Dead-letter a job (Part A5 — permanent failures, or transient
   * failures that exceeded QUEUE_MAX_AGE_HOURS). Never deletes the
   * record (Part A5 — "Nothing is ever deleted because of a failure"):
   * persists it with the long dead-letter TTL (>= 30 days, Part A2) and
   * adds its id to the `dead` set for `/queue`/`/queue retry` lookups.
   *
   * @param {object} job - The job record, with `state: 'dead'` and
   *   `last_error` already set by the caller.
   * @returns {Promise<void>}
   */
  async function markDead(job) {
    const deadJob = { ...job, state: 'dead', lease_until: null };
    const pipeline = redis.pipeline();
    pipeline.zrem(INFLIGHT_KEY, job.id);
    pipeline.zrem(READY_KEY, job.id);
    pipeline.sadd(DEAD_KEY, job.id);
    pipeline.set(jobKey(job.id), JSON.stringify(deadJob), 'EX', DEAD_TTL_SECONDS);
    await pipeline.exec();
  }

  /**
   * @returns {Promise<string[]>} Every job id currently in the dead set.
   */
  async function listDeadIds() {
    return redis.smembers(DEAD_KEY);
  }

  /**
   * Requeue every currently dead job back into `ready`, immediately due,
   * with `attempts` reset to 0 — the `/queue retry` admin command (Part
   * A7). Clears the `dead` set entry for each job requeued.
   *
   * @returns {Promise<number>} Count of jobs requeued.
   */
  async function requeueDead() {
    const ids = await listDeadIds();
    if (ids.length === 0) return 0;

    const jobs = await getJobs(ids);
    const now = Date.now();
    const pipeline = redis.pipeline();
    for (const job of jobs) {
      const requeued = {
        ...job,
        state: 'queued',
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date(now).toISOString(),
        lease_until: null,
      };
      pipeline.set(jobKey(job.id), JSON.stringify(requeued));
      pipeline.zadd(READY_KEY, now, job.id);
      pipeline.srem(DEAD_KEY, job.id);
    }
    await pipeline.exec();
    return jobs.length;
  }

  /**
   * Counts by state, plus oldest-job age and dead count — everything the
   * `/queue` admin command and `GET /health` need, in a small, fixed
   * number of Redis commands regardless of queue depth (Part A7 — "Do
   * not include message text in the output" is enforced by callers only
   * ever reading this summary, never a raw job record, for those two
   * surfaces).
   *
   * "Oldest job age" is measured from each job's own `received_at`
   * (Part A2/A7's actual notion of "how long has this been waiting",
   * used by "/queue"'s "oldest job age" and the
   * QUEUE_ALERT_OLDEST_MINUTES alert) — NOT from the ready/inflight
   * ZSET scores, which are scheduling metadata (next_attempt_at /
   * lease_until, i.e. points in the FUTURE relative to "now" for a
   * healthy job) rather than an age. The oldest member of each ZSET by
   * score is still the right one to fetch (the earliest-scheduled ready
   * job, or the earliest-leased inflight job, is also the one most
   * likely to have been waiting longest overall) — only the age
   * computation itself reads that job's `received_at` field instead of
   * reusing the ZSET score as if it were a timestamp of "when this
   * started waiting".
   *
   * @returns {Promise<{
   *   queued: number,
   *   inflight: number,
   *   dead: number,
   *   oldestReadyAgeMs: number|null,
   *   oldestInflightAgeMs: number|null,
   * }>}
   */
  async function getCounts() {
    const now = Date.now();
    const pipeline = redis.pipeline();
    pipeline.zcard(READY_KEY);
    pipeline.zcard(INFLIGHT_KEY);
    pipeline.scard(DEAD_KEY);
    pipeline.zrange(READY_KEY, 0, 0);
    pipeline.zrange(INFLIGHT_KEY, 0, 0);
    const results = await pipeline.exec();

    const [queuedRes, inflightRes, deadRes, oldestReadyIdRes, oldestInflightIdRes] = results;
    const queued = queuedRes[1];
    const inflight = inflightRes[1];
    const dead = deadRes[1];
    const oldestReadyId = oldestReadyIdRes[1] && oldestReadyIdRes[1][0];
    const oldestInflightId = oldestInflightIdRes[1] && oldestInflightIdRes[1][0];

    const [oldestReadyJob, oldestInflightJob] = await Promise.all([
      oldestReadyId ? getJob(oldestReadyId) : Promise.resolve(null),
      oldestInflightId ? getJob(oldestInflightId) : Promise.resolve(null),
    ]);

    const ageOf = (job) => (job && job.received_at ? now - new Date(job.received_at).getTime() : null);

    return {
      queued,
      inflight,
      dead,
      oldestReadyAgeMs: ageOf(oldestReadyJob),
      oldestInflightAgeMs: ageOf(oldestInflightJob),
    };
  }

  return {
    saveJob,
    getJob,
    getJobs,
    dedupeCheckAndSet,
    scheduleReady,
    enqueue,
    claimReady,
    reclaimExpiredLeases,
    ack,
    reschedule,
    markDead,
    listDeadIds,
    requeueDead,
    getCounts,
  };
}

module.exports = {
  createRedisJobStore,
  WQ_PREFIX,
  JOB_KEY_PREFIX,
  READY_KEY,
  INFLIGHT_KEY,
  DEAD_KEY,
  SEEN_KEY_PREFIX,
  SEEN_TTL_SECONDS,
  DONE_TTL_SECONDS,
  DEAD_TTL_SECONDS,
  CLAIM_SCRIPT,
  RECLAIM_SCRIPT,
};
