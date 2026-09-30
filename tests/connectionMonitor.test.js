// connectionMonitor.test.js
// Property-based and unit tests for src/connectionMonitor.js (Phase 7 —
// Hardening & Deployment). See
// .kiro/specs/hardening-deployment/design.md "Correctness Properties" for
// design context.
//
// No real timers are used anywhere in this file — every test passes
// explicit `at` timestamps, per connectionMonitor.js's own design (it
// accepts timestamps as data rather than calling Date.now() internally).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('fast-check');

const { createConnectionMonitor, recoveryNoticeText } = require('../src/connectionMonitor');

function makeTmpAlertLogPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-monitor-test-'));
  return { tmpDir, alertLogPath: path.join(tmpDir, 'connection-alerts.log') };
}

function readAlertLogEntries(alertLogPath) {
  if (!fs.existsSync(alertLogPath)) return [];
  return fs
    .readFileSync(alertLogPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Property 3: Exactly one Offline_Alert is raised per continuous outage,
// only once the threshold is crossed
// ---------------------------------------------------------------------------

// Feature: hardening-deployment, Property 3: Exactly one Offline_Alert is raised per continuous outage, only once the threshold is crossed
test('Property 3: Exactly one Offline_Alert is raised per continuous outage, only once the threshold is crossed', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1000, max: 600000 }), // thresholdMs
      fc.array(fc.integer({ min: 0, max: 700000 }), { minLength: 1, maxLength: 10 }), // offsets (ms since disconnect) at which checkAndMaybeAlert is called
      async (thresholdMs, offsets) => {
        const { tmpDir, alertLogPath } = makeTmpAlertLogPath();
        try {
          const monitor = createConnectionMonitor({ thresholdMs, alertLogPath, fallbackNumber: null });

          const disconnectedAt = new Date(1000000);
          monitor.onDisconnected(disconnectedAt);

          for (const offset of offsets) {
            await monitor.checkAndMaybeAlert(new Date(disconnectedAt.getTime() + offset));
          }

          const anyQualified = offsets.some((o) => o >= thresholdMs);
          const entries = readAlertLogEntries(alertLogPath).filter((e) => e.event === 'connection_offline_alert');

          if (anyQualified) {
            assert.strictEqual(entries.length, 1, 'expected exactly one alert log entry once threshold is crossed');
          } else {
            assert.strictEqual(entries.length, 0, 'expected zero alert log entries when threshold never crossed');
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 4: A recovery notice is sent only for outages that actually
// crossed the alert threshold
// ---------------------------------------------------------------------------

// Feature: hardening-deployment, Property 4: A recovery notice is sent only for outages that actually crossed the alert threshold
test('Property 4: A recovery notice is sent only for outages that actually crossed the alert threshold', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1000, max: 600000 }), // thresholdMs
      fc.integer({ min: 0, max: 700000 }), // outageDurationMs (until reconnect)
      fc.boolean(), // whether a qualifying checkAndMaybeAlert call happens before reconnect
      fc.boolean(), // whether a fallbackNumber is configured
      async (thresholdMs, outageDurationMs, checkedBeforeReconnect, hasFallback) => {
        const { tmpDir, alertLogPath } = makeTmpAlertLogPath();
        try {
          const fallbackNumber = hasFallback ? 'fallback@s.whatsapp.net' : null;
          const monitor = createConnectionMonitor({ thresholdMs, alertLogPath, fallbackNumber });

          const disconnectedAt = new Date(1000000);
          monitor.onDisconnected(disconnectedAt);

          const outageCrossedThreshold = outageDurationMs >= thresholdMs;

          if (checkedBeforeReconnect) {
            // Check partway through (or at the end of) the outage — only
            // qualifies if that check's own timestamp is >= threshold.
            await monitor.checkAndMaybeAlert(new Date(disconnectedAt.getTime() + outageDurationMs));
          }

          const sendCalls = [];
          const sendMessage = async (jid, content) => {
            sendCalls.push({ jid, content });
          };

          await monitor.onReconnected({ sendMessage, at: new Date(disconnectedAt.getTime() + outageDurationMs) });

          const wasEverAlerted = checkedBeforeReconnect && outageCrossedThreshold;
          const recoveredEntries = readAlertLogEntries(alertLogPath).filter((e) => e.event === 'connection_recovered');

          if (!wasEverAlerted) {
            assert.strictEqual(sendCalls.length, 0, 'no recovery notice for an outage that never crossed the threshold');
            assert.strictEqual(recoveredEntries.length, 0);
          } else {
            assert.strictEqual(recoveredEntries.length, 1, 'exactly one connection_recovered log entry for an alerted outage');
            if (hasFallback) {
              assert.strictEqual(sendCalls.length, 1);
              assert.strictEqual(sendCalls[0].jid, fallbackNumber);
            } else {
              assert.strictEqual(sendCalls.length, 0, 'no send attempted when no fallbackNumber is configured');
            }
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 5: A failed recovery-notice send is logged and swallowed, never
// retried
// ---------------------------------------------------------------------------

// Feature: hardening-deployment, Property 5: A failed recovery-notice send is logged and swallowed, never retried
test('Property 5: A failed recovery-notice send is logged and swallowed, never retried', async () => {
  const { tmpDir, alertLogPath } = makeTmpAlertLogPath();
  try {
    const thresholdMs = 5000;
    const monitor = createConnectionMonitor({ thresholdMs, alertLogPath, fallbackNumber: 'fallback@s.whatsapp.net' });

    const disconnectedAt = new Date(1000000);
    monitor.onDisconnected(disconnectedAt);
    await monitor.checkAndMaybeAlert(new Date(disconnectedAt.getTime() + thresholdMs));

    let sendCalls = 0;
    const sendMessage = async () => {
      sendCalls += 1;
      throw new Error('simulated send failure');
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(
        monitor.onReconnected({ sendMessage, at: new Date(disconnectedAt.getTime() + thresholdMs + 1000) })
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.strictEqual(sendCalls, 1, 'sendMessage must be attempted exactly once, never retried');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Targeted unit tests
// ---------------------------------------------------------------------------

test('a fresh outage after a previously alerted-and-recovered one starts unalerted again', async () => {
  const { tmpDir, alertLogPath } = makeTmpAlertLogPath();
  try {
    const monitor = createConnectionMonitor({ thresholdMs: 1000, alertLogPath, fallbackNumber: null });

    const firstDisconnect = new Date(0);
    monitor.onDisconnected(firstDisconnect);
    await monitor.checkAndMaybeAlert(new Date(2000)); // crosses threshold
    await monitor.onReconnected({ sendMessage: async () => {}, at: new Date(2000) });

    // Second outage, immediately re-checked before its own threshold —
    // must NOT be considered alerted just because the previous outage was.
    const secondDisconnect = new Date(3000);
    monitor.onDisconnected(secondDisconnect);
    const alertedTooSoon = await monitor.checkAndMaybeAlert(new Date(3100));
    assert.strictEqual(alertedTooSoon, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('recoveryNoticeText includes an approximate minute count', () => {
  const text = recoveryNoticeText(5 * 60 * 1000);
  assert.ok(text.includes('5 minute'));
  assert.ok(text.toLowerCase().includes('reconnected'));
});

test('onReconnected with no prior onDisconnected call is a no-op (defensive)', async () => {
  const { tmpDir, alertLogPath } = makeTmpAlertLogPath();
  try {
    const monitor = createConnectionMonitor({ thresholdMs: 1000, alertLogPath, fallbackNumber: 'fb@s.whatsapp.net' });
    let sendCalls = 0;
    await monitor.onReconnected({ sendMessage: async () => { sendCalls += 1; } });
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(readAlertLogEntries(alertLogPath).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
