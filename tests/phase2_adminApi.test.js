'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const adminRoutes = require('../lib/adminRoutes');
const { getOpenApiSpec } = require('../lib/openapi');
const store = require('../lib/store');
const LoadBalancer = require('../lib/loadBalancer');

let server;
let port;

before((t, done) => {
  process.env.ADMIN_INSECURE_DEV_MODE = 'true';
  const app = express();
  app.use(express.json());

  // Setup mock lb and redis
  const lb = new LoadBalancer(['http://localhost:5001', 'http://localhost:5002'], 'round-robin');
  lb.destroy(); // stop timer
  app.set('lb', lb);
  app.set('redis', { status: 'ready' });
  app.set('store', store);

  app.use('/admin/api', adminRoutes);
  app.get('/openapi.json', (req, res) => res.json(getOpenApiSpec(req)));

  server = http.createServer(app);
  server.listen(0, () => {
    port = server.address().port;
    done();
  });
});

after((t, done) => {
  delete process.env.ADMIN_INSECURE_DEV_MODE;
  server.close(done);
});

function api(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders),
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('admin-api: GET /openapi.json returns valid OpenAPI 3 specification', async () => {
  const res = await api('GET', '/openapi.json');
  assert.equal(res.status, 200);
  assert.equal(res.body.openapi, '3.0.3');
  assert.ok(res.body.paths['/api/ping']);
  assert.ok(res.body.paths['/health']);
  assert.ok(res.body.paths['/metrics']);
});

test('admin-api: Keys CRUD and audit recording', async () => {
  // Create Key
  const createRes = await api('POST', '/admin/api/keys', { name: 'Admin Created App', tier: 'PRO' });
  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.secret.startsWith('gw_live_'));
  assert.equal(createRes.body.key.name, 'Admin Created App');
  assert.equal(createRes.body.key.tier, 'PRO');
  const keyId = createRes.body.key.id;

  // List Keys
  const listRes = await api('GET', '/admin/api/keys');
  assert.equal(listRes.status, 200);
  const found = listRes.body.keys.find(k => k.id === keyId);
  assert.ok(found);
  assert.equal(found.quotaMax, 100000);

  // Toggle Enabled
  const toggleRes = await api('PATCH', `/admin/api/keys/${keyId}`, { enabled: false });
  assert.equal(toggleRes.status, 200);
  assert.equal(toggleRes.body.key.enabled, false);

  // Delete Key
  const deleteRes = await api('DELETE', `/admin/api/keys/${keyId}`);
  assert.equal(deleteRes.status, 200);

  // Verify Audit Log has entries for key actions
  const auditRes = await api('GET', '/admin/api/audit');
  assert.equal(auditRes.status, 200);
  const actions = auditRes.body.audit.map(a => a.action);
  assert.ok(actions.includes('API_KEY_CREATED'));
  assert.ok(actions.includes('API_KEY_STATUS_CHANGED'));
  assert.ok(actions.includes('API_KEY_REVOKED'));
});

test('admin-api: Routes CRUD', async () => {
  // Create Route
  const createRes = await api('POST', '/admin/api/routes', {
    name: 'Admin Test Route',
    path: '/api/admin/test/*',
    methods: ['GET'],
    authRequired: true,
  });
  assert.equal(createRes.status, 201);
  const routeId = createRes.body.route.id;

  // Update Route
  const updateRes = await api('PUT', `/admin/api/routes/${routeId}`, {
    name: 'Updated Admin Test Route',
    methods: ['GET', 'POST'],
  });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.route.name, 'Updated Admin Test Route');
  assert.deepEqual(updateRes.body.route.methods, ['GET', 'POST']);

  // Delete Route
  const deleteRes = await api('DELETE', `/admin/api/routes/${routeId}`);
  assert.equal(deleteRes.status, 200);
});

test('admin-api: Backends list and administrative toggle', async () => {
  const listRes = await api('GET', '/admin/api/backends');
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.backends.length > 0);

  // Disable backend
  const toggleRes = await api('POST', '/admin/api/backends/toggle', {
    url: 'http://localhost:5001',
    enabled: false,
  });
  assert.equal(toggleRes.status, 200);
  const b1 = toggleRes.body.stats.backends.find(b => b.url === 'http://localhost:5001');
  assert.equal(b1.enabled, false);

  // Re-enable backend
  const enableRes = await api('POST', '/admin/api/backends/toggle', {
    url: 'http://localhost:5001',
    enabled: true,
  });
  assert.equal(enableRes.status, 200);
});

test('admin-api: Analytics endpoint returns live statistics', async () => {
  const res = await api('GET', '/admin/api/analytics');
  assert.equal(res.status, 200);
  assert.ok(res.body.summary);
  assert.ok(res.body.tiers);
  assert.ok(Array.isArray(res.body.topEndpoints));
});

test('admin-api: Settings read and write', async () => {
  const getRes = await api('GET', '/admin/api/settings');
  assert.equal(getRes.status, 200);
  assert.ok(getRes.body.readOnly);
  assert.ok(getRes.body.editable);

  const postRes = await api('POST', '/admin/api/settings', {
    lbStrategy: 'least-connections',
    proxyTimeoutMs: 15000,
  });
  assert.equal(postRes.status, 200);
  assert.equal(postRes.body.settings.lbStrategy, 'least-connections');
  assert.equal(postRes.body.settings.proxyTimeoutMs, 15000);
});

test('admin-api security: configured ADMIN_API_KEY requires valid credentials', async () => {
  const adminAuth = adminRoutes.adminAuth;

  const originalKey = process.env.ADMIN_API_KEY;
  const originalDev = process.env.ADMIN_INSECURE_DEV_MODE;
  process.env.ADMIN_API_KEY = 'test-secret-admin-key';
  delete process.env.ADMIN_INSECURE_DEV_MODE;

  try {
    // 1. Missing header
    let resObj = null;
    let nextCalled = false;
    adminAuth({ headers: {}, query: {} }, {
      status(code) { this.statusCode = code; return this; },
      json(payload) { resObj = { status: this.statusCode, body: payload }; return this; }
    }, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(resObj.status, 401);
    assert.ok(resObj.body.error.includes('missing'));

    // 2. Incorrect header
    resObj = null;
    nextCalled = false;
    adminAuth({ headers: { 'x-admin-key': 'wrong-key' }, query: {} }, {
      status(code) { this.statusCode = code; return this; },
      json(payload) { resObj = { status: this.statusCode, body: payload }; return this; }
    }, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(resObj.status, 401);
    assert.ok(resObj.body.error.includes('invalid'));

    // 3. Correct header
    nextCalled = false;
    adminAuth({ headers: { 'x-admin-key': 'test-secret-admin-key' }, query: {} }, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);

    // 4. Correct query parameter
    nextCalled = false;
    adminAuth({ headers: {}, query: { adminKey: 'test-secret-admin-key' } }, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (originalKey) process.env.ADMIN_API_KEY = originalKey; else delete process.env.ADMIN_API_KEY;
    if (originalDev) process.env.ADMIN_INSECURE_DEV_MODE = originalDev; else delete process.env.ADMIN_INSECURE_DEV_MODE;
  }
});

test('admin-api security: unconfigured ADMIN_API_KEY fails closed unless dev mode is explicit', async () => {
  const adminAuth = adminRoutes.adminAuth;

  const originalKey = process.env.ADMIN_API_KEY;
  const originalDev = process.env.ADMIN_INSECURE_DEV_MODE;
  delete process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_INSECURE_DEV_MODE;

  try {
    // 1. Unconfigured and dev mode not set -> FAILS CLOSED with 401
    let resObj = null;
    let nextCalled = false;
    adminAuth({ headers: {}, query: {} }, {
      status(code) { this.statusCode = code; return this; },
      json(payload) { resObj = { status: this.statusCode, body: payload }; return this; }
    }, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(resObj.status, 401);
    assert.ok(resObj.body.error.includes('protected'));

    // 2. Explicit ADMIN_INSECURE_DEV_MODE=true allows access
    process.env.ADMIN_INSECURE_DEV_MODE = 'true';
    nextCalled = false;
    adminAuth({ headers: {}, query: {} }, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (originalKey) process.env.ADMIN_API_KEY = originalKey; else delete process.env.ADMIN_API_KEY;
    if (originalDev) process.env.ADMIN_INSECURE_DEV_MODE = originalDev; else delete process.env.ADMIN_INSECURE_DEV_MODE;
  }
});
