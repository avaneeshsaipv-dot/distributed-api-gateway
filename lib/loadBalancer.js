'use strict';

/**
 * Health-aware load balancer with circuit breaking.
 *
 * Two strategies:
 *   round-robin      – cycles through healthy backends in order
 *   least-connections – picks the healthy backend with the fewest active
 *                       in-flight requests (in-process counter)
 *
 * Health checks run on a configurable interval via HTTP GET /health on
 * each backend.  Unhealthy backends are excluded from routing until they
 * recover; if ALL backends are unhealthy pick() returns null and the
 * gateway must return HTTP 503.
 *
 * Each backend has its own CircuitBreaker.  A backend is only routed to
 * when both healthy === true AND circuitBreaker.canRequest() === true.
 *
 * Requires Node ≥ 18 for the global fetch API.
 */

const { CircuitBreaker } = require('./circuitBreaker');

const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 10_000;
const HEALTH_CHECK_TIMEOUT_MS  = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS,  10) || 3_000;

class LoadBalancer {
  /**
   * @param {string[]} backends   Array of backend base URLs e.g. ['http://host:5001']
   * @param {string}   strategy  'round-robin' | 'least-connections'
   */
  constructor(backends, strategy = 'round-robin') {
    if (!backends || backends.length === 0) {
      throw new Error('LoadBalancer requires at least one backend URL');
    }

    this.backends  = backends;
    this.strategy  = strategy;
    this._rrIndex  = 0;

    // Per-backend counters
    this._active  = Object.fromEntries(backends.map(b => [b, 0]));   // in-flight
    this._total   = Object.fromEntries(backends.map(b => [b, 0]));   // lifetime requests served
    this._errors  = Object.fromEntries(backends.map(b => [b, 0]));   // lifetime errors

    // Start optimistically healthy (avoids a cold-start dead zone before
    // the first health check completes)
    this._healthy      = Object.fromEntries(backends.map(b => [b, true]));
    this._adminEnabled = Object.fromEntries(backends.map(b => [b, true]));

    this._cb = Object.fromEntries(
      backends.map(b => [b, new CircuitBreaker({
        failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5,
        recoveryTimeout:  parseInt(process.env.CB_RECOVERY_TIMEOUT_MS, 10) || 30_000,
        successThreshold: parseInt(process.env.CB_SUCCESS_THRESHOLD, 10) || 2,
      })])
    );

    this._healthTimer = setInterval(
      () => this._checkAll().catch(() => {}),
      HEALTH_CHECK_INTERVAL_MS
    );
    this._healthTimer.unref(); // do not prevent process exit

    // Run an initial health check shortly after startup
    setTimeout(() => this._checkAll().catch(() => {}), 1_500);
  }

  // ─── Health checking ────────────────────────────────────────────────────────

  async _checkOne(backend) {
    const url = `${backend}/health`;
    let timer;
    try {
      const ctrl  = new AbortController();
      timer = setTimeout(() => ctrl.abort(), HEALTH_CHECK_TIMEOUT_MS);
      const res   = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);

      const wasHealthy = this._healthy[backend];
      this._healthy[backend] = res.ok;

      if (!wasHealthy && res.ok) {
        console.log(`[lb] backend ${backend} is healthy again`);
      }
    } catch {
      clearTimeout(timer);
      if (this._healthy[backend]) {
        console.warn(`[lb] backend ${backend} failed health check`);
      }
      this._healthy[backend] = false;
    }
  }

  async _checkAll() {
    await Promise.allSettled(this.backends.map(b => this._checkOne(b)));
  }

  // ─── Backend selection ──────────────────────────────────────────────────────

  /**
   * Select a backend to serve the next request.
   * @returns {string|null} Backend URL, or null if no healthy backend is available.
   */
  pick() {
    // Candidates are backends that are administratively enabled, healthy AND whose circuit is not fully open
    const candidates = this.backends.filter(
      b => this._adminEnabled[b] !== false && this._healthy[b] && this._cb[b].canRequest()
    );

    if (candidates.length === 0) return null;

    if (this.strategy === 'least-connections') {
      return candidates.reduce((best, b) =>
        this._active[b] < this._active[best] ? b : best
      );
    }

    // Round-robin: advance the global index, wrap over the full backend list,
    // then pick the first candidate at or after that position.
    for (let i = 0; i < this.backends.length; i++) {
      const idx     = (this._rrIndex + i) % this.backends.length;
      const backend = this.backends[idx];
      if (candidates.includes(backend)) {
        this._rrIndex = (idx + 1) % this.backends.length;
        return backend;
      }
    }
    return null; // shouldn't happen given candidates.length > 0
  }

  /** Administratively enable or disable a backend */
  setBackendEnabled(backendUrl, enabled) {
    if (!this.backends.includes(backendUrl)) return false;
    this._adminEnabled[backendUrl] = Boolean(enabled);
    return true;
  }

  // ─── Request lifecycle hooks ─────────────────────────────────────────────────

  /** Call immediately before proxying to a backend. */
  onRequestStart(backend) {
    this._active[backend] = (this._active[backend] || 0) + 1;
    this._total[backend]  = (this._total[backend]  || 0) + 1;
  }

  /**
   * Call after a request completes (success OR failure).
   * This must always be called exactly once per onRequestStart to prevent leaks.
   */
  onRequestEnd(backend) {
    this._active[backend] = Math.max(0, (this._active[backend] || 1) - 1);
  }

  /** Call after the upstream responded successfully (non-5xx). */
  onRequestSuccess(backend) {
    this._cb[backend].onSuccess();
  }

  /**
   * Call after a proxy/upstream error or a 5xx response.
   * @returns {boolean} true if the circuit breaker tripped open.
   */
  onRequestFailure(backend) {
    this._errors[backend] = (this._errors[backend] || 0) + 1;
    const tripped = this._cb[backend].onFailure();
    if (tripped) {
      console.warn(`[lb] circuit breaker OPEN for backend ${backend}`);
    }
    return tripped;
  }

  // ─── Observability ───────────────────────────────────────────────────────────

  stats() {
    return {
      strategy: this.strategy,
      backends: this.backends.map(b => ({
        url:               b,
        healthy:           this._healthy[b],
        enabled:           this._adminEnabled[b] !== false,
        activeConnections: this._active[b],
        totalRequests:     this._total[b],
        errors:            this._errors[b],
        circuitBreaker:    this._cb[b].toJSON(),
      })),
    };
  }

  /** Clean up the health-check timer (useful in tests). */
  destroy() {
    clearInterval(this._healthTimer);
  }
}

module.exports = LoadBalancer;
