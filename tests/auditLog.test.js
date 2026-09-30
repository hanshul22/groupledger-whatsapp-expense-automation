// auditLog.test.js
// Unit tests for src/auditLog.js's appendAuditLog(auditLogPath, entry).
// See .kiro/specs/approval-engine/tasks.md task 2.2.
//
// Validates: Requirements 5.2, 8.5

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendAuditLog } = require('../src/auditLog');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-test-'));
}

function readLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').filter((line) => line.length > 0);
}

test('appending multiple entries results in valid JSON lines readable back in append order', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auditLogPath = path.join(tmpDir, 'audit.log');
  const entries = [
    { event: 'expense_recorded', entryId: '1', at: '2024-01-01T00:00:00.000Z' },
    { event: 'expense_approved', entryId: '1', responderJid: 'a@s.whatsapp.net', at: '2024-01-01T00:01:00.000Z' },
    { event: 'expense_rejected', entryId: '2', detail: 'duplicate', at: '2024-01-01T00:02:00.000Z' },
  ];

  for (const entry of entries) {
    await appendAuditLog(auditLogPath, entry);
  }

  const lines = readLines(auditLogPath);
  assert.strictEqual(lines.length, entries.length);

  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepStrictEqual(parsed, entries);
});

test('appending works when the target directory does not exist yet', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const nestedDir = path.join(tmpDir, 'nested', 'does-not-exist-yet');
  const auditLogPath = path.join(nestedDir, 'audit.log');

  assert.strictEqual(fs.existsSync(nestedDir), false);

  const entry = { event: 'expense_recorded', entryId: '1', at: '2024-01-01T00:00:00.000Z' };
  await appendAuditLog(auditLogPath, entry);

  assert.strictEqual(fs.existsSync(auditLogPath), true);
  const lines = readLines(auditLogPath);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), entry);
});

test('appending works when the target file does not exist yet but the directory does', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auditLogPath = path.join(tmpDir, 'audit.log');
  assert.strictEqual(fs.existsSync(auditLogPath), false);

  const entry = { event: 'expense_recorded', entryId: '1', at: '2024-01-01T00:00:00.000Z' };
  await appendAuditLog(auditLogPath, entry);

  assert.strictEqual(fs.existsSync(auditLogPath), true);
  const lines = readLines(auditLogPath);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), entry);
});
