const Redis = require('ioredis');

// Single shared connection. In a real multi-instance deployment,
// every gateway process points at the SAME Redis host so rate-limit
// state (tokens, window counts, queue depth) is consistent across
// all instances instead of being per-process.
const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});

module.exports = redis;
