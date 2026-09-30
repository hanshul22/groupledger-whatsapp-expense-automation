// ecosystemConfig.test.js
// Structural unit test for wedding-expense-bot/ecosystem.config.js (Phase
// 7 — Hardening & Deployment). See
// .kiro/specs/hardening-deployment/tasks.md Task 7.2.
//
// Validates: Requirements 4.1, 4.2, 4.3

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ecosystemConfig = require('../ecosystem.config.js');

test('ecosystem.config.js defines exactly one app targeting src/index.js', () => {
  assert.ok(Array.isArray(ecosystemConfig.apps));
  assert.strictEqual(ecosystemConfig.apps.length, 1);
  assert.strictEqual(ecosystemConfig.apps[0].script, 'src/index.js');
});

test('ecosystem.config.js enables autorestart (Requirement 4.2)', () => {
  assert.strictEqual(ecosystemConfig.apps[0].autorestart, true);
});

test('ecosystem.config.js disables file-watching-triggered restarts (Requirement 4.3)', () => {
  assert.strictEqual(ecosystemConfig.apps[0].watch, false);
});

test('ecosystem.config.js sets an explicit cwd (Requirement 4.1)', () => {
  assert.strictEqual(ecosystemConfig.apps[0].cwd, path.join(__dirname, '..'));
});
