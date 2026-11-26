'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../lib/store');
const { validateKey, tierLimits, tierQuotas } = require('../lib/auth');

test('api-keys: create key generates raw secret once and stores hashed key', () => {
  const { record, secret } = store.createKeyRecord({ name: 'Payment App', tier: 'PRO' });

  assert.ok(secret.startsWith('gw_live_'), 'Raw secret should start with gw_live_');
  assert.equal(secret.length, 48, 'Raw secret should be 48 characters');
  assert.equal(record.tier, 'PRO');
  assert.equal(record.enabled, true);
  assert.ok(record.maskedKey.startsWith('gw_live_***'));

  // Raw secret must NOT be in the stored record
  assert.equal(record.secret, undefined);
  const inStore = store.getKeyRecord(record.id);
  assert.ok(inStore.keyHash, 'Store must have keyHash');
  assert.equal(inStore.secret, undefined, 'Store must not have raw secret');

  // Verify hash matches
  const expectedHash = crypto.createHash('sha256').update(secret).digest('hex');
  assert.equal(inStore.keyHash, expectedHash);
});

test('api-keys: validateKey succeeds with valid generated key', () => {
  const { record, secret } = store.createKeyRecord({ name: 'Auth Test App', tier: 'PREMIUM' });
  const res = validateKey(secret);

  assert.equal(res.valid, true);
  assert.equal(res.tier, 'PREMIUM');
  assert.equal(res.keyId, record.id);
  assert.equal(res.name, 'Auth Test App');
});

test('api-keys: validateKey rejects invalid key', () => {
  const res = validateKey('gw_live_totally_bogus_key_1234567890');
  assert.equal(res.valid, false);
  assert.equal(res.status, 403);
});

test('api-keys: validateKey rejects disabled key', () => {
  const { record, secret } = store.createKeyRecord({ name: 'Disabled App', tier: 'FREE' });
  store.setKeyEnabled(record.id, false);

  const res = validateKey(secret);
  assert.equal(res.valid, false);
  assert.equal(res.status, 403);
  assert.ok(res.error.includes('disabled'));
});

test('api-keys: validateKey rejects revoked/deleted key', () => {
  const { record, secret } = store.createKeyRecord({ name: 'Revoked App', tier: 'FREE' });
  store.deleteKey(record.id);

  const res = validateKey(secret);
  assert.equal(res.valid, false);
  assert.equal(res.status, 403);
});

test('api-keys: tierLimits returns correct capacity and rate limits', () => {
  const free = tierLimits('FREE');
  const pro = tierLimits('PRO');
  const prem = tierLimits('PREMIUM');

  assert.equal(free.capacity, 20);
  assert.equal(pro.capacity, 100);
  assert.equal(prem.capacity, 500);

  assert.equal(tierQuotas('FREE'), 10000);
  assert.equal(tierQuotas('PRO'), 100000);
  assert.equal(tierQuotas('PREMIUM'), 1000000);
});
