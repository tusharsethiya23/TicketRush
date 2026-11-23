const logger = require('./logger');
const { getRedis } = require('./redis');

/**
 * Read-through JSON cache (NFR-3). Any Redis failure falls back to the loader, so a
 * Redis outage makes reads slower but never fails them (NFR-5).
 * The loader's result is cached only if it returns; a thrown 404 is not cached.
 */
async function cached(key, ttlSeconds, loader) {
  const redis = getRedis();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit);
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Cache read failed; using MongoDB');
  }

  const value = await loader();

  redis.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch((err) => {
    logger.warn({ err: err.message, key }, 'Cache write failed');
  });
  return value;
}

/** Best effort: a stale entry expires on its own TTL anyway. */
async function invalidate(...keys) {
  try {
    await getRedis().del(...keys);
  } catch (err) {
    logger.warn({ err: err.message, keys }, 'Cache invalidation failed');
  }
}

const keys = {
  event: (eventId) => `event:${eventId}`,
  seatMap: (eventId) => `seatmap:${eventId}`,
  failedHolds: (eventId) => `stats:failedHolds:${eventId}`,
};

const TTL = { event: 60, seatMap: 2, stats: 7 * 24 * 60 * 60 };

module.exports = { cached, invalidate, keys, TTL };
