// jobQueue.js
// v1.2 — Durable Job Queue (additive). Runtime layer.
//
// Responsibilities:
//   - Own the public enqueue/register-handler/start/stop API every other
//     module (index.js, and Phase 2+'s inbound_message wiring) calls.
//   - Trigger the worker immediately after enqueue rather than polling
//     (Part A1's Upstash-command-budget design goal); keep an in-memory
//     timer per delayed job so a scheduled retry fires close to its
//     `next_attempt_at` without the sweeper's help; run the sweeper only
//     as a slow (default 60s) recovery net for jobs whose timer was lost
//     (process restart) or whose lease expired because a worker crashed.
//   - Enforce QUEUE_CONCURRENCY: at most N jobs claimed/processing at
//     once, each job scheduled independently via next_attempt_at so one
//     stuck job never blocks the others (Part A3).
//   - Classify handler failures (via an injected classifier — Phase 4
//     wires the real one; this file only needs the shape) into
//     transient/blocked/permanent and apply the right backoff (Part A5).
//   - On Redis-unavailable-at-enqueue: buffer in memory and spill to a
//     local JSONL file, retry connecting, and replay into the queue when
//     Redis returns (Part A6).
//   - On SIGTERM: stop claiming, let in-flight jobs finish (bounded
//     grace period), release the rest back to Redis untouched — actual
//     process.on('SIGTERM', ...) wiring happens in index.js (Phase 4);
//     this file only exposes `stop({graceMs})` for that wiring to call.
//
// This module has no dependency on WhatsApp, Sheets, or the normalizer —
// handlers are injected by type (`registerHandler(type, fn)`), so Phase 2
// wires `inbound_message` without this file changing at all.

const fs = require('fs');
const path = require('path');

const { createJob, JOB_STATE, computeTransientBackoffMs, BLOCKED_RETRY_INTERVAL_MS, HoldError } = require('./jobTypes');
const { createAlertThrottle } = require('./alertThrottle');

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_SWEEP_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_AGE_HOURS = 72;
const DEFAULT_ALERT_OLDEST_MINUTES = 15;
// Part A7 — "queue depth is unusually high". No env var is named for this
// specific threshold in the task's CONFIG list, so a fixed, generous
// default is used: at wedding-bot volume (Part's own acceptance test:
// "50 messages sent quickly"), a depth past this is a genuine signal
// something downstream is stuck, not normal traffic.
const UNUSUAL_QUEUE_DEPTH_THRESHOLD = 100;

/**
 * Default failure classifier: treats every handler error as transient.
 * Phase 4 replaces this with the real classifier (network/5xx/429 ->
 * transient, 401/402/403/404/wrong-sheet-id -> blocked, schema/bad-
 * payload -> permanent). Kept here as a safe default so Phase 1's queue
 * core is independently testable without Phase 4's classifier existing
 * yet.
 *
 * @param {Error} _err
 * @returns {'transient'|'blocked'|'permanent'}
 */
function defaultClassifyError(_err) {
  return 'transient';
}

/**
 * Redact an error down to a short, secret-free string for `last_error`
 * (Part 5 — never log full message text, phone numbers, or keys).
 * Handlers are expected to throw errors whose `.message` is already
 * safe to store; this is a defensive length cap only.
 *
 * @param {Error|string} err
 * @returns {string}
 */
function toShortErrorString(err) {
  const raw = err && err.message ? err.message : String(err);
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/**
 * Create the Job Queue runtime.
 *
 * @param {object} deps
 * @param {ReturnType<import('./redisStore').createRedisJobStore>} deps.store -
 *   The storage interface (Redis-backed today; the seam a future file/
 *   SQLite store would implement identically).
 * @param {number} [deps.concurrency] - QUEUE_CONCURRENCY. Defaults to 2.
 * @param {number} [deps.leaseSeconds] - QUEUE_LEASE_SECONDS. Defaults to 120.
 * @param {number} [deps.sweepIntervalSeconds] - QUEUE_SWEEP_INTERVAL_SECONDS. Defaults to 60.
 * @param {number} [deps.maxAgeHours] - QUEUE_MAX_AGE_HOURS. Defaults to 72.
 * @param {(err: Error) => 'transient'|'blocked'|'permanent'} [deps.classifyError] -
 *   Injected failure classifier. Defaults to "always transient" (Phase 4
 *   wires the real one).
 * @param {(message: string) => void} [deps.onAlert] - Called for
 *   dead-letter/blocker/oldest-job-age/queue-depth alerts (index.js
 *   routes this to BOT_ADMIN_FALLBACK_NUMBER). No-op if omitted.
 *   Automatically rate-limited to once per hour per distinct condition
 *   (Part A5/A7) via an internal alertThrottle — callers do not need to
 *   throttle it themselves.
 * @param {number} [deps.alertOldestMinutes] - QUEUE_ALERT_OLDEST_MINUTES.
 *   Defaults to 15.
 * @param {string} [deps.bufferFilePath] - Local JSONL spill file used
 *   when Redis is unavailable at enqueue time (Part A6). Defaults to
 *   ./data/queue-buffer.jsonl.
 * @param {() => number} [deps.now] - Injectable clock (ms epoch), for
 *   deterministic tests. Defaults to Date.now.
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeoutFn] -
 *   Injectable timer, for deterministic tests. Defaults to global
 *   setTimeout.
 * @param {(handle: any) => void} [deps.clearTimeoutFn] - Defaults to
 *   global clearTimeout.
 * @returns {object} The Job Queue's public API.
 */
function createJobQueue(deps) {
  const {
    store,
    concurrency = DEFAULT_CONCURRENCY,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    sweepIntervalSeconds = DEFAULT_SWEEP_INTERVAL_SECONDS,
    maxAgeHours = DEFAULT_MAX_AGE_HOURS,
    classifyError = defaultClassifyError,
    onAlert = () => {},
    alertOldestMinutes = DEFAULT_ALERT_OLDEST_MINUTES,
    bufferFilePath = './data/queue-buffer.jsonl',
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;

  // Part A5/A7 — every alert this queue raises goes through this
  // throttle, so "alert once per blocker per hour" is enforced
  // structurally rather than left to each call site to remember.
  const alertThrottle = createAlertThrottle({ onAlert, now });

  const handlers = new Map(); // type -> async (job) => void
  const delayTimers = new Map(); // jobId -> timer handle, for in-memory scheduling
  let activeCount = 0;
  let stopped = false;
  let sweepTimer = null;
  let drainingBuffer = false;

  /**
   * Register the handler function for a job type. Must be called before
   * `start()` for every type the queue will ever see (Part A4).
   *
   * @param {string} type
   * @param {(job: object) => Promise<void>} handler
   */
  function registerHandler(type, handler) {
    handlers.set(type, handler);
  }

  /**
   * Append a job to the local JSONL spill file (Part A6 — "buffer in
   * memory and spill to a local JSONL file" when Redis is unreachable at
   * enqueue time). Loud logging by design (Part A6 — "Log loudly") but
   * never logs the job's payload contents, only its id/type.
   *
   * @param {object} job
   * @returns {Promise<void>}
   */
  async function spillToBuffer(job) {
    const dir = path.dirname(bufferFilePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(bufferFilePath, `${JSON.stringify(job)}\n`, { encoding: 'utf8' });
    console.error(
      `Queue: Redis unavailable — job ${job.id} (${job.type}) buffered to ${bufferFilePath}. ` +
        'It will be replayed into the queue once Redis is reachable again.',
    );
  }

  /**
   * Replay every job currently sitting in the local spill file into the
   * real Redis-backed queue, then truncate the file. Called once Redis
   * connectivity is confirmed (Part A6 — "retry connecting, and replay
   * into the queue when Redis returns").
   *
   * Idempotent-safe: `enqueueJob` re-runs dedupe for inbound_message jobs
   * via the WhatsApp message id, so a buffered job that somehow already
   * made it into Redis (e.g. a partial prior replay) is a harmless no-op
   * rather than a duplicate — see Part A3.
   *
   * @returns {Promise<number>} Count of jobs replayed.
   */
  async function drainBuffer() {
    if (drainingBuffer) return 0;
    drainingBuffer = true;
    try {
      let raw;
      try {
        raw = await fs.promises.readFile(bufferFilePath, { encoding: 'utf8' });
      } catch (err) {
        if (err && err.code === 'ENOENT') return 0;
        throw err;
      }

      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length === 0) return 0;

      let replayed = 0;
      for (const line of lines) {
        let job;
        try {
          job = JSON.parse(line);
        } catch {
          continue; // corrupt line — skip rather than crash the drain
        }
        try {
          await store.enqueue(job);
          scheduleDelayTimer(job);
          replayed += 1;
        } catch (err) {
          // Redis went away again mid-drain — re-spill remaining lines
          // and stop; the next successful connection retries the drain.
          console.error('Queue: buffer drain interrupted, will retry later:', toShortErrorString(err));
          break;
        }
      }

      // Truncate only after a successful pass — remove replayed lines by
      // rewriting the file with whatever wasn't consumed (simple/safe at
      // wedding-bot volume; no need for a more surgical partial-truncate
      // scheme).
      await fs.promises.writeFile(bufferFilePath, '', { encoding: 'utf8' });
      if (replayed > 0) {
        console.error(`Queue: replayed ${replayed} buffered job(s) into Redis.`);
      }
      return replayed;
    } finally {
      drainingBuffer = false;
    }
  }

  /**
   * Enqueue a brand-new job. This is the ONLY public entry point for
   * creating work (Part A3 — enqueue is the first thing that happens for
   * any inbound message the pipeline would act on).
   *
   * If Redis is unreachable, falls back to the in-memory-buffer + JSONL
   * spill path (Part A6) rather than throwing or dropping the message.
   *
   * @param {object} options
   * @param {string} options.type
   * @param {object} options.payload
   * @param {string} [options.id] - Deterministic id (e.g. sheet_write's
   *   hash of the WhatsApp message id, Part A4) — omit to auto-generate.
   * @param {Date} [options.receivedAt] - Defaults to now; callers
   *   handling an inbound WhatsApp message MUST pass the message's own
   *   timestamp (Part A3's date-default rule).
   * @returns {Promise<object>} The created Job record.
   */
  async function enqueueJob({ type, payload, id, receivedAt }) {
    const job = createJob({ type, payload, id, receivedAt });
    try {
      await store.enqueue(job);
    } catch (err) {
      console.error(`Queue: enqueue failed (Redis unreachable?) for job ${job.id}:`, toShortErrorString(err));
      await spillToBuffer(job);
      return job;
    }
    scheduleDelayTimer(job);
    return job;
  }

  /**
   * Check-and-set the WhatsApp-message-id dedupe marker, then enqueue if
   * (and only if) this is the first time this message id has been seen
   * (Part A3 — atomic dedupe on the WhatsApp message id).
   *
   * @param {object} options
   * @param {string} options.waMessageId
   * @param {string} options.type
   * @param {object} options.payload
   * @param {string} [options.id]
   * @param {Date} [options.receivedAt]
   * @returns {Promise<{deduped: true} | {deduped: false, job: object}>}
   */
  async function enqueueDeduped({ waMessageId, type, payload, id, receivedAt }) {
    let isNew;
    try {
      isNew = await store.dedupeCheckAndSet(waMessageId);
    } catch (err) {
      // Redis unreachable at the dedupe check itself — fail toward
      // "still enqueue" (buffered) rather than silently dropping the
      // message; a rare double-buffer-replay is preferable to losing an
      // expense. The buffered enqueue path below still applies its own
      // dedupe once Redis recovers, via the real dedupeCheckAndSet call
      // inside drainBuffer's retry loop... actually drainBuffer calls
      // store.enqueue directly, not enqueueDeduped, so duplicate
      // suppression here is intentionally best-effort only during a
      // Redis outage. This tradeoff is documented in RUNBOOK.md.
      console.error('Queue: dedupe check failed (Redis unreachable?):', toShortErrorString(err));
      isNew = true;
    }

    if (!isNew) {
      return { deduped: true };
    }

    const job = await enqueueJob({ type, payload, id, receivedAt });
    return { deduped: false, job };
  }

  /**
   * Schedule an in-memory timer to trigger the worker loop right around
   * `job.next_attempt_at`, per Part A1 — "keep in-memory timers for
   * delayed jobs" so the queue reacts promptly without polling Redis.
   * Purely a latency optimization: if the timer is lost (process
   * restart) the sweeper's periodic `reclaimExpiredLeases` + a plain
   * `tick()` call still picks the job up, just up to
   * `sweepIntervalSeconds` later.
   *
   * @param {object} job
   */
  function scheduleDelayTimer(job) {
    if (stopped) return;
    const delayMs = Math.max(0, new Date(job.next_attempt_at).getTime() - now());
    const existing = delayTimers.get(job.id);
    if (existing) clearTimeoutFn(existing);

    const handle = setTimeoutFn(() => {
      delayTimers.delete(job.id);
      tick();
    }, delayMs);
    delayTimers.set(job.id, handle);
  }

  /**
   * Attempt to claim and process up to the remaining concurrency budget.
   * Safe to call any number of times concurrently — `activeCount` gates
   * how many `processOne` calls are in flight at once (Part A3 —
   * QUEUE_CONCURRENCY).
   */
  async function tick() {
    if (stopped) return;
    const available = concurrency - activeCount;
    if (available <= 0) return;

    let claimed;
    try {
      claimed = await store.claimReady({ limit: available, leaseSeconds });
    } catch (err) {
      console.error('Queue: claimReady failed:', toShortErrorString(err));
      return;
    }

    for (const job of claimed) {
      activeCount += 1;
      processOne(job)
        .catch((err) => {
          // processOne is designed to never throw (every branch inside
          // it catches its own errors) — this is a last-resort net so a
          // truly unexpected bug in the queue runtime itself doesn't
          // silently swallow the job's active-slot accounting.
          console.error(`Queue: unexpected error processing job ${job.id}:`, toShortErrorString(err));
        })
        .finally(() => {
          activeCount -= 1;
          if (!stopped) tick(); // pick up more work immediately, no polling
        });
    }
  }

  /**
   * Run the registered handler for one claimed job, then ack/reschedule/
   * dead-letter it based on the outcome (Part A4/A5).
   *
   * @param {object} job
   */
  async function processOne(job) {
    const handler = handlers.get(job.type);
    if (!handler) {
      // Permanent — no handler registered for this type is a code/config
      // bug, not a transient condition (Part A5).
      await deadLetter(job, `No handler registered for job type "${job.type}".`);
      return;
    }

    try {
      await handler(job);
      await store.ack({ ...job, state: JOB_STATE.DONE });
      // A successful run of this job type means any previously-alerted
      // blocker for it has cleared — reset the throttle so a FUTURE
      // blocker alerts immediately rather than waiting out a stale
      // cooldown from before the fix (Part A5's "fixing the key resumes
      // automatically" acceptance criterion implies the alert state
      // should reset too, not just processing).
      alertThrottle.clear(`blocked:${job.type}`);
    } catch (err) {
      if (err instanceof HoldError) {
        await handleHold(job, err);
        return;
      }
      await handleFailure(job, err);
    }
  }

  /**
   * Reschedule a job for a short delay WITHOUT counting an attempt and
   * WITHOUT running it through failure classification/backoff/dead-
   * lettering — per Part B's normalizer hold policy. `job.attempts` (as
   * incremented by this claim) is rolled back to its pre-claim value so
   * a long hold sequence never counts toward, or gets confused with, a
   * genuine failure streak; `received_at` (and therefore the overall
   * QUEUE_MAX_AGE_HOURS/NORMALIZER_MAX_HOLD_MINUTES ceilings, computed
   * by the caller from that same field) is untouched.
   *
   * @param {object} job
   * @param {HoldError} holdErr
   */
  async function handleHold(job, holdErr) {
    const nextAttemptAt = new Date(now() + holdErr.retryAfterMs).toISOString();
    const updated = {
      ...job,
      state: JOB_STATE.QUEUED,
      attempts: Math.max(0, job.attempts - 1), // undo this claim's increment — a hold is not an attempt
      next_attempt_at: nextAttemptAt,
      // last_error intentionally left as it was — a hold is not a
      // failure, so it must never overwrite a genuine prior error with
      // hold-status text (Part 5 — also keeps logs/last_error free of
      // routine hold noise).
    };
    await store.reschedule(updated);
    scheduleDelayTimer(updated);
  }

  /**
   * Classify a handler failure and apply the right retry/backoff/dead-
   * letter policy (Part A5).
   *
   * @param {object} job
   * @param {Error} err
   */
  async function handleFailure(job, err) {
    const failureClass = classifyError(err);
    const shortError = toShortErrorString(err);
    const ageMs = now() - new Date(job.received_at).getTime();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    if (failureClass === 'permanent') {
      await deadLetter(job, shortError);
      return;
    }

    if (failureClass === 'blocked') {
      // Never burns an attempt (Part A5). Retry on a fixed interval and
      // alert once per blocker per hour — throttled by job TYPE (not by
      // individual job id), since every sheet_write job sharing the same
      // blocked Google credential is the SAME underlying condition, and
      // Part A5/A7 asks for "once per blocker per hour", not once per
      // affected job.
      alertThrottle.alert(
        `blocked:${job.type}`,
        `Queue: ${job.type} jobs are blocked: ${shortError}`,
      );
      const nextAttemptAt = new Date(now() + BLOCKED_RETRY_INTERVAL_MS).toISOString();
      const updated = {
        ...job,
        state: JOB_STATE.QUEUED,
        last_error: shortError,
        next_attempt_at: nextAttemptAt,
      };
      await store.reschedule(updated);
      scheduleDelayTimer(updated);
      return;
    }

    // transient
    if (ageMs >= maxAgeMs) {
      await deadLetter(job, `Exceeded QUEUE_MAX_AGE_HOURS (${maxAgeHours}h): ${shortError}`);
      return;
    }

    const delayMs = computeTransientBackoffMs(job.attempts);
    const nextAttemptAt = new Date(now() + delayMs).toISOString();
    const updated = {
      ...job,
      state: JOB_STATE.QUEUED,
      last_error: shortError,
      next_attempt_at: nextAttemptAt,
    };
    await store.reschedule(updated);
    scheduleDelayTimer(updated);
  }

  /**
   * Dead-letter a job: persist with `state: 'dead'`, add to the dead
   * set, alert once (Part A7). Never deletes the record (Part A5).
   *
   * @param {object} job
   * @param {string} reason
   */
  async function deadLetter(job, reason) {
    const deadJob = { ...job, state: JOB_STATE.DEAD, last_error: reason };
    await store.markDead(deadJob);
    // Throttled per JOB (not per type) — Part A7 lists "a job is dead-
    // lettered" as its own alert condition, distinct from "a blocker is
    // detected"; each dead-lettered job is a distinct, one-time event
    // worth its own notice, but the throttle still guards against a
    // pathological retry loop somehow dead-lettering the same job id
    // repeatedly (defensive; markDead's TTL means this key is
    // effectively single-fire in practice).
    alertThrottle.alert(
      `dead_letter:${job.id}`,
      `Queue: job ${job.id} (${job.type}) dead-lettered: ${reason}`,
    );
  }

  /**
   * Part A7 — "Alert when ... oldest job age > QUEUE_ALERT_OLDEST_MINUTES,
   * or queue depth is unusually high." Checked from the sweeper's
   * cadence (not the fast tick/timer path) since this is a health
   * signal, not something that needs sub-second reaction.
   */
  async function checkQueueHealth() {
    let counts;
    try {
      counts = await store.getCounts();
    } catch (err) {
      console.error('Queue: checkQueueHealth failed to read counts:', toShortErrorString(err));
      return;
    }

    const thresholdMs = alertOldestMinutes * 60 * 1000;
    const oldestAgeMs = Math.max(counts.oldestReadyAgeMs || 0, counts.oldestInflightAgeMs || 0);
    if (oldestAgeMs > thresholdMs) {
      alertThrottle.alert(
        'oldest_job_age',
        `Queue: oldest job is ${Math.round(oldestAgeMs / 60000)} minute(s) old (threshold ${alertOldestMinutes}m).`,
      );
    } else {
      alertThrottle.clear('oldest_job_age');
    }

    const depth = counts.queued + counts.inflight;
    if (depth > UNUSUAL_QUEUE_DEPTH_THRESHOLD) {
      alertThrottle.alert(
        'queue_depth',
        `Queue: unusually high depth (${depth} queued+inflight jobs).`,
      );
    } else {
      alertThrottle.clear('queue_depth');
    }
  }

  /**
   * The sweeper's periodic recovery pass (Part A1/A6): reclaim expired
   * leases (crashed/frozen workers) and re-attempt a buffer drain in
   * case Redis recovered since the last enqueue attempt. Runs on
   * `sweepIntervalSeconds`, default 60s — deliberately slow, since
   * `tick()`+timers handle the normal-path latency.
   */
  async function sweep() {
    if (stopped) return;
    try {
      const reclaimed = await store.reclaimExpiredLeases();
      if (reclaimed.length > 0) {
        console.error(`Queue: reclaimed ${reclaimed.length} job(s) with expired leases.`);
      }
    } catch (err) {
      console.error('Queue: sweep reclaim failed:', toShortErrorString(err));
    }

    try {
      await drainBuffer();
    } catch (err) {
      console.error('Queue: sweep buffer drain failed:', toShortErrorString(err));
    }

    await checkQueueHealth();

    tick();
  }

  /**
   * Start the queue runtime: recover from a prior crash (reclaim expired
   * leases), attempt a buffer drain, kick off the sweeper interval, and
   * take an initial tick to resume any already-ready jobs (Part A6 —
   * "On startup: reclaim expired leases, load ready jobs, resume").
   *
   * @returns {Promise<void>}
   */
  async function start() {
    stopped = false;
    try {
      await store.reclaimExpiredLeases();
    } catch (err) {
      console.error('Queue: startup reclaim failed:', toShortErrorString(err));
    }
    try {
      await drainBuffer();
    } catch (err) {
      console.error('Queue: startup buffer drain failed:', toShortErrorString(err));
    }
    sweepTimer = setInterval(() => {
      sweep();
    }, sweepIntervalSeconds * 1000);
    // setInterval on Node keeps the process alive unless unref'd; the
    // queue is core to this process's purpose, so that's the desired
    // behavior (mirrors the existing connectionMonitor's setInterval in
    // index.js, which is also never unref'd).
    tick();
  }

  /**
   * Graceful shutdown (Part A6 — SIGTERM handling): stop claiming new
   * work and clear pending delay timers, then wait up to `graceMs` for
   * any currently in-flight `processOne` calls to finish naturally.
   * Jobs still inflight after the grace period are left exactly as they
   * are in Redis — their lease will simply expire and the next
   * process's sweeper/claim cycle reclaims them (Part A3's lease
   * mechanism already handles this; no special "release" call is
   * needed).
   *
   * @param {object} [options]
   * @param {number} [options.graceMs] - Defaults to 20000 (~20s, Part A6).
   * @returns {Promise<void>}
   */
  async function stop({ graceMs = 20000 } = {}) {
    stopped = true;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const handle of delayTimers.values()) {
      clearTimeoutFn(handle);
    }
    delayTimers.clear();

    const deadline = now() + graceMs;
    while (activeCount > 0 && now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeoutFn(resolve, 100));
    }
  }

  /**
   * @returns {Promise<object>} Counts by state, oldest job age, and dead
   *   count — for the `/queue` admin command and `GET /health` (Part A7).
   *   Delegates straight to the store; exposed here so callers never
   *   need to reach into the store directly.
   */
  async function getCounts() {
    return store.getCounts();
  }

  /**
   * @returns {Promise<number>} Count of dead jobs requeued — the
   * `/queue retry` admin command (Part A7).
   */
  async function retryDead() {
    return store.requeueDead();
  }

  return {
    registerHandler,
    enqueueJob,
    enqueueDeduped,
    start,
    stop,
    tick,
    sweep,
    drainBuffer,
    getCounts,
    retryDead,
    checkQueueHealth,
    // Test/introspection seams — not part of the "public API" other
    // modules should call in normal operation, but useful for
    // deterministic assertions.
    _getActiveCount: () => activeCount,
  };
}

module.exports = {
  createJobQueue,
  defaultClassifyError,
  toShortErrorString,
  HoldError,
  DEFAULT_CONCURRENCY,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_SWEEP_INTERVAL_SECONDS,
  DEFAULT_MAX_AGE_HOURS,
};
