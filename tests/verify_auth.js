'use strict';

const http = require('http');

function makeRequest(path = '/api/ping', headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path,
      method: 'GET',
      headers,
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

async function run() {
  console.log('══════════════════════════════════════════════════');
  console.log('  Authentication Verification');
  console.log('══════════════════════════════════════════════════');

  // Test 1: Missing credential
  console.log('[Auth-1] Testing missing credential...');
  const missingRes = await makeRequest('/api/ping');
  console.log(`  Status: ${missingRes.statusCode}, Body:`, JSON.stringify(missingRes.body));
  if (missingRes.statusCode !== 401) {
    console.error(`FAIL: Expected 401 for missing credential, got ${missingRes.statusCode}`);
    process.exit(1);
  }

  // Test 2: Invalid credential
  console.log('[Auth-2] Testing invalid credential...');
  const invalidRes = await makeRequest('/api/ping', { 'X-Api-Key': 'invalid-key-xyz' });
  console.log(`  Status: ${invalidRes.statusCode}, Body:`, JSON.stringify(invalidRes.body));
  if (invalidRes.statusCode !== 403) {
    console.error(`FAIL: Expected 403 for invalid credential, got ${invalidRes.statusCode}`);
    process.exit(1);
  }

  // Test 3: Valid FREE credential
  console.log('[Auth-3] Testing valid FREE tier credential...');
  const freeRes = await makeRequest('/api/ping', { 'X-Api-Key': 'testkey-free' });
  console.log(`  Status: ${freeRes.statusCode}, X-RateLimit-Limit: ${freeRes.headers['x-ratelimit-limit']}`);
  if (freeRes.statusCode !== 200 || freeRes.headers['x-ratelimit-limit'] !== '20') {
    console.error(`FAIL: Expected 200 with limit 20, got ${freeRes.statusCode} with limit ${freeRes.headers['x-ratelimit-limit']}`);
    process.exit(1);
  }

  // Test 4: Valid PRO credential
  console.log('[Auth-4] Testing valid PRO tier credential...');
  const proRes = await makeRequest('/api/ping', { 'X-Api-Key': 'testkey-pro' });
  console.log(`  Status: ${proRes.statusCode}, X-RateLimit-Limit: ${proRes.headers['x-ratelimit-limit']}`);
  if (proRes.statusCode !== 200 || proRes.headers['x-ratelimit-limit'] !== '100') {
    console.error(`FAIL: Expected 200 with limit 100, got ${proRes.statusCode} with limit ${proRes.headers['x-ratelimit-limit']}`);
    process.exit(1);
  }

  // Test 5: Valid PREMIUM credential
  console.log('[Auth-5] Testing valid PREMIUM tier credential...');
  const premRes = await makeRequest('/api/ping', { 'X-Api-Key': 'testkey-premium' });
  console.log(`  Status: ${premRes.statusCode}, X-RateLimit-Limit: ${premRes.headers['x-ratelimit-limit']}`);
  if (premRes.statusCode !== 200 || premRes.headers['x-ratelimit-limit'] !== '500') {
    console.error(`FAIL: Expected 200 with limit 500, got ${premRes.statusCode} with limit ${premRes.headers['x-ratelimit-limit']}`);
    process.exit(1);
  }

  // Test 6: Query param auth (?apiKey=testkey-pro)
  console.log('[Auth-6] Testing query parameter auth...');
  const queryRes = await makeRequest('/api/ping?apiKey=testkey-pro');
  console.log(`  Status: ${queryRes.statusCode}, X-RateLimit-Limit: ${queryRes.headers['x-ratelimit-limit']}`);
  if (queryRes.statusCode !== 200 || queryRes.headers['x-ratelimit-limit'] !== '100') {
    console.error(`FAIL: Expected 200 with limit 100 via query param, got ${queryRes.statusCode}`);
    process.exit(1);
  }

  // Test 7: Rate limit tier burst behavior (PRO allows 25 burst without throttling, whereas FREE throttles at 21)
  console.log('[Auth-7] Testing tier rate-limit differentiation under burst...');
  // Burst 25 requests with PRO key
  const proBurst = await Promise.all(
    Array.from({ length: 25 }, () => makeRequest('/api/ping', { 'X-Api-Key': 'testkey-pro' }))
  );
  const proAllowed = proBurst.filter(r => r.statusCode === 200).length;
  console.log(`  PRO tier burst of 25: ${proAllowed} allowed, ${25 - proAllowed} throttled (Expected 25 allowed)`);
  if (proAllowed !== 25) {
    console.error(`FAIL: Expected all 25 allowed for PRO tier, got ${proAllowed}`);
    process.exit(1);
  }

  console.log('══════════════════════════════════════════════════');
  console.log('PASS: Authentication and tier-based limits verified successfully.');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
