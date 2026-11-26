'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const routeRegistry = require('../lib/routeRegistry');

test('routes: matches exact route /api/ping', () => {
  const match = routeRegistry.match('GET', '/api/ping');
  assert.equal(match.matched, true);
  assert.equal(match.disabled, false);
  assert.equal(match.methodNotAllowed, false);
  assert.equal(match.route.path, '/api/ping');
});

test('routes: rejects unallowed method with 405 information', () => {
  const match = routeRegistry.match('POST', '/api/ping');
  assert.equal(match.matched, true);
  assert.equal(match.methodNotAllowed, true);
  assert.deepEqual(match.allowedMethods, ['GET']);
});

test('routes: matches wildcard route with specificity ranking', () => {
  // /api/users/profile should match /api/users/* rather than the fallback /api/*
  const match = routeRegistry.match('GET', '/api/users/profile');
  assert.equal(match.matched, true);
  assert.equal(match.route.path, '/api/users/*');
  assert.equal(match.route.authRequired, true);
});

test('routes: supports CRUD operations', () => {
  const customId = `route_custom_${Date.now()}`;
  routeRegistry.saveRoute({
    id: customId,
    name: 'Custom Endpoint',
    path: '/api/custom/endpoint',
    methods: ['GET', 'POST'],
    targetBackend: 'load-balanced',
    authRequired: true,
    timeoutMs: 5000,
    enabled: true,
  });

  // Verify match
  const match = routeRegistry.match('GET', '/api/custom/endpoint');
  assert.equal(match.matched, true);
  assert.equal(match.route.id, customId);

  // Update route (disable it)
  routeRegistry.saveRoute({
    id: customId,
    name: 'Custom Endpoint',
    path: '/api/custom/endpoint',
    methods: ['GET', 'POST'],
    enabled: false,
  });

  const disabledMatch = routeRegistry.match('GET', '/api/custom/endpoint');
  assert.equal(disabledMatch.matched, true);
  assert.equal(disabledMatch.disabled, true);

  // Delete route
  const deleted = routeRegistry.deleteRoute(customId);
  assert.equal(deleted, true);

  // Now should fall back to wildcard /api/*
  const fallbackMatch = routeRegistry.match('GET', '/api/custom/endpoint');
  assert.equal(fallbackMatch.matched, true);
  assert.equal(fallbackMatch.route.path, '/api/*');
});
