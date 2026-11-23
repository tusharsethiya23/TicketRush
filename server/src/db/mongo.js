const mongoose = require('mongoose');
const config = require('../config/env');
const models = require('../models');

mongoose.set('strictQuery', true);

/**
 * Creates every collection and syncs its indexes up front. Transactions in phase 2 need
 * the collections to exist, and the race tests need the unique indexes in place.
 */
async function ensureIndexes() {
  for (const model of Object.values(models)) {
    await model.createCollection();
    await model.syncIndexes();
  }
}

/** `syncIndexes: false` for cluster workers: the primary process has already done it. */
async function connectMongo(uri = config.MONGO_URI, options = {}, { syncIndexes = true } = {}) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false, ...options });
  if (syncIndexes) await ensureIndexes();
  return mongoose.connection;
}

async function disconnectMongo() {
  await mongoose.disconnect();
}

/** True when MongoDB answers a ping (FR-19). */
async function pingMongo() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = { connectMongo, disconnectMongo, ensureIndexes, pingMongo };
