'use strict';

/**
 * Metrics unit tests — no Redis required.
 * Run: node --test tests/metrics.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// We need a fresh Metrics instance for each test group, so we import the class
// directly rather than the singleton.
const Metrics = (() => {
  // Re-require the class by reading the module source and eval-ing a fresh instance.
  // Simpler approach: just call .reset() on the singleton.
  const m = require('../lib/metrics');
  return m.constructor;  // grab the class
})();

function freshMetrics() {
  const m = require('../lib/metrics');
  m.reset();
  return m;
}

test('starts with all counters at zero', () => {
  const m = freshMetrics();
  const s = m.snapshot();
  assert.equal(s.totalRequests, 0);
  assert.equal(s.allowedRequests, 0);
  assert.equal(s.throttledRequests, 0);
  assert.equal(s.failedRequests, 0);
  assert.equal(s.latency.avgMs, 0);
});

test('records a successful request', () => {
  const m = freshMetrics();
  m.record({ status: 200, latencyMs: 42, backend: 'http://localhost:5001' });
  const s = m.snapshot();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.allowedRequests, 1);
  assert.equal(s.throttledRequests, 0);
  assert.equal(s.failedRequests, 0);
  assert.equal(s.statusCodes['200'], 1);
  assert.ok(s.latency.avgMs > 0);
});

test('records a throttled request (no latency counted)', () => {
  const m = freshMetrics();
  m.record({ status: 429, throttled: true });
  const s = m.snapshot();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.throttledRequests, 1);
  assert.equal(s.allowedRequests, 0);
  assert.equal(s.latency.avgMs, 0); // throttled requests don't count for latency
  assert.equal(s.statusCodes['429'], 1);
});

test('records a failed request', () => {
  const m = freshMetrics();
  m.record({ status: 502, failed: true, backend: 'http://localhost:5001' });
  const s = m.snapshot();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.failedRequests, 1);
  assert.equal(s.allowedRequests, 0);
  assert.equal(s.statusCodes['502'], 1);
  assert.equal(s.backendStats['http://localhost:5001'].errors, 1);
});

test('tracks per-backend stats', () => {
  const m = freshMetrics();
  m.record({ status: 200, latencyMs: 10, backend: 'http://localhost:5001' });
  m.record({ status: 200, latencyMs: 20, backend: 'http://localhost:5001' });
  m.record({ status: 200, latencyMs: 30, backend: 'http://localhost:5002' });
  const s = m.snapshot();
  assert.equal(s.backendStats['http://localhost:5001'].requests, 2);
  assert.equal(s.backendStats['http://localhost:5002'].requests, 1);
  assert.equal(s.backendStats['http://localhost:5001'].errors, 0);
});

test('computes average latency correctly', () => {
  const m = freshMetrics();
  m.record({ status: 200, latencyMs: 100 });
  m.record({ status: 200, latencyMs: 200 });
  m.record({ status: 200, latencyMs: 300 });
  const avg = m.avgLatencyMs();
  assert.ok(Math.abs(avg - 200) < 0.01, `Expected avg ~200, got ${avg}`);
});

test('percentile p50 returns median', () => {
  const m = freshMetrics();
  for (let i = 1; i <= 10; i++) m.record({ status: 200, latencyMs: i * 10 });
  const p50 = m.percentile(50);
  // Median of [10,20,...,100] = 50 or 60
  assert.ok(p50 >= 50 && p50 <= 60, `p50 should be near median, got ${p50}`);
});

test('ring buffer does not grow unboundedly', () => {
  const m = freshMetrics();
  const RING_SIZE = 1024;
  for (let i = 0; i < RING_SIZE + 100; i++) {
    m.record({ status: 200, latencyMs: i });
  }
  assert.equal(m._latCount, RING_SIZE); // capped at ring size
});

test('requestsPerSecond reflects recent activity', () => {
  const m = freshMetrics();
  for (let i = 0; i < 10; i++) m.record({ status: 200 });
  const rps = m.requestsPerSecond();
  // Should be > 0 (all in current second)
  assert.ok(rps > 0, `Expected rps > 0, got ${rps}`);
});

test('statusCodes histogram is accurate', () => {
  const m = freshMetrics();
  m.record({ status: 200 });
  m.record({ status: 200 });
  m.record({ status: 429, throttled: true });
  m.record({ status: 502, failed: true });
  const s = m.snapshot();
  assert.equal(s.statusCodes['200'], 2);
  assert.equal(s.statusCodes['429'], 1);
  assert.equal(s.statusCodes['502'], 1);
});

test('retries are counted', () => {
  const m = freshMetrics();
  m.record({ status: 200, latencyMs: 50, retried: true });
  assert.equal(m.snapshot().retries, 1);
});
