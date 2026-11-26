'use strict';

const crypto = require('crypto');
const store  = require('./store');
const { sendError } = require('./errors');

/**
 * Enhanced API Key Authentication & Quota Engine
 *
 * Supports:
 * - Dynamic API key verification against SHA-256 hashed keys in persistent store
 * - Legacy environment variable keys (API_KEYS) for backward compatibility
 * - Route-level and global auth enforcement
 * - Monthly usage quotas (FREE: 10,000, PRO: 100,000, PREMIUM: 1,000,000)
 * - Safe masked key display and last-used tracking
 */

const TIER_LIMITS = {
  FREE: {
    // token bucket
    capacity: 20, refillRate: 5,
    // sliding window
    windowMs: 10_000, limit: 15,
    // leaky bucket
    leakCapacity: 10, leakRate: 2,
  },
  PRO: {
    capacity: 100, refillRate: 20,
    windowMs: 10_000, limit: 60,
    leakCapacity: 40, leakRate: 8,
  },
  PREMIUM: {
    capacity: 500, refillRate: 100,
    windowMs: 10_000, limit: 300,
    leakCapacity: 200, leakRate: 40,
  },
};

const TIER_QUOTAS = {
  FREE:    10_000,
  PRO:     100_000,
  PREMIUM: 1_000_000,
};

/** Legacy map for backward compatibility with process.env.API_KEYS */
function buildLegacyKeyMap() {
  const raw = process.env.API_KEYS !== undefined
    ? process.env.API_KEYS
    : 'testkey-free:FREE,testkey-pro:PRO,testkey-premium:PREMIUM';
  const map = new Map();
  if (!raw.trim()) return map;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx < 1) {
      map.set(trimmed, 'FREE');
    } else {
      const key  = trimmed.slice(0, colonIdx).trim();
      const tier = trimmed.slice(colonIdx + 1).trim().toUpperCase();
      if (key) map.set(key, tier);
    }
  }
  return map;
}

const LEGACY_KEY_MAP = buildLegacyKeyMap();

/**
 * Validate an API key string.
 * @param {string} rawKey
 * @returns {object} { valid, tier, keyId, name, maskedKey, error, status }
 */
function validateKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') {
    return { valid: false, error: 'Unauthorised', status: 401 };
  }

  // 1. Check persistent store (via SHA-256 hash)
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const record = store.findKeyByHash(hash);

  if (record) {
    if (!record.enabled) {
      return { valid: false, error: 'Forbidden – API key is disabled', status: 403 };
    }

    // Monthly Quota Check
    const tier = record.tier || 'FREE';
    const maxQuota = TIER_QUOTAS[tier] || TIER_QUOTAS.FREE;
    const currentUsage = store.getMonthlyQuotaUsage(record.id);

    if (currentUsage >= maxQuota) {
      return {
        valid: false,
        quotaExceeded: true,
        error: `Monthly quota exceeded for ${tier} tier (${maxQuota.toLocaleString()} requests/month)`,
        status: 429,
        tier,
        keyId: record.id,
      };
    }

    // Increment quota usage
    store.incrementMonthlyQuota(record.id);

    return {
      valid: true,
      tier,
      keyId: record.id,
      name: record.name,
      maskedKey: record.maskedKey,
      record,
    };
  }

  // 2. Check legacy environment keys
  if (LEGACY_KEY_MAP.has(rawKey)) {
    const tier = LEGACY_KEY_MAP.get(rawKey);
    return {
      valid: true,
      tier,
      keyId: rawKey,
      name: 'Legacy Env Key',
      maskedKey: rawKey.length > 8 ? `${rawKey.slice(0, 4)}***${rawKey.slice(-2)}` : '***',
    };
  }

  return { valid: false, error: 'Forbidden – invalid API key', status: 403 };
}

/**
 * Express middleware for authentication and quota evaluation.
 */
function authMiddleware(req, res, next) {
  const globalAuthEnabled = store.getSettings().globalAuthEnabled;
  const routeRequiresAuth = req.routeConfig?.authRequired === true;
  const isAuthRequired = globalAuthEnabled || routeRequiresAuth;

  const apiKey =
    req.headers['x-api-key'] ||
    req.headers['x-api-key'.toLowerCase()] ||
    req.query.apiKey;

  if (!apiKey) {
    if (isAuthRequired) {
      return sendError(res, 401, 'Unauthorised', req.requestId, {
        hint: 'Provide an X-Api-Key header or ?apiKey= query parameter',
      });
    }
    // Auth optional for this route — allow through with default FREE tier
    req.authTier = 'FREE';
    return next();
  }

  const result = validateKey(apiKey);

  if (!result.valid) {
    const extra = result.quotaExceeded ? { quotaExceeded: true } : {};
    return sendError(res, result.status || 403, result.error, req.requestId, extra);
  }

  req.authTier = result.tier;
  req.clientId = result.keyId; // scope rate limits per API key ID
  req.apiKeyRecord = result;

  next();
}

function tierLimits(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.FREE;
}

function tierQuotas(tier) {
  return TIER_QUOTAS[tier] || TIER_QUOTAS.FREE;
}

module.exports = {
  authMiddleware,
  validateKey,
  tierLimits,
  tierQuotas,
  TIER_LIMITS,
  TIER_QUOTAS,
};
