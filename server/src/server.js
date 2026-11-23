const config = require('./config/env');
const logger = require('./lib/logger');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { createApp } = require('./app');

async function main() {
  await connectMongo();
  logger.info('Connected to MongoDB');

  const server = createApp().listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await disconnectMongo();
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
