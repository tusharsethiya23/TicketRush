const mongoose = require('mongoose');
const RedisMock = require('ioredis-mock');
const { connectMongo } = require('../../src/db/mongo');
const { setRedis, getRedis } = require('../../src/lib/redis');

/**
 * Each test file gets its own database so files can never see each other's data,
 * and an in-memory Redis (ioredis-mock) in place of a real one.
 */
async function connectTestDb() {
  const dbName = `ticketrush_test_${process.env.JEST_WORKER_ID}_${Date.now()}`;
  await connectMongo(process.env.MONGO_URI, { dbName });
  setRedis(new RedisMock());
}

async function clearTestDb() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await getRedis().flushall();
}

async function closeTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  getRedis().disconnect();
  setRedis(null);
}

/** A Redis client whose every command fails, as when Redis is down (NFR-5). */
function brokenRedis() {
  const fail = () => Promise.reject(new Error('Connection is closed.'));
  const multi = new Proxy({}, { get: (_, prop) => (prop === 'exec' ? fail : () => multi) });
  return new Proxy(
    {},
    { get: (_, prop) => (prop === 'multi' ? () => multi : prop === 'then' ? undefined : fail) },
  );
}

module.exports = { connectTestDb, clearTestDb, closeTestDb, brokenRedis };
