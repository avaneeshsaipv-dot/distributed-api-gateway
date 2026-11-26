'use strict';

/**
 * Standardized API Gateway Error Response Formatter
 *
 * Ensures all client-facing errors adhere to a uniform structure:
 * {
 *   "error": "Message",
 *   "status": 503,
 *   "requestId": "...",
 *   "timestamp": "..."
 * }
 *
 * Supplemental fields (such as algorithm/retryAfterSec for 429,
 * or hint for 401) are preserved for full backward compatibility.
 */

function formatError(error, status, requestId, extra = {}) {
  return {
    error: typeof error === 'string' ? error : (error?.message || 'Internal error'),
    status,
    requestId: requestId || '',
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function sendError(res, status, error, requestId, extra = {}) {
  if (res.headersSent) return;
  return res.status(status).json(formatError(error, status, requestId, extra));
}

module.exports = {
  formatError,
  sendError,
};
