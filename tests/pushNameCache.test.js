// pushNameCache.test.js
// Unit tests for src/pushNameCache.js — the in-memory JID -> pushName
// cache that lets a ✅/❌ reaction (which carries no display name of its
// own) still resolve to a real name, as long as that JID has sent at
// least one text message (which does carry pushName) since the cache was
// created.

const { test } = require('node:test');
const assert = require('node:assert');

const { createPushNameCache } = require('../src/pushNameCache');

test('remember then get returns the remembered name for that JID', () => {
  const cache = createPushNameCache();
  cache.remember('a@s.whatsapp.net', 'Hanshul');
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Hanshul');
});

test('get returns undefined for a JID that was never remembered', () => {
  const cache = createPushNameCache();
  assert.strictEqual(cache.get('never-seen@s.whatsapp.net'), undefined);
});

test('a later remember call for the same JID overwrites the earlier name', () => {
  const cache = createPushNameCache();
  cache.remember('a@s.whatsapp.net', 'Old Name');
  cache.remember('a@s.whatsapp.net', 'New Name');
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'New Name');
});

test('remember with a falsy/empty pushName is a no-op and never overwrites a known name', () => {
  const cache = createPushNameCache();
  cache.remember('a@s.whatsapp.net', 'Real Name');

  cache.remember('a@s.whatsapp.net', undefined);
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Real Name');

  cache.remember('a@s.whatsapp.net', null);
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Real Name');

  cache.remember('a@s.whatsapp.net', '');
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Real Name');

  cache.remember('a@s.whatsapp.net', '   ');
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Real Name');
});

test('remember with a missing jid is a no-op (never throws)', () => {
  const cache = createPushNameCache();
  assert.doesNotThrow(() => cache.remember(undefined, 'Name'));
  assert.doesNotThrow(() => cache.remember(null, 'Name'));
  assert.doesNotThrow(() => cache.remember('', 'Name'));
});

test('names are tracked independently per JID', () => {
  const cache = createPushNameCache();
  cache.remember('a@s.whatsapp.net', 'Alice');
  cache.remember('b@s.whatsapp.net', 'Bob');

  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Alice');
  assert.strictEqual(cache.get('b@s.whatsapp.net'), 'Bob');
});

test('a stored name is trimmed of surrounding whitespace', () => {
  const cache = createPushNameCache();
  cache.remember('a@s.whatsapp.net', '  Hanshul  ');
  assert.strictEqual(cache.get('a@s.whatsapp.net'), 'Hanshul');
});
