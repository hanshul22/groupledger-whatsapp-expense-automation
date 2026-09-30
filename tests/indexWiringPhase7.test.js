// indexWiringPhase7.test.js
// Structural (source-grep) test confirming src/index.js wires up Phase 7's
// onDisconnected/getAuthState/connectionMonitor.onReconnected, per
// .kiro/specs/hardening-deployment/tasks.md Task 6.3. Matches this
// project's existing convention of not having a full dedicated index.js
// test harness (index.js is wiring-only, verified by the modules it wires
// together plus targeted structural checks — see sheets-writer's Task 6.3
// and responder-commands' Task 6.4 for precedent).
//
// Validates: Requirements 2.1, 2.4, 3.1

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');
const source = fs.readFileSync(INDEX_PATH, 'utf8');

test('constructs getAuthState via createAuthStateFactory reading REDIS_URL', () => {
  assert.match(source, /createAuthStateFactory\(\{\s*[\s\S]*?redisUrl:\s*process\.env\.REDIS_URL/);
});

test('constructs connectionMonitor via createConnectionMonitor reading BOT_ADMIN_FALLBACK_NUMBER', () => {
  assert.match(source, /createConnectionMonitor\(\{\s*[\s\S]*?fallbackNumber:\s*process\.env\.BOT_ADMIN_FALLBACK_NUMBER/);
});

test('passes getAuthState into the startWhatsApp call', () => {
  assert.match(source, /startWhatsApp\(\{\s*getAuthState,/);
});

test('passes an onDisconnected handler calling connectionMonitor.onDisconnected into startWhatsApp', () => {
  assert.match(source, /onDisconnected:\s*\(\)\s*=>\s*connectionMonitor\.onDisconnected\(\)/);
});

test('calls connectionMonitor.onReconnected inside the onReady handler', () => {
  const onReadyIndex = source.indexOf('onReady: async (sock)');
  const onReconnectedIndex = source.indexOf('connectionMonitor.onReconnected', onReadyIndex);
  assert.ok(onReadyIndex !== -1 && onReconnectedIndex !== -1, 'expected connectionMonitor.onReconnected to be called inside onReady');
});

test('starts a periodic setInterval calling connectionMonitor.checkAndMaybeAlert', () => {
  assert.match(source, /setInterval\([\s\S]*?connectionMonitor\.checkAndMaybeAlert\(\)/);
});
