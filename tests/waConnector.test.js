// waConnector.test.js
// Tests for src/waConnector.js — Requirement 4.1 ("The system SHALL listen
// for a Baileys 'messages.reaction' event") and 4.2 ("...and invoke the
// injected onReaction handler once per reaction with (sock, reaction)").
//
// Testing note: startWhatsApp() internally calls useMultiFileAuthState
// (real filesystem I/O), fetchLatestBaileysVersion (real network call), and
// makeWASocket (real Baileys socket construction) from
// '@whiskeysockets/baileys'. None of these are injectable via
// startWhatsApp's current parameters, and this task is scoped to NOT modify
// src/waConnector.js. node:test's `mock.module()` API (which could stub out
// '@whiskeysockets/baileys') is only available on this Node install behind
// the --experimental-test-module-mocks flag, which the project's `npm test`
// script (`node --test`) does not pass — so it isn't reliably available
// here. Per the task's guidance, this file instead uses:
//
//   1. A structural (static source-inspection) test — in the same spirit as
//      tests/approvalEngineStructural.test.js — asserting the
//      'messages.reaction' listener is registered, onReaction is
//      destructured from the handlers parameter, and the reconnect call
//      passes onReaction through.
//   2. A behavioral test that replicates the exact reaction-iteration
//      callback body (copied verbatim from src/waConnector.js's
//      `sock.ev.on('messages.reaction', ...)` handler) as a standalone
//      function, and exercises it with fake reaction arrays and a fake
//      sock/onReaction spy. This validates the actual iteration logic
//      (call onReaction once per reaction, with (sock, reaction), and
//      tolerate a missing onReaction) without needing a real Baileys
//      socket.
//   3. Direct unit tests for extractText and isGroupAdmin, which ARE pure
//      functions directly testable with fake inputs.
//
// Validates: Requirements 4.1, 4.2

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { extractText, isGroupAdmin } = require('../src/waConnector');

const WA_CONNECTOR_PATH = path.join(__dirname, '..', 'src', 'waConnector.js');

describe('waConnector.js structural constraints (Requirements 4.1, 4.2)', () => {
  const source = fs.readFileSync(WA_CONNECTOR_PATH, 'utf8');

  test("registers a 'messages.reaction' listener on sock.ev", () => {
    assert.match(source, /sock\.ev\.on\(\s*['"]messages\.reaction['"]/);
  });

  test('destructures onReaction from the handlers parameter of startWhatsApp', () => {
    // Phase 7 added onDisconnected/getAuthState/setTimeoutFn/reconnectAttempt
    // to this same parameter list (see waConnector.test.js's Phase 7 describe
    // block below) — this assertion only needs onGroupMessage/onReady/
    // onReaction to still be present, in order, not that the parameter list
    // is exactly those three and nothing else.
    assert.match(
      source,
      /async function startWhatsApp\(\{\s*onGroupMessage,\s*onReady,\s*onReaction,/
    );
  });

  test('passes onReaction through on reconnect (recursive startWhatsApp call)', () => {
    // Phase 7 wraps the recursive call in setTimeoutFn(() => { ... }, delay)
    // and spreads it across multiple lines/properties, so the reconnect
    // call body is isolated by matching from "startWhatsApp({" up to the
    // closing "});" that ends the setTimeoutFn callback, rather than a
    // single-line, single-brace-depth regex.
    const startIndex = source.indexOf('startWhatsApp({', source.indexOf("connection === 'close'"));
    assert.notStrictEqual(startIndex, -1, 'expected to find a recursive startWhatsApp({...}) call after the close handler');

    const reconnectCallBody = source.slice(startIndex, source.indexOf('}, delayMs);', startIndex));
    assert.ok(
      reconnectCallBody.includes('onReaction'),
      `expected the reconnect call to include onReaction, found: ${reconnectCallBody}`
    );
  });
});

describe('waConnector.js Phase 7 structural constraints (Requirements 1.1-1.4, 2.1, 3.2, 3.5)', () => {
  const source = fs.readFileSync(WA_CONNECTOR_PATH, 'utf8');

  test('destructures onDisconnected, getAuthState, setTimeoutFn, and reconnectAttempt from the handlers parameter', () => {
    assert.match(source, /onDisconnected,/);
    assert.match(source, /getAuthState = \(\) => useMultiFileAuthState\(AUTH_DIR\),/);
    assert.match(source, /setTimeoutFn = setTimeout,/);
    assert.match(source, /reconnectAttempt = 0,/);
  });

  test('calls getAuthState() instead of useMultiFileAuthState(AUTH_DIR) directly', () => {
    assert.match(source, /await getAuthState\(\)/);
    assert.doesNotMatch(source, /const \{ state, saveCreds \} = await useMultiFileAuthState/);
  });

  test('calls onDisconnected before the isLoggedOut check inside the close branch', () => {
    const closeIndex = source.indexOf("if (connection === 'close')");
    const onDisconnectedIndex = source.indexOf('onDisconnected()', closeIndex);
    const loggedOutIndex = source.indexOf('isLoggedOut', closeIndex);
    assert.ok(closeIndex !== -1 && onDisconnectedIndex !== -1 && loggedOutIndex !== -1);
    assert.ok(onDisconnectedIndex < loggedOutIndex, 'onDisconnected() must be called before the isLoggedOut check');
  });

  test('resets currentAttempt to 0 inside the open branch', () => {
    const openIndex = source.indexOf("if (connection === 'open')");
    const resetIndex = source.indexOf('currentAttempt = 0;', openIndex);
    assert.ok(openIndex !== -1 && resetIndex !== -1);
  });

  test('reconnects via setTimeoutFn with a computeBackoffDelayMs delay, not an immediate call', () => {
    assert.match(source, /const delayMs = computeBackoffDelayMs\(currentAttempt\)/);
    assert.match(source, /setTimeoutFn\(\(\) => \{/);
    assert.match(source, /\}, delayMs\);/);
  });
});

describe('reaction-iteration logic (behavioral, replicated from waConnector.js)', () => {
  // This mirrors, verbatim, the body registered via:
  //   sock.ev.on('messages.reaction', async (reactions) => {
  //     for (const reaction of reactions) {
  //       if (typeof onReaction === 'function') {
  //         onReaction(sock, reaction);
  //       }
  //     }
  //   });
  async function handleReactions(sock, onReaction, reactions) {
    for (const reaction of reactions) {
      if (typeof onReaction === 'function') {
        onReaction(sock, reaction);
      }
    }
  }

  test('calls onReaction once per reaction, with (sock, reaction)', async () => {
    const fakeSock = { fake: 'sock' };
    const calls = [];
    const onReaction = (sock, reaction) => calls.push({ sock, reaction });

    const reactions = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
    await handleReactions(fakeSock, onReaction, reactions);

    assert.strictEqual(calls.length, reactions.length);
    for (let i = 0; i < reactions.length; i++) {
      assert.strictEqual(calls[i].sock, fakeSock);
      assert.strictEqual(calls[i].reaction, reactions[i]);
    }
  });

  test('does nothing (no throw) when there are zero reactions', async () => {
    const calls = [];
    await handleReactions({}, (s, r) => calls.push(r), []);
    assert.strictEqual(calls.length, 0);
  });

  test('tolerates a missing/omitted onReaction handler', async () => {
    // Regression safety: when onReaction is omitted, iteration must not
    // throw (typeof undefined === 'function' is false, so the call is
    // simply skipped).
    await assert.doesNotReject(() => handleReactions({}, undefined, [{ id: 'r1' }]));
  });
});

describe('connection.update close/reconnect logic (behavioral, replicated from waConnector.js)', () => {
  const { computeBackoffDelayMs } = require('../src/reconnectBackoff');
  const { DisconnectReason } = require('@whiskeysockets/baileys');

  // This mirrors, verbatim in spirit, the body registered via:
  //   sock.ev.on('connection.update', (update) => { ... if (connection ===
  //   'close') { onDisconnected?.(); ...isLoggedOut check + return...;
  //   delayMs = computeBackoffDelayMs(currentAttempt); setTimeoutFn(() =>
  //   startWhatsApp({..., reconnectAttempt: currentAttempt + 1}), delayMs);
  //   } });
  function handleClose({ lastDisconnect, onDisconnected, setTimeoutFn, currentAttempt, onReconnect }) {
    if (typeof onDisconnected === 'function') {
      onDisconnected();
    }

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

    if (isLoggedOut) {
      return;
    }

    const delayMs = computeBackoffDelayMs(currentAttempt);
    setTimeoutFn(() => onReconnect(currentAttempt + 1), delayMs);
  }

  test('close (not logged out): calls onDisconnected, then schedules a reconnect via setTimeoutFn with the backoff delay for the current attempt', () => {
    const disconnectedCalls = [];
    const scheduled = [];

    handleClose({
      lastDisconnect: { error: { output: { statusCode: 428 } } },
      onDisconnected: () => disconnectedCalls.push(true),
      setTimeoutFn: (fn, delay) => scheduled.push({ fn, delay }),
      currentAttempt: 2,
      onReconnect: (nextAttempt) => scheduled.push({ nextAttempt }),
    });

    assert.strictEqual(disconnectedCalls.length, 1);
    assert.strictEqual(scheduled.length, 1);
    assert.strictEqual(scheduled[0].delay, computeBackoffDelayMs(2));

    scheduled[0].fn();
    assert.strictEqual(scheduled[1].nextAttempt, 3);
  });

  test('close (logged out): calls onDisconnected but makes zero setTimeoutFn calls (Requirement 1.4 regression)', () => {
    const disconnectedCalls = [];
    let setTimeoutCalls = 0;

    handleClose({
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
      onDisconnected: () => disconnectedCalls.push(true),
      setTimeoutFn: () => {
        setTimeoutCalls += 1;
      },
      currentAttempt: 0,
      onReconnect: () => {},
    });

    assert.strictEqual(disconnectedCalls.length, 1, 'onDisconnected must still fire even on logout');
    assert.strictEqual(setTimeoutCalls, 0, 'must never schedule a reconnect on explicit logout');
  });

  test('tolerates a missing/omitted onDisconnected handler on close', () => {
    let setTimeoutCalls = 0;
    assert.doesNotThrow(() =>
      handleClose({
        lastDisconnect: { error: { output: { statusCode: 428 } } },
        onDisconnected: undefined,
        setTimeoutFn: () => {
          setTimeoutCalls += 1;
        },
        currentAttempt: 0,
        onReconnect: () => {},
      })
    );
    assert.strictEqual(setTimeoutCalls, 1);
  });

  test('successive close attempts (open never observed) increase the backoff delay', () => {
    const delays = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      handleClose({
        lastDisconnect: { error: { output: { statusCode: 428 } } },
        onDisconnected: () => {},
        setTimeoutFn: (fn, delay) => delays.push(delay),
        currentAttempt: attempt,
        onReconnect: () => {},
      });
    }
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] >= delays[i - 1], `expected non-decreasing delays, got ${delays}`);
    }
  });
});

describe('extractText (regression safety)', () => {
  test('extracts message.conversation', () => {
    const msg = { message: { conversation: 'hello there' } };
    assert.strictEqual(extractText(msg), 'hello there');
  });

  test('extracts message.extendedTextMessage.text', () => {
    const msg = { message: { extendedTextMessage: { text: 'extended text' } } };
    assert.strictEqual(extractText(msg), 'extended text');
  });

  test('extracts message.imageMessage.caption', () => {
    const msg = { message: { imageMessage: { caption: 'a photo caption' } } };
    assert.strictEqual(extractText(msg), 'a photo caption');
  });

  test('extracts message.videoMessage.caption', () => {
    const msg = { message: { videoMessage: { caption: 'a video caption' } } };
    assert.strictEqual(extractText(msg), 'a video caption');
  });

  test('returns null when there is no text content', () => {
    const msg = { message: { stickerMessage: {} } };
    assert.strictEqual(extractText(msg), null);
  });

  test('returns null when message is missing entirely', () => {
    assert.strictEqual(extractText({}), null);
    assert.strictEqual(extractText({ message: null }), null);
  });
});

describe('isGroupAdmin (regression safety)', () => {
  const participants = [
    { id: 'admin@s.whatsapp.net', admin: 'admin' },
    { id: 'superadmin@s.whatsapp.net', admin: 'superadmin' },
    { id: 'member@s.whatsapp.net', admin: null },
  ];

  function makeFakeSock() {
    return {
      groupMetadata: async (_groupId) => ({ participants }),
    };
  }

  test('returns true for a participant with admin: "admin"', async () => {
    const sock = makeFakeSock();
    const result = await isGroupAdmin(sock, 'group@g.us', 'admin@s.whatsapp.net');
    assert.strictEqual(result, true);
  });

  test('returns true for a participant with admin: "superadmin"', async () => {
    const sock = makeFakeSock();
    const result = await isGroupAdmin(sock, 'group@g.us', 'superadmin@s.whatsapp.net');
    assert.strictEqual(result, true);
  });

  test('returns false for a participant with no admin field (regular member)', async () => {
    const sock = makeFakeSock();
    const result = await isGroupAdmin(sock, 'group@g.us', 'member@s.whatsapp.net');
    assert.strictEqual(result, false);
  });

  test('returns false when the participant is not found in the group at all', async () => {
    const sock = makeFakeSock();
    const result = await isGroupAdmin(sock, 'group@g.us', 'stranger@s.whatsapp.net');
    assert.strictEqual(result, false);
  });
});
