const config = require('./config/env');
const logger = require('./lib/logger');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { getRedis, closeRedis } = require('./lib/redis');
const { createApp } = require('./app');

async function main() {
  await connectMongo();
  logger.info('Connected to MongoDB');

  // Not awaited: the API starts and stays correct without Redis (NFR-5); it reconnects in the background.
  getRedis();

  const server = createApp().listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), closeRedis()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
