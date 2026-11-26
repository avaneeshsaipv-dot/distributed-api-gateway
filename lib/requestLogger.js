'use strict';

/**
 * Bounded In-Memory Request Logger
 *
 * Implements a strict ring buffer with maximum capacity (default 500)
 * to prevent uncontrolled memory growth. Provides rich filtering,
 * pagination, and sorting for the Request Logs dashboard and admin APIs.
 */

const DEFAULT_CAPACITY = 500;

class RequestLogger {
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.logs = [];
  }

  /**
   * Record a completed request log entry.
   */
  record({
    requestId,
    timestamp,
    method,
    path,
    status,
    latencyMs,
    backend,
    clientId,
    keyName,
    algo,
    rateLimitResult,
    error,
  }) {
    const entry = {
      requestId: requestId || '',
      timestamp: timestamp || new Date().toISOString(),
      method: (method || 'GET').toUpperCase(),
      path: path || '/',
      status: Number(status) || 0,
      latencyMs: latencyMs != null ? Math.round(latencyMs) : null,
      backend: backend || null,
      clientId: clientId || 'anonymous',
      keyName: keyName || null,
      algo: algo || 'token-bucket',
      rateLimitResult: rateLimitResult || null,
      error: error || null,
    };

    this.logs.unshift(entry);
    if (this.logs.length > this.capacity) {
      this.logs.length = this.capacity;
    }
    return entry;
  }

  /**
   * Query logs with multi-field filtering and pagination.
   *
   * @param {object} opts
   * @param {string} [opts.method]     Filter by HTTP method (e.g. 'GET', 'POST')
   * @param {string} [opts.status]     Filter by exact status ('200') or family ('2xx', '4xx', '5xx')
   * @param {string} [opts.backend]    Filter by backend URL substring
   * @param {string} [opts.search]     Search across path, requestId, and clientId
   * @param {number} [opts.limit]      Page size (default 50, max 100)
   * @param {number} [opts.offset]     Page offset (default 0)
   */
  query(opts = {}) {
    let filtered = this.logs;

    // Filter by method
    if (opts.method && opts.method !== 'ALL') {
      const m = opts.method.toUpperCase();
      filtered = filtered.filter(l => l.method === m);
    }

    // Filter by status code or family (2xx, 4xx, 5xx)
    if (opts.status && opts.status !== 'ALL') {
      const s = opts.status.toLowerCase();
      if (s === '2xx') {
        filtered = filtered.filter(l => l.status >= 200 && l.status < 300);
      } else if (s === '4xx') {
        filtered = filtered.filter(l => l.status >= 400 && l.status < 500);
      } else if (s === '5xx') {
        filtered = filtered.filter(l => l.status >= 500);
      } else {
        const num = parseInt(s, 10);
        if (!isNaN(num)) {
          filtered = filtered.filter(l => l.status === num);
        }
      }
    }

    // Filter by backend
    if (opts.backend && opts.backend !== 'ALL') {
      const be = opts.backend.toLowerCase();
      filtered = filtered.filter(l => l.backend && l.backend.toLowerCase().includes(be));
    }

    // Search keyword in path, requestId, clientId, or keyName
    if (opts.search) {
      const q = opts.search.toLowerCase().trim();
      filtered = filtered.filter(l =>
        (l.path && l.path.toLowerCase().includes(q)) ||
        (l.requestId && l.requestId.toLowerCase().includes(q)) ||
        (l.clientId && l.clientId.toLowerCase().includes(q)) ||
        (l.keyName && l.keyName.toLowerCase().includes(q))
      );
    }

    const total = filtered.length;
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 50));
    const items = filtered.slice(offset, offset + limit);

    return {
      total,
      offset,
      limit,
      items,
    };
  }

  clear() {
    this.logs = [];
  }
}

module.exports = new RequestLogger();
