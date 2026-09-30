// approvalEngineStructural.test.js
// Structural (static source-inspection) test for src/approvalEngine.js.
// See .kiro/specs/approval-engine/design.md "Testing Strategy": Requirement
// 7.4 (no Sheets writes / no ledger messages from this module) is enforced
// by design review — approvalEngine.js's only external dependencies are the
// injected isGroupAdmin and sendMessage functions and the local filesystem;
// it imports no Sheets client and defines no ledger-confirmation message
// copy. This is a static/structural check, not a property-based test, so it
// uses plain node:test + node:assert (no fast-check).
//
// Validates: Requirements 7.4

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APPROVAL_ENGINE_PATH = path.join(__dirname, '..', 'src', 'approvalEngine.js');
const DECISION_PROCESSOR_PATH = path.join(__dirname, '..', 'src', 'decisionProcessor.js');
const NOTIFIER_PATH = path.join(__dirname, '..', 'src', 'notifier.js');

// Strips `//` line comments and `/* ... */` block comments (including
// JSDoc) so structural checks below inspect only executable source (string
// literals, identifiers, requires) — not prose in comments that may
// legitimately reference "Sheets" or "ledger" while explaining that the
// module does NOT touch them (as approvalEngine.js's own header comment
// does).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

describe('approvalEngine.js structural constraints (Requirement 7.4)', () => {
  const source = fs.readFileSync(APPROVAL_ENGINE_PATH, 'utf8');
  const code = stripComments(source);

  test('does not reference a Sheets/Google API client (googleapis)', () => {
    assert.doesNotMatch(code, /googleapis/i);
  });

  test('does not require a sheets-writer module', () => {
    assert.doesNotMatch(code, /require\(['"]\.\/sheets/i);
    assert.doesNotMatch(code, /require\(['"]googleapis['"]\)/i);
  });

  test('defines no ledger-confirmation/rejection message text', () => {
    // The module hands off resolutions via the injected Resolution_Callback
    // and never itself composes a "ledger" confirmation/rejection message.
    // Checked against comment-stripped code so the module's own doc
    // comments (which explain it does NOT send ledger messages) don't
    // trigger a false positive.
    assert.doesNotMatch(code, /ledger/i);
  });
});

describe('sibling Phase 4 modules also avoid Sheets/ledger side effects', () => {
  // Optional extension per the task's judgment call: decisionProcessor.js
  // and notifier.js are also part of the Approval Engine's implementation
  // and share the same architectural constraint (no direct Sheets/ledger
  // writes) per design.md's module boundary.
  for (const [name, filePath] of [
    ['decisionProcessor.js', DECISION_PROCESSOR_PATH],
    ['notifier.js', NOTIFIER_PATH],
  ]) {
    test(`${name} does not reference googleapis or a sheets-writer module`, () => {
      const src = stripComments(fs.readFileSync(filePath, 'utf8'));
      assert.doesNotMatch(src, /googleapis/i);
      assert.doesNotMatch(src, /require\(['"]\.\/sheets/i);
      assert.doesNotMatch(src, /require\(['"]googleapis['"]\)/i);
    });
  }
});
