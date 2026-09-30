// fakeRedis.js
// Test-only in-memory fake of the ioredis subset src/queue/redisStore.js
// uses: get/set/mget/pipeline/eval/zadd/zrem/zcard/zrange/zrangebyscore/
// sadd/srem/smembers/scard. No real Redis connection is used anywhere in
// the queue test suite, mirroring tests/authState.test.js's existing
// "fake client backed by a plain in-memory Map" convention.
//
// Only implements exactly what redisStore.js calls — not a general-
// purpose Redis emulator.

class FakeRedis {
  constructor() {
    this.strings = new Map(); // key -> { value, expiresAtMs|null }
    this.zsets = new Map(); // key -> Map<member, score>
    this.sets = new Map(); // key -> Set<member>
  }

  _isExpired(key) {
    const entry = this.strings.get(key);
    if (!entry) return false;
    if (entry.expiresAtMs === null) return false;
    return Date.now() >= entry.expiresAtMs;
  }

  _purgeIfExpired(key) {
    if (this._isExpired(key)) {
      this.strings.delete(key);
    }
  }

  async get(key) {
    this._purgeIfExpired(key);
    const entry = this.strings.get(key);
    return entry ? entry.value : null;
  }

  async mget(...keys) {
    return keys.map((k) => {
      this._purgeIfExpired(k);
      const entry = this.strings.get(k);
      return entry ? entry.value : null;
    });
  }

  /**
   * Supports the two call shapes redisStore.js uses:
   *   set(key, value)
   *   set(key, value, 'EX', seconds)
   *   set(key, value, 'EX', seconds, 'NX')
   *   set(key, value, 'NX')
   */
  async set(key, value, ...rest) {
    let ttlSeconds = null;
    let nx = false;
    for (let i = 0; i < rest.length; i += 1) {
      const token = String(rest[i]).toUpperCase();
      if (token === 'EX') {
        ttlSeconds = Number(rest[i + 1]);
        i += 1;
      } else if (token === 'NX') {
        nx = true;
      }
    }

    if (nx) {
      this._purgeIfExpired(key);
      if (this.strings.has(key)) {
        return null; // NX: key already exists, no-op
      }
    }

    const expiresAtMs = ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null;
    this.strings.set(key, { value, expiresAtMs });
    return 'OK';
  }

  async del(key) {
    this.strings.delete(key);
    return 1;
  }

  async zadd(key, score, member) {
    return this._zaddSync(key, score, member);
  }

  async zrem(key, member) {
    return this._zremSync(key, member);
  }

  async zcard(key) {
    const z = this.zsets.get(key);
    return z ? z.size : 0;
  }

  /**
   * Supports zrangebyscore(key, min, max, 'LIMIT', offset, count) as used
   * inside the CLAIM_SCRIPT/RECLAIM_SCRIPT lua emulation below, and the
   * plain two-arg form.
   */
  async zrangebyscore(key, min, max, ...rest) {
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    let members = this._zrangebyscoreSync(key, lo, hi);

    const limitIdx = rest.findIndex((t) => String(t).toUpperCase() === 'LIMIT');
    if (limitIdx !== -1) {
      const offset = Number(rest[limitIdx + 1]) || 0;
      const count = Number(rest[limitIdx + 2]);
      members = members.slice(offset, Number.isFinite(count) ? offset + count : undefined);
    }
    return members;
  }

  /**
   * Supports zrange(key, start, stop) and zrange(key, start, stop,
   * 'WITHSCORES') — used by getCounts() for the oldest-job-age lookup.
   */
  async zrange(key, start, stop, ...rest) {
    const z = this.zsets.get(key);
    if (!z) return [];
    const entries = Array.from(z.entries()).sort((a, b) => a[1] - b[1]);
    const withScores = rest.some((t) => String(t).toUpperCase() === 'WITHSCORES');
    const stopIdx = stop === -1 ? entries.length - 1 : stop;
    const slice = entries.slice(start, stopIdx + 1);
    if (!withScores) return slice.map(([member]) => member);
    const flat = [];
    for (const [member, score] of slice) {
      flat.push(member, String(score));
    }
    return flat;
  }

  async sadd(key, member) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key).add(member);
    return 1;
  }

  async srem(key, member) {
    const s = this.sets.get(key);
    if (!s) return 0;
    return s.delete(member) ? 1 : 0;
  }

  async smembers(key) {
    const s = this.sets.get(key);
    return s ? Array.from(s) : [];
  }

  async scard(key) {
    const s = this.sets.get(key);
    return s ? s.size : 0;
  }

  /**
   * Minimal eval() emulation. redisStore.js only ever evals the two
   * scripts exported from redisStore.js (CLAIM_SCRIPT / RECLAIM_SCRIPT)
   * — rather than a real Lua interpreter, this fake pattern-matches on
   * script content and re-implements the same two operations directly
   * against this fake's own zset storage, which is equivalent in
   * observable behavior for test purposes.
   *
   * IMPORTANT: real Redis executes a Lua script atomically (Redis is
   * single-threaded, so nothing can interleave between a script's
   * internal reads and writes). This emulation must preserve that
   * atomicity guarantee, or tests that rely on "two concurrent claims
   * can never claim the same job" would see a false failure that could
   * never actually happen against real Redis. The read-then-mutate
   * logic below therefore runs entirely SYNCHRONOUSLY (via the private
   * *Sync helper methods, not this class's own async zrem/zadd/
   * zrangebyscore methods) — `eval` itself is still declared `async`
   * (matching ioredis's real interface, which always returns a
   * Promise), but its body contains no `await` before all mutations are
   * already applied, so nothing can interleave between them even if two
   * `eval()` calls are kicked off "concurrently" from the caller's
   * perspective (they still serialize at the first `await` a caller
   * puts after calling `eval`, i.e. exactly as real Redis would from
   * two concurrent clients).
   */
  async eval(script, numKeys, ...rest) {
    const keys = rest.slice(0, numKeys);
    const argv = rest.slice(numKeys);

    if (script.includes('ZRANGEBYSCORE') && script.includes("redis.call('ZADD', inflight")) {
      // CLAIM_SCRIPT
      const [readyKey, inflightKey] = keys;
      const [nowArg, leaseUntilArg, limitArg] = argv;
      const due = this._zrangebyscoreSync(readyKey, -Infinity, Number(nowArg)).slice(0, Number(limitArg));
      for (const jobId of due) {
        this._zremSync(readyKey, jobId);
        this._zaddSync(inflightKey, Number(leaseUntilArg), jobId);
      }
      return due;
    }

    if (script.includes("redis.call('ZADD', ready")) {
      // RECLAIM_SCRIPT
      const [inflightKey, readyKey] = keys;
      const [nowArg] = argv;
      const expired = this._zrangebyscoreSync(inflightKey, -Infinity, Number(nowArg));
      for (const jobId of expired) {
        this._zremSync(inflightKey, jobId);
        this._zaddSync(readyKey, Number(nowArg), jobId);
      }
      return expired;
    }

    throw new Error('FakeRedis.eval: unrecognized script');
  }

  // --- Synchronous internals shared by eval() and the public async
  // zadd/zrem/zrangebyscore methods below, so both call sites share one
  // implementation. ---

  _zrangebyscoreSync(key, lo, hi) {
    const z = this.zsets.get(key);
    if (!z) return [];
    const entries = Array.from(z.entries())
      .filter(([, score]) => score >= lo && score <= hi)
      .sort((a, b) => a[1] - b[1]);
    return entries.map(([member]) => member);
  }

  _zremSync(key, member) {
    const z = this.zsets.get(key);
    if (!z) return 0;
    return z.delete(member) ? 1 : 0;
  }

  _zaddSync(key, score, member) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    this.zsets.get(key).set(member, Number(score));
    return 1;
  }

  /**
   * Minimal pipeline emulation: queues [method, ...args] tuples, then
   * `exec()` runs them in order against `this` and returns
   * [[null, result], ...] tuples, matching ioredis's pipeline result
   * shape (`[error, result]` per command) closely enough for
   * redisStore.js's usage (it only ever reads `result[1]`, never
   * `result[0]`).
   */
  pipeline() {
    const ops = [];
    const self = this;
    const chain = {};
    const methods = ['set', 'zadd', 'zrem', 'sadd', 'srem', 'zcard', 'scard', 'zrange'];
    for (const m of methods) {
      chain[m] = (...args) => {
        ops.push([m, args]);
        return chain;
      };
    }
    chain.exec = async () => {
      const results = [];
      for (const [method, args] of ops) {
        // eslint-disable-next-line no-await-in-loop
        const result = await self[method](...args);
        results.push([null, result]);
      }
      return results;
    };
    return chain;
  }
}

module.exports = { FakeRedis };
