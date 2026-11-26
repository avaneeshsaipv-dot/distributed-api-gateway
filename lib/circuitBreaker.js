'use strict';

/**
 * Per-backend circuit breaker.
 *
 * States:
 *   CLOSED    – requests flow normally; failures are counted
 *   OPEN      – requests are blocked; a recovery timer runs
 *   HALF_OPEN – one probe request is allowed; success → CLOSED, failure → OPEN
 *
 * All state is in-process (per gateway instance). If you run multiple
 * gateways, each has its own circuit breaker — that is acceptable here
 * because health-check-based recovery also works per-instance.
 */

const STATES = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {number} opts.failureThreshold   – consecutive failures before opening (default 5)
   * @param {number} opts.recoveryTimeout    – ms to wait in OPEN before trying HALF_OPEN (default 30000)
   * @param {number} opts.successThreshold   – consecutive successes in HALF_OPEN to close (default 2)
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.recoveryTimeout  = opts.recoveryTimeout  ?? 30_000;
    this.successThreshold = opts.successThreshold ?? 2;

    this._state      = STATES.CLOSED;
    this._failures   = 0;
    this._successes  = 0;
    this._openedAt   = null;
  }

  get state()  { return this._state; }
  get isOpen() { return this._state === STATES.OPEN; }

  /**
   * Returns true if a request should be allowed through right now.
   * Transitions OPEN → HALF_OPEN when the recovery timeout elapses.
   */
  canRequest() {
    switch (this._state) {
      case STATES.CLOSED:
        return true;
      case STATES.OPEN:
        if (Date.now() - this._openedAt >= this.recoveryTimeout) {
          this._transition(STATES.HALF_OPEN);
          return true;   // allow one probe
        }
        return false;
      case STATES.HALF_OPEN:
        return true;     // allow probe(s) through; success/failure decides next state
      default:
        return false;
    }
  }

  /** Call after a successful upstream response. */
  onSuccess() {
    if (this._state === STATES.HALF_OPEN) {
      this._successes++;
      if (this._successes >= this.successThreshold) {
        this._transition(STATES.CLOSED);
      }
    } else {
      // Reset failure streak on any success in CLOSED state
      this._failures = 0;
    }
  }

  /**
   * Call after a failed upstream response.
   * @returns {boolean} true if this failure tripped the breaker (CLOSED→OPEN)
   */
  onFailure() {
    this._failures++;
    const shouldOpen =
      this._state === STATES.HALF_OPEN ||
      this._failures >= this.failureThreshold;

    if (shouldOpen) {
      this._transition(STATES.OPEN);
      return true;
    }
    return false;
  }

  _transition(next) {
    this._state    = next;
    this._failures  = 0;
    this._successes = 0;
    if (next === STATES.OPEN) {
      this._openedAt = Date.now();
    } else {
      this._openedAt = null;
    }
  }

  toJSON() {
    return {
      state:    this._state,
      failures: this._failures,
      openedAt: this._openedAt,
      recoveryRemainingMs: this._state === STATES.OPEN
        ? Math.max(0, this.recoveryTimeout - (Date.now() - this._openedAt))
        : null,
    };
  }
}

module.exports = { CircuitBreaker, STATES };
