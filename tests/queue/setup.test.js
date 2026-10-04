// setup.test.js
// Unit tests for src/queue/setup.js — the QUEUE_ENABLED-gated
// construction helper. Mirrors tests/authState.test.js's Property 7
// ("the factory selects the configured backend and no other"): the core
// guarantee under test here is that a disabled queue NEVER constructs a
// Redis client, matching Rule 2 ("behavior must be identical to today").

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { setupQueue } = require('../../src/queue/setup');

function makeSpyRedisClientCtor() {
  let constructedCount = 0;
  class SpyRedisClient {
    constructor(url) {
      constructedCount += 1;
      this.url = url;
    }
    async get() { return null; }
    async set() { return 'OK'; }
    async del() { return 1; }
    async mget() { return []; }
    async zadd() { return 1; }
    async zrem() { return 1; }
    async zcard() { return 0; }
    async zrangebyscore() { return []; }
    async zrange() { return []; }
    async sadd() { return 1; }
    async srem() { return 1; }
    async smembers() { return []; }
    async scard() { return 0; }
    async eval() { return []; }
    pipeline() {
      const ops = [];
      const chain = { exec: async () => ops.map(() => [null, null]) };
      return chain;
    }
    on() {} // real ioredis is an EventEmitter — setup.js attaches an 'error' listener
  }
  return { SpyRedisClient, getConstructedCount: () => constructedCount };
}

test('setupQueue(enabled: false) never constructs a Redis client and returns null', () => {
  const { SpyRedisClient, getConstructedCount } = makeSpyRedisClientCtor();
  const result = setupQueue({ enabled: false, redisUrl: 'rediss://fake', RedisClientCtor: SpyRedisClient });

  assert.strictEqual(result, null);
  assert.strictEqual(getConstructedCount(), 0);
});

test('setupQueue(enabled: false) never constructs a Redis client even without a redisUrl at all', () => {
  const { SpyRedisClient, getConstructedCount } = makeSpyRedisClientCtor();
  const result = setupQueue({ enabled: false, RedisClientCtor: SpyRedisClient });

  assert.strictEqual(result, null);
  assert.strictEqual(getConstructedCount(), 0);
});

test('setupQueue(enabled: true) constructs exactly one Redis client and returns a queue+store pair', () => {
  const { SpyRedisClient, getConstructedCount } = makeSpyRedisClientCtor();
  const result = setupQueue({ enabled: true, redisUrl: 'rediss://fake', RedisClientCtor: SpyRedisClient });

  assert.ok(result);
  assert.ok(result.queue);
  assert.ok(result.store);
  assert.strictEqual(getConstructedCount(), 1);
});

test('setupQueue(enabled: true) without a redisUrl throws synchronously rather than silently disabling', () => {
  assert.throws(() => setupQueue({ enabled: true, RedisClientCtor: class {} }), /REDIS_URL/);
});

test('Property: setupQueue constructs a Redis client if and only if enabled is true', () => {
  fc.assert(
    fc.property(fc.boolean(), (enabled) => {
      const { SpyRedisClient, getConstructedCount } = makeSpyRedisClientCtor();
      const result = setupQueue({
        enabled,
        redisUrl: enabled ? 'rediss://fake' : undefined,
        RedisClientCtor: SpyRedisClient,
      });

      if (enabled) {
        assert.strictEqual(getConstructedCount(), 1);
        assert.ok(result);
      } else {
        assert.strictEqual(getConstructedCount(), 0);
        assert.strictEqual(result, null);
      }
    }),
    { numRuns: 50 },
  );
});
