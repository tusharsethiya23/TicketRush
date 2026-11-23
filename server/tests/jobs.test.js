/**
 * Phase 5 with an in-memory queue: release-hold jobs and the sweep (FR-9, NFR-6),
 * the confirm vs expiry race (SRS 9), the email job (FR-15, FR-16), and enqueue
 * failures never failing a request (NFR-5). tests/worker.redis.test.js runs real BullMQ.
 */
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const request = require('supertest');
const { createApp } = require('../src/app');
const config = require('../src/config/env');
const payments = require('../src/lib/payments');
const mailer = require('../src/lib/mailer');
const { getQueue, setQueueFactory, QUEUES, JOBS, RELEASE_SLACK_MS } = require('../src/jobs/queues');
const {
  processReleaseHold,
  sweepExpiredHolds,
  processBookingEmail,
  emailBackoff,
} = require('../src/jobs/processors');
const { startSweep } = require('../src/jobs/workers');
const { Booking, Event, Hold, Payment, Seat } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUser, createUsers, createOnSaleEvent } = require('./helpers/factories');

let server;

beforeAll(async () => {
  await connectTestDb();
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeTestDb();
});

let keyCounter = 0;
const newKey = () => `jobs-key-${++keyCounter}`;

async function holdSeats(user, eventId, seatIds) {
  const res = await request(server)
    .post(`/api/v1/events/${eventId}/holds`)
    .set('Authorization', user.auth)
    .send({ seatIds })
    .expect(201);
  return res.body.hold;
}

const confirm = (user, holdId, key = newKey()) =>
  request(server).post(`/api/v1/holds/${holdId}/confirm`).set('Authorization', user.auth).set('Idempotency-Key', key);

const expireHold = (holdId, msAgo = 1000) =>
  Hold.updateOne({ _id: holdId }, { expiresAt: new Date(Date.now() - msAgo) });

/** Lets fire-and-forget enqueue calls settle. */
const settle = () => new Promise((r) => setImmediate(r));

describe('release-hold jobs are scheduled and removed (SRS 6.1 step 5, 6.2 step 6)', () => {
  test('a new hold schedules release-hold with jobId = holdId, due just after expiresAt', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    await settle();

    const job = getQueue(QUEUES.holds).jobs.get(hold.id);
    expect(job).toMatchObject({ name: JOBS.releaseHold, data: { holdId: hold.id } });
    const ttlMs = config.HOLD_TTL_SECONDS * 1000;
    expect(job.opts.delay).toBeGreaterThan(ttlMs - 2000);
    expect(job.opts.delay).toBeLessThanOrEqual(ttlMs + RELEASE_SLACK_MS);
  });

  test('an early release removes the job', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    await request(server).delete(`/api/v1/holds/${hold.id}`).set('Authorization', fan.auth).expect(204);
    await settle();
    expect(getQueue(QUEUES.holds).jobs.has(hold.id)).toBe(false);
  });

  test('a confirm removes the release job and queues one email job with 3 retries', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const { booking } = (await confirm(fan, hold.id).expect(201)).body;
    await settle();

    expect(getQueue(QUEUES.holds).jobs.has(hold.id)).toBe(false);
    const email = getQueue(QUEUES.emails).jobs.get(`booking-email-${booking.id}`);
    expect(email).toMatchObject({ name: JOBS.bookingEmail, data: { bookingId: booking.id } });
    expect(email.opts).toMatchObject({ attempts: 4, backoff: { type: 'custom' }, removeOnFail: false });
  });
});

describe('a broken queue never fails a request (NFR-5)', () => {
  test('enqueue errors: hold, release and confirm all still succeed', async () => {
    setQueueFactory(() => ({
      add: () => Promise.reject(new Error('Connection is closed.')),
      remove: () => Promise.reject(new Error('Connection is closed.')),
      close: async () => {},
    }));
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();

    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    await confirm(fan, hold.id).expect(201);
    const other = await holdSeats(fan, event.id, [seatIds[1]]);
    await request(server).delete(`/api/v1/holds/${other.id}`).set('Authorization', fan.auth).expect(204);
  });

  test('a queue that hangs does not slow a request down', async () => {
    setQueueFactory(() => ({ add: () => new Promise(() => {}), remove: () => new Promise(() => {}), close: async () => {} }));
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();

    const start = Date.now();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    await confirm(fan, hold.id).expect(201);
    expect(Date.now() - start).toBeLessThan(900); // under the 1 s enqueue timeout
  });
});

describe('release-hold job (FR-9)', () => {
  test('releases an expired hold: seats back to available', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, seatIds.slice(0, 2));
    await expireHold(hold.id);

    await expect(processReleaseHold({ data: { holdId: hold.id } })).resolves.toEqual({ released: true });
    expect((await Hold.findById(hold.id).lean()).status).toBe('expired');
    const seats = await Seat.find({ _id: { $in: seatIds.slice(0, 2) } }).lean();
    expect(seats.every((s) => s.status === 'available' && s.holdId === null)).toBe(true);
  });

  test('does nothing to a hold that is not yet expired, or already converted', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const live = await holdSeats(fan, event.id, [seatIds[0]]);
    await expect(processReleaseHold({ data: { holdId: live.id } })).resolves.toEqual({ released: false });
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('held');

    await confirm(fan, live.id).expect(201);
    await expireHold(live.id);
    await expect(processReleaseHold({ data: { holdId: live.id } })).resolves.toEqual({ released: false });
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('booked');
  });
});

describe('sweep (NFR-6)', () => {
  test('SRS 9 expiry test: expired holds are released and the seat can be held again; a second run is a no-op', async () => {
    const [a, b, c] = await createUsers(3);
    const { event, seatIds } = await createOnSaleEvent();
    const h1 = await holdSeats(a, event.id, [seatIds[0]]);
    const h2 = await holdSeats(b, event.id, [seatIds[1], seatIds[2]]);
    const live = await holdSeats(c, event.id, [seatIds[3]]);
    await expireHold(h1.id);
    await expireHold(h2.id);

    await expect(sweepExpiredHolds()).resolves.toEqual({ found: 2, released: 2, reopened: 0 });
    expect(await Seat.countDocuments({ status: 'available' })).toBe(seatIds.length - 1);
    expect((await Hold.findById(live.id).lean()).status).toBe('active');

    await holdSeats(c, event.id, [seatIds[0]]); // the freed seat can be held again
    await expect(sweepExpiredHolds()).resolves.toEqual({ found: 0, released: 0, reopened: 0 });
  });

  test('works in batches', async () => {
    const users = await createUsers(3);
    const { event, seatIds } = await createOnSaleEvent();
    for (const [i, u] of users.entries()) await expireHold((await holdSeats(u, event.id, [seatIds[i]])).id);

    await expect(sweepExpiredHolds({ batchSize: 2 })).resolves.toMatchObject({ found: 2, released: 2 });
    await expect(sweepExpiredHolds({ batchSize: 2 })).resolves.toMatchObject({ found: 1, released: 1 });
  });

  test('puts a sold_out event with a free seat back on sale (FR-28 repair)', async () => {
    const { event } = await createOnSaleEvent();
    await Event.updateOne({ _id: event.id }, { status: 'sold_out', soldOutAt: new Date() });

    await expect(sweepExpiredHolds()).resolves.toMatchObject({ reopened: 1 });
    const reopened = await Event.findById(event.id).lean();
    expect(reopened.status).toBe('on_sale');
    expect(reopened.soldOutAt).toBeInstanceOf(Date);
  });

  test('startSweep runs at once, and stopping waits for the running sweep', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    await expireHold((await holdSeats(fan, event.id, [seatIds[0]])).id);

    const stop = startSweep(60_000);
    await stop();
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('available');
  });
});

describe('SRS 9: confirm vs expiry race', () => {
  test('every round ends in exactly one outcome: booked, or 410 with the seat free and the payment refunded', async () => {
    const outcomes = { booked: 0, expired: 0 };

    for (let round = 0; round < 12; round++) {
      const fan = await createUser();
      const { event, seatIds } = await createOnSaleEvent({ seats: { seatsPerRow: 1 } });
      const [seatId] = seatIds;
      const hold = await holdSeats(fan, event.id, [seatId]);

      // The hold expires 150 ms from now. Payment is fast (books), slow (paid after expiry,
      // so it must be refunded) or random near the deadline (the real race), in turn.
      const TTL_MS = 150;
      const paymentMs = [10, 300, 100 + Math.random() * 100][round % 3];
      await Hold.updateOne({ _id: hold.id }, { expiresAt: new Date(Date.now() + TTL_MS) });
      jest.spyOn(payments, 'charge').mockImplementation(async () => {
        await sleep(paymentMs);
        return true;
      });

      // The release job fires right at the deadline, racing the confirm.
      const releaser = (async () => {
        await sleep(TTL_MS + Math.random() * 20);
        await processReleaseHold({ data: { holdId: hold.id } });
      })();
      const res = await confirm(fan, hold.id);
      await releaser;
      await sweepExpiredHolds(); // the safety net finishes any release the job fired too early for
      jest.restoreAllMocks();

      const [seat, bookings, paid, refunded, holdDoc] = await Promise.all([
        Seat.findById(seatId).lean(),
        Booking.countDocuments({ holdId: hold.id }),
        Payment.countDocuments({ holdId: hold.id, status: 'succeeded' }),
        Payment.countDocuments({ holdId: hold.id, status: 'refunded' }),
        Hold.findById(hold.id).lean(),
      ]);

      if (res.status === 201) {
        outcomes.booked++;
        expect(seat.status).toBe('booked');
        expect(holdDoc.status).toBe('converted');
        expect([bookings, paid, refunded]).toEqual([1, 1, 0]);
      } else {
        outcomes.expired++;
        expect(res.status).toBe(410);
        expect(seat).toMatchObject({ status: 'available', holdId: null });
        expect(holdDoc.status).toBe('expired');
        expect(bookings).toBe(0);
        expect(paid).toBe(0); // a charge that ran was refunded; a hold seen expired was never charged
      }
    }

    expect(outcomes.booked + outcomes.expired).toBe(12);
    expect(outcomes.booked).toBeGreaterThanOrEqual(4); // every fast round books
    expect(outcomes.expired).toBeGreaterThanOrEqual(4); // every slow round is refunded
  });
});

describe('booking email job (FR-15, FR-16)', () => {
  async function bookOne(eventOverrides = {}) {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent(eventOverrides);
    const hold = await holdSeats(fan, event.id, seatIds.slice(0, 2));
    const { booking } = (await confirm(fan, hold.id).expect(201)).body;
    return { fan, event, booking };
  }

  test('sends the booking details and a QR code of the ticket code, once', async () => {
    const { fan, booking } = await bookOne({ name: 'Rock <script>alert(1)</script> Night' });
    // Stubbed: nodemailer rewrites attachment content in place, and this checks the message as built.
    const send = jest.spyOn(mailer, 'send').mockResolvedValue({});

    await expect(processBookingEmail({ data: { bookingId: booking.id } })).resolves.toEqual({ sent: true });

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe(fan.user.email);
    expect(message.subject).toBe('Your tickets for Rock <script>alert(1)</script> Night');
    expect(message.text).toContain(booking.ticketCode);
    expect(message.text).toContain('S1 A1, S1 A2');
    expect(message.text).toContain('₹1,000.00');
    expect(message.html).toContain('Rock &lt;script&gt;alert(1)&lt;/script&gt; Night');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('cid:ticket-qr');
    const [qr] = message.attachments;
    expect(qr).toMatchObject({ cid: 'ticket-qr', contentType: 'image/png', filename: `${booking.ticketCode}.png` });
    expect(qr.content.subarray(1, 4).toString()).toBe('PNG');

    expect((await Booking.findById(booking.id).lean()).emailSentAt).toBeInstanceOf(Date);
    await expect(processBookingEmail({ data: { bookingId: booking.id } })).resolves.toEqual({ skipped: 'already sent' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a send failure throws, so BullMQ retries, and the booking is not marked sent', async () => {
    const { booking } = await bookOne();
    jest.spyOn(mailer, 'send').mockRejectedValueOnce(new Error('SMTP down'));

    await expect(processBookingEmail({ data: { bookingId: booking.id } })).rejects.toThrow('SMTP down');
    expect((await Booking.findById(booking.id).lean()).emailSentAt).toBeNull();
  });

  test('skips a cancelled or missing booking', async () => {
    const { booking } = await bookOne();
    await Booking.updateOne({ _id: booking.id }, { status: 'cancelled' });
    const send = jest.spyOn(mailer, 'send');

    await expect(processBookingEmail({ data: { bookingId: booking.id } })).resolves.toEqual({ skipped: 'booking cancelled' });
    await expect(processBookingEmail({ data: { bookingId: '0123456789abcdef01234567' } })).resolves.toEqual({
      skipped: 'booking not found',
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('without SMTP_URL the email is rendered by nodemailer and logged, not sent', async () => {
    const { booking } = await bookOne();
    const send = jest.spyOn(mailer, 'send');

    await processBookingEmail({ data: { bookingId: booking.id } });
    const info = await send.mock.results[0].value;
    const rendered = JSON.parse(info.message); // nodemailer's jsonTransport output
    expect(rendered.from.address).toBe('no-reply@ticketrush.local');
    expect(rendered.attachments[0].cid).toBe('ticket-qr');
  });

  test('retry delays are 1 s, 4 s and 16 s (FR-16)', () => {
    expect([1, 2, 3].map((n) => emailBackoff(n, 1000))).toEqual([1000, 4000, 16000]);
  });
});
