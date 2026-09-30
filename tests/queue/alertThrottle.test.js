// alertThrottle.test.js
// Unit tests for src/queue/alertThrottle.js.

const { test } = require('node:test');
const assert = require('node:assert');

const { createAlertThrottle } = require('../../src/queue/alertThrottle');

test('the first alert for a key is always delivered', () => {
  const delivered = [];
  const throttle = createAlertThrottle({ onAlert: (m) => delivered.push(m) });
  throttle.alert('blocked:sheet_write', 'first');
  assert.deepStrictEqual(delivered, ['first']);
});

test('a second alert for the same key within the cooldown window is suppressed', () => {
  const delivered = [];
  let time = 0;
  const throttle = createAlertThrottle({ onAlert: (m) => delivered.push(m), now: () => time });
  throttle.alert('blocked:sheet_write', 'first');
  time += 1000; // 1 second later, well within the default 1h cooldown
  throttle.alert('blocked:sheet_write', 'second');
  assert.deepStrictEqual(delivered, ['first']);
});

test('an alert for a DIFFERENT key is never throttled by another key\'s cooldown', () => {
  const delivered = [];
  const throttle = createAlertThrottle({ onAlert: (m) => delivered.push(m) });
  throttle.alert('blocked:sheet_write', 'sheet blocked');
  throttle.alert('blocked:normalizer', 'llm blocked');
  assert.deepStrictEqual(delivered, ['sheet blocked', 'llm blocked']);
});

test('an alert for the same key after the cooldown window has elapsed is delivered again', () => {
  const delivered = [];
  let time = 0;
  const throttle = createAlertThrottle({ onAlert: (m) => delivered.push(m), now: () => time, cooldownMs: 1000 });
  throttle.alert('blocked:sheet_write', 'first');
  time += 1001;
  throttle.alert('blocked:sheet_write', 'second');
  assert.deepStrictEqual(delivered, ['first', 'second']);
});

test('clear(key) resets the cooldown so the next alert for that key fires immediately', () => {
  const delivered = [];
  let time = 0;
  const throttle = createAlertThrottle({ onAlert: (m) => delivered.push(m), now: () => time });
  throttle.alert('blocked:sheet_write', 'first');
  throttle.clear('blocked:sheet_write');
  time += 10; // barely any time has passed
  throttle.alert('blocked:sheet_write', 'second');
  assert.deepStrictEqual(delivered, ['first', 'second']);
});

test('a throwing onAlert never propagates out of alert()', () => {
  const throttle = createAlertThrottle({ onAlert: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => throttle.alert('key', 'message'));
});
