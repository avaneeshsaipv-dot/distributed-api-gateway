'use strict';

const routeRegistry = require('./routeRegistry');

/**
 * Generates an accurate OpenAPI 3.0.3 specification
 * reflecting actual gateway routes and system endpoints.
 */
function getOpenApiSpec(req) {
  const host = req ? req.get('host') : 'localhost:8080';
  const protocol = req && req.protocol ? req.protocol : 'http';
  const serverUrl = `${protocol}://${host}`;

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Distributed API Gateway Specification',
      version: '2.0.0',
      description: 'Production-grade distributed API gateway with Redis-backed rate limiting, health-aware load balancing, circuit breaking, API key management, and usage quotas.',
    },
    servers: [
      {
        url: serverUrl,
        description: 'Gateway Server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description: 'Pass your API Key via X-Api-Key header',
        },
        QueryApiKey: {
          type: 'apiKey',
          in: 'query',
          name: 'apiKey',
          description: 'Pass your API Key via query parameter',
        },
      },
      headers: {
        'X-Request-Id': {
          schema: { type: 'string', format: 'uuid' },
          description: 'Unique request correlation identifier generated for every request',
        },
        'X-RateLimit-Limit': {
          schema: { type: 'integer' },
          description: 'Maximum permitted requests in the rate-limit window or bucket capacity',
        },
        'X-RateLimit-Remaining': {
          schema: { type: 'number' },
          description: 'Number of remaining allowed requests or available bucket tokens',
        },
        'X-RateLimit-Algorithm': {
          schema: { type: 'string', enum: ['token-bucket', 'sliding-window', 'leaky-bucket'] },
          description: 'Rate-limiting algorithm applied to this request',
        },
        'Retry-After': {
          schema: { type: 'integer' },
          description: 'Seconds to wait before retrying after a 429 Too Many Requests response',
        },
      },
      schemas: {
        StandardError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            status: { type: 'integer' },
            requestId: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
          },
          required: ['error', 'status', 'requestId', 'timestamp'],
        },
        PingResponse: {
          type: 'object',
          properties: {
            servedBy: { type: 'string', example: 'backend-5001' },
            path: { type: 'string', example: '/ping' },
            method: { type: 'string', example: 'GET' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            gateway: { type: 'string', example: 'api-gateway/1.0' },
            lbStrategy: { type: 'string', enum: ['round-robin', 'least-connections'] },
            uptime: { type: 'number' },
            backends: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  healthy: { type: 'boolean' },
                  enabled: { type: 'boolean' },
                  activeConnections: { type: 'integer' },
                  totalRequests: { type: 'integer' },
                  errors: { type: 'integer' },
                  circuitBreaker: {
                    type: 'object',
                    properties: {
                      state: { type: 'string', enum: ['CLOSED', 'OPEN', 'HALF_OPEN'] },
                      failures: { type: 'integer' },
                      recoveryRemainingMs: { type: 'integer', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    paths: {
      '/api/ping': {
        get: {
          summary: 'Ping Health Check',
          description: 'Verifies gateway routing to active backend cluster.',
          parameters: [
            {
              name: 'algo',
              in: 'query',
              schema: { type: 'string', enum: ['token-bucket', 'sliding-window', 'leaky-bucket'], default: 'token-bucket' },
              description: 'Select rate limiting algorithm',
            },
          ],
          responses: {
            '200': {
              description: 'Successful ping response from upstream backend',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PingResponse' } } },
              headers: {
                'X-Request-Id': { $ref: '#/components/headers/X-Request-Id' },
                'X-RateLimit-Limit': { $ref: '#/components/headers/X-RateLimit-Limit' },
                'X-RateLimit-Remaining': { $ref: '#/components/headers/X-RateLimit-Remaining' },
                'X-RateLimit-Algorithm': { $ref: '#/components/headers/X-RateLimit-Algorithm' },
              },
            },
            '429': {
              description: 'Rate limit or monthly quota exceeded',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/StandardError' } } },
              headers: { 'Retry-After': { $ref: '#/components/headers/Retry-After' } },
            },
            '503': {
              description: 'Service Unavailable — no healthy backends or all circuits open',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/StandardError' } } },
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Gateway & Cluster Health',
          description: 'Returns real-time health status of gateway and all upstream backends.',
          responses: {
            '200': {
              description: 'All or subset of backends healthy',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
            },
            '503': {
              description: 'Degraded — all backends are unhealthy or circuit-broken',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
            },
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus-Style Machine Metrics',
          description: 'Reports request counts, status code distribution, percentiles (p50, p95, p99), and rate per second.',
          responses: {
            '200': {
              description: 'Metrics snapshot',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };

  // Dynamically include user-configured routes from routeRegistry
  try {
    const routes = routeRegistry.getRoutes();
    for (const r of routes) {
      if (r.path === '/api/ping') continue; // already documented in core

      const methods = (r.methods || ['*']).map(m => m.toLowerCase());
      const pathKey = r.path.replace(/\*/g, '{wildcard}');
      if (!spec.paths[pathKey]) {
        spec.paths[pathKey] = {};
      }

      const activeMethods = methods.includes('*') ? ['get', 'post', 'put', 'delete'] : methods;

      for (const m of activeMethods) {
        spec.paths[pathKey][m] = {
          summary: r.name || `Route ${r.path}`,
          description: `Proxied route to target backend: ${r.targetBackend || 'load-balanced'}. Authentication ${r.authRequired ? 'required' : 'optional'}.`,
          security: r.authRequired ? [{ ApiKeyAuth: [] }, { QueryApiKey: [] }] : [],
          responses: {
            '200': { description: 'Successful proxied response' },
            '401': { description: 'Missing API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/StandardError' } } } },
            '403': { description: 'Invalid or disabled API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/StandardError' } } } },
            '429': { description: 'Rate limit or monthly quota exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/StandardError' } } } },
            '502': { description: 'Bad Gateway — upstream connection error' },
            '503': { description: 'Service Unavailable — route disabled or no backends available' },
            '504': { description: 'Gateway Timeout' },
          },
        };
      }
    }
  } catch (_) {}

  return spec;
}

module.exports = { getOpenApiSpec };
