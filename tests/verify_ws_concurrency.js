'use strict';

const http = require('http');
const WebSocket = require('ws');

const TOTAL_REQUESTS = 120;
const GATEWAY_WS = 'ws://localhost:8080/ws';
const GATEWAY_HTTP_HOST = 'localhost';
const GATEWAY_HTTP_PORT = 8080;

async function run() {
  console.log(`[ws-test] Connecting to ${GATEWAY_WS}...`);
  const ws = new WebSocket(GATEWAY_WS);

  const wsEvents = [];
  const wsReady = new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('[ws-test] WebSocket connected.');
      resolve();
    });
    ws.on('error', reject);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'request') {
        wsEvents.push(msg);
      }
    } catch (e) {
      console.error('[ws-test] Malformed WS message:', e);
    }
  });

  await wsReady;

  // Small delay to allow any initial bursts/snapshots to clear
  await new Promise(r => setTimeout(r, 200));

  console.log(`[ws-test] Firing ${TOTAL_REQUESTS} concurrent requests...`);
  const promises = [];

  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    const clientId = `ws-client-${i}`;

    const p = new Promise((resolve) => {
      const req = http.request({
        hostname: GATEWAY_HTTP_HOST,
        port: GATEWAY_HTTP_PORT,
        path: '/api/ping',
        method: 'GET',
        headers: {
          'X-Client-Id': clientId,
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          resolve({
            clientId,
            statusCode: res.statusCode,
            resRequestId: res.headers['x-request-id'],
            body: body.toString(),
          });
        });
      });

      req.on('error', (err) => {
        resolve({
          clientId,
          statusCode: 0,
          error: err.message,
        });
      });

      req.end();
    });

    promises.push(p);
  }

  const responses = await Promise.all(promises);
  console.log(`[ws-test] All ${TOTAL_REQUESTS} HTTP requests completed.`);

  // Wait for any remaining WS messages in flight to be received
  await new Promise(r => setTimeout(r, 1500));
  ws.close();

  // ── Verification ───────────────────────────────────────────────────────────
  const successfulHttp = responses.filter(r => r.statusCode === 200);
  console.log(`[ws-test] Successful HTTP 200 responses: ${successfulHttp.length}/${TOTAL_REQUESTS}`);

  // Map of response requestIds from this batch
  const expectedRequestIds = new Set(responses.map(r => r.resRequestId).filter(Boolean));
  console.log(`[ws-test] Unique response Request-IDs captured: ${expectedRequestIds.size}`);

  // Filter wsEvents to only those belonging to this test run
  const ourWsEvents = wsEvents.filter(e => expectedRequestIds.has(e.requestId));
  console.log(`[ws-test] Total matching WS events received: ${ourWsEvents.length}`);

  // Check for duplicates
  const wsCountById = new Map();
  for (const ev of ourWsEvents) {
    wsCountById.set(ev.requestId, (wsCountById.get(ev.requestId) || 0) + 1);
  }

  let duplicateCount = 0;
  for (const [id, count] of wsCountById.entries()) {
    if (count > 1) {
      duplicateCount++;
      console.error(`[ws-test] DUPLICATE event for requestId: ${id} (received ${count} times)`);
    }
  }

  // Check for missing events and cross-request data corruption
  let missingCount = 0;
  let crossDataMismatchCount = 0;

  for (const httpRes of responses) {
    const reqId = httpRes.resRequestId;
    if (!reqId) {
      missingCount++;
      console.error(`[ws-test] HTTP response missing x-request-id header for client ${httpRes.clientId}`);
      continue;
    }

    const ev = ourWsEvents.find(e => e.requestId === reqId);
    if (!ev) {
      missingCount++;
      console.error(`[ws-test] MISSING WS event for requestId: ${reqId}`);
      continue;
    }

    if (ev.clientId !== httpRes.clientId) {
      crossDataMismatchCount++;
      console.error(`[ws-test] ClientId mismatch for ${reqId}: expected ${httpRes.clientId}, got ${ev.clientId}`);
    }
    if (ev.status !== httpRes.statusCode) {
      crossDataMismatchCount++;
      console.error(`[ws-test] Status mismatch for ${reqId}: expected ${httpRes.statusCode}, got ${ev.status}`);
    }
    if (!ev.backend || !ev.backend.startsWith('http://backend-')) {
      crossDataMismatchCount++;
      console.error(`[ws-test] Invalid backend for ${reqId}: ${ev.backend}`);
    }
    if (typeof ev.latencyMs !== 'number' || ev.latencyMs < 0) {
      crossDataMismatchCount++;
      console.error(`[ws-test] Invalid latencyMs for ${reqId}: ${ev.latencyMs}`);
    }
  }

  console.log('══════════════════════════════════════════════════');
  console.log('  WebSocket Concurrency Verification Results');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Requests generated   : ${TOTAL_REQUESTS}`);
  console.log(`  HTTP 200 received    : ${successfulHttp.length}`);
  console.log(`  WS events received   : ${ourWsEvents.length}`);
  console.log(`  Duplicates found     : ${duplicateCount}`);
  console.log(`  Missing events       : ${missingCount}`);
  console.log(`  Cross-request errors : ${crossDataMismatchCount}`);
  console.log('══════════════════════════════════════════════════');

  if (successfulHttp.length === TOTAL_REQUESTS &&
      ourWsEvents.length === TOTAL_REQUESTS &&
      duplicateCount === 0 &&
      missingCount === 0 &&
      crossDataMismatchCount === 0) {
    console.log('PASS: WebSocket event stream is perfectly correlated under concurrent load.');
    process.exit(0);
  } else {
    console.error('FAIL: WebSocket concurrency verification failed.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[ws-test] Fatal error:', err);
  process.exit(1);
});
