'use strict';

require('dotenv').config();

const express    = require('express');
const httpProxy  = require('http-proxy');
const http       = require('http');
const path       = require('path');
const crypto     = require('crypto');
const WebSocket  = require('ws');

const { checkTokenBucket }   = require('./lib/rateLimiters/tokenBucket');
const { checkSlidingWindow } = require('./lib/rateLimiters/slidingWindow');
const { checkLeakyBucket }   = require('./lib/rateLimiters/leakyBucket');
const LoadBalancer            = require('./lib/loadBalancer');
const metrics                 = require('./lib/metrics');
const { authMiddleware, tierLimits } = require('./lib/auth');
const store                   = require('./lib/store');
const routeRegistry           = require('./lib/routeRegistry');
const requestLogger           = require('./lib/requestLogger');
const { sendError }           = require('./lib/errors');
const adminRoutes             = require('./lib/adminRoutes');
const { getOpenApiSpec }      = require('./lib/openapi');
const redis                   = require('./lib/redisClient');

// ─── Configuration (all from environment, never hard-coded) ─────────────────

const PORT         = parseInt(process.env.GATEWAY_PORT, 10) || 8080;
const BACKENDS     = (process.env.BACKENDS || 'http://localhost:5001,http://localhost:5002,http://localhost:5003')
                       .split(',').map(s => s.trim()).filter(Boolean);
const LB_STRATEGY  = process.env.LB_STRATEGY || 'round-robin';
const PROXY_TIMEOUT = parseInt(process.env.PROXY_TIMEOUT_MS, 10) || 10_000;
const LOG_LEVEL    = process.env.LOG_LEVEL || 'info'; // 'debug' | 'info' | 'warn' | 'error'

// ─── Core objects ────────────────────────────────────────────────────────────

const app = express();

/**
 * IMPORTANT: We create a single shared proxy instance but do NOT attach
 * per-request listeners to it (proxy.once/on would be shared across
 * concurrent requests and fire on the wrong request's response).
 *
 * Instead we use:
 *   • The error callback of proxy.web() for error handling.
 *   • res.on('close') for the success path cleanup.
 *   • A one-shot done flag to ensure exactly one cleanup per request.
 *
 * The 'proxyReq' event below fires once per proxied request on the correct
 * outbound request object, so it is safe on the shared proxy.
 */
const proxy = httpProxy.createProxyServer({});

// Forward the request-id and real client IP to backends
proxy.on('proxyReq', (proxyReq, req) => {
  proxyReq.setHeader('X-Request-Id', req.requestId || '');
  proxyReq.setHeader('X-Forwarded-For', req.ip || 'unknown');
  proxyReq.setHeader('X-Gateway', 'api-gateway/1.0');
});

// Capture upstream status for circuit-breaker accounting.
// proxyRes fires per-request on the correct response object — safe.
proxy.on('proxyRes', (proxyRes, req) => {
  if (req._backendUrl) {
    req._upstreamStatus = proxyRes.statusCode;
  }
});

const lb = new LoadBalancer(BACKENDS, LB_STRATEGY);
app.set('lb', lb);
app.set('redis', redis);
app.set('store', store);

// ─── WebSocket server (live dashboard) ───────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Send current metrics snapshot on connect
  ws.send(JSON.stringify({ type: 'snapshot', data: metrics.snapshot() }));
  // Send backend health on connect
  ws.send(JSON.stringify({ type: 'health', data: lb.stats() }));
});

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Periodically broadcast health + metrics so the dashboard stays fresh
// even during quiet periods.
setInterval(() => {
  broadcast({ type: 'health',   data: lb.stats()        });
  broadcast({ type: 'snapshot', data: metrics.snapshot() });
}, 5_000);

// ─── Rate-limiter registry ───────────────────────────────────────────────────

const ALGORITHMS = {
  'token-bucket':   (id, limits) => checkTokenBucket(id,   { capacity: limits.capacity,     refillRate: limits.refillRate }),
  'sliding-window': (id, limits) => checkSlidingWindow(id, { windowMs:  limits.windowMs,     limit:      limits.limit }),
  'leaky-bucket':   (id, limits) => checkLeakyBucket(id,   { capacity: limits.leakCapacity, leakRate:   limits.leakRate }),
};

// ─── Middleware: structured logging helper ───────────────────────────────────

function log(level, msg, fields = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) >= (levels[LOG_LEVEL] ?? 1)) {
    console[level === 'debug' ? 'log' : level](
      JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })
    );
  }
}

// ─── Middleware: security headers ────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');              // modern browsers ignore this; CSP is correct approach
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Request-Id', req.requestId = crypto.randomUUID());
  next();
});

// ─── Middleware: CORS ─────────────────────────────────────────────────────────

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Key,X-Client-Id,X-Request-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Tier,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Algorithm,Retry-After,X-Request-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Middleware: request body limit ──────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Static dashboard ────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Admin management API & OpenAPI ──────────────────────────────────────────

app.use('/admin/api', adminRoutes);

app.get('/openapi.json', (req, res) => {
  res.json(getOpenApiSpec(req));
});

// ─── Route resolution middleware ─────────────────────────────────────────────

app.use('/api', (req, res, next) => {
  const fullPath = (req.baseUrl || '') + req.path;
  const match = routeRegistry.match(req.method, fullPath);
  if (match.matched) {
    if (match.disabled) {
      return sendError(res, 503, 'Service unavailable — route is administratively disabled', req.requestId);
    }
    if (match.methodNotAllowed) {
      res.setHeader('Allow', match.allowedMethods.join(', '));
      return sendError(res, 405, `Method ${req.method} not allowed for ${fullPath}`, req.requestId, {
        allowedMethods: match.allowedMethods,
      });
    }
    req.routeConfig = match.route;
  }
  next();
});

// ─── Auth middleware (optional — controlled by AUTH_ENABLED env var or per-route) ──

app.use('/api', authMiddleware);

// ─── Main API proxy middleware ───────────────────────────────────────────────

app.all('/api/*', async (req, res) => {
  const start       = Date.now();
  const fullPath    = (req.baseUrl || '') + req.path;
  const clientId    = req.clientId || req.headers['x-client-id'] || req.ip || 'unknown';
  const effectiveId = req.apiKeyRecord ? (req.apiKeyRecord.maskedKey || req.apiKeyRecord.keyId) : clientId;
  const algo        = ALGORITHMS[req.query.algo] ? req.query.algo : 'token-bucket';
  const limits      = tierLimits(req.authTier || 'FREE');

  // ── Rate limiting ──────────────────────────────────────────────────────────
  let rlResult;
  try {
    rlResult = await ALGORITHMS[algo](clientId, limits);
  } catch (err) {
    log('error', 'rate limiter error', { requestId: req.requestId, err: err.message });
    metrics.record({ status: 500, failed: true });
    return sendError(res, 500, 'Rate limiter unavailable', req.requestId);
  }

  // Rate-limit informational headers (always set, even when allowed)
  const limitValue = limits.capacity ?? limits.limit ?? 0;
  res.setHeader('X-RateLimit-Tier',      req.authTier || 'FREE');
  res.setHeader('X-RateLimit-Algorithm', algo);
  res.setHeader('X-RateLimit-Limit',     limitValue);
  res.setHeader('X-RateLimit-Remaining', rlResult.remaining ?? rlResult.queueLevel ?? 0);

  if (!rlResult.allowed) {
    const retryAfter = algo === 'sliding-window'
      ? Math.ceil((limits.windowMs || 10_000) / 1000)
      : 1;
    res.setHeader('Retry-After', retryAfter);

    metrics.record({ status: 429, throttled: true });
    broadcast({ type: 'request', requestId: req.requestId, clientId: effectiveId, algo, status: 429, timestamp: Date.now() });

    requestLogger.record({
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: fullPath,
      status: 429,
      latencyMs: Date.now() - start,
      backend: null,
      clientId: effectiveId,
      keyName: req.apiKeyRecord ? req.apiKeyRecord.name : null,
      algo,
      rateLimitResult: 'throttled',
      error: 'Too Many Requests',
    });

    if (req.apiKeyRecord?.keyId) {
      store.recordKeyActivity(req.apiKeyRecord.keyId, 429);
    }

    log('debug', 'throttled', { requestId: req.requestId, clientId: effectiveId, algo });
    return sendError(res, 429, 'Too Many Requests', req.requestId, {
      algorithm: algo,
      retryAfterSec: retryAfter,
    });
  }

  // ── Backend selection ─────────────────────────────────────────────────────
  let backend = null;
  if (req.routeConfig?.targetBackend && req.routeConfig.targetBackend !== 'load-balanced') {
    const directTarget = req.routeConfig.targetBackend;
    if (lb._adminEnabled[directTarget] !== false && lb._healthy[directTarget] && lb._cb[directTarget]?.canRequest()) {
      backend = directTarget;
    }
  }

  if (!backend) {
    backend = lb.pick();
  }

  if (!backend) {
    // All backends are unhealthy or circuit-broken — do NOT route to a known-dead backend
    metrics.record({ status: 503, failed: true });
    broadcast({ type: 'request', requestId: req.requestId, clientId: effectiveId, algo, status: 503, timestamp: Date.now() });
    requestLogger.record({
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: fullPath,
      status: 503,
      latencyMs: Date.now() - start,
      backend: null,
      clientId: effectiveId,
      keyName: req.apiKeyRecord ? req.apiKeyRecord.name : null,
      algo,
      rateLimitResult: 'denied_no_backend',
      error: 'Service temporarily unavailable — no healthy backends',
    });
    log('warn', 'no healthy backends', { requestId: req.requestId });
    return sendError(res, 503, 'Service temporarily unavailable — no healthy backends', req.requestId);
  }

  lb.onRequestStart(backend);
  req._backendUrl = backend; // used by the proxyRes event to record upstream status

  // ── One-shot cleanup: called exactly once per request regardless of outcome
  let _cleaned = false;
  function cleanup(success) {
    if (_cleaned) return;
    _cleaned = true;

    lb.onRequestEnd(backend);
    if (success) {
      lb.onRequestSuccess(backend);
    } else {
      const tripped = lb.onRequestFailure(backend);
      if (tripped) metrics.circuitBreakerTrips++;
    }

    const latencyMs = Date.now() - start;
    const status    = res.statusCode || 0;

    metrics.record({ status, latencyMs, backend, failed: !success && status >= 500 });

    requestLogger.record({
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: fullPath,
      status,
      latencyMs,
      backend,
      clientId: effectiveId,
      keyName: req.apiKeyRecord ? req.apiKeyRecord.name : null,
      algo,
      rateLimitResult: rlResult.remaining ?? rlResult.queueLevel ?? 'allowed',
      error: !success && status >= 500 ? (res.statusMessage || `HTTP ${status}`) : null,
    });

    if (req.apiKeyRecord?.keyId) {
      store.recordKeyActivity(req.apiKeyRecord.keyId, status);
    }

    broadcast({
      type:      'request',
      requestId: req.requestId,
      clientId:  effectiveId,
      algo,
      backend,
      status,
      latencyMs,
      remaining: rlResult.remaining ?? rlResult.queueLevel ?? 0,
      timestamp: Date.now(),
    });

    log('info', 'request', {
      requestId: req.requestId,
      method:    req.method,
      path:      fullPath,
      status,
      latencyMs,
      backend,
      clientId:  effectiveId,
      algo,
    });
  }

  // 'close' fires when the TCP connection closes — covers both normal finish
  // and aborted/timed-out connections without waiting for 'finish'.
  res.on('close', () => {
    const upstreamStatus = req._upstreamStatus;
    const success = upstreamStatus != null && upstreamStatus < 500;
    cleanup(success);
  });

  // ── Proxy ─────────────────────────────────────────────────────────────────
  const timeoutMs = req.routeConfig?.timeoutMs || PROXY_TIMEOUT;
  proxy.web(req, res, {
    target:       backend,
    changeOrigin: true,
    proxyTimeout: timeoutMs, // upstream connection timeout
    timeout:      timeoutMs, // socket inactivity timeout
  }, (err) => {
    // Error callback fires for connection refused, ECONNRESET, timeout, etc.
    // 'close' will fire after we send the 502/504, so cleanup() runs there.
    if (res.headersSent) return;

    const isTimeout = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    const status    = isTimeout ? 504 : 502;
    const message   = isTimeout ? 'Gateway Timeout' : 'Bad Gateway';

    log('warn', message.toLowerCase(), { requestId: req.requestId, backend, err: err.message });
    sendError(res, status, message, req.requestId);
  });
});

// ─── Health endpoint ──────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const lbStats = lb.stats();
  const anyHealthy = lbStats.backends.some(b => b.healthy);
  res.status(anyHealthy ? 200 : 503).json({
    status:     anyHealthy ? 'ok' : 'degraded',
    gateway:    'api-gateway/1.0',
    lbStrategy: LB_STRATEGY,
    uptime:     process.uptime(),
    ...lbStats,
  });
});

// ─── Machine-readable metrics endpoint ───────────────────────────────────────

app.get('/metrics', (req, res) => {
  res.json({
    ...metrics.snapshot(),
    lb: lb.stats(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Catch-all 404 ───────────────────────────────────────────────────────────

app.use((req, res) => {
  sendError(res, 404, 'Not found', req.requestId);
});

// ─── Unhandled errors in express ─────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('error', 'unhandled express error', { requestId: req.requestId, err: err.message });
  sendError(res, 500, 'Internal server error', req.requestId);
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log('info', 'gateway started', {
    port:      PORT,
    backends:  BACKENDS,
    strategy:  LB_STRATEGY,
    dashboard: `http://localhost:${PORT}`,
    metrics:   `http://localhost:${PORT}/metrics`,
    health:    `http://localhost:${PORT}/health`,
    adminAuth: process.env.ADMIN_API_KEY
      ? 'protected'
      : (process.env.ADMIN_INSECURE_DEV_MODE === 'true' ? 'insecure-dev-mode' : 'fail-closed'),
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'received SIGTERM, shutting down');
  server.close(() => {
    lb.destroy();
    process.exit(0);
  });
});
