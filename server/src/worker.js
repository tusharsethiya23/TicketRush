const Redis = require('ioredis');
const config = require('./config/env');
const logger = require('./lib/logger');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { getRedis, closeRedis } = require('./lib/redis');
const { createWorkers, startSweep } = require('./jobs/workers');

/**
 * The background worker process (SRS 3): release-hold and email jobs from BullMQ,
 * plus the sweep. Run it next to the API with `npm run worker`.
 */
async function main() {
  await connectMongo();
  logger.info('Worker connected to MongoDB');
  getRedis(); // for cache invalidation when the sweep reopens an event

  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ workers
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  let down = false;
  connection.on('ready', () => {
    down = false;
    logger.info('Worker connected to Redis');
  });
  connection.on('error', (err) => {
    if (!down) logger.warn({ err: err.message }, 'Worker lost Redis; the sweep keeps releasing holds');
    down = true;
  });

  const workers = createWorkers(connection);
  const stopSweep = startSweep();
  logger.info({ sweepEverySeconds: config.SWEEP_INTERVAL_SECONDS }, 'Worker started');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Worker shutting down');
    setTimeout(() => process.exit(1), 15_000).unref();
    await stopSweep();
    await Promise.allSettled(workers.map((w) => w.close()));
    connection.disconnect();
    await Promise.allSettled([disconnectMongo(), closeRedis()]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
