// setup.js
// v1.2 — Durable Job Queue (additive). Construction/wiring helper.
//
// Responsibilities:
//   - Decide, from env-var-shaped options, whether the queue is enabled
//     at all — mirrors authState.js's createAuthStateFactory: when
//     disabled, this module must NEVER construct a Redis client
//     (Rule 2 — "With QUEUE_ENABLED=false ... behavior must be identical
//     to today").
//   - Own the one Redis client instance used for queue state, separate
//     from (but exactly parallel to) authState.js's own Baileys-auth
//     Redis client — Rule 4 says "reuse the existing Redis client/
//     connection"; in practice authState.js's client is private to that
//     module (no export exists to reuse, confirmed during Phase 0
//     investigation), so this module constructs its own client against
//     the SAME REDIS_URL, which is the closest available interpretation
//     of "reuse the existing Redis connection" without refactoring
//     authState.js's encapsulation. Both clients point at the same
//     logical Redis instance/database; queue keys are namespaced "wq:"
//     (see redisStore.js) so they can never collide with authState.js's
//     "baileys:auth:" keys even though they share a connection target.
//
// This module is intentionally thin — index.js calls `setupQueue(...)`
// once at module load time (alongside sheetsWriter/getAuthState/
// normalizer, all of which are also constructed before onReady) and gets
// back either `null` (QUEUE_ENABLED=false — nothing else in index.js
// should reference the queue at all) or a ready-to-use `{queue, store}`
// pair.

const { createRedisJobStore } = require('./redisStore');
const { createJobQueue } = require('./jobQueue');

/**
 * @param {object} options
 * @param {boolean} options.enabled - QUEUE_ENABLED. When falsy, returns
 *   `null` immediately and constructs nothing (no Redis client, no
 *   queue) — Rule 2's "identical to today" guarantee.
 * @param {string} [options.redisUrl] - REDIS_URL. Required when
 *   `enabled` is true; throws synchronously (fail loud at startup,
 *   mirroring sheetsWriter.js's credential validation) if missing.
 * @param {new (url: string) => any} [options.RedisClientCtor] - Defaults
 *   to `ioredis`'s default export. Injectable for tests.
 * @param {number} [options.concurrency] - QUEUE_CONCURRENCY.
 * @param {number} [options.leaseSeconds] - QUEUE_LEASE_SECONDS.
 * @param {number} [options.sweepIntervalSeconds] - QUEUE_SWEEP_INTERVAL_SECONDS.
 * @param {number} [options.maxAgeHours] - QUEUE_MAX_AGE_HOURS.
 * @param {(err: Error) => 'transient'|'blocked'|'permanent'} [options.classifyError]
 * @param {(message: string) => void} [options.onAlert]
 * @param {string} [options.bufferFilePath]
 * @returns {{queue: ReturnType<typeof createJobQueue>, store: ReturnType<typeof createRedisJobStore>, redis: any} | null}
 */
function setupQueue(options = {}) {
  const { enabled, redisUrl, RedisClientCtor } = options;

  if (!enabled) {
    return null; // Rule 2 — never construct a Redis client when disabled.
  }

  if (!redisUrl) {
    throw new Error('REDIS_URL is required when QUEUE_ENABLED=true.');
  }

  const Ctor = RedisClientCtor || require('ioredis');
  // rediss:// (TLS) is the expected scheme for Upstash — Rule 5 requires
  // treating Redis contents as sensitive; ioredis negotiates TLS
  // automatically from a rediss:// URL, no extra option needed here.
  const redis = new Ctor(redisUrl);

  const store = createRedisJobStore({ redis });
  const queue = createJobQueue({
    store,
    concurrency: options.concurrency,
    leaseSeconds: options.leaseSeconds,
    sweepIntervalSeconds: options.sweepIntervalSeconds,
    maxAgeHours: options.maxAgeHours,
    classifyError: options.classifyError,
    onAlert: options.onAlert,
    bufferFilePath: options.bufferFilePath,
  });

  return { queue, store, redis };
}

module.exports = {
  setupQueue,
};
