'use strict';

/**
 * Circuit Breaker unit tests — no Redis required.
 * Run: node --test tests/circuitBreaker.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { CircuitBreaker, STATES } = require('../lib/circuitBreaker');

test('starts in CLOSED state', () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.state, STATES.CLOSED);
  assert.equal(cb.isOpen, false);
  assert.equal(cb.canRequest(), true);
});

test('opens after failureThreshold consecutive failures', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  cb.onFailure();
  assert.equal(cb.state, STATES.CLOSED);
  cb.onFailure();
  assert.equal(cb.state, STATES.CLOSED);
  const tripped = cb.onFailure();
  assert.equal(tripped, true);
  assert.equal(cb.state, STATES.OPEN);
  assert.equal(cb.isOpen, true);
  assert.equal(cb.canRequest(), false);
});

test('OPEN → HALF_OPEN after recoveryTimeout', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 50 });
  cb.onFailure();
  assert.equal(cb.state, STATES.OPEN);
  assert.equal(cb.canRequest(), false);

  await new Promise(r => setTimeout(r, 60)); // wait for recovery timeout
  assert.equal(cb.canRequest(), true);
  assert.equal(cb.state, STATES.HALF_OPEN);
});

test('HALF_OPEN → CLOSED after successThreshold successes', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 50, successThreshold: 2 });
  cb.onFailure();
  await new Promise(r => setTimeout(r, 60));
  cb.canRequest(); // transition to HALF_OPEN
  cb.onSuccess();
  assert.equal(cb.state, STATES.HALF_OPEN); // not enough yet
  cb.onSuccess();
  assert.equal(cb.state, STATES.CLOSED);
  assert.equal(cb.canRequest(), true);
});

test('HALF_OPEN → OPEN on failure', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 50 });
  cb.onFailure();
  await new Promise(r => setTimeout(r, 60));
  cb.canRequest(); // HALF_OPEN
  const tripped = cb.onFailure();
  assert.equal(tripped, true);
  assert.equal(cb.state, STATES.OPEN);
});

test('success in CLOSED state resets failure counter', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  cb.onFailure();
  cb.onFailure();
  cb.onSuccess(); // should reset
  cb.onFailure();
  cb.onFailure();
  assert.equal(cb.state, STATES.CLOSED); // only 2 failures after reset
  cb.onFailure();
  assert.equal(cb.state, STATES.OPEN);   // 3rd failure trips it
});

test('toJSON includes recoveryRemainingMs when OPEN', () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 5000 });
  cb.onFailure();
  const snap = cb.toJSON();
  assert.equal(snap.state, STATES.OPEN);
  assert.ok(snap.recoveryRemainingMs > 0 && snap.recoveryRemainingMs <= 5000);
});

test('toJSON recoveryRemainingMs is null when CLOSED', () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.toJSON().recoveryRemainingMs, null);
});
