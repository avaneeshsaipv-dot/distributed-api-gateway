'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'gateway-store.json');
const MAX_AUDIT_LOG_ITEMS = 250;

class Store {
  constructor() {
    this.data = {
      apiKeys: [],
      routes: [],
      auditLog: [],
      quotas: {}, // { [keyId]: { "YYYY-MM": count } }
      settings: {
        lbStrategy: process.env.LB_STRATEGY || 'round-robin',
        defaultAlgo: 'token-bucket',
        globalAuthEnabled: process.env.AUTH_ENABLED === 'true',
        proxyTimeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS, 10) || 10000,
        healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 10000,
        cbFailureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5,
        cbRecoveryTimeoutMs: parseInt(process.env.CB_RECOVERY_TIMEOUT_MS, 10) || 30000,
      },
    };

    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(STORE_PATH)) {
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
          ...this.data,
          ...parsed,
          settings: { ...this.data.settings, ...(parsed.settings || {}) },
        };
      } else {
        this._seedDefaults();
        this.save();
      }
    } catch (err) {
      console.warn('[store] Failed to load store from disk, using defaults:', err.message);
      this._seedDefaults();
    }
  }

  _seedDefaults() {
    // Default routes
    this.data.routes = [
      {
        id: 'route_ping',
        name: 'Ping Health Check',
        path: '/api/ping',
        methods: ['GET'],
        targetBackend: 'load-balanced',
        authRequired: false,
        rateLimitPolicy: 'tier-default',
        timeoutMs: 10000,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'route_users',
        name: 'User Service API',
        path: '/api/users/*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        targetBackend: 'load-balanced',
        authRequired: true,
        rateLimitPolicy: 'tier-default',
        timeoutMs: 10000,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'route_orders',
        name: 'Orders Service API',
        path: '/api/orders/*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        targetBackend: 'load-balanced',
        authRequired: true,
        rateLimitPolicy: 'tier-default',
        timeoutMs: 10000,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'route_wildcard',
        name: 'Default Wildcard Proxy',
        path: '/api/*',
        methods: ['*'],
        targetBackend: 'load-balanced',
        authRequired: false,
        rateLimitPolicy: 'tier-default',
        timeoutMs: 10000,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];

    // Audit seed
    this.data.auditLog = [
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        action: 'SYSTEM_INITIALIZED',
        resource: 'gateway',
        details: { message: 'Gateway management store initialized with default configuration' },
        user: 'system',
      },
    ];
  }

  save() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(STORE_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] Error saving store to disk:', err.message);
    }
  }

  // ── Audit Log ───────────────────────────────────────────────────────────────

  recordAudit(action, resource, details = {}, user = 'admin') {
    const item = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      resource,
      details,
      user,
    };
    this.data.auditLog.unshift(item);
    if (this.data.auditLog.length > MAX_AUDIT_LOG_ITEMS) {
      this.data.auditLog.length = MAX_AUDIT_LOG_ITEMS;
    }
    this.save();
    return item;
  }

  getAuditLog(limit = 100) {
    return this.data.auditLog.slice(0, limit);
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  getSettings() {
    return { ...this.data.settings };
  }

  updateSettings(partial = {}) {
    this.data.settings = {
      ...this.data.settings,
      ...partial,
    };
    this.recordAudit('SETTINGS_UPDATED', 'settings', partial);
    this.save();
    return this.getSettings();
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  getRoutes() {
    return [...this.data.routes];
  }

  getRoute(id) {
    return this.data.routes.find(r => r.id === id) || null;
  }

  saveRoute(route) {
    const existingIdx = this.data.routes.findIndex(r => r.id === route.id);
    if (existingIdx >= 0) {
      this.data.routes[existingIdx] = {
        ...this.data.routes[existingIdx],
        ...route,
        updatedAt: new Date().toISOString(),
      };
      this.recordAudit('ROUTE_UPDATED', route.path || route.id, { id: route.id, name: route.name });
      this.save();
      return this.data.routes[existingIdx];
    } else {
      const newRoute = {
        id: route.id || `route_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: route.name || 'API Route',
        path: route.path,
        methods: Array.isArray(route.methods) && route.methods.length > 0 ? route.methods : ['*'],
        targetBackend: route.targetBackend || 'load-balanced',
        authRequired: Boolean(route.authRequired),
        rateLimitPolicy: route.rateLimitPolicy || 'tier-default',
        timeoutMs: parseInt(route.timeoutMs, 10) || 10000,
        enabled: route.enabled !== false,
        createdAt: new Date().toISOString(),
      };
      this.data.routes.push(newRoute);
      this.recordAudit('ROUTE_CREATED', newRoute.path, { id: newRoute.id, name: newRoute.name });
      this.save();
      return newRoute;
    }
  }

  deleteRoute(id) {
    const idx = this.data.routes.findIndex(r => r.id === id);
    if (idx >= 0) {
      const removed = this.data.routes.splice(idx, 1)[0];
      this.recordAudit('ROUTE_DELETED', removed.path, { id: removed.id, name: removed.name });
      this.save();
      return true;
    }
    return false;
  }

  // ── API Keys ────────────────────────────────────────────────────────────────

  getKeys() {
    return this.data.apiKeys.map(k => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      maskedKey: k.maskedKey,
      tier: k.tier,
      enabled: k.enabled,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      stats: k.stats || { total: 0, successful: 0, throttled: 0, failed: 0 },
    }));
  }

  getKeyRecord(id) {
    return this.data.apiKeys.find(k => k.id === id) || null;
  }

  findKeyByHash(hash) {
    return this.data.apiKeys.find(k => k.keyHash === hash) || null;
  }

  createKeyRecord({ name, tier = 'FREE' }) {
    const rawSecret = `gw_live_${crypto.randomBytes(20).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawSecret).digest('hex');
    const keyPrefix = rawSecret.slice(0, 8);
    const maskedKey = `${keyPrefix}***${rawSecret.slice(-4)}`;

    const keyRecord = {
      id: crypto.randomUUID(),
      name: name || 'Untitled API Key',
      keyPrefix,
      maskedKey,
      keyHash,
      tier: ['FREE', 'PRO', 'PREMIUM'].includes(tier.toUpperCase()) ? tier.toUpperCase() : 'FREE',
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      stats: { total: 0, successful: 0, throttled: 0, failed: 0 },
    };

    this.data.apiKeys.push(keyRecord);
    this.recordAudit('API_KEY_CREATED', keyRecord.name, {
      id: keyRecord.id,
      tier: keyRecord.tier,
      maskedKey: keyRecord.maskedKey,
    });
    this.save();

    return {
      record: {
        id: keyRecord.id,
        name: keyRecord.name,
        maskedKey: keyRecord.maskedKey,
        tier: keyRecord.tier,
        enabled: keyRecord.enabled,
        createdAt: keyRecord.createdAt,
      },
      secret: rawSecret, // RETURNED ONLY ONCE
    };
  }

  setKeyEnabled(id, enabled) {
    const record = this.data.apiKeys.find(k => k.id === id);
    if (!record) return null;
    record.enabled = Boolean(enabled);
    this.recordAudit('API_KEY_STATUS_CHANGED', record.name, {
      id: record.id,
      enabled: record.enabled,
    });
    this.save();
    return record;
  }

  deleteKey(id) {
    const idx = this.data.apiKeys.findIndex(k => k.id === id);
    if (idx >= 0) {
      const removed = this.data.apiKeys.splice(idx, 1)[0];
      this.recordAudit('API_KEY_REVOKED', removed.name, {
        id: removed.id,
        maskedKey: removed.maskedKey,
      });
      this.save();
      return true;
    }
    return false;
  }

  recordKeyActivity(id, status) {
    const record = this.data.apiKeys.find(k => k.id === id);
    if (!record) return;

    record.lastUsedAt = new Date().toISOString();
    if (!record.stats) {
      record.stats = { total: 0, successful: 0, throttled: 0, failed: 0 };
    }
    record.stats.total++;
    if (status >= 200 && status < 400) {
      record.stats.successful++;
    } else if (status === 429) {
      record.stats.throttled++;
    } else if (status >= 400) {
      record.stats.failed++;
    }
    // Periodic save or defer to avoid disk churn
    this._scheduleSave();
  }

  // ── Monthly Quotas ──────────────────────────────────────────────────────────

  getMonthlyQuotaUsage(keyId, yearMonth = null) {
    const ym = yearMonth || new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    return this.data.quotas[keyId]?.[ym] || 0;
  }

  incrementMonthlyQuota(keyId, yearMonth = null) {
    const ym = yearMonth || new Date().toISOString().slice(0, 7);
    if (!this.data.quotas[keyId]) {
      this.data.quotas[keyId] = {};
    }
    this.data.quotas[keyId][ym] = (this.data.quotas[keyId][ym] || 0) + 1;
    this._scheduleSave();
    return this.data.quotas[keyId][ym];
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 1000);
    this._saveTimer.unref();
  }
}

// Export singleton
module.exports = new Store();
