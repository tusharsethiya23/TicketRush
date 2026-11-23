const { MongoMemoryReplSet } = require('mongodb-memory-server');

/** One in-memory replica set for the whole run; transactions need a replica set. */
module.exports = async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.MONGO_URI = replSet.getUri();
};
