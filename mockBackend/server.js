'use strict';

const express = require('express');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 5001;

// Simulate a configurable failure rate for circuit-breaker testing.
// Set FAILURE_RATE=0.3 to make ~30% of requests return 500.
const FAILURE_RATE = parseFloat(process.env.FAILURE_RATE || '0');

// ── Health check endpoint ─────────────────────────────────────────────────────
// The gateway's load balancer calls GET /health to decide whether to route
// traffic here.  Must return 200 when the backend is ready.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT, pid: process.pid });
});

// ── Mock API handler ──────────────────────────────────────────────────────────
// Handles any /api/* path that the gateway proxies through.
app.use('/api', (req, res) => {
  // Simulate random failures for circuit-breaker testing
  if (FAILURE_RATE > 0 && Math.random() < FAILURE_RATE) {
    return res.status(500).json({
      error:     'Simulated backend error',
      servedBy:  `backend-${PORT}`,
      failureRate: FAILURE_RATE,
    });
  }

  // Simulate variable processing time so least-connections routing
  // behaves visibly differently from round-robin under sustained load.
  const delayMs = Math.random() * 150;
  setTimeout(() => {
    res.json({
      servedBy:  `backend-${PORT}`,
      path:      req.path,
      method:    req.method,
      timestamp: new Date().toISOString(),
    });
  }, delayMs);
});

app.listen(PORT, () => {
  console.log(JSON.stringify({
    ts:      new Date().toISOString(),
    level:   'info',
    msg:     'mock backend started',
    port:    PORT,
    failureRate: FAILURE_RATE,
  }));
});
