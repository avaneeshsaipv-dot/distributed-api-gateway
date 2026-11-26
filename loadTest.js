'use strict';

/**
 * Fires concurrent HTTP requests at the gateway and reports:
 *   Total / Allowed (2xx) / Throttled (429) / Failed (5xx or network error)
 *   Average latency / p95 latency / Requests per second
 *
 * ALL numbers come from actual HTTP responses — no estimation.
 *
 * Usage:
 *   node loadTest.js [options]
 *
 * Options:
 *   --requests    N      Total requests to fire            (default 500)
 *   --concurrency N      Max in-flight at once             (default 50)
 *   --algo        name   Rate-limit algorithm to use       (default token-bucket)
 *                        token-bucket | sliding-window | leaky-bucket
 *   --client-id   id     Client ID header value            (default random per client pool)
 *   --clients     N      Number of distinct client IDs     (default 10)
 *
 * Requires Node ≥ 18 (global fetch).
 */

const { parseArgs } = require('node:util');

const { values: args } = parseArgs({
  options: {
    requests:    { type: 'string',  default: '500' },
    concurrency: { type: 'string',  default: '50'  },
    algo:        { type: 'string',  default: 'token-bucket' },
    'client-id': { type: 'string',  default: ''    },
    clients:     { type: 'string',  default: '10'  },
  },
  strict: false,
});

const TOTAL       = Math.max(1, parseInt(args.requests, 10));
const CONCURRENCY = Math.max(1, parseInt(args.concurrency, 10));
const ALGO        = args.algo;
const CLIENTS     = Math.max(1, parseInt(args.clients, 10));
const FIXED_ID    = args['client-id'] || '';
const GATEWAY     = process.env.GATEWAY_URL || 'http://localhost:8080';

const VALID_ALGOS = ['token-bucket', 'sliding-window', 'leaky-bucket'];
if (!VALID_ALGOS.includes(ALGO)) {
  console.error(`Unknown algorithm: ${ALGO}. Valid: ${VALID_ALGOS.join(', ')}`);
  process.exit(1);
}

async function fireOne(idx) {
  const clientId = FIXED_ID || `load-client-${idx % CLIENTS}`;
  const url      = `${GATEWAY}/api/ping?algo=${ALGO}`;
  const start    = Date.now();

  try {
    const res = await fetch(url, {
      headers: { 'X-Client-Id': clientId },
      signal:  AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;
    return { status: res.status, latencyMs, clientId };
  } catch (err) {
    return { status: 0, latencyMs: Date.now() - start, clientId, err: err.message };
  }
}

async function run() {
  console.log(`\nGateway:     ${GATEWAY}`);
  console.log(`Algorithm:   ${ALGO}`);
  console.log(`Requests:    ${TOTAL}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Clients:     ${FIXED_ID ? 1 : CLIENTS}`);
  console.log('─'.repeat(50));
  console.log('Firing…\n');

  const results  = [];
  let inFlight   = 0;
  let nextIdx    = 0;
  const wallStart = Date.now();

  await new Promise((resolve) => {
    function launch() {
      while (inFlight < CONCURRENCY && nextIdx < TOTAL) {
        const i = nextIdx++;
        inFlight++;
        fireOne(i).then((r) => {
          results.push(r);
          inFlight--;
          if (results.length === TOTAL) resolve();
          else launch();
        });
      }
    }
    launch();
  });

  const wallMs   = Date.now() - wallStart;

  // ── Categorise by actual HTTP status ──────────────────────────────────────
  const allowed  = results.filter(r => r.status >= 200 && r.status < 300);
  const throttled = results.filter(r => r.status === 429);
  const failed   = results.filter(r => r.status === 0 || (r.status >= 500 && r.status < 600));
  const other    = results.filter(r => !allowed.includes(r) && !throttled.includes(r) && !failed.includes(r));

  const latencies     = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const avgLatency    = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  const p50           = latencies[Math.floor(latencies.length * 0.50)] ?? 0;
  const p95           = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99           = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const rps           = (TOTAL / (wallMs / 1000)).toFixed(1);

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('═'.repeat(50));
  console.log('  Load Test Results');
  console.log('═'.repeat(50));
  console.log(`  Total requests   : ${TOTAL}`);
  console.log(`  Allowed (2xx)    : ${allowed.length}  (${pct(allowed.length)}%)`);
  console.log(`  Throttled (429)  : ${throttled.length}  (${pct(throttled.length)}%)`);
  console.log(`  Failed (5xx/err) : ${failed.length}  (${pct(failed.length)}%)`);
  if (other.length) {
    console.log(`  Other status     : ${other.length}  (${pct(other.length)}%)`);
  }
  console.log('─'.repeat(50));
  console.log(`  Avg latency      : ${avgLatency.toFixed(1)} ms`);
  console.log(`  p50 latency      : ${p50} ms`);
  console.log(`  p95 latency      : ${p95} ms`);
  console.log(`  p99 latency      : ${p99} ms`);
  console.log(`  Wall time        : ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`  Req / sec        : ${rps}`);
  console.log('═'.repeat(50));

  function pct(n) { return ((n / TOTAL) * 100).toFixed(1); }
}

run().catch(err => {
  console.error('Load test failed:', err.message);
  process.exit(1);
});
