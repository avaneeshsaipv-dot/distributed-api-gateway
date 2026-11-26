const redis = require('../redisClient');

/**
 * SLIDING WINDOW LOG
 * Stores a timestamp per request in a Redis sorted set (score = timestamp).
 * On each request: drop entries older than the window, count what's left,
 * and allow only if under the limit. More accurate than fixed windows
 * (no burst at window boundaries) at the cost of more memory.
 */
const LUA_SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

local windowStart = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
local count = redis.call('ZCARD', key)

local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, now .. '-' .. math.random())
  allowed = 1
  count = count + 1
end

redis.call('PEXPIRE', key, windowMs)
return { allowed, count }
`;

/**
 * @param {string} clientId
 * @param {object} opts  { windowMs, limit }
 */
async function checkSlidingWindow(clientId, opts = {}) {
  const windowMs = opts.windowMs || 10000; // 10s window
  const limit = opts.limit || 15; // max requests per window
  const key = `rl:sw:${clientId}`;
  const now = Date.now();

  const [allowed, count] = await redis.eval(
    LUA_SLIDING_WINDOW,
    1,
    key,
    now,
    windowMs,
    limit
  );

  return {
    allowed: allowed === 1,
    remaining: Math.max(0, limit - count),
    algorithm: 'sliding-window',
  };
}

module.exports = { checkSlidingWindow };
