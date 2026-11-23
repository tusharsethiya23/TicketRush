const mongoose = require('mongoose');
const { connectMongo } = require('../../src/db/mongo');

/** Each test file gets its own database so files can never see each other's data. */
async function connectTestDb() {
  const dbName = `ticketrush_test_${process.env.JEST_WORKER_ID}_${Date.now()}`;
  await connectMongo(process.env.MONGO_URI, { dbName });
}

async function clearTestDb() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

async function closeTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

module.exports = { connectTestDb, clearTestDb, closeTestDb };
