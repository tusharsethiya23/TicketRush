/**
 * Phase 5 against a real Redis: BullMQ queues and workers end to end, and the rate
 * limiter's MULTI (SET NX PX, INCR, PTTL), which ioredis-mock only imitates.
 * Runs when a Redis answers at REDIS_TEST_URL (default redis://127.0.0.1:6379/15);
 * skipped otherwise. Only keys under the test prefixes are touched, never FLUSHALL.
 */
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const express = require('express');
const Redis = require('ioredis');
const request = require('supertest');
const { Queue } = require('bullmq');
const { createApp } = require('../src/app');
const config = require('../src/config/env');
const mailer = require('../src/lib/mailer');
const { getRedis, setRedis, createRedis } = require('../src/lib/redis');
const { rateLimit } = require('../src/middleware/rateLimit');
const { errorHandler } = require('../src/middleware/errorHandler');
const { setQueueFactory, closeQueues, getQueue, QUEUES, JOBS, EMAIL_JOB_OPTIONS } = require('../src/jobs/queues');
const { createWorkers } = require('../src/jobs/workers');
const { Booking, Seat } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUser, createOnSaleEvent } = require('./helpers/factories');

const describeRedis = process.env.REDIS_TEST_AVAILABLE === 'true' ? describe : describe.skip;
const PREFIX = config.QUEUE_PREFIX; // 'trtest' in tests
// A delayed retry can wait for the worker's next poll, so job waits get more time.
const JOB_TIMEOUT_MS = 15_000;

/** Polls until check() is truthy, or fails after timeoutMs. */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

async function deleteKeys(redis, pattern) {
  const found = await redis.keys(pattern);
  if (found.length) await redis.del(...found);
}

describeRedis('real Redis (REDIS_TEST_URL)', () => {
  jest.setTimeout(60_000);
  let server;
  let producer;
  let workerConnection;
  let workers;
  let admin;

  const realQueues = () => setQueueFactory((name) => new Queue(name, { connection: producer, prefix: PREFIX }));

  beforeAll(async () => {
    await connectTestDb();
    admin = new Redis(process.env.REDIS_TEST_URL);
    producer = new Redis(process.env.REDIS_TEST_URL);
    workerConnection = new Redis(process.env.REDIS_TEST_URL, { maxRetriesPerRequest: null });
    await deleteKeys(admin, `${PREFIX}:*`);
    workers = createWorkers(workerConnection, { prefix: PREFIX });
    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, resolve));
  });

  beforeEach(realQueues);

  afterEach(async () => {
    jest.restoreAllMocks();
    await closeQueues();
    await clearTestDb(); // flushes the ioredis-mock only, then installs fake queues
    for (const name of Object.values(QUEUES)) {
      const q = new Queue(name, { connection: producer, prefix: PREFIX });
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(workers.map((w) => w.close()));
    await deleteKeys(admin, `${PREFIX}:*`);
    for (const r of [admin, producer, workerConnection]) r.disconnect();
    await closeTestDb();
  });

  async function holdSeats(user, eventId, seatIds) {
    const res = await request(server)
      .post(`/api/v1/events/${eventId}/holds`)
      .set('Authorization', user.auth)
      .send({ seatIds })
      .expect(201);
    return res.body.hold;
  }

  test('rate limiter: SET NX PX + INCR + PTTL in MULTI works on real Redis (FR-17)', async () => {
    const mock = getRedis();
    const real = createRedis(process.env.REDIS_TEST_URL);
    await new Promise((resolve) => real.once('ready', resolve));
    // Warm up: the API client's 200 ms command timeout can trip on a cold connection
    // while the workers start, and the limiter would then (correctly) fail open.
    await real.ping();
    setRedis(real);
    const warn = jest.spyOn(require('../src/lib/logger'), 'warn');
    try {
      const mini = express();
      mini.get('/x', rateLimit({ name: 'real-redis-test', limit: 3, by: 'ip', enabled: true }), (req, res) =>
        res.json({ ok: true }),
      );
      mini.use(errorHandler);

      for (let i = 2; i >= 0; i--) {
        const ok = await request(mini).get('/x').expect(200);
        expect(warn.mock.calls).toEqual([]); // a fail-open warning here would carry the Redis error
        expect(ok.headers['ratelimit-remaining']).toBe(String(i));
      }
      const limited = await request(mini).get('/x').expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      const [key] = await admin.keys('rl:real-redis-test:*');
      const pttl = await admin.pttl(key);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(60_000);
    } finally {
      setRedis(mock); // never leave the real client in place: clearTestDb flushes getRedis()
      await deleteKeys(admin, 'rl:real-redis-test:*');
      real.disconnect();
    }
  });

  test('a hold schedules a delayed BullMQ job that the worker runs to free the seats (FR-9)', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);

    const queue = getQueue(QUEUES.holds);
    const job = await waitFor(() => queue.getJob(hold.id));
    expect(job.name).toBe(JOBS.releaseHold);
    expect(await job.getState()).toBe('delayed');
    expect(job.opts.delay).toBeGreaterThan((config.HOLD_TTL_SECONDS - 2) * 1000);

    // Fast-forward: the hold is past its expiry, and the job is due now.
    const { Hold } = require('../src/models');
    await Hold.updateOne({ _id: hold.id }, { expiresAt: new Date(Date.now() - 1000) });
    await job.promote();

    await waitFor(async () => (await Seat.findById(seatIds[0]).lean()).status === 'available', JOB_TIMEOUT_MS);
    expect((await Hold.findById(hold.id).lean()).status).toBe('expired');
    await waitFor(async () => !(await queue.getJob(hold.id))); // removed on completion
  });

  test('a confirm removes the delayed job and the worker sends the email', async () => {
    const send = jest.spyOn(mailer, 'send').mockResolvedValue({});
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    await waitFor(() => getQueue(QUEUES.holds).getJob(hold.id));

    const res = await request(server)
      .post(`/api/v1/holds/${hold.id}/confirm`)
      .set('Authorization', fan.auth)
      .set('Idempotency-Key', 'real-redis-confirm')
      .expect(201);

    await waitFor(async () => !(await getQueue(QUEUES.holds).getJob(hold.id)));
    await waitFor(async () => (await Booking.findById(res.body.booking.id).lean()).emailSentAt, JOB_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe(fan.user.email);
  });

  test('a failing email retries with backoff and succeeds on the third try (FR-16)', async () => {
    const send = jest
      .spyOn(mailer, 'send')
      .mockRejectedValueOnce(new Error('SMTP down'))
      .mockRejectedValueOnce(new Error('SMTP down'))
      .mockResolvedValue({});
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const res = await request(server)
      .post(`/api/v1/holds/${hold.id}/confirm`)
      .set('Authorization', fan.auth)
      .set('Idempotency-Key', 'real-redis-retry')
      .expect(201);

    const bookingId = res.body.booking.id;
    await waitFor(async () => (await Booking.findById(bookingId).lean()).emailSentAt, JOB_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('an email that always fails ends in the failed set after 1 try and 3 retries (FR-16)', async () => {
    const send = jest.spyOn(mailer, 'send').mockRejectedValue(new Error('SMTP down'));
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const res = await request(server)
      .post(`/api/v1/holds/${hold.id}/confirm`)
      .set('Authorization', fan.auth)
      .set('Idempotency-Key', 'real-redis-fail')
      .expect(201);

    const queue = getQueue(QUEUES.emails);
    const job = await waitFor(() => queue.getJob(`booking-email-${res.body.booking.id}`));
    await waitFor(async () => (await job.getState()) === 'failed', JOB_TIMEOUT_MS);
    const failed = await queue.getJob(job.id);
    expect(failed.failedReason).toBe('SMTP down');
    expect(send).toHaveBeenCalledTimes(EMAIL_JOB_OPTIONS.attempts); // 1 try + 3 retries
    expect(await queue.getFailedCount()).toBe(1); // kept for inspection (removeOnFail: false)
    expect((await Booking.findById(res.body.booking.id).lean()).emailSentAt).toBeNull();
  });
});
