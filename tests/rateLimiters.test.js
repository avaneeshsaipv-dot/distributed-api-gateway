'use strict';

/**
 * Rate limiter integration tests — REQUIRES a running Redis at localhost:6379.
 *
 * Run:
 *   docker run --rm -p 6379:6379 redis:7-alpine   # in another terminal
 *   node --test tests/rateLimiters.test.js
 *
 * Tests use unique key prefixes per test to avoid cross-test interference.
 * After each test, the keys are deleted.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const redis = require('../lib/redisClient');

const { checkTokenBucket }   = require('../lib/rateLimiters/tokenBucket');
const { checkSlidingWindow } = require('../lib/rateLimiters/slidingWindow');
const { checkLeakyBucket }   = require('../lib/rateLimiters/leakyBucket');

after(async () => {
  // Clean up test keys and close connection so the process can exit
  const keys = await redis.keys('rl:test:*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return `test:${Math.random().toString(36).slice(2)}`;
}

// ── Token Bucket ──────────────────────────────────────────────────────────────

test('token-bucket: allows requests up to capacity', async () => {
  const id = uid();
  const opts = { capacity: 5, refillRate: 0.001 }; // negligible refill

  const results = [];
  for (let i = 0; i < 7; i++) {
    results.push(await checkTokenBucket(id, opts));
  }

  const allowed  = results.filter(r => r.allowed).length;
  const denied   = results.filter(r => !r.allowed).length;
  assert.equal(allowed, 5, `Expected 5 allowed, got ${allowed}`);
  assert.equal(denied,  2, `Expected 2 denied, got ${denied}`);
});

test('token-bucket: refills over time', async () => {
  const id = uid();
  const opts = { capacity: 2, refillRate: 100 }; // 100 tokens/sec = fully refills in 10ms

  // Drain the bucket
  await checkTokenBucket(id, opts);
  await checkTokenBucket(id, opts);
  let r = await checkTokenBucket(id, opts);
  assert.equal(r.allowed, false, 'Should be denied after draining');

  // Wait for refill
  await new Promise(res => setTimeout(res, 25));
  r = await checkTokenBucket(id, opts);
  assert.equal(r.allowed, true, 'Should be allowed after refill');
});

test('token-bucket: returns algorithm name', async () => {
  const id = uid();
  const r  = await checkTokenBucket(id, { capacity: 10, refillRate: 1 });
  assert.equal(r.algorithm, 'token-bucket');
});

test('token-bucket: remaining decreases with each request', async () => {
  const id = uid();
  const opts = { capacity: 10, refillRate: 0.001 };
  const r1 = await checkTokenBucket(id, opts);
  const r2 = await checkTokenBucket(id, opts);
  assert.ok(r1.remaining > r2.remaining, 'remaining should decrease');
});

test('token-bucket: isolates different client IDs', async () => {
  const id1 = uid(), id2 = uid();
  const opts = { capacity: 1, refillRate: 0.001 };

  // Drain id1
  await checkTokenBucket(id1, opts);
  const r1 = await checkTokenBucket(id1, opts);
  assert.equal(r1.allowed, false, 'id1 should be throttled');

  // id2 should still be allowed
  const r2 = await checkTokenBucket(id2, opts);
  assert.equal(r2.allowed, true, 'id2 should not be affected by id1');
});

// ── Sliding Window ────────────────────────────────────────────────────────────

test('sliding-window: allows requests up to limit', async () => {
  const id   = uid();
  const opts = { windowMs: 5000, limit: 4 };

  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await checkSlidingWindow(id, opts));
  }

  const allowed = results.filter(r => r.allowed).length;
  const denied  = results.filter(r => !r.allowed).length;
  assert.equal(allowed, 4, `Expected 4 allowed, got ${allowed}`);
  assert.equal(denied,  2, `Expected 2 denied, got ${denied}`);
});

test('sliding-window: returns algorithm name', async () => {
  const id = uid();
  const r  = await checkSlidingWindow(id, { windowMs: 5000, limit: 10 });
  assert.equal(r.algorithm, 'sliding-window');
});

test('sliding-window: allows again after window expires', async () => {
  const id   = uid();
  const opts = { windowMs: 200, limit: 1 }; // 200ms window

  const r1 = await checkSlidingWindow(id, opts);
  assert.equal(r1.allowed, true);
  const r2 = await checkSlidingWindow(id, opts);
  assert.equal(r2.allowed, false, 'Second request should be denied');

  await new Promise(res => setTimeout(res, 250)); // window expires
  const r3 = await checkSlidingWindow(id, opts);
  assert.equal(r3.allowed, true, 'Should be allowed again after window expires');
});

test('sliding-window: isolates different client IDs', async () => {
  const id1 = uid(), id2 = uid();
  const opts = { windowMs: 5000, limit: 1 };

  await checkSlidingWindow(id1, opts);
  const throttled = await checkSlidingWindow(id1, opts);
  assert.equal(throttled.allowed, false);

  const fresh = await checkSlidingWindow(id2, opts);
  assert.equal(fresh.allowed, true, 'id2 not affected by id1 limit');
});

// ── Leaky Bucket ──────────────────────────────────────────────────────────────

test('leaky-bucket: allows requests up to capacity', async () => {
  const id   = uid();
  const opts = { capacity: 3, leakRate: 0.001 }; // negligible leak

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await checkLeakyBucket(id, opts));
  }

  const allowed = results.filter(r => r.allowed).length;
  const denied  = results.filter(r => !r.allowed).length;
  // Fixed predicate: level + 1 <= capacity ensures exactly capacity requests fit.
  assert.equal(allowed, 3, `Expected exactly 3 allowed, got ${allowed}`);
  assert.equal(denied,  2, `Expected exactly 2 denied, got ${denied}`);
});

test('leaky-bucket: allows after leak drains capacity', async () => {
  const id   = uid();
  const opts = { capacity: 1, leakRate: 100 }; // drains at 100/sec ≈ empty in 10ms

  const r1 = await checkLeakyBucket(id, opts);
  assert.equal(r1.allowed, true);

  // Immediate second request — bucket just became full (level=1)
  // With leakRate=100/s, even 1ms elapsed only leaks 0.1 — level is still ≈0.9,
  // and 0.9 + 1 = 1.9 > 1 = capacity, so this must be denied.
  const r2 = await checkLeakyBucket(id, opts);
  assert.equal(r2.allowed, false, 'Second immediate request must be denied (bucket full)');

  await new Promise(res => setTimeout(res, 15)); // 15ms × 100/s = 1.5 units drained → empty
  const r3 = await checkLeakyBucket(id, opts);
  assert.equal(r3.allowed, true, 'Must be allowed again after leaking');
});

test('leaky-bucket: returns algorithm name', async () => {
  const id = uid();
  const r  = await checkLeakyBucket(id, { capacity: 5, leakRate: 1 });
  assert.equal(r.algorithm, 'leaky-bucket');
});

test('leaky-bucket: isolates different client IDs', async () => {
  const id1 = uid(), id2 = uid();
  const opts = { capacity: 1, leakRate: 0.001 };

  await checkLeakyBucket(id1, opts);
  const throttled = await checkLeakyBucket(id1, opts);
  assert.equal(throttled.allowed, false, 'id1 second request must be denied (bucket full)');

  const fresh = await checkLeakyBucket(id2, opts);
  assert.equal(fresh.allowed, true, 'id2 must not be affected by id1');
});
