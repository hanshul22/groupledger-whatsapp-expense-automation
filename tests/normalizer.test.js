// normalizer.test.js
// Tests for src/normalizer.js (v1.1 — LLM Normalization Layer). See
// doc/trd.md §8 and doc/prd.md §10 for the full design context.
//
// Covers: mode=off/shadow inertness on the live path (FR11), fail-open
// behavior on every technical failure, and the deterministic guards
// G1-G8 (FR12) that gate a `normalized` result vs `needs_clarification`.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createNormalizer,
  extractAllAmounts,
  containsDigits,
  amountsMatch,
  sharesToken,
  isDateWithinWindow,
} = require('../src/normalizer');

const REFERENCE_DATE = new Date('2026-08-19T18:42:00+05:30');

/**
 * Install a stub `global.fetch` for the duration of `fn`, restoring the
 * original afterward (even on throw). `impl` receives the same args real
 * fetch would and must return a Response-shaped object (or throw/reject to
 * simulate a network error).
 */
async function withStubFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    await fn();
  } finally {
    global.fetch = original;
  }
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  };
}

function llmContent(fields) {
  return JSON.stringify({
    is_expense: true,
    multiple_entries: false,
    amount: null,
    given_to: null,
    date: null,
    description: '',
    party: null,
    confidence: 0.95,
    notes: '',
    ...fields,
  });
}

function chatCompletion(content, { model = 'test/model' } = {}) {
  return jsonResponse({
    model,
    choices: [{ message: { content } }],
  });
}

// ---------------------------------------------------------------------------
// Mode inertness (FR11)
// ---------------------------------------------------------------------------

test('mode=off never calls fetch and returns passthrough unchanged', async () => {
  let fetchCalled = false;
  await withStubFetch(
    async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called when mode=off');
    },
    async () => {
      const normalizer = createNormalizer({ mode: 'off', apiKey: 'key', model: 'm' });
      const parsed = { amount: 500, given_to: 'Ram', date: '2026-08-19', paid_by: 'Sita', raw_message: 'gave 500 to ram' };

      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(result.status, 'passthrough');
      assert.strictEqual(result.entry, parsed);
      assert.strictEqual(result.meta.changed, false);
    },
  );
});

test('missing OPENROUTER_API_KEY falls open to passthrough without calling fetch', async () => {
  let fetchCalled = false;
  await withStubFetch(
    async () => {
      fetchCalled = true;
      return chatCompletion(llmContent({}));
    },
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: undefined, model: 'm' });
      const parsed = { amount: 500, given_to: 'Ram', date: '2026-08-19', paid_by: 'Sita', raw_message: 'gave 500 to ram' };

      const result = await normalizer.normalize({ rawText: 'gave 500 to ram', parsed, messageTimestamp: REFERENCE_DATE });

      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(result.status, 'passthrough');
      assert.strictEqual(result.entry, parsed);
    },
  );
});

test('mode=shadow returns passthrough immediately without awaiting the LLM call', async () => {
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => {
    resolveFetch = resolve;
  });

  await withStubFetch(
    async () => pendingFetch, // never resolves during this test
    async () => {
      const normalizer = createNormalizer({ mode: 'shadow', apiKey: 'key', model: 'm' });
      const parsed = { amount: 500, given_to: 'Ram', date: '2026-08-19', paid_by: 'Sita', raw_message: 'gave 500 to ram' };

      const start = Date.now();
      const result = await normalizer.normalize({ rawText: 'gave 500 to ram', parsed, messageTimestamp: REFERENCE_DATE });
      const elapsedMs = Date.now() - start;

      assert.strictEqual(result.status, 'passthrough');
      assert.strictEqual(result.entry, parsed);
      // Should return near-instantly since the LLM call is fired in the
      // background and never awaited on the live path.
      assert.ok(elapsedMs < 500, `expected shadow mode to return quickly, took ${elapsedMs}ms`);

      // Let the background shadow call resolve so it doesn't leak into
      // another test as an unhandled rejection.
      resolveFetch(chatCompletion(llmContent({ amount: 500, given_to: 'Ram' })));
      await new Promise((r) => setTimeout(r, 10));
    },
  );
});

// ---------------------------------------------------------------------------
// Fail-open on technical failures (FR11)
// ---------------------------------------------------------------------------

test('network error falls open to passthrough (after one retry)', async () => {
  let callCount = 0;
  await withStubFetch(
    async () => {
      callCount += 1;
      throw new Error('ECONNRESET');
    },
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const parsed = { amount: 500, given_to: 'Ram', date: '2026-08-19', paid_by: 'Sita', raw_message: 'gave 500 to ram' };

      const result = await normalizer.normalize({ rawText: 'gave 500 to ram', parsed, messageTimestamp: REFERENCE_DATE });

      assert.strictEqual(result.status, 'passthrough');
      assert.strictEqual(callCount, 2, 'expected exactly one retry after the first failure');
    },
  );
});

test('HTTP 429 falls open to passthrough with no retry', async () => {
  let callCount = 0;
  await withStubFetch(
    async () => {
      callCount += 1;
      return jsonResponse({}, { ok: false, status: 429 });
    },
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'passthrough');
      assert.strictEqual(callCount, 1, 'HTTP 429 must not be retried');
    },
  );
});

test('malformed JSON response falls open to passthrough', async () => {
  await withStubFetch(
    async () => chatCompletion('not valid json at all {{{'),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'passthrough');
    },
  );
});

test('schema-invalid response (missing required keys) falls open to passthrough', async () => {
  await withStubFetch(
    async () => chatCompletion(JSON.stringify({ amount: 500 })), // missing most required keys
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'passthrough');
    },
  );
});

test('response wrapped in markdown code fences is still parsed successfully', async () => {
  const content = '```json\n' + llmContent({ amount: 500, given_to: 'Ram', date: '2026-08-19' }) + '\n```';
  await withStubFetch(
    async () => chatCompletion(content),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram on 19 aug',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'normalized');
      assert.strictEqual(result.entry.amount, 500);
      assert.strictEqual(result.entry.given_to, 'Ram');
    },
  );
});

// ---------------------------------------------------------------------------
// Deterministic guards (FR12)
// ---------------------------------------------------------------------------

test('G2: multiple_entries=true triggers needs_clarification, never a write', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram', multiple_entries: true })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram and 200 to sita',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
      assert.strictEqual(result.entry, undefined);
    },
  );
});

test('G2: is_expense=false triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ is_expense: false })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'hey how are you',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

test('G3: LLM amount not traceable to any digits in the raw message triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 99999, given_to: 'Ram' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram', // 99999 is not derivable from this text
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

test('G3: words-only amount (no digits in message) triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave five hundred to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

test('G3: k-shorthand amount is correctly traced back to the raw message', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 20000, given_to: 'Ram' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 20k to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'normalized');
      assert.strictEqual(result.entry.amount, 20000);
    },
  );
});

test('G4: LLM amount conflicting with the v1.0 parser amount triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const parsed = { amount: 5000, given_to: 'Ram', date: '2026-08-19', paid_by: 'Sita', raw_message: 'gave 500 to ram' };

      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

test('G5: given_to sharing no token with the raw message triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Totally Unrelated Name' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

test('G6: date far outside the sanity window triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram', date: '2020-01-01' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

test('G7: party outside allowedParties is silently cleared, not a failure', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram', party: "Not A Real Party" })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram for groom side',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
        allowedParties: ["Bride's side", "Groom's side"],
      });

      assert.strictEqual(result.status, 'normalized');
      assert.strictEqual(result.entry.party, undefined);
    },
  );
});

test('G7: party matching allowedParties is kept', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram', party: "Groom's side" })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram for groom side',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
        allowedParties: ["Bride's side", "Groom's side"],
      });

      assert.strictEqual(result.status, 'normalized');
      assert.strictEqual(result.entry.party, "Groom's side");
    },
  );
});

test('G8: confidence below NORMALIZER_MIN_CONFIDENCE triggers needs_clarification', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram', confidence: 0.4 })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm', minConfidence: 0.7 });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'needs_clarification');
    },
  );
});

// ---------------------------------------------------------------------------
// Successful normalization / meta.changed
// ---------------------------------------------------------------------------

test('a fully valid, guard-passing response returns a normalized entry with meta.changed=true when it differs from the parser', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 20000, given_to: 'Ram', date: '2026-08-19', description: 'advance to ram' }), { model: 'anthropic/claude-haiku-4.5' }),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'anthropic/claude-haiku-4.5' });
      const parsed = { amount: 20000, given_to: 'ram', date: '2026-08-18', paid_by: 'Sita', raw_message: 'ram ko 20k diye kal' };

      const result = await normalizer.normalize({
        rawText: 'ram ko 20k diye kal',
        parsed,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'normalized');
      assert.strictEqual(result.entry.amount, 20000);
      assert.strictEqual(result.entry.given_to, 'Ram');
      assert.strictEqual(result.entry.date, '2026-08-19');
      assert.strictEqual(result.entry.paid_by, 'Sita'); // carried over from parsed, untouched
      assert.strictEqual(result.meta.changed, true); // given_to/date differ from parsed
      assert.strictEqual(result.meta.model, 'anthropic/claude-haiku-4.5');
      assert.strictEqual(typeof result.meta.confidence, 'number');
    },
  );
});

test('never sets status/approved_by/approved_at/entry_id on the normalized entry (FR13)', async () => {
  await withStubFetch(
    async () => chatCompletion(llmContent({ amount: 500, given_to: 'Ram' })),
    async () => {
      const normalizer = createNormalizer({ mode: 'on', apiKey: 'key', model: 'm' });
      const result = await normalizer.normalize({
        rawText: 'gave 500 to ram',
        parsed: null,
        messageTimestamp: REFERENCE_DATE,
      });

      assert.strictEqual(result.status, 'normalized');
      assert.strictEqual(result.entry.status, undefined);
      assert.strictEqual(result.entry.approved_by, undefined);
      assert.strictEqual(result.entry.approved_at, undefined);
      assert.strictEqual(result.entry.entry_id, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

test('extractAllAmounts understands k/lakh/lac/crore shorthand and Indian digit grouping', () => {
  assert.deepStrictEqual(extractAllAmounts('gave 20k to ram'), [20000]);
  assert.deepStrictEqual(extractAllAmounts('1.5 lakh for catering'), [150000]);
  assert.deepStrictEqual(extractAllAmounts('2 crore for venue'), [20000000]);
  assert.deepStrictEqual(extractAllAmounts('paid 1,50,000 total'), [150000]);
  assert.deepStrictEqual(extractAllAmounts('no numbers here'), []);
});

test('containsDigits detects digit presence', () => {
  assert.strictEqual(containsDigits('gave 500 to ram'), true);
  assert.strictEqual(containsDigits('gave five hundred to ram'), false);
  assert.strictEqual(containsDigits(''), false);
});

test('amountsMatch tolerates floating point noise', () => {
  assert.strictEqual(amountsMatch(20000, 20000.001), true);
  assert.strictEqual(amountsMatch(20000, 20001), false);
});

test('sharesToken matches case-insensitively on shared alphabetic tokens', () => {
  assert.strictEqual(sharesToken('Ram', 'gave 500 to ram'), true);
  assert.strictEqual(sharesToken('RAM SHARMA', 'paid ram for catering'), true);
  assert.strictEqual(sharesToken('Totally Different', 'gave 500 to ram'), false);
});

test('isDateWithinWindow accepts dates within [-365, +7] days and rejects out-of-range/invalid dates', () => {
  assert.strictEqual(isDateWithinWindow('2026-08-19', REFERENCE_DATE), true);
  assert.strictEqual(isDateWithinWindow('2026-08-20', REFERENCE_DATE), true); // +1 day
  assert.strictEqual(isDateWithinWindow('2026-08-27', REFERENCE_DATE), false); // +8 days, out of window
  assert.strictEqual(isDateWithinWindow('2025-08-19', REFERENCE_DATE), true); // -365 days
  assert.strictEqual(isDateWithinWindow('2024-01-01', REFERENCE_DATE), false); // too far in the past
  assert.strictEqual(isDateWithinWindow('2026-02-30', REFERENCE_DATE), false); // impossible calendar date
});
