// failureClassifier.test.js
// Unit tests for src/queue/failureClassifier.js — Part A5's real
// transient/blocked/permanent classification.

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyError, extractHttpStatus } = require('../../src/queue/failureClassifier');

function errWith(props) {
  return Object.assign(new Error(props.message || 'error'), props);
}

// --- transient ---

test('network errors (ECONNRESET, ETIMEDOUT, etc.) classify as transient', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    assert.strictEqual(classifyError(errWith({ code })), 'transient', `code ${code}`);
  }
});

test('AbortError (timeout) classifies as transient', () => {
  const err = errWith({ message: 'The operation was aborted' });
  err.name = 'AbortError';
  assert.strictEqual(classifyError(err), 'transient');
});

test('HTTP 429 classifies as transient (per Part A5\'s explicit list)', () => {
  assert.strictEqual(classifyError(errWith({ status: 429 })), 'transient');
});

test('HTTP 5xx classifies as transient', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.strictEqual(classifyError(errWith({ status })), 'transient', `status ${status}`);
  }
});

test('googleapis-style error with response.status 500 classifies as transient', () => {
  const err = errWith({ message: 'Internal error' });
  err.response = { status: 500 };
  assert.strictEqual(classifyError(err), 'transient');
});

// --- blocked ---

test('OpenRouter 401 (bad key) classifies as blocked', () => {
  assert.strictEqual(classifyError(errWith({ status: 401 })), 'blocked');
});

test('OpenRouter 402 (no credit) classifies as blocked', () => {
  assert.strictEqual(classifyError(errWith({ status: 402 })), 'blocked');
});

test('Google 403 (sheet not shared) classifies as blocked', () => {
  assert.strictEqual(classifyError(errWith({ status: 403 })), 'blocked');
});

test('Google 404 (wrong sheet id) classifies as blocked', () => {
  assert.strictEqual(classifyError(errWith({ status: 404 })), 'blocked');
});

test('googleapis-style error with numeric .code=401 classifies as blocked', () => {
  const err = errWith({ message: 'Unauthorized' });
  err.code = 401;
  assert.strictEqual(classifyError(err), 'blocked');
});

test('a message-embedded status code (no structured field) is still recognized', () => {
  assert.strictEqual(classifyError(new Error('Request failed with status code 403')), 'blocked');
  assert.strictEqual(classifyError(new Error('Request failed with status code 429')), 'transient');
});

// --- permanent ---

test('a schema violation classifies as permanent', () => {
  assert.strictEqual(classifyError(new Error('schema violation: amount missing')), 'permanent');
});

test('"no handler registered" classifies as permanent', () => {
  assert.strictEqual(classifyError(new Error('No handler registered for job type "bogus".')), 'permanent');
});

test('writeResolutionIdempotent\'s missing-entryId error classifies as permanent', () => {
  assert.strictEqual(
    classifyError(new Error('writeResolutionIdempotent requires resolution.entryId to be set to a deterministic hash.')),
    'permanent',
  );
});

test('a generic 400 Bad Request classifies as permanent (not transient, not blocked)', () => {
  assert.strictEqual(classifyError(errWith({ status: 400 })), 'permanent');
});

// --- defaults / robustness ---

test('an unrecognized error shape defaults to transient', () => {
  assert.strictEqual(classifyError(new Error('something went wrong')), 'transient');
});

test('classifyError never throws, even given garbage input', () => {
  assert.strictEqual(classifyError(null), 'transient');
  assert.strictEqual(classifyError(undefined), 'transient');
  assert.strictEqual(classifyError('a plain string'), 'transient');
  assert.strictEqual(classifyError({}), 'transient');
});

test('extractHttpStatus reads status/code/response.status in that priority order', () => {
  assert.strictEqual(extractHttpStatus(errWith({ status: 429 })), 429);
  assert.strictEqual(extractHttpStatus(Object.assign(new Error('x'), { code: 403 })), 403);
  assert.strictEqual(extractHttpStatus(Object.assign(new Error('x'), { response: { status: 500 } })), 500);
  assert.strictEqual(extractHttpStatus(new Error('no status here')), null);
});
