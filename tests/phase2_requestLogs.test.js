'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const requestLogger = require('../lib/requestLogger');

test('request-logger: records request with full metadata', () => {
  requestLogger.clear();
  const entry = requestLogger.record({
    requestId: 'req-test-123',
    timestamp: new Date().toISOString(),
    method: 'GET',
    path: '/api/ping',
    status: 200,
    latencyMs: 45.2,
    backend: 'http://localhost:5001',
    clientId: 'client-1',
    keyName: 'Test App',
    algo: 'token-bucket',
    rateLimitResult: 19,
    error: null,
  });

  assert.equal(entry.requestId, 'req-test-123');
  assert.equal(entry.status, 200);
  assert.equal(entry.latencyMs, 45);
  assert.equal(requestLogger.logs.length, 1);
});

test('request-logger: ring buffer enforces capacity bound', () => {
  requestLogger.clear();
  // Fill with 550 entries (capacity is 500)
  for (let i = 0; i < 550; i++) {
    requestLogger.record({
      requestId: `req-${i}`,
      method: 'GET',
      path: '/api/test',
      status: 200,
    });
  }

  assert.equal(requestLogger.logs.length, 500, 'Ring buffer must not exceed capacity 500');
  // Most recent request should be req-549
  assert.equal(requestLogger.logs[0].requestId, 'req-549');
});

test('request-logger: queries with method and status filters', () => {
  requestLogger.clear();
  requestLogger.record({ method: 'GET', path: '/api/ping', status: 200, backend: 'http://backend-1:5001' });
  requestLogger.record({ method: 'POST', path: '/api/users', status: 201, backend: 'http://backend-2:5002' });
  requestLogger.record({ method: 'GET', path: '/api/throttled', status: 429, backend: null });
  requestLogger.record({ method: 'GET', path: '/api/error', status: 502, backend: 'http://backend-1:5001' });

  // Filter by method POST
  const postOnly = requestLogger.query({ method: 'POST' });
  assert.equal(postOnly.total, 1);
  assert.equal(postOnly.items[0].method, 'POST');

  // Filter by status family 4xx
  const status4xx = requestLogger.query({ status: '4xx' });
  assert.equal(status4xx.total, 1);
  assert.equal(status4xx.items[0].status, 429);

  // Filter by status family 5xx
  const status5xx = requestLogger.query({ status: '5xx' });
  assert.equal(status5xx.total, 1);
  assert.equal(status5xx.items[0].status, 502);

  // Filter by backend
  const backend1 = requestLogger.query({ backend: '5001' });
  assert.equal(backend1.total, 2);

  // Search keyword
  const searchPing = requestLogger.query({ search: 'ping' });
  assert.equal(searchPing.total, 1);
});
