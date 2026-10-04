// authState.test.js
// Property-based and unit tests for src/authState.js (Phase 7 — Hardening
// & Deployment). See .kiro/specs/hardening-deployment/design.md
// "Correctness Properties — Properties 6, 7" for design context.
//
// No real Redis connection is used anywhere in this file — every test
// injects a fake RedisClientCtor backed by a plain in-memory Map.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createRedisAuthState, createAuthStateFactory } = require('../src/authState');

// Excludes "__proto__" — fast-check's fc.dictionary can otherwise generate
// a key literally named "__proto__", and assigning obj['__proto__'] = x via
// bracket notation mutates the object's prototype instead of adding an own
// property, which then fails a plain assert.deepStrictEqual against an
// expected plain object (prototype mismatch, not a real behavioral bug).
const safeKeyArb = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s !== '__proto__');

/**
 * A minimal ioredis-compatible fake: `get`/`set`/`del` backed by a shared
 * in-memory Map, so multiple client instances constructed against the
 * "same" fake connection can see each other's writes (mirroring how two
 * `createRedisAuthState` calls against the same real Redis instance would
 * behave).
 */
function makeFakeRedisClientCtor(sharedStore = new Map()) {
  class FakeRedisClient {
    constructor(url) {
      this.url = url;
      this.store = sharedStore;
    }

    async get(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    }

    async set(key, value) {
      this.store.set(key, value);
    }

    async del(key) {
      this.store.delete(key);
    }
  }
  FakeRedisClient.sharedStore = sharedStore;
  return FakeRedisClient;
}

// ---------------------------------------------------------------------------
// Property 6: The Redis-backed auth state round-trips credentials and keys
// exactly like local-disk storage
// ---------------------------------------------------------------------------

// Feature: hardening-deployment, Property 6: The Redis-backed auth state round-trips credentials and keys exactly like local-disk storage
test('Property 6: The Redis-backed auth state round-trips credentials and keys exactly like local-disk storage', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.dictionary(safeKeyArb, fc.jsonValue(), { maxKeys: 5 }),
      fc.array(
        fc.record({
          category: fc.constantFrom('pre-key', 'session', 'sender-key'),
          id: safeKeyArb,
          value: fc.dictionary(safeKeyArb, fc.string(), { maxKeys: 3 }),
        }),
        { maxLength: 5 }
      ),
      async (credsExtra, keyEntries) => {
        const store = new Map();
        const RedisClientCtor = makeFakeRedisClientCtor(store);
        const client = new RedisClientCtor('redis://fake');

        const first = await createRedisAuthState(client);
        Object.assign(first.state.creds, credsExtra);
        await first.saveCreds();

        const setPayload = {};
        for (const { category, id, value } of keyEntries) {
          setPayload[category] = setPayload[category] || {};
          setPayload[category][id] = value;
        }
        await first.state.keys.set(setPayload);

        // Re-read via a FRESH createRedisAuthState call against the same
        // underlying store, mirroring a process restart against the same
        // Redis instance.
        const second = await createRedisAuthState(client);

        // Compared via a JSON round-trip rather than assert.deepStrictEqual
        // directly: the real storage layer already serializes every value
        // through JSON.stringify/JSON.parse, and fast-check's generators
        // (e.g. fc.dictionary/fc.jsonValue) can produce values with a
        // null-prototype internal representation that JSON round-tripping
        // normalizes away — a difference in prototype chain that has no
        // bearing on the actual property under test (does the *data*
        // survive the round trip).
        const normalize = (v) => JSON.parse(JSON.stringify(v));

        for (const [key, value] of Object.entries(credsExtra)) {
          assert.deepStrictEqual(normalize(second.state.creds[key]), normalize(value));
        }

        for (const { category, id, value } of keyEntries) {
          const result = await second.state.keys.get(category, [id]);
          assert.deepStrictEqual(normalize(result[id]), normalize(value));
        }
      }
    ),
    { numRuns: 100 }
  );
});

test('keys.set with a falsy value removes the key (del), not a stored falsy value', async () => {
  const RedisClientCtor = makeFakeRedisClientCtor();
  const client = new RedisClientCtor('redis://fake');
  const authState = await createRedisAuthState(client);

  await authState.state.keys.set({ session: { 'abc': { some: 'value' } } });
  let result = await authState.state.keys.get('session', ['abc']);
  assert.deepStrictEqual(result.abc, { some: 'value' });

  await authState.state.keys.set({ session: { abc: null } });
  result = await authState.state.keys.get('session', ['abc']);
  assert.strictEqual(result.abc, null);
});

test('a fresh Redis store with nothing saved initializes creds via initAuthCreds (Requirement 3.3)', async () => {
  const RedisClientCtor = makeFakeRedisClientCtor();
  const client = new RedisClientCtor('redis://fake');
  const authState = await createRedisAuthState(client);

  assert.ok(authState.state.creds);
  assert.ok(authState.state.creds.noiseKey);
  assert.strictEqual(authState.state.creds.registered, false);
});

test('saveCreds persists creds so a subsequent createRedisAuthState call resumes them (Requirement 3.4)', async () => {
  const store = new Map();
  const RedisClientCtor = makeFakeRedisClientCtor(store);
  const client = new RedisClientCtor('redis://fake');

  const first = await createRedisAuthState(client);
  first.state.creds.registered = true;
  await first.saveCreds();

  const second = await createRedisAuthState(client);
  assert.strictEqual(second.state.creds.registered, true);
});

// ---------------------------------------------------------------------------
// Property 7: The auth-state factory selects the configured backend and no
// other
// ---------------------------------------------------------------------------

// Feature: hardening-deployment, Property 7: The auth-state factory selects the configured backend and no other
test('Property 7: The auth-state factory selects the configured backend and no other', () => {
  fc.assert(
    fc.property(fc.option(fc.webUrl(), { nil: undefined }), (redisUrl) => {
      let constructedCount = 0;
      class SpyRedisClient {
        constructor(url) {
          constructedCount += 1;
          this.url = url;
        }
        async get() { return null; }
        async set() {}
        async del() {}
        on() {} // real ioredis is an EventEmitter — createAuthStateFactory attaches an 'error' listener
      }

      const getAuthState = createAuthStateFactory({ redisUrl, RedisClientCtor: SpyRedisClient });

      assert.strictEqual(typeof getAuthState, 'function');

      if (redisUrl) {
        assert.strictEqual(constructedCount, 1, 'a Redis client must be constructed exactly once when redisUrl is set');
      } else {
        assert.strictEqual(constructedCount, 0, 'no Redis client must ever be constructed when redisUrl is unset');
      }
    }),
    { numRuns: 100 }
  );
});

test('createAuthStateFactory with redisUrl unset never touches RedisClientCtor even if provided', () => {
  let constructedCount = 0;
  class SpyRedisClient {
    constructor() {
      constructedCount += 1;
    }
  }

  const getAuthState = createAuthStateFactory({ redisUrl: undefined, RedisClientCtor: SpyRedisClient });
  assert.strictEqual(typeof getAuthState, 'function');
  assert.strictEqual(constructedCount, 0);
});

test('createAuthStateFactory with redisUrl set reuses the same client instance across repeated getAuthState() calls', async () => {
  let constructedCount = 0;
  const store = new Map();
  class SpyRedisClient {
    constructor() {
      constructedCount += 1;
      this.store = store;
    }
    async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
    async set(key, value) { this.store.set(key, value); }
    async del(key) { this.store.delete(key); }
    on() {} // real ioredis is an EventEmitter — createAuthStateFactory attaches an 'error' listener
  }

  const getAuthState = createAuthStateFactory({ redisUrl: 'redis://fake', RedisClientCtor: SpyRedisClient });

  await getAuthState();
  await getAuthState();

  assert.strictEqual(constructedCount, 1, 'the Redis client instance must be constructed exactly once and reused');
});
