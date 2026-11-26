# Distributed API Gateway (v2.0)

A production-grade, distributed API gateway and API management platform built with Node.js, Redis, and Docker Compose, demonstrating real-world distributed-systems patterns and conventional API gateway operations.

## Architecture

```
                         ┌─────────────────────────────────────────────────────────┐
                         │                    API Gateway (8080)                   │
                         │                                                         │
Client Request ─────────▶│  Security Headers → Route Registry → Auth & Quotas     │──▶ Redis
                         │       │                                 │               │    (rate-limit state)
                         │       ▼                                 ▼               │
                         │  Method Validation (405)       Token / Sliding / Leaky  │
                         │       │                        Rate Limiters (Lua)      │
                         │       ▼                                 │               │
                         │  Load Balancer (Round-Robin / Least-Conn)               │
                         │       │                                                 │
                         │  Per-Backend Circuit Breakers (CLOSED/OPEN/HALF_OPEN)   │
                         │       │                                                 │
                         │  HTTP Proxy Timeout Enforcer → Request Ring Buffer Log │
                         └───────┬───────────────────┬───────────────────┬─────────┘
                                 │                   │                   │
                             backend-1           backend-2           backend-3
                              (5001)              (5002)              (5003)
```

**Request flow:**
1. **Security headers + Request ID**: Injects strict CSP/no-sniff headers and unique UUID `X-Request-Id`.
2. **Route Registry Resolution**: Matches exact paths (`/api/ping`) and wildcard routes (`/api/users/*`) with specificity ranking. Validates HTTP methods, returning `405 Method Not Allowed` with `Allow` header if invalid.
3. **Authentication & Usage Quota**: Resolves API key from `X-Api-Key` or `?apiKey=`. Checks SHA-256 hash against persistent store, verifies active status, and evaluates monthly usage quota (FREE: 10k, PRO: 100k, PREMIUM: 1M req/month).
4. **Pluggable Rate Limiting**: Executes atomic Redis Lua scripts (Token Bucket, Sliding Window, or Leaky Bucket) scoped by client tier. Injects `X-RateLimit-Tier`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining`.
5. **Backend Load Balancing**: Selects healthy, non-disabled, non-circuit-broken backend using Round-Robin or Least-Connections.
6. **Circuit Breakers & Proxy**: Proxies upstream with configurable timeout (`504 Gateway Timeout` on timeout, `502 Bad Gateway` on connection drop, `503 Service Unavailable` if no backends available).
7. **Observability & Logging**: Records telemetry to in-memory bounded ring buffer (500 entries max), updates real-time analytics, and broadcasts WebSocket live events.

---

## Phase 2 Features

### 1. API Key & Quota Management
- **One-Time Raw Secret Generation**: Raw API keys (`gw_live_<hex>`) are generated and presented **only once** upon creation.
- **Hashed Storage**: Only cryptographically secure SHA-256 hashes are persisted to disk (`data/gateway-store.json`). Raw keys are never stored.
- **Masked Identification**: Keys are safely referenced in logs and dashboards as `gw_live_***<last4>`.
- **Administrative Control**: Enable, disable, and revoke API keys with instantaneous enforcement.
- **Monthly Usage Quotas**:
  - **FREE Tier**: 20 req/min rate limit, 10,000 requests/month quota
  - **PRO Tier**: 100 req/min rate limit, 100,000 requests/month quota
  - **PREMIUM Tier**: 500 req/min rate limit, 1,000,000 requests/month quota
  - Returning `429 Too Many Requests` with quota exceeded details when depleted.

### 2. Dynamic Route Registry
- Specificity-ranked path matcher supporting exact routes (e.g., `/api/ping`), prefix wildcards (e.g., `/api/users/*`), and global fallbacks (`/api/*`).
- HTTP method validation per route with RFC-compliant `405 Method Not Allowed` and `Allow` response headers.
- Per-route configuration of target backend, authentication requirement (`authRequired`), custom timeouts, and administrative enable/disable toggles.

### 3. Request Logging (Bounded Ring Buffer)
- Bounded in-memory ring buffer (500 capacity) preventing memory leakage.
- Captures full request lifecycle: `requestId`, `timestamp`, `method`, `path`, `status`, `latencyMs`, `backend`, `clientId`, `rateLimitResult`, and error messages.
- Admin querying API supporting filtering by `method`, `status` (2xx, 4xx, 5xx), `backend`, text search, and pagination (`limit`, `offset`).

### 4. Live Gateway Analytics
- Zero-dependency analytics computed directly from real gateway traffic:
  - Total requests, clean proxied requests (2xx), throttled requests (429), and failures (5xx).
  - Average latency and precise percentiles: **P50**, **P95**, and **P99**.
  - Current Requests Per Second (RPS) over a rolling 60-second window.
  - Top active endpoints breakdown and per-backend traffic distribution.
  - HTTP status distribution histograms.

### 5. Backend Management & Health Probing
- Real-time backend status reporting: health state, active connections, lifetime requests, errors, and circuit breaker states (`CLOSED`, `OPEN`, `HALF_OPEN`).
- Administrative toggle allowing operators to safely drain or disable a backend without removing it from the configuration.

### 6. OpenAPI 3.0.3 Specification
- Standardized OpenAPI 3.0.3 schema served dynamically at `GET /openapi.json`.
- Accurately documents all core endpoints (`/api/ping`, `/health`, `/metrics`) and dynamically registered routes.

### 7. Administrative Audit Log
- Audit trail recording mutations (API key creation, key revocation, route updates, backend status toggling, setting changes).
- Bounded retention (250 entries) stored persistently.

### 8. Standardized Error Payloads
Uniform JSON structure across all gateway error scenarios:
```json
{
  "error": "Forbidden – API key is disabled",
  "status": 403,
  "requestId": "74d15fae-63f4-47a7-b3a8-d77abef17e82",
  "timestamp": "2026-09-20T13:07:09.515Z"
}
```

---

## Core Gateway Capabilities

### Rate Limiting (Redis-backed, Lua atomic)

| Algorithm | File | Behaviour |
|---|---|---|
| Token Bucket | `lib/rateLimiters/tokenBucket.js` | Allows bursts up to `capacity`; refills at `refillRate` tokens/sec |
| Sliding Window Log | `lib/rateLimiters/slidingWindow.js` | Exact request count in rolling window; prevents boundary bursts |
| Leaky Bucket | `lib/rateLimiters/leakyBucket.js` | Smooths bursty traffic to a constant outflow rate |

Select via query parameter: `?algo=token-bucket`, `?algo=sliding-window`, `?algo=leaky-bucket`

### Load Balancing & Circuit Breakers

- **Round-Robin**: Evenly balances traffic across available healthy nodes.
- **Least-Connections**: Directs traffic to the backend with fewest active in-flight requests.
- **Circuit Breaker**: Trips to `OPEN` on consecutive failures, transitioning to `HALF_OPEN` after a recovery timeout to probe upstream health before restoring to `CLOSED`.

---

## Management Dashboard

Access the interactive management console at `http://localhost:8080/`.

- **Overview**: Real-time traffic KPIs, latency percentiles, backend cluster health, and live WebSocket event stream.
- **APIs / Routes**: Interactive route registry management (add, edit, toggle, delete).
- **API Keys**: Key generator with one-time raw secret reveal, tier quota trackers, and revocation controls.
- **Requests / Logs**: Bounded request logs with real-time filters and search.
- **Analytics**: P50/P95/P99 latency distribution, top endpoints, and traffic charts.
- **Backends**: Cluster health status, active connection gauges, and administrative toggles.
- **Rate Limits & Quotas**: Visual reference for rate limit policies and monthly quota thresholds.
- **API Documentation**: Interactive documentation and direct links to OpenAPI 3.0.3 specification.
- **Audit Log**: Chronological trail of administrative actions.
- **Settings**: Read-only environment details alongside runtime configuration controls.

---

## Testing & Verification

### Unit & Functional Test Suites (No external dependencies required)
```bash
npm test
# Runs circuit breaker, metrics, load balancer, API key, routes, quotas, logs, errors, and admin API tests (54 tests)
```

### Full Integration Test Suite (Redis running)
```bash
npm run test:all
# Runs all 67 tests including atomic Redis Lua rate-limiting tests
```

### End-to-End & Concurrency Verification
```bash
# Verify WebSocket event stream correlation under concurrent load (120 parallel requests)
node tests/verify_ws_concurrency.js

# Verify least-connections in-flight tracking and cleanup
node tests/verify_least_connections.js

# Run high-concurrency load test against Docker stack
node loadTest.js --requests 500 --concurrency 50 --algo token-bucket
```

---

## Running with Docker Compose

```bash
# Build and start all services (Redis, 3 Mock Backends, API Gateway)
docker compose build
docker compose up -d

# Check status of cluster
docker compose ps

# Access services:
# Management Dashboard: http://localhost:8080
# Gateway Health:       http://localhost:8080/health
# Gateway Metrics:      http://localhost:8080/metrics
# OpenAPI Specification: http://localhost:8080/openapi.json
# Ping Route:           http://localhost:8080/api/ping
```

---

## Known Limitations

- **Metrics & Logging Storage**: Metrics counters and request logs are stored in-process per gateway instance. In a multi-gateway cluster, request logs are local to the handling node; for multi-node aggregation, a distributed log collector (e.g. OpenTelemetry / Vector) is recommended.
- **In-Memory Circuit Breakers**: Circuit breaker state is tracked in-process per gateway node to eliminate network overhead on failure detection.
- **Client Retries**: The gateway intentionally does not retry timed-out requests to prevent thundering-herd issues on downstream backends. Upstream clients should observe the standard `Retry-After` header.
- **Active Connections Tracking**: The load balancer's active connection count is scoped in-process per gateway instance.
- **WebSocket Dashboard Scope**: The WebSocket dashboard delivers real-time events for the connected gateway instance.
