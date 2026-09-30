// reconnectBackoff.test.js
// Property-based test for src/reconnectBackoff.js (Phase 7 — Hardening &
// Deployment). See .kiro/specs/hardening-deployment/design.md
// "Correctness Properties — Property 1" for design context.

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { computeBackoffDelayMs, DEFAULT_BASE_MS, DEFAULT_MAX_MS } = require('../src/reconnectBackoff');

// Feature: hardening-deployment, Property 1: Backoff delay is non-decreasing in attempt number and bounded by the configured maximum
test('Property 1: Backoff delay is non-decreasing in attempt number and bounded by the configured maximum', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 100, max: 5000 }),
      fc.integer({ min: 5000, max: 120000 }),
      (a, b, baseMs, maxMs) => {
        const [first, second] = a <= b ? [a, b] : [b, a];

        const delayFirst = computeBackoffDelayMs(first, { baseMs, maxMs });
        const delaySecond = computeBackoffDelayMs(second, { baseMs, maxMs });

        assert.ok(delaySecond >= delayFirst, `expected delay(${second})=${delaySecond} >= delay(${first})=${delayFirst}`);
        assert.ok(delayFirst <= maxMs);
        assert.ok(delaySecond <= maxMs);
        assert.ok(delayFirst >= Math.min(baseMs, maxMs));
        assert.ok(delaySecond >= Math.min(baseMs, maxMs));
      }
    ),
    { numRuns: 100 }
  );
});

test('defaults: attempt 0 returns baseMs, delay caps at maxMs for large attempts', () => {
  assert.strictEqual(computeBackoffDelayMs(0), DEFAULT_BASE_MS);
  assert.strictEqual(computeBackoffDelayMs(1), DEFAULT_BASE_MS * 2);
  assert.strictEqual(computeBackoffDelayMs(2), DEFAULT_BASE_MS * 4);
  assert.strictEqual(computeBackoffDelayMs(100), DEFAULT_MAX_MS);
});

test('negative attempt values are treated as 0 (defensive)', () => {
  assert.strictEqual(computeBackoffDelayMs(-5), computeBackoffDelayMs(0));
});
