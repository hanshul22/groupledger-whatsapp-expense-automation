// authState.js
// Phase 7 — Hardening & Deployment. See
// .kiro/specs/hardening-deployment/design.md "Redis Auth State
// (`authState.js`)" for the full design context.
//
// Responsibilities:
//   - Provide a Redis-backed implementation of Baileys' authentication
//     state contract (`{state: {creds, keys: {get, set}}, saveCreds}`),
//     structurally identical to Baileys' own `useMultiFileAuthState`, so
//     `waConnector.js` (and everything downstream of it) never needs to
//     know which backend is active (Requirement 3.2).
//   - Select between the Redis backend and the existing local-disk
//     backend via a factory, defaulting to local disk when no Redis URL
//     is configured (Requirement 3.5) — this default MUST hold without
//     ever constructing a Redis client, so deployments that don't set
//     REDIS_URL are completely unaffected (Requirement 3.6).

const { useMultiFileAuthState, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const AUTH_DIR = './auth';
const KEY_PREFIX = 'baileys:auth:';

/**
 * Create a Redis-backed Baileys auth state, per design.md's
 * `createRedisAuthState` pseudocode — structurally identical to Baileys'
 * own `useMultiFileAuthState` return shape (same field names, same
 * `keys.get`/`keys.set` signatures, same `BufferJSON`/`initAuthCreds`/
 * `proto.Message.AppStateSyncKeyData` handling), backed by
 * `redisClient.get`/`set`/`del` instead of file reads/writes.
 *
 * @param {{
 *   get: (key: string) => Promise<string | null>,
 *   set: (key: string, value: string) => Promise<any>,
 *   del: (key: string) => Promise<any>,
 * }} redisClient - Any client exposing this minimal `ioredis`-compatible
 *   interface (a real `ioredis` instance in production, an in-memory fake
 *   in tests — see design.md's Testing Strategy).
 * @returns {Promise<{
 *   state: { creds: object, keys: { get: Function, set: Function } },
 *   saveCreds: () => Promise<void>,
 * }>}
 */
async function createRedisAuthState(redisClient) {
  async function readData(key) {
    const raw = await redisClient.get(KEY_PREFIX + key);
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
  }

  async function writeData(key, value) {
    await redisClient.set(KEY_PREFIX + key, JSON.stringify(value, BufferJSON.replacer));
  }

  async function removeData(key) {
    await redisClient.del(KEY_PREFIX + key);
  }

  // Req 3.3 — fresh creds when nothing has ever been stored; Req 3.4 —
  // resumes the prior session when something has.
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        async set(data) {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              tasks.push(value ? writeData(`${category}-${id}`, value) : removeData(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeData('creds', creds),
  };
}

/**
 * Build the `getAuthState` factory function `waConnector.js`'s
 * `startWhatsApp` calls at connection-setup time, per design.md's
 * `createAuthStateFactory` pseudocode.
 *
 * - `redisUrl` unset/empty: returns a function equivalent to the existing
 *   default (`() => useMultiFileAuthState(authDir)`), and never
 *   constructs `RedisClientCtor` at all (Requirements 3.1, 3.5, 3.6).
 * - `redisUrl` set: constructs exactly one `RedisClientCtor(redisUrl)`
 *   instance (reused across every `getAuthState()` call — Baileys itself
 *   only calls this once per process lifetime, at `startWhatsApp` startup,
 *   but a single shared client is still the correct shape if that ever
 *   changed) and returns a function that builds the Redis-backed state
 *   against it.
 *
 * @param {object} options
 * @param {string | undefined | null} options.redisUrl - `process.env.REDIS_URL`.
 * @param {string} [options.authDir] - Defaults to `./auth`, matching
 *   `waConnector.js`'s existing `AUTH_DIR`.
 * @param {new (url: string) => any} [options.RedisClientCtor] - The Redis
 *   client constructor to use when `redisUrl` is set. Required only in
 *   that case — omit entirely (or pass a fake) when `redisUrl` is unset,
 *   per Requirement 3.6's "never constructs a Redis client" guarantee.
 * @returns {() => Promise<{state: object, saveCreds: Function}>}
 */
function createAuthStateFactory({ redisUrl, authDir = AUTH_DIR, RedisClientCtor } = {}) {
  if (!redisUrl) {
    return () => useMultiFileAuthState(authDir); // Req 3.5 — default, unchanged behavior
  }

  const redisClient = new RedisClientCtor(redisUrl);
  // ioredis emits 'error' on connection problems (e.g. the host going
  // down mid-session); with no listener attached, Node treats an
  // unhandled EventEmitter 'error' event as fatal and crashes the whole
  // process. Logging it here is enough — ioredis itself already retries
  // the connection internally.
  redisClient.on('error', (err) => console.error('Redis auth-state client error:', err));
  return () => createRedisAuthState(redisClient);
}

module.exports = {
  createRedisAuthState,
  createAuthStateFactory,
  AUTH_DIR,
  KEY_PREFIX,
};
