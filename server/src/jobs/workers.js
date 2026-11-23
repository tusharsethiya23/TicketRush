const { Worker } = require('bullmq');
const config = require('../config/env');
const logger = require('../lib/logger');
const { QUEUES } = require('./queues');
const { processReleaseHold, processBookingEmail, sweepExpiredHolds, emailBackoff } = require('./processors');

/**
 * Consumers for both queues. `connection` must be an ioredis client with
 * maxRetriesPerRequest: null, as BullMQ workers require.
 */
function createWorkers(connection, { prefix = config.QUEUE_PREFIX } = {}) {
  const holds = new Worker(QUEUES.holds, processReleaseHold, { connection, prefix, concurrency: 20 });
  const emails = new Worker(QUEUES.emails, processBookingEmail, {
    connection,
    prefix,
    concurrency: 5,
    settings: { backoffStrategy: (attemptsMade) => emailBackoff(attemptsMade) },
  });

  for (const worker of [holds, emails]) {
    worker.on('failed', (job, err) =>
      logger.warn(
        { queue: worker.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
        'Job failed',
      ),
    );
    worker.on('error', (err) => logger.debug({ queue: worker.name, err: err.message }, 'Worker error'));
  }
  return [holds, emails];
}

/**
 * Runs the sweep now and then every SWEEP_INTERVAL_SECONDS. It uses only MongoDB, so it
 * keeps releasing holds while Redis is down. Runs never overlap.
 * @returns a function that stops the sweep and waits for a running one to finish
 */
function startSweep(intervalMs = config.SWEEP_INTERVAL_SECONDS * 1000) {
  let running = null;
  const tick = () => {
    if (running) return;
    running = sweepExpiredHolds()
      .then((r) => {
        if (r.found || r.reopened) logger.info(r, 'Sweep finished');
      })
      .catch((err) => logger.error({ err }, 'Sweep failed'))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearInterval(timer);
    await running;
  };
}

module.exports = { createWorkers, startSweep };
