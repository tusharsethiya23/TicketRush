const Redis = require('ioredis');
const config = require('../config/env');
const logger = require('./logger');

/**
 * The API's Redis client, for cache, rate limits and counters only. MongoDB is the
 * source of truth, so every caller must survive Redis being down (NFR-5).
 *
 * Options make a broken Redis fail fast instead of stalling requests:
 * - enableOfflineQueue false: commands fail at once while disconnected, not queued
 * - maxRetriesPerRequest 1 and commandTimeout: a slow Redis costs at most ~200 ms
 * BullMQ (phase 5) needs different options and gets its own connections.
 */
let client = null;

function createRedis(url = config.REDIS_URL) {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 200,
    retryStrategy: (times) => Math.min(times * 200, 2000), // keep reconnecting
  });
  // ioredis emits 'error' on every failed reconnect; warn once per outage.
  let down = false;
  redis.on('ready', () => {
    down = false;
    logger.info('Connected to Redis');
  });
  redis.on('error', (err) => {
    if (!down) logger.warn({ err: err.message }, 'Redis unavailable; running without cache and rate limits');
    down = true;
  });
  return redis;
}

function getRedis() {
  client ??= createRedis();
  return client;
}

/** Tests swap in ioredis-mock or a broken client. */
function setRedis(redis) {
  client = redis;
}

async function closeRedis() {
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
  client = null;
}

/** True when Redis answers a ping (FR-19). */
async function pingRedis() {
  try {
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

module.exports = { getRedis, setRedis, closeRedis, pingRedis, createRedis };
