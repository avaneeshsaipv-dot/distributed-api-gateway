'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const { validateKey, TIER_QUOTAS } = require('../lib/auth');

test('quotas: usage increments with each request', () => {
  const { record } = store.createKeyRecord({ name: 'Quota App', tier: 'FREE' });
  const ym = new Date().toISOString().slice(0, 7);

  const initial = store.getMonthlyQuotaUsage(record.id, ym);
  assert.equal(initial, 0);

  store.incrementMonthlyQuota(record.id, ym);
  store.incrementMonthlyQuota(record.id, ym);
  assert.equal(store.getMonthlyQuotaUsage(record.id, ym), 2);
});

test('quotas: enforces monthly quota limit on validateKey', () => {
  const { record, secret } = store.createKeyRecord({ name: 'Quota Limit App', tier: 'FREE' });
  const ym = new Date().toISOString().slice(0, 7);

  // Artificially set usage to max FREE quota (10,000)
  if (!store.data.quotas[record.id]) store.data.quotas[record.id] = {};
  store.data.quotas[record.id][ym] = TIER_QUOTAS.FREE;

  const res = validateKey(secret);
  assert.equal(res.valid, false);
  assert.equal(res.status, 429);
  assert.equal(res.quotaExceeded, true);
  assert.ok(res.error.includes('Monthly quota exceeded'));
});

test('quotas: PRO tier allows requests when usage is above FREE limit but below PRO limit', () => {
  const { record, secret } = store.createKeyRecord({ name: 'Pro Quota App', tier: 'PRO' });
  const ym = new Date().toISOString().slice(0, 7);

  // Set usage to 15,000 (above FREE 10,000 but below PRO 100,000)
  if (!store.data.quotas[record.id]) store.data.quotas[record.id] = {};
  store.data.quotas[record.id][ym] = 15000;

  const res = validateKey(secret);
  assert.equal(res.valid, true);
  assert.equal(res.tier, 'PRO');
});
