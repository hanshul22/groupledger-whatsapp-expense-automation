// jobTypes.test.js
// Unit tests for src/queue/jobTypes.js — the pure job-model helpers.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  JOB_STATE,
  createJob,
  generateJobId,
  computeTransientBackoffMs,
  TRANSIENT_BACKOFF_SCHEDULE_MS,
} = require('../../src/queue/jobTypes');

test('createJob defaults every field per the Part A2 job model', () => {
  const job = createJob({ type: 'inbound_message', payload: { rawText: 'hi' } });
  assert.strictEqual(job.type, 'inbound_message');
  assert.deepStrictEqual(job.payload, { rawText: 'hi' });
  assert.strictEqual(job.state, JOB_STATE.QUEUED);
  assert.strictEqual(job.attempts, 0);
  assert.strictEqual(job.lease_until, null);
  assert.strictEqual(job.last_error, null);
  assert.ok(job.id);
  assert.ok(job.created_at);
  assert.ok(job.next_attempt_at);
  assert.ok(job.received_at);
});

test('createJob uses the supplied receivedAt (WhatsApp message timestamp), not now()', () => {
  const messageTimestamp = new Date('2026-01-01T00:00:00.000Z');
  const job = createJob({ type: 'inbound_message', payload: {}, receivedAt: messageTimestamp });
  assert.strictEqual(job.received_at, messageTimestamp.toISOString());
});

test('createJob accepts a caller-supplied deterministic id (e.g. sheet_write entry hash)', () => {
  const job = createJob({ type: 'sheet_write', payload: {}, id: 'fixed-id-123' });
  assert.strictEqual(job.id, 'fixed-id-123');
});

test('generateJobId produces unique-looking ids across many calls', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) {
    ids.add(generateJobId());
  }
  assert.strictEqual(ids.size, 1000);
});

test('computeTransientBackoffMs follows the ~5s,15s,45s,2m,5m,15m,30m-cap schedule (within jitter)', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.double({ min: 0, max: 1, noNaN: true }), (attempts, rand) => {
      const delay = computeTransientBackoffMs(attempts, () => rand);
      const index = Math.min(attempts - 1, TRANSIENT_BACKOFF_SCHEDULE_MS.length - 1);
      const base = TRANSIENT_BACKOFF_SCHEDULE_MS[index];
      const min = base * 0.8;
      const max = base * 1.2;
      assert.ok(delay >= Math.floor(min) - 1 && delay <= Math.ceil(max) + 1, `delay ${delay} out of [${min},${max}] for attempts=${attempts}`);
    }),
    { numRuns: 200 },
  );
});

test('computeTransientBackoffMs never returns a negative delay', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), fc.double({ min: 0, max: 1, noNaN: true }), (attempts, rand) => {
      const delay = computeTransientBackoffMs(attempts, () => rand);
      assert.ok(delay >= 0);
    }),
    { numRuns: 200 },
  );
});

test('computeTransientBackoffMs caps at the 30-minute schedule entry for attempts beyond the table length', () => {
  const delayAt7 = computeTransientBackoffMs(7, () => 0.5); // no jitter at rand()=0.5
  const delayAt20 = computeTransientBackoffMs(20, () => 0.5);
  assert.strictEqual(delayAt7, delayAt20);
});
