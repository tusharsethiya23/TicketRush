const cluster = require('node:cluster');
const config = require('./config/env');
const logger = require('./lib/logger');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { getRedis, closeRedis } = require('./lib/redis');
const { createApp } = require('./app');
const { closeQueues } = require('./jobs/queues');

/** One API process: Express on PORT. */
async function serve({ syncIndexes }) {
  await connectMongo(undefined, {}, { syncIndexes });
  logger.info('Connected to MongoDB');

  // Not awaited: the API starts and stays correct without Redis (NFR-5); it reconnects in the background.
  getRedis();

  // Node's default backlog (511) refuses connections when a flash sale opens and 1,000
  // fans connect in the same instant; the OS still caps this at its own limit (somaxconn).
  const server = createApp().listen({ port: config.PORT, backlog: 4096 }, () => {
    logger.info({ port: config.PORT, pid: process.pid }, 'API listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), closeRedis(), closeQueues()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * WEB_CONCURRENCY > 1: the primary syncs indexes once, then forks that many API processes
 * sharing PORT, and replaces any that crash. Correctness never depends on which process
 * serves a request: MongoDB decides every seat, and limits and caches live in Redis.
 */
async function primary(workers) {
  await connectMongo();
  await disconnectMongo();
  logger.info({ workers }, 'Indexes ready; starting API processes');

  let stopping = false;
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      if (Object.keys(cluster.workers).length === 0) process.exit(0);
      return;
    }
    logger.error({ pid: worker.process.pid, code, signal }, 'API process died; starting a new one');
    cluster.fork();
  });

  const shutdown = (signal) => {
    stopping = true;
    logger.info({ signal }, 'Shutting down API processes');
    for (const worker of Object.values(cluster.workers)) worker.process.kill('SIGTERM');
    setTimeout(() => process.exit(1), 12_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const start =
  config.WEB_CONCURRENCY > 1 && cluster.isPrimary
    ? primary(config.WEB_CONCURRENCY)
    : serve({ syncIndexes: cluster.isPrimary });

start.catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
