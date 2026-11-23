const { Queue } = require('bullmq');
const Redis = require('ioredis');
const config = require('../config/env');
const logger = require('../lib/logger');

/**
 * Producer side of the job queues, used by the API. Adding or removing a job is best
 * effort: it never fails or slows a request (NFR-5). If Redis is down, the sweep in
 * the worker still releases expired holds, and only the email is lost.
 */
const QUEUES = { holds: 'holds', emails: 'emails' };
const JOBS = { releaseHold: 'release-hold', bookingEmail: 'booking-email' };

const ENQUEUE_TIMEOUT_MS = 1000;
/** The release job runs a little after expiresAt, because the release requires expiresAt <= now. */
const RELEASE_SLACK_MS = 500;

/** FR-16: 1 try plus 3 retries; failed jobs stay in the failed set for inspection. */
const EMAIL_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: false,
};

let connection = null;
const queues = new Map();

function defaultFactory(name) {
  if (config.NODE_ENV === 'test') throw new Error('Tests must install a queue factory');
  connection ??= new Redis(config.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  connection.on('error', () => {}); // the API's own Redis client already logs outages
  return new Queue(name, { connection, prefix: config.QUEUE_PREFIX });
}

let factory = defaultFactory;

function getQueue(name) {
  if (!queues.has(name)) {
    const queue = factory(name);
    queue.on?.('error', (err) => logger.debug({ err: err.message, queue: name }, 'Queue error'));
    queues.set(name, queue);
  }
  return queues.get(name);
}

/** Tests install an in-memory queue, or real BullMQ queues on a test Redis. */
function setQueueFactory(fn) {
  queues.clear();
  factory = fn ?? defaultFactory;
}

async function closeQueues() {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}

async function safely(what, work) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ENQUEUE_TIMEOUT_MS} ms`)), ENQUEUE_TIMEOUT_MS);
    });
    await Promise.race([Promise.resolve().then(work), timeout]);
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, `${what} failed`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** All three resolve to true or false and never throw, so callers do not await them. */
const jobs = {
  /** SRS 6.1 step 5: jobId = holdId, so a hold has at most one release job. */
  scheduleHoldRelease: (holdId, expiresAt) =>
    safely('Scheduling the hold release', () =>
      getQueue(QUEUES.holds).add(
        JOBS.releaseHold,
        { holdId: String(holdId) },
        {
          jobId: String(holdId),
          delay: Math.max(0, new Date(expiresAt).getTime() - Date.now()) + RELEASE_SLACK_MS,
          removeOnComplete: true,
          removeOnFail: { age: 24 * 60 * 60 },
        },
      ),
    ),

  /** After a confirm or an early release. If this fails, the job runs and does nothing. */
  cancelHoldRelease: (holdId) =>
    safely('Removing the hold release job', () => getQueue(QUEUES.holds).remove(String(holdId))),

  /** FR-15: one email job per booking. */
  enqueueBookingEmail: (bookingId) =>
    safely('Queueing the booking email', () =>
      getQueue(QUEUES.emails).add(
        JOBS.bookingEmail,
        { bookingId: String(bookingId) },
        { jobId: `booking-email-${bookingId}`, ...EMAIL_JOB_OPTIONS },
      ),
    ),
};

module.exports = { jobs, getQueue, setQueueFactory, closeQueues, QUEUES, JOBS, EMAIL_JOB_OPTIONS, RELEASE_SLACK_MS };
