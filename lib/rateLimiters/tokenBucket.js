const redis = require('../redisClient');

/**
 * TOKEN BUCKET
 * A bucket holds up to `capacity` tokens and refills at `refillRate`
 * tokens/second. Each request consumes 1 token. If no tokens are
 * available, the request is throttled.
 *
 * Implemented as a single atomic Lua script so multiple gateway
 * instances hitting the same Redis never race on read-modify-write.
 */
const LUA_TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens = tonumber(bucket[1])
local timestamp = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  timestamp = now
end

-- refill based on elapsed time
local elapsed = math.max(0, now - timestamp)
tokens = math.min(capacity, tokens + (elapsed * refillRate))

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'timestamp', now)
redis.call('EXPIRE', key, 60)

return { allowed, tokens }
`;

/**
 * @param {string} clientId  identifier to bucket on (IP, API key, etc.)
 * @param {object} opts      { capacity, refillRate }
 */
async function checkTokenBucket(clientId, opts = {}) {
  const capacity = opts.capacity || 20;
  const refillRate = opts.refillRate || 5; // tokens per second
  const key = `rl:tb:${clientId}`;
  const now = Date.now() / 1000;

  const [allowed, remaining] = await redis.eval(
    LUA_TOKEN_BUCKET,
    1,
    key,
    capacity,
    refillRate,
    now
  );

  return {
    allowed: allowed === 1,
    remaining: Math.floor(remaining),
    algorithm: 'token-bucket',
  };
}

module.exports = { checkTokenBucket };
