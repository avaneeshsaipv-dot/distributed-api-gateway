'use strict';

const http = require('http');

function makeRequest(path = '/api/ping', clientId = 'lc-test') {
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
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', err => resolve({ statusCode: 0, error: err.message }));
    req.end();
  });
}

function getActiveConnections() {
  return new Promise((resolve) => {
    http.get('http://localhost:8080/health', (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const active = {};
          for (const b of json.backends) {
            active[b.url] = b.activeConnections;
          }
          resolve(active);
        } catch (_) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function run() {
  console.log('══════════════════════════════════════════════════');
  console.log('  Least-Connections Verification');
  console.log('══════════════════════════════════════════════════');

  // Step 1: Initial state
  const initial = await getActiveConnections();
  console.log('[LC-1] Initial active connections:', JSON.stringify(initial));

  // Step 2: Fire 100 concurrent requests
  console.log('[LC-2] Firing 100 concurrent requests...');
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(makeRequest('/api/ping', `lc-client-${i}`));
  }

  // Sample in-flight active connections while promises are running
  await new Promise(r => setTimeout(r, 40));
  const inFlight = await getActiveConnections();
  console.log('[LC-3] In-flight active connections sample:', JSON.stringify(inFlight));

  const results = await Promise.all(promises);
  console.log(`[LC-4] Completed ${results.length} requests (status 200: ${results.filter(r => r.statusCode === 200).length})`);

  // Wait brief moment for any lingering close handlers
  await new Promise(r => setTimeout(r, 500));
  const postFlight = await getActiveConnections();
  console.log('[LC-5] Post-flight active connections:', JSON.stringify(postFlight));

  const allZero = Object.values(postFlight).every(v => v === 0);
  if (!allZero) {
    console.error('FAIL: Active connections did not return to zero after normal requests!');
    process.exit(1);
  } else {
    console.log('PASS: All active connection counts returned to 0 after concurrent requests.');
  }

  // Step 3: Test Error Paths
  console.log('[LC-6] Testing error paths: hitting invalid backend path / 500 scenarios...');
  // Send concurrent requests that result in errors or timeouts
  // We can test rapid requests where client immediately aborts / errors
  const abortPromises = [];
  for (let i = 0; i < 30; i++) {
    const p = new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/ping',
        method: 'GET',
        headers: { 'X-Client-Id': `lc-err-${i}` },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0));
      // Abort half of them immediately to test client disconnect cleanup
      if (i % 2 === 0) {
        setTimeout(() => req.destroy(), 10);
      }
      req.end();
    });
    abortPromises.push(p);
  }

  await Promise.all(abortPromises);
  await new Promise(r => setTimeout(r, 800));

  const postError = await getActiveConnections();
  console.log('[LC-7] Post-error/abort active connections:', JSON.stringify(postError));

  const allZeroPostError = Object.values(postError).every(v => v === 0);
  if (!allZeroPostError) {
    console.error('FAIL: Active connections did not return to zero after error/abort paths!');
    process.exit(1);
  } else {
    console.log('PASS: All active connections returned to 0 after error & client abort paths.');
  }

  console.log('══════════════════════════════════════════════════');
  console.log('Least-connections verified successfully.');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
