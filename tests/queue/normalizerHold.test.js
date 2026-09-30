// normalizerHold.test.js
// Unit tests for src/queue/normalizerHold.js — Part B's queue-interaction
// hold policy for the normalizer.

const { test } = require('node:test');
const assert = require('node:assert');

const { decideNormalizerHold, isLlmCallFailure } = require('../../src/queue/normalizerHold');

function llmCallFailureResult(parsed = null) {
  return { status: 'passthrough', entry: parsed, meta: { changed: false, notes: 'LLM call failed (status 500).' } };
}

// --- isLlmCallFailure ---

test('isLlmCallFailure recognizes normalizer.js\'s exact LLM-call-failure note', () => {
  assert.strictEqual(isLlmCallFailure(llmCallFailureResult()), true);
});

test('isLlmCallFailure returns false for mode-off passthrough', () => {
  const result = { status: 'passthrough', entry: null, meta: { notes: 'Normalizer mode is off.' } };
  assert.strictEqual(isLlmCallFailure(result), false);
});

test('isLlmCallFailure returns false for a malformed-JSON passthrough (not a call failure)', () => {
  const result = { status: 'passthrough', entry: null, meta: { notes: 'LLM response was not valid JSON.' } };
  assert.strictEqual(isLlmCallFailure(result), false);
});

test('isLlmCallFailure returns false for needs_clarification (LLM answered, guard rejected)', () => {
  const result = { status: 'needs_clarification', reason: 'please rephrase' };
  assert.strictEqual(isLlmCallFailure(result), false);
});

test('isLlmCallFailure returns false for a successful normalized result', () => {
  const result = { status: 'normalized', entry: {}, meta: { changed: true, notes: '' } };
  assert.strictEqual(isLlmCallFailure(result), false);
});

test('isLlmCallFailure is robust to a missing/undefined meta', () => {
  assert.strictEqual(isLlmCallFailure({ status: 'passthrough', entry: null }), false);
  assert.strictEqual(isLlmCallFailure(null), false);
  assert.strictEqual(isLlmCallFailure(undefined), false);
});

// --- decideNormalizerHold ---

test('needs_clarification is never held — proceeds exactly as specified', () => {
  const result = { status: 'needs_clarification', reason: 'one expense per message' };
  const decision = decideNormalizerHold({ normalizeResult: result, receivedAt: new Date(), parserProducedUsableEntry: true });
  assert.strictEqual(decision.decision, 'proceed');
});

test('a normalized result proceeds (used as-is)', () => {
  const result = { status: 'normalized', entry: {}, meta: {} };
  const decision = decideNormalizerHold({ normalizeResult: result, receivedAt: new Date(), parserProducedUsableEntry: true });
  assert.strictEqual(decision.decision, 'proceed');
});

test('a mode-off passthrough proceeds (this is not an LLM-down condition at all)', () => {
  const result = { status: 'passthrough', entry: {}, meta: { notes: 'Normalizer mode is off.' } };
  const decision = decideNormalizerHold({ normalizeResult: result, receivedAt: new Date(), parserProducedUsableEntry: true });
  assert.strictEqual(decision.decision, 'proceed');
});

test('shadow mode\'s passthrough proceeds immediately — never held, never delayed, per Part B\'s "shadow mode runs off the critical path" rule', () => {
  const result = { status: 'passthrough', entry: { amount: 100 }, meta: { changed: false, notes: 'Normalizer mode is shadow.' } };
  const decision = decideNormalizerHold({ normalizeResult: result, receivedAt: new Date(), parserProducedUsableEntry: true });
  assert.strictEqual(decision.decision, 'proceed');
});

test('an LLM call failure within the hold window holds (default onLlmDown=hold)', () => {
  const receivedAt = new Date(Date.now() - 60 * 1000); // 1 minute ago
  const decision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult(),
    receivedAt,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: true,
  });
  assert.strictEqual(decision.decision, 'hold');
});

test('an LLM call failure past the hold window, with a usable parsed entry, falls back to passthrough', () => {
  const receivedAt = new Date(Date.now() - 11 * 60 * 1000); // 11 minutes ago
  const decision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult({ amount: 100 }),
    receivedAt,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: true,
  });
  assert.strictEqual(decision.decision, 'passthrough');
});

test('an LLM call failure past the hold window, with NO usable parsed entry, keeps holding', () => {
  const receivedAt = new Date(Date.now() - 11 * 60 * 1000);
  const decision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult(null),
    receivedAt,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: false,
  });
  assert.strictEqual(decision.decision, 'hold');
});

test('NORMALIZER_ON_LLM_DOWN=passthrough gives immediate fail-open, even within the hold window', () => {
  const receivedAt = new Date(); // just now
  const decision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult({ amount: 100 }),
    onLlmDown: 'passthrough',
    receivedAt,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: true,
  });
  assert.strictEqual(decision.decision, 'passthrough');
});

test('the hold window boundary is respected: just under maxHoldMinutes holds, just over falls through', () => {
  const justUnder = new Date(Date.now() - (10 * 60 * 1000 - 1000)); // 9m59s ago
  const justOver = new Date(Date.now() - (10 * 60 * 1000 + 1000)); // 10m01s ago

  const underDecision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult({ amount: 1 }),
    receivedAt: justUnder,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: true,
  });
  const overDecision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult({ amount: 1 }),
    receivedAt: justOver,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: true,
  });

  assert.strictEqual(underDecision.decision, 'hold');
  assert.strictEqual(overDecision.decision, 'passthrough');
});

test('decideNormalizerHold accepts an injectable clock for deterministic testing', () => {
  const receivedAt = new Date('2026-01-01T00:00:00.000Z');
  const fiveMinLater = new Date('2026-01-01T00:05:00.000Z').getTime();

  const decision = decideNormalizerHold({
    normalizeResult: llmCallFailureResult(),
    receivedAt,
    maxHoldMinutes: 10,
    parserProducedUsableEntry: true,
    now: () => fiveMinLater,
  });

  assert.strictEqual(decision.decision, 'hold');
});
