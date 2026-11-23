const Redis = require('ioredis');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

/** True if a real Redis answers at `url`; tests/worker.redis.test.js runs only then. */
async function redisAnswers(url) {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 500, maxRetriesPerRequest: 0, retryStrategy: null });
  redis.on('error', () => {});
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

/** One in-memory replica set for the whole run; transactions need a replica set. */
module.exports = async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.MONGO_URI = replSet.getUri();

  // Database 15 by default, so test keys never mix with local development data.
  process.env.REDIS_TEST_URL ??= 'redis://127.0.0.1:6379/15';
  process.env.REDIS_TEST_AVAILABLE = (await redisAnswers(process.env.REDIS_TEST_URL)) ? 'true' : 'false';
};
