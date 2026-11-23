/**
 * Phase 4: confirm with idempotency (FR-11 to FR-13, SRS 6.2), sell-out (FR-28),
 * my bookings and cancel (FR-14, FR-30, SRS 6.4).
 * Requests go through a real HTTP server so parallel requests truly overlap.
 */
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const request = require('supertest');
const { createApp } = require('../src/app');
const payments = require('../src/lib/payments');
const { getRedis } = require('../src/lib/redis');
const { Booking, Event, Hold, IdempotencyKey, Payment, Seat } = require('../src/models');
const { STALE_PROCESSING_MS } = require('../src/modules/bookings/bookings.service');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUser, createUsers, createOnSaleEvent, HOUR } = require('./helpers/factories');

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
const newKey = () => `key-${Date.now()}-${++keyCounter}`;

async function holdSeats(user, eventId, seatIds) {
  const res = await request(server)
    .post(`/api/v1/events/${eventId}/holds`)
    .set('Authorization', user.auth)
    .send({ seatIds })
    .expect(201);
  return res.body.hold;
}

const confirm = (user, holdId, key) => {
  const req = request(server).post(`/api/v1/holds/${holdId}/confirm`).set('Authorization', user.auth);
  return key === undefined ? req : req.set('Idempotency-Key', key);
};

const countBy = (values) => values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

describe('POST /holds/:id/confirm (FR-11 to FR-13)', () => {
  test('pays and books: 201 with a ticket code; hold converted, seats booked, key stored', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, seatIds.slice(0, 2));
    const key = newKey();

    const res = await confirm(fan, hold.id, key).expect(201);

    expect(res.body.booking).toMatchObject({
      eventId: event.id,
      holdId: hold.id,
      seatIds: seatIds.slice(0, 2),
      totalPaise: 100_000,
      status: 'confirmed',
      cancelledAt: null,
    });
    expect(res.body.booking.ticketCode).toMatch(/^TR-[0-9A-F]{12}$/);
    expect(res.headers['idempotent-replayed']).toBeUndefined();

    expect((await Hold.findById(hold.id).lean()).status).toBe('converted');
    expect(await Seat.countDocuments({ _id: { $in: seatIds.slice(0, 2) }, status: 'booked' })).toBe(2);
    const payment = await Payment.findOne({ holdId: hold.id }).lean();
    expect(payment).toMatchObject({ status: 'succeeded', amountPaise: 100_000 });
    const stored = await IdempotencyKey.findOne({ key }).lean();
    expect(stored).toMatchObject({ status: 'completed', responseStatus: 201 });
  });

  test('428 without the Idempotency-Key header; 400 for a malformed key or a body', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);

    const missing = await confirm(fan, hold.id).expect(428);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const long = await confirm(fan, hold.id, 'x'.repeat(256)).expect(400);
    expect(long.body.error.details[0].path).toBe('Idempotency-Key');
    await confirm(fan, hold.id, 'has space').expect(400);
    await confirm(fan, hold.id, newKey()).send({ seatIds: [] }).expect(400);

    expect(await IdempotencyKey.countDocuments()).toBe(0);
    expect(await Booking.countDocuments()).toBe(0);
  });

  test('only users confirm; another user’s hold is 404 and does not use up the key', async () => {
    const [fan, other] = [await createUser(), await createUser()];
    const org = await createUser('organiser');
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const key = newKey();

    await confirm(org, hold.id, key).expect(403);
    const res = await confirm(other, hold.id, key).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await IdempotencyKey.countDocuments()).toBe(0);

    // The same key string still works for the other user's own hold.
    const own = await holdSeats(other, event.id, [seatIds[1]]);
    await confirm(other, own.id, key).expect(201);
  });

  test('a repeat with the same key replays the identical 201 and books nothing new', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const key = newKey();
    const charge = jest.spyOn(payments, 'charge');

    const first = await confirm(fan, hold.id, key).expect(201);
    const again = await confirm(fan, hold.id, key).expect(201);

    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(charge).toHaveBeenCalledTimes(1);
    expect(await Booking.countDocuments()).toBe(1);
  });

  test('422 IDEMPOTENCY_KEY_REUSED when one key is used for a different hold', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const [h1, h2] = [await holdSeats(fan, event.id, [seatIds[0]]), await holdSeats(fan, event.id, [seatIds[1]])];
    const key = newKey();

    await confirm(fan, h1.id, key).expect(201);
    const res = await confirm(fan, h2.id, key).expect(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await Hold.findById(h2.id).lean()).status).toBe('active');
  });

  test('SRS 9: 5 parallel confirms with one key give 1 booking; a sixth gets the identical 201', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const key = newKey();
    // A slow payment keeps the first request in flight while the others arrive.
    const charge = jest.spyOn(payments, 'charge').mockImplementation(async () => {
      await sleep(300);
      return true;
    });

    const responses = await Promise.all(Array.from({ length: 5 }, () => confirm(fan, hold.id, key)));
    const statuses = countBy(responses.map((r) => r.status));

    expect(statuses[201]).toBeGreaterThanOrEqual(1);
    expect((statuses[201] ?? 0) + (statuses[409] ?? 0)).toBe(5);
    const created = responses.filter((r) => r.status === 201);
    created.forEach((r) => expect(r.body).toEqual(created[0].body));
    responses
      .filter((r) => r.status === 409)
      .forEach((r) => expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS'));

    const sixth = await confirm(fan, hold.id, key).expect(201);
    expect(sixth.body).toEqual(created[0].body);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(await Booking.countDocuments()).toBe(1);
    expect(await Payment.countDocuments()).toBe(1);
  });

  test('SRS 9 payment retry: 402 frees the key, then the same key succeeds with 1 booking', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const key = newKey();
    jest.spyOn(payments, 'charge').mockResolvedValueOnce(false);

    const declined = await confirm(fan, hold.id, key).expect(402);
    expect(declined.body.error.code).toBe('PAYMENT_FAILED');
    expect(await IdempotencyKey.countDocuments()).toBe(0);
    expect((await Hold.findById(hold.id).lean()).status).toBe('active');
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('held');

    await confirm(fan, hold.id, key).expect(201);
    expect(await Booking.countDocuments()).toBe(1);
    const statuses = (await Payment.find().sort({ createdAt: 1 }).lean()).map((p) => p.status);
    expect(statuses).toEqual(['failed', 'succeeded']);
  });

  test('FR-13: paid but the hold expired meanwhile: 410, refund recorded, no booking; the 410 is stored', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const key = newKey();
    const charge = jest.spyOn(payments, 'charge').mockImplementation(async () => {
      await Hold.updateOne({ _id: hold.id }, { expiresAt: new Date(Date.now() - 1000) });
      return true;
    });

    const res = await confirm(fan, hold.id, key).expect(410);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect(res.body.error.message).toMatch(/refunded/);
    expect(res.body.error.requestId).toBeDefined();

    expect(await Booking.countDocuments()).toBe(0);
    expect((await Payment.findOne({ holdId: hold.id }).lean()).status).toBe('refunded');
    // The hold was not converted; the expiry job (phase 5) frees its seats.
    expect((await Hold.findById(hold.id).lean()).status).toBe('active');
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('held');

    const again = await confirm(fan, hold.id, key).expect(410);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.error.message).toBe(res.body.error.message);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  test('410 without charging for an expired, released or converted hold', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const charge = jest.spyOn(payments, 'charge');

    const expired = await holdSeats(fan, event.id, [seatIds[0]]);
    await Hold.updateOne({ _id: expired.id }, { expiresAt: new Date(Date.now() - 1000) });
    await confirm(fan, expired.id, newKey()).expect(410);

    const released = await holdSeats(fan, event.id, [seatIds[1]]);
    await request(server).delete(`/api/v1/holds/${released.id}`).set('Authorization', fan.auth).expect(204);
    const r = await confirm(fan, released.id, newKey()).expect(410);
    expect(r.body.error.message).toMatch(/released/);

    const booked = await holdSeats(fan, event.id, [seatIds[2]]);
    await confirm(fan, booked.id, newKey()).expect(201);
    const c = await confirm(fan, booked.id, newKey()).expect(410); // a new key cannot book twice
    expect(c.body.error.message).toMatch(/converted/);

    expect(charge).toHaveBeenCalledTimes(1);
    expect(await Booking.countDocuments()).toBe(1);
  });

  test('two keys racing on one hold: 1 booking; the loser gets 410 and its payment is refunded', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    // A slow payment lets both requests pass the hold check, so both pay and race to book.
    const charge = jest.spyOn(payments, 'charge').mockImplementation(async () => {
      await sleep(200);
      return true;
    });

    const responses = await Promise.all([confirm(fan, hold.id, newKey()), confirm(fan, hold.id, newKey())]);
    const statuses = responses.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 410]);
    expect(charge).toHaveBeenCalledTimes(2);
    expect(await Booking.countDocuments()).toBe(1);
    const byStatus = countBy((await Payment.find().lean()).map((p) => p.status));
    expect(byStatus).toEqual({ succeeded: 1, refunded: 1 });
  });

  test('a fresh processing key is 409 REQUEST_IN_PROGRESS; a stale one is taken over', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const hold = await holdSeats(fan, event.id, [seatIds[0]]);
    const key = newKey();
    const requestHash = require('node:crypto')
      .createHash('sha256')
      .update(`POST /holds/${hold.id}/confirm`)
      .digest('hex');
    const stuck = await IdempotencyKey.create({ userId: fan.id, key, requestHash });

    const busy = await confirm(fan, hold.id, key).expect(409);
    expect(busy.body.error.code).toBe('REQUEST_IN_PROGRESS');

    // The first request crashed more than STALE_PROCESSING_MS ago.
    await IdempotencyKey.updateOne({ _id: stuck._id }, { createdAt: new Date(Date.now() - STALE_PROCESSING_MS - 1000) });
    await confirm(fan, hold.id, key).expect(201);
    expect(await IdempotencyKey.countDocuments()).toBe(1);
  });

  test('FR-17: 10 confirms per user per minute, then 429', async () => {
    const fan = await createUser();
    const holdId = '0123456789abcdef01234567';
    for (let i = 0; i < 10; i++) await confirm(fan, holdId).expect(428);
    const res = await confirm(fan, holdId).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('sold out (FR-28)', () => {
  test('booking the last seat sets sold_out and soldOutAt, and clears the event cache', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const { event, seatIds } = await createOnSaleEvent({ seats: { seatsPerRow: 3 } });
    await request(server).get(`/api/v1/events/${event.id}`).expect(200); // cache it

    const h1 = await holdSeats(a, event.id, seatIds.slice(0, 2));
    const h2 = await holdSeats(b, event.id, [seatIds[2]]);
    await confirm(a, h1.id, newKey()).expect(201);
    // One seat is still held, not booked: not sold out yet.
    expect((await Event.findById(event.id).lean()).status).toBe('on_sale');

    await confirm(b, h2.id, newKey()).expect(201);
    const sold = await Event.findById(event.id).lean();
    expect(sold.status).toBe('sold_out');
    expect(sold.soldOutAt).toBeInstanceOf(Date);
    expect(await getRedis().exists(`event:${event.id}`)).toBe(0);

    const page = await request(server).get(`/api/v1/events/${event.id}`).expect(200);
    expect(page.body.event.status).toBe('sold_out');
  });
});

describe('GET /me/bookings (FR-14)', () => {
  test('lists only your bookings, newest first, with event and seat details, paginated', async () => {
    const [fan, other] = [await createUser(), await createUser()];
    const { event, seatIds } = await createOnSaleEvent();

    const first = await holdSeats(fan, event.id, [seatIds[0]]);
    await confirm(fan, first.id, newKey()).expect(201);
    const second = await holdSeats(fan, event.id, [seatIds[1], seatIds[2]]);
    await confirm(fan, second.id, newKey()).expect(201);
    const theirs = await holdSeats(other, event.id, [seatIds[3]]);
    await confirm(other, theirs.id, newKey()).expect(201);

    const res = await request(server).get('/api/v1/me/bookings').set('Authorization', fan.auth).expect(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.bookings.map((b) => b.holdId)).toEqual([second.id, first.id]);

    const [latest] = res.body.bookings;
    expect(latest.ticketCode).toMatch(/^TR-/);
    expect(latest.event).toMatchObject({ id: event.id, name: event.name, city: event.city, status: 'on_sale' });
    expect(latest.seats).toEqual([
      expect.objectContaining({ id: seatIds[1], section: 'S1', row: 'A', number: 2, pricePaise: 50_000 }),
      expect.objectContaining({ id: seatIds[2], number: 3 }),
    ]);

    const page2 = await request(server)
      .get('/api/v1/me/bookings?page=2&limit=1')
      .set('Authorization', fan.auth)
      .expect(200);
    expect(page2.body.bookings.map((b) => b.holdId)).toEqual([first.id]);

    await request(server).get('/api/v1/me/bookings').expect(401);
    await request(server).get('/api/v1/me/bookings?limit=51').set('Authorization', fan.auth).expect(400);
  });
});

describe('POST /bookings/:id/cancel (FR-14, FR-30)', () => {
  async function book(user, eventId, seats) {
    const hold = await holdSeats(user, eventId, seats);
    return (await confirm(user, hold.id, newKey()).expect(201)).body.booking;
  }
  const cancel = (user, bookingId) =>
    request(server).post(`/api/v1/bookings/${bookingId}/cancel`).set('Authorization', user.auth);

  test('SRS 9: cancel frees the seats, the event goes back on sale keeping soldOutAt, and the seat can be rebooked', async () => {
    const [fan, next] = await createUsers(2);
    const { event, seatIds } = await createOnSaleEvent({ seats: { seatsPerRow: 2 } });
    const booking = await book(fan, event.id, seatIds);
    const { soldOutAt } = await Event.findById(event.id).lean();
    expect(soldOutAt).toBeInstanceOf(Date);
    await request(server).get(`/api/v1/events/${event.id}`).expect(200); // cache the sold_out event

    const res = await cancel(fan, booking.id).expect(200);
    expect(res.body.booking).toMatchObject({ id: booking.id, status: 'cancelled' });
    expect(res.body.booking.cancelledAt).toBeTruthy();

    const seats = await Seat.find({ _id: { $in: seatIds } }).lean();
    expect(seats.every((s) => s.status === 'available' && s.holdId === null)).toBe(true);
    const reopened = await Event.findById(event.id).lean();
    expect(reopened.status).toBe('on_sale');
    expect(reopened.soldOutAt).toEqual(soldOutAt);
    expect(await getRedis().exists(`event:${event.id}`)).toBe(0);

    // The partial unique index ignores cancelled bookings, so the seat books again.
    await book(next, event.id, [seatIds[0]]);
    expect(await Booking.countDocuments({ status: 'confirmed' })).toBe(1);

    // Selling out again keeps the first soldOutAt.
    await book(next, event.id, [seatIds[1]]);
    const again = await Event.findById(event.id).lean();
    expect(again.status).toBe('sold_out');
    expect(again.soldOutAt).toEqual(soldOutAt);
  });

  test('cancelling twice returns the cancelled booking; seats are not touched again', async () => {
    const [fan, next] = await createUsers(2);
    const { event, seatIds } = await createOnSaleEvent();
    const booking = await book(fan, event.id, [seatIds[0]]);

    const first = await cancel(fan, booking.id).expect(200);
    await book(next, event.id, [seatIds[0]]); // someone else books the freed seat
    const second = await cancel(fan, booking.id).expect(200);

    expect(second.body.booking).toEqual(first.body.booking);
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('booked');
  });

  test('409 CANCEL_WINDOW_CLOSED within 24 hours of the event', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const booking = await book(fan, event.id, [seatIds[0]]);
    await Event.updateOne({ _id: event.id }, { startsAt: new Date(Date.now() + 23 * HOUR) });

    const res = await cancel(fan, booking.id).expect(409);
    expect(res.body.error.code).toBe('CANCEL_WINDOW_CLOSED');
    expect((await Booking.findById(booking.id).lean()).status).toBe('confirmed');
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('booked');
  });

  test('another user’s booking is 404; an organiser gets 403', async () => {
    const [fan, other] = await createUsers(2);
    const org = await createUser('organiser');
    const { event, seatIds } = await createOnSaleEvent();
    const booking = await book(fan, event.id, [seatIds[0]]);

    await cancel(other, booking.id).expect(404);
    await cancel(org, booking.id).expect(403);
    await cancel(fan, 'not-an-id').expect(400);
  });
});

describe('payment simulator (FR-12)', () => {
  test('succeeds at PAYMENT_SUCCESS_RATE=1 and rejects a bad amount', async () => {
    await expect(payments.charge({ amountPaise: 100 })).resolves.toBe(true);
    await expect(payments.charge({ amountPaise: 1.5 })).rejects.toThrow('Invalid payment amount');
  });
});
