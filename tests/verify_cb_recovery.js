'use strict';

const http = require('http');

function makeRequest(path = '/api/ping', clientId = 'cb-recover') {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path,
      method: 'GET',
      headers: { 'X-Client-Id': clientId },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json,
        });
      });
    });
    req.on('error', err => resolve({ statusCode: 0, error: err.message }));
    req.end();
  });
}

async function getHealth() {
  const res = await makeRequest('/health', 'health-check');
  return res.body;
}

async function run() {
  console.log('══════════════════════════════════════════════════');
  console.log('  Circuit Breaker Recovery Verification');
  console.log('══════════════════════════════════════════════════');

  // Check initial state
  let health = await getHealth();
  let b1 = health.backends.find(b => b.url.includes(':5001'));
  console.log(`[CB-Rec-1] Current backend-1 CB state=${b1.circuitBreaker.state}, recoveryRemainingMs=${b1.circuitBreaker.recoveryRemainingMs}`);

  // Wait if there's remaining time
  const waitMs = (b1.circuitBreaker.recoveryRemainingMs || 0) + 1500;
  if (waitMs > 0) {
    console.log(`[CB-Rec-2] Waiting ${waitMs}ms for recovery timeout to elapse...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  // Now recovery timeout has elapsed. Sending requests should trigger canRequest() -> transition to HALF_OPEN, then probe successes -> CLOSED
  console.log('[CB-Rec-3] Sending requests to probe recovered backend-1...');

  let closedReached = false;
  let halfOpenObserved = false;
  for (let i = 1; i <= 15; i++) {
    const res = await makeRequest('/api/ping', `cb-rec-${i}`);
    health = await getHealth();
    b1 = health.backends.find(b => b.url.includes(':5001'));
    const state = b1.circuitBreaker.state;
    console.log(`  Req #${i}: status=${res.statusCode}, servedBy=${res.body?.servedBy || 'none'} | backend-1 CB state=${state}`);

    if (state === 'HALF_OPEN') halfOpenObserved = true;
    if (state === 'CLOSED') {
      closedReached = true;
      console.log(`[CB-Rec-4] SUCCESS: backend-1 circuit breaker transitioned to CLOSED!`);
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!closedReached) {
    console.error('FAIL: backend-1 failed to transition back to CLOSED.');
    process.exit(1);
  }

  // Verify backend-1 is serving traffic normally again
  console.log('[CB-Rec-5] Verifying traffic distribution across all backends...');
  const servedCounts = {};
  for (let i = 0; i < 30; i++) {
    const res = await makeRequest('/api/ping', `cb-final-${i}`);
    const s = res.body?.servedBy || 'error';
    servedCounts[s] = (servedCounts[s] || 0) + 1;
  }
  console.log('  Distribution:', JSON.stringify(servedCounts));

  if (servedCounts['backend-5001'] > 0 && servedCounts['backend-5002'] > 0 && servedCounts['backend-5003'] > 0) {
    console.log('PASS: All 3 backends are actively serving traffic.');
    process.exit(0);
  } else {
    console.error('FAIL: Not all backends are serving traffic.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
