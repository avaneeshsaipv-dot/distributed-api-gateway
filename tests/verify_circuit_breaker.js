'use strict';

const http = require('http');

function makeRequest(path = '/api/ping', clientId = 'cb-test') {
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
  console.log('  Circuit Breaker Integration Verification');
  console.log('══════════════════════════════════════════════════');

  // Step 1: Initial state
  let health = await getHealth();
  const b1Initial = health.backends.find(b => b.url.includes(':5001'));
  console.log(`[CB-1] Initial state for backend-1: state=${b1Initial.circuitBreaker.state}, failures=${b1Initial.circuitBreaker.failures}`);

  // Step 2: Send requests through gateway until backend-1 trips OPEN
  console.log('[CB-2] Routing traffic through gateway to induce failures on backend-1...');
  let b1Tripped = false;
  let attempts = 0;
  const maxAttempts = 30;

  while (!b1Tripped && attempts < maxAttempts) {
    attempts++;
    const res = await makeRequest('/api/ping', `cb-trip-${attempts}`);
    health = await getHealth();
    const b1 = health.backends.find(b => b.url.includes(':5001'));
    console.log(`  Req #${attempts}: status=${res.statusCode}, servedBy=${res.body?.servedBy || 'none'} | backend-1 failures=${b1.circuitBreaker.failures}, state=${b1.circuitBreaker.state}`);
    if (b1.circuitBreaker.state === 'OPEN') {
      b1Tripped = true;
      console.log(`[CB-3] SUCCESS: backend-1 circuit breaker transitioned to OPEN after ${b1.circuitBreaker.failures} failures!`);
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!b1Tripped) {
    console.error('FAIL: backend-1 circuit breaker failed to transition to OPEN.');
    process.exit(1);
  }

  // Step 3: Verify traffic is NOT sent to backend-1 while OPEN
  console.log('[CB-4] Sending 20 requests while circuit breaker is OPEN...');
  const servedByCounts = {};
  for (let i = 0; i < 20; i++) {
    const res = await makeRequest('/api/ping', `cb-open-${i}`);
    const server = res.body?.servedBy || 'error';
    servedByCounts[server] = (servedByCounts[server] || 0) + 1;
  }
  console.log('  Traffic distribution while OPEN:', JSON.stringify(servedByCounts));

  if (servedByCounts['backend-5001']) {
    console.error(`FAIL: Traffic was sent to backend-5001 while circuit was OPEN: ${servedByCounts['backend-5001']} requests!`);
    process.exit(1);
  } else {
    console.log('  PASS: Exactly 0 requests were routed to backend-1 while OPEN.');
  }

  console.log('Circuit breaker trip & isolation verified successfully.');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
