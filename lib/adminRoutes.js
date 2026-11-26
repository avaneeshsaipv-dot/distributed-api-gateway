'use strict';

const express = require('express');
const router = express.Router();
const store = require('./store');
const routeRegistry = require('./routeRegistry');
const requestLogger = require('./requestLogger');
const metrics = require('./metrics');
const { sendError } = require('./errors');
const { TIER_LIMITS, TIER_QUOTAS } = require('./auth');

/**
 * Admin Security Middleware:
 *
 * Enforces authentication for all administrative and management endpoints.
 *
 * 1. If ADMIN_API_KEY is configured:
 *    Requires matching 'x-admin-key' header or 'adminKey' query parameter.
 *    Rejects invalid or missing credentials with 401 Unauthorized.
 *
 * 2. If ADMIN_API_KEY is NOT configured:
 *    Management endpoints MUST NOT silently become unrestricted.
 *    Access is ONLY allowed if ADMIN_INSECURE_DEV_MODE === 'true' is explicitly set.
 *    Otherwise, access is rejected with 401 Unauthorized (safe fail-closed default).
 */
function adminAuth(req, res, next) {
  const configuredAdminKey = process.env.ADMIN_API_KEY;
  const isInsecureDevMode = process.env.ADMIN_INSECURE_DEV_MODE === 'true';

  // 1. Explicit opt-in to insecure development mode
  if (!configuredAdminKey && isInsecureDevMode) {
    return next();
  }

  // 2. Fail-closed: if ADMIN_API_KEY is not configured and dev mode is not active, reject
  if (!configuredAdminKey) {
    return sendError(
      res,
      401,
      'Unauthorized — administrative endpoints are protected. Configure ADMIN_API_KEY or set ADMIN_INSECURE_DEV_MODE=true',
      req.requestId,
      { hint: 'Set ADMIN_API_KEY in environment or provide X-Admin-Key header' }
    );
  }

  // 3. Validate client admin key
  const clientAdminKey = req.headers['x-admin-key'] || req.query.adminKey;
  if (!clientAdminKey) {
    return sendError(
      res,
      401,
      'Unauthorized — missing X-Admin-Key administrative credentials',
      req.requestId,
      { hint: 'Provide X-Admin-Key header or ?adminKey= query parameter' }
    );
  }

  if (clientAdminKey !== configuredAdminKey) {
    return sendError(
      res,
      401,
      'Unauthorized — invalid administrative credentials',
      req.requestId
    );
  }

  next();
}

router.use(adminAuth);
router.adminAuth = adminAuth;

// ─── API Keys Management ──────────────────────────────────────────────────────

router.get('/keys', (req, res) => {
  const keys = store.getKeys().map(k => {
    const quotaUsed = store.getMonthlyQuotaUsage(k.id);
    const quotaMax = TIER_QUOTAS[k.tier] || TIER_QUOTAS.FREE;
    return {
      ...k,
      quotaUsed,
      quotaMax,
      quotaRemaining: Math.max(0, quotaMax - quotaUsed),
      quotaPercentage: Math.min(100, Math.round((quotaUsed / quotaMax) * 100)),
    };
  });
  res.json({ keys });
});

router.post('/keys', (req, res) => {
  const { name, tier } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return sendError(res, 400, 'Name is required to create an API key', req.requestId);
  }

  const normalizedTier = ['FREE', 'PRO', 'PREMIUM'].includes((tier || '').toUpperCase())
    ? tier.toUpperCase()
    : 'FREE';

  const result = store.createKeyRecord({
    name: name.trim(),
    tier: normalizedTier,
  });

  res.status(201).json({
    message: 'API key created successfully. Save your secret key now — it will not be shown again.',
    key: result.record,
    secret: result.secret, // ONE-TIME SECRET DISPLAY
  });
});

router.patch('/keys/:id', (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body || {};
  if (enabled === undefined) {
    return sendError(res, 400, 'Missing enabled field', req.requestId);
  }

  const updated = store.setKeyEnabled(id, enabled);
  if (!updated) {
    return sendError(res, 404, `API key not found: ${id}`, req.requestId);
  }
  res.json({ message: `API key ${enabled ? 'enabled' : 'disabled'}`, key: updated });
});

router.delete('/keys/:id', (req, res) => {
  const { id } = req.params;
  const deleted = store.deleteKey(id);
  if (!deleted) {
    return sendError(res, 404, `API key not found: ${id}`, req.requestId);
  }
  res.json({ message: 'API key revoked successfully', id });
});

// ─── Route Registry Management ────────────────────────────────────────────────

router.get('/routes', (req, res) => {
  res.json({ routes: routeRegistry.getRoutes() });
});

router.post('/routes', (req, res) => {
  const { name, path: routePath, methods, targetBackend, authRequired, timeoutMs, enabled } = req.body || {};

  if (!routePath || typeof routePath !== 'string' || !routePath.startsWith('/')) {
    return sendError(res, 400, 'Valid route path starting with "/" is required', req.requestId);
  }

  const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', '*'];
  const assignedMethods = Array.isArray(methods) && methods.length > 0
    ? methods.map(m => m.toUpperCase()).filter(m => validMethods.includes(m))
    : ['*'];

  const route = store.saveRoute({
    name: (name || 'New Route').trim(),
    path: routePath.trim(),
    methods: assignedMethods,
    targetBackend: targetBackend || 'load-balanced',
    authRequired: Boolean(authRequired),
    timeoutMs: parseInt(timeoutMs, 10) || 10000,
    enabled: enabled !== false,
  });

  res.status(201).json({ message: 'Route created successfully', route });
});

router.put('/routes/:id', (req, res) => {
  const { id } = req.params;
  const existing = store.getRoute(id);
  if (!existing) {
    return sendError(res, 404, `Route not found: ${id}`, req.requestId);
  }

  const { name, path: routePath, methods, targetBackend, authRequired, timeoutMs, enabled } = req.body || {};

  const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', '*'];
  const assignedMethods = Array.isArray(methods) && methods.length > 0
    ? methods.map(m => m.toUpperCase()).filter(m => validMethods.includes(m))
    : existing.methods;

  const updated = store.saveRoute({
    ...existing,
    name: name !== undefined ? name.trim() : existing.name,
    path: routePath !== undefined ? routePath.trim() : existing.path,
    methods: assignedMethods,
    targetBackend: targetBackend !== undefined ? targetBackend : existing.targetBackend,
    authRequired: authRequired !== undefined ? Boolean(authRequired) : existing.authRequired,
    timeoutMs: timeoutMs !== undefined ? parseInt(timeoutMs, 10) || 10000 : existing.timeoutMs,
    enabled: enabled !== undefined ? Boolean(enabled) : existing.enabled,
  });

  res.json({ message: 'Route updated successfully', route: updated });
});

router.delete('/routes/:id', (req, res) => {
  const { id } = req.params;
  if (id === 'route_ping') {
    return sendError(res, 400, 'Cannot delete the essential health-check ping route', req.requestId);
  }

  const deleted = store.deleteRoute(id);
  if (!deleted) {
    return sendError(res, 404, `Route not found: ${id}`, req.requestId);
  }
  res.json({ message: 'Route deleted successfully', id });
});

// ─── Backends Management ──────────────────────────────────────────────────────

router.get('/backends', (req, res) => {
  const lb = req.app.get('lb');
  if (!lb) {
    return sendError(res, 500, 'Load balancer service unavailable', req.requestId);
  }
  res.json(lb.stats());
});

function handleBackendToggle(req, res) {
  const { url, enabled } = req.body || {};
  if (!url) {
    return sendError(res, 400, 'Backend url is required', req.requestId);
  }
  const lb = req.app.get('lb');
  if (!lb) {
    return sendError(res, 500, 'Load balancer service unavailable', req.requestId);
  }

  const success = lb.setBackendEnabled(url, enabled);
  if (!success) {
    return sendError(res, 404, `Unknown backend URL: ${url}`, req.requestId);
  }

  store.recordAudit('BACKEND_STATUS_CHANGED', url, { enabled: Boolean(enabled) });
  res.json({ message: `Backend ${url} is now ${enabled ? 'enabled' : 'disabled'}`, stats: lb.stats() });
}

router.post('/backends/toggle', handleBackendToggle);
router.patch('/backends', handleBackendToggle);

// ─── Request Logs & Audit Logs ────────────────────────────────────────────────

router.get('/logs', (req, res) => {
  const result = requestLogger.query(req.query);
  res.json(result);
});

router.get('/audit', (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
  res.json({ audit: store.getAuditLog(limit) });
});

// ─── Analytics ────────────────────────────────────────────────────────────────

router.get('/analytics', (req, res) => {
  const snap = metrics.snapshot();
  const logs = requestLogger.logs;

  // Aggregate top endpoints from actual logs
  const endpointCounts = {};
  const statusDistribution = { ...snap.statusCodes };
  const methodCounts = {};

  for (const l of logs) {
    const p = (l.path || '').split('?')[0];
    endpointCounts[p] = (endpointCounts[p] || 0) + 1;
    methodCounts[l.method] = (methodCounts[l.method] || 0) + 1;
  }

  const topEndpoints = Object.entries(endpointCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([path, count]) => ({ path, count }));

  const total = snap.totalRequests || 1;
  const failed = snap.failedRequests || 0;
  const throttled = snap.throttledRequests || 0;
  const errorRate = Math.round(((failed + throttled) / total) * 1000) / 10;

  res.json({
    summary: {
      totalRequests: snap.totalRequests,
      allowedRequests: snap.allowedRequests,
      throttledRequests: snap.throttledRequests,
      failedRequests: snap.failedRequests,
      errorRatePct: errorRate,
      requestsPerSecond: snap.requestsPerSecond,
      latency: snap.latency,
    },
    topEndpoints,
    statusCodes: statusDistribution,
    backendStats: snap.backendStats,
    methods: methodCounts,
    tiers: {
      limits: TIER_LIMITS,
      quotas: TIER_QUOTAS,
    },
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  const redis = req.app.get('redis');
  const lb = req.app.get('lb');

  res.json({
    readOnly: {
      nodeVersion: process.version,
      platform: process.platform,
      processUptimeSec: Math.round(process.uptime()),
      pid: process.pid,
      gatewayPort: parseInt(process.env.GATEWAY_PORT, 10) || 8080,
      redisHost: process.env.REDIS_HOST || '127.0.0.1',
      redisPort: parseInt(process.env.REDIS_PORT, 10) || 6379,
      redisStatus: redis && redis.status ? redis.status : 'connected',
      configuredBackends: lb ? lb.backends : [],
    },
    editable: store.getSettings(),
  });
});

function handleSettingsUpdate(req, res) {
  const { lbStrategy, defaultAlgo, globalAuthEnabled, proxyTimeoutMs } = req.body || {};
  const lb = req.app.get('lb');

  const updates = {};
  if (lbStrategy && ['round-robin', 'least-connections'].includes(lbStrategy)) {
    updates.lbStrategy = lbStrategy;
    if (lb) lb.strategy = lbStrategy;
  }
  if (defaultAlgo && ['token-bucket', 'sliding-window', 'leaky-bucket'].includes(defaultAlgo)) {
    updates.defaultAlgo = defaultAlgo;
  }
  if (globalAuthEnabled !== undefined) {
    updates.globalAuthEnabled = Boolean(globalAuthEnabled);
  }
  if (proxyTimeoutMs !== undefined) {
    updates.proxyTimeoutMs = Math.max(500, parseInt(proxyTimeoutMs, 10) || 10000);
  }

  const updatedSettings = store.updateSettings(updates);
  res.json({ message: 'Settings updated successfully', settings: updatedSettings });
}

router.post('/settings', handleSettingsUpdate);
router.put('/settings', handleSettingsUpdate);

module.exports = router;
