'use strict';

/**
 * LoadBalancer unit tests — no Redis required.
 * Health checks are disabled by injecting a fake fetch.
 *
 * Run: node --test tests/loadBalancer.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Stub globalThis.fetch so health checks don't hit real network
before(() => {
  globalThis.fetch = async () => ({ ok: true });
});
after(() => {
  delete globalThis.fetch;
});

const LoadBalancer = require('../lib/loadBalancer');

function makeLb(urls, strategy = 'round-robin') {
  const lb = new LoadBalancer(urls, strategy);
  lb.destroy(); // stop health-check timer for unit tests
  // Force all backends healthy (timer won't run)
  for (const b of urls) lb._healthy[b] = true;
  return lb;
}

// ── Round-robin ───────────────────────────────────────────────────────────────

test('round-robin cycles through all backends', () => {
  const urls = ['http://a:1', 'http://b:2', 'http://c:3'];
  const lb   = makeLb(urls, 'round-robin');
  const picks = [lb.pick(), lb.pick(), lb.pick(), lb.pick()];
  assert.equal(picks[0], 'http://a:1');
  assert.equal(picks[1], 'http://b:2');
  assert.equal(picks[2], 'http://c:3');
  assert.equal(picks[3], 'http://a:1'); // wraps
});

test('round-robin skips unhealthy backends', () => {
  const urls = ['http://a:1', 'http://b:2', 'http://c:3'];
  const lb   = makeLb(urls, 'round-robin');
  lb._healthy['http://b:2'] = false;
  const picks = new Set([lb.pick(), lb.pick(), lb.pick(), lb.pick()]);
  assert.ok(!picks.has('http://b:2'), 'unhealthy backend must not be picked');
});

test('round-robin returns null when all backends are unhealthy', () => {
  const urls = ['http://a:1', 'http://b:2'];
  const lb   = makeLb(urls);
  lb._healthy['http://a:1'] = false;
  lb._healthy['http://b:2'] = false;
  assert.equal(lb.pick(), null);
});

// ── Least connections ─────────────────────────────────────────────────────────

test('least-connections picks backend with fewest active connections', () => {
  const urls = ['http://a:1', 'http://b:2', 'http://c:3'];
  const lb   = makeLb(urls, 'least-connections');
  lb._active['http://a:1'] = 5;
  lb._active['http://b:2'] = 2;
  lb._active['http://c:3'] = 8;
  assert.equal(lb.pick(), 'http://b:2');
});

test('least-connections skips unhealthy backend even if it has 0 connections', () => {
  const urls = ['http://a:1', 'http://b:2'];
  const lb   = makeLb(urls, 'least-connections');
  lb._active['http://a:1'] = 10;
  lb._active['http://b:2'] = 0;
  lb._healthy['http://b:2'] = false;
  assert.equal(lb.pick(), 'http://a:1');
});

// ── Active connection accounting ──────────────────────────────────────────────

test('onRequestStart increments active connections', () => {
  const urls = ['http://a:1'];
  const lb   = makeLb(urls);
  assert.equal(lb._active['http://a:1'], 0);
  lb.onRequestStart('http://a:1');
  assert.equal(lb._active['http://a:1'], 1);
  lb.onRequestStart('http://a:1');
  assert.equal(lb._active['http://a:1'], 2);
});

test('onRequestEnd decrements active connections and never goes below 0', () => {
  const urls = ['http://a:1'];
  const lb   = makeLb(urls);
  lb.onRequestStart('http://a:1');
  lb.onRequestEnd('http://a:1');
  assert.equal(lb._active['http://a:1'], 0);
  lb.onRequestEnd('http://a:1'); // should clamp to 0
  assert.equal(lb._active['http://a:1'], 0);
});

// ── Circuit breaker integration ───────────────────────────────────────────────

test('circuit breaker opens after repeated failures and blocks routing', () => {
  const urls = ['http://a:1', 'http://b:2'];
  const lb   = makeLb(urls);
  // Override threshold for test speed
  lb._cb['http://a:1'].failureThreshold = 3;

  lb.onRequestFailure('http://a:1');
  lb.onRequestFailure('http://a:1');
  lb.onRequestFailure('http://a:1'); // should trip

  assert.equal(lb._cb['http://a:1'].isOpen, true);

  // Now picks should never include http://a:1
  for (let i = 0; i < 6; i++) {
    const pick = lb.pick();
    assert.ok(pick !== 'http://a:1', `Open circuit backend must not be picked, got ${pick}`);
  }
});

test('circuit breaker recovery: CLOSED after successful probes', async () => {
  const urls = ['http://a:1'];
  const lb   = makeLb(urls);
  lb._cb['http://a:1'].failureThreshold  = 1;
  lb._cb['http://a:1'].recoveryTimeout   = 50;
  lb._cb['http://a:1'].successThreshold  = 1;

  lb.onRequestFailure('http://a:1'); // opens

  await new Promise(r => setTimeout(r, 60)); // wait for recovery timeout

  // canRequest() should return true (transitions to HALF_OPEN)
  assert.equal(lb.pick(), 'http://a:1');

  // Simulate a successful probe
  lb.onRequestSuccess('http://a:1');
  assert.equal(lb._cb['http://a:1'].state, 'CLOSED');
});

// ── Stats ─────────────────────────────────────────────────────────────────────

test('stats() returns structured output', () => {
  const urls = ['http://a:1', 'http://b:2'];
  const lb   = makeLb(urls);
  const s    = lb.stats();
  assert.equal(s.strategy, 'round-robin');
  assert.equal(s.backends.length, 2);
  assert.ok('healthy' in s.backends[0]);
  assert.ok('circuitBreaker' in s.backends[0]);
});

// ── Error handling ────────────────────────────────────────────────────────────

test('throws on empty backends list', () => {
  assert.throws(() => new LoadBalancer([]), /at least one backend/);
});
