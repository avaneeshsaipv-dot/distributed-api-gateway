'use strict';

/**
 * In-process metrics store (per gateway instance).
 *
 * Tracks:
 *   - total / allowed / throttled / failed request counts
 *   - status code distribution
 *   - latency (avg, p50, p95, p99) via a bounded ring buffer
 *   - per-backend request and error counts
 *   - a rolling 60-second window for requests/sec
 *   - retry count
 *   - circuit breaker trip count
 *
 * This is a singleton exported as a module — import the same object
 * everywhere within one gateway process.
 */

const RING_SIZE = 1024;          // latency ring buffer size
const BUCKET_COUNT = 60;         // one bucket per second, 60s history

class Metrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.totalRequests    = 0;
    this.allowedRequests  = 0;   // reached a backend (not throttled, not a 5xx from gateway itself)
    this.throttledRequests = 0;  // rejected by rate limiter (429)
    this.failedRequests   = 0;   // proxy/gateway error (502/503/504)
    this.statusCodes      = {};  // { '200': N, '429': N, '502': N, ... }
    this.backendStats     = {};  // { 'http://...': { requests, errors } }
    this.retries          = 0;
    this.circuitBreakerTrips = 0;

    // Bounded ring buffer for latency samples
    this._latRing  = new Float64Array(RING_SIZE);
    this._latHead  = 0;   // next write position
    this._latCount = 0;   // number of samples written (capped at RING_SIZE)
    this._latSum   = 0;   // rolling sum (approx — reset when ring wraps)

    // Rolling per-second buckets for req/s calculation
    // Each bucket: { sec: unixSec, count: N }
    this._buckets = Array.from({ length: BUCKET_COUNT }, () => ({ sec: 0, count: 0 }));
  }

  /**
   * Record a completed request.
   *
   * @param {object} p
   * @param {number}  p.status      HTTP status code (0 = network failure)
   * @param {number}  [p.latencyMs] End-to-end latency in milliseconds
   * @param {string}  [p.backend]   Backend URL that handled the request
   * @param {boolean} [p.throttled] true if rejected by rate limiter
   * @param {boolean} [p.failed]    true if proxy/gateway error
   * @param {boolean} [p.retried]   true if at least one retry occurred
   */
  record({ status, latencyMs, backend, throttled = false, failed = false, retried = false }) {
    this.totalRequests++;

    if (throttled) {
      this.throttledRequests++;
    } else if (failed) {
      this.failedRequests++;
    } else {
      this.allowedRequests++;
    }

    if (retried) this.retries++;

    // Status code histogram
    const sc = String(status || 0);
    this.statusCodes[sc] = (this.statusCodes[sc] || 0) + 1;

    // Latency ring buffer (only for proxied requests that have a latency)
    if (latencyMs != null && !throttled) {
      const slot = this._latHead % RING_SIZE;
      const evicted = this._latRing[slot];
      if (this._latCount >= RING_SIZE) {
        this._latSum -= evicted;   // remove the value being overwritten
      }
      this._latRing[slot] = latencyMs;
      this._latSum += latencyMs;
      this._latHead = (this._latHead + 1) % RING_SIZE;
      this._latCount = Math.min(this._latCount + 1, RING_SIZE);
    }

    // Backend distribution
    if (backend) {
      if (!this.backendStats[backend]) {
        this.backendStats[backend] = { requests: 0, errors: 0 };
      }
      this.backendStats[backend].requests++;
      if (failed || status >= 500) {
        this.backendStats[backend].errors++;
      }
    }

    // Rolling req/s bucket
    const nowSec = Math.floor(Date.now() / 1000);
    const idx    = nowSec % BUCKET_COUNT;
    const bucket = this._buckets[idx];
    if (bucket.sec === nowSec) {
      bucket.count++;
    } else {
      bucket.sec   = nowSec;
      bucket.count = 1;
    }
  }

  // ─── Derived metrics ────────────────────────────────────────────────────────

  avgLatencyMs() {
    if (this._latCount === 0) return 0;
    return this._latSum / this._latCount;
  }

  /**
   * Compute a percentile from the latency ring buffer.
   * @param {number} p  Percentile 0–100
   */
  percentile(p) {
    if (this._latCount === 0) return 0;
    // Collect live samples (ring might not be full)
    const samples = Array.from(this._latRing.subarray(0, this._latCount)).sort((a, b) => a - b);
    const idx = Math.min(Math.ceil((p / 100) * samples.length) - 1, samples.length - 1);
    return samples[Math.max(0, idx)];
  }

  /**
   * Average requests per second over the last 60 seconds.
   * Buckets older than 60s are ignored.
   */
  requestsPerSecond() {
    const nowSec = Math.floor(Date.now() / 1000);
    let total = 0;
    let activeBuckets = 0;
    for (const bucket of this._buckets) {
      const age = nowSec - bucket.sec;
      if (bucket.sec > 0 && age >= 0 && age < BUCKET_COUNT) {
        total += bucket.count;
        activeBuckets++;
      }
    }
    if (activeBuckets === 0) return 0;
    // Divide by the actual elapsed window, not just active buckets
    const windowSec = Math.min(activeBuckets, BUCKET_COUNT);
    return total / windowSec;
  }

  /** Returns a plain JSON-serialisable snapshot. */
  snapshot() {
    return {
      totalRequests:     this.totalRequests,
      allowedRequests:   this.allowedRequests,
      throttledRequests: this.throttledRequests,
      failedRequests:    this.failedRequests,
      statusCodes:       { ...this.statusCodes },
      latency: {
        avgMs: Math.round(this.avgLatencyMs() * 10) / 10,
        p50Ms: Math.round(this.percentile(50)),
        p95Ms: Math.round(this.percentile(95)),
        p99Ms: Math.round(this.percentile(99)),
        sampleCount: this._latCount,
      },
      requestsPerSecond:   Math.round(this.requestsPerSecond() * 10) / 10,
      backendStats:        JSON.parse(JSON.stringify(this.backendStats)),
      retries:             this.retries,
      circuitBreakerTrips: this.circuitBreakerTrips,
    };
  }
}

// Singleton per gateway process
module.exports = new Metrics();
