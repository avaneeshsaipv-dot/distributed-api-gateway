const redis = require('../redisClient');

/**
 * LEAKY BUCKET
 * Requests fill a queue (bucket) of fixed capacity. The bucket "leaks"
 * at a constant `leakRate` requests/second, smoothing bursts into a
 * steady outflow — useful when the downstream service needs a
 * predictable, non-bursty request rate rather than just a cap.
 */
const LUA_LEAKY_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local leakRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'level', 'timestamp')
local level = tonumber(bucket[1])
local timestamp = tonumber(bucket[2])

if level == nil then
  level = 0
  timestamp = now
end

-- leak based on elapsed time
local elapsed = math.max(0, now - timestamp)
level = math.max(0, level - (elapsed * leakRate))

-- IMPORTANT: check level + 1 <= capacity, not level < capacity.
-- After floating-point leak, level can be e.g. 2.9999 instead of 3.0.
-- "level < capacity" would allow a 4th request into a capacity-3 bucket,
-- pushing level to 3.9999 (an overflow).  The correct predicate is whether
-- the bucket still has room for one more whole unit.
local allowed = 0
if level + 1 <= capacity then
  level = level + 1
  allowed = 1
end

redis.call('HMSET', key, 'level', level, 'timestamp', now)
redis.call('EXPIRE', key, 60)

return { allowed, level }
`;

/**
 * @param {string} clientId
 * @param {object} opts  { capacity, leakRate }
 */
async function checkLeakyBucket(clientId, opts = {}) {
  const capacity = opts.capacity || 10;
  const leakRate = opts.leakRate || 2; // requests drained per second
  const key = `rl:lb:${clientId}`;
  const now = Date.now() / 1000;

  const [allowed, level] = await redis.eval(
    LUA_LEAKY_BUCKET,
    1,
    key,
    capacity,
    leakRate,
    now
  );

  return {
    allowed: allowed === 1,
    queueLevel: Math.round(level * 100) / 100,
    algorithm: 'leaky-bucket',
  };
}

module.exports = { checkLeakyBucket };
