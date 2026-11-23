const request = require('supertest');
const { Types } = require('mongoose');
const { createApp } = require('../src/app');
const { Event, Seat, Hold } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUser, createOnSaleEvent, HOUR } = require('./helpers/factories');

const app = createApp();

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(closeTestDb);

const hold = (auth, eventId, seatIds) =>
  request(app).post(`/api/v1/events/${eventId}/holds`).set('Authorization', auth).send({ seatIds });

describe('POST /events/:id/holds (FR-7, FR-8)', () => {
  test('holds the seats for 5 minutes', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();

    const before = Date.now();
    const res = await hold(fan.auth, event.id, seatIds.slice(0, 3)).expect(201);

    expect(res.body.hold).toMatchObject({ eventId: event.id, seatIds: seatIds.slice(0, 3), status: 'active' });
    const ttl = new Date(res.body.hold.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(299_000);
    expect(ttl).toBeLessThanOrEqual(301_000);

    const seats = await Seat.find({ _id: { $in: seatIds.slice(0, 3) } }).lean();
    expect(seats.every((s) => s.status === 'held' && String(s.holdId) === res.body.hold.id)).toBe(true);
  });

  test('is all-or-nothing: one taken seat fails the whole hold and holds nothing (FR-8)', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const { event, seatIds } = await createOnSaleEvent();
    await hold(a.auth, event.id, [seatIds[2]]).expect(201);

    const res = await hold(b.auth, event.id, [seatIds[0], seatIds[1], seatIds[2]]).expect(409);
    expect(res.body.error.code).toBe('SEAT_TAKEN');

    const free = await Seat.find({ _id: { $in: [seatIds[0], seatIds[1]] } }).lean();
    expect(free.every((s) => s.status === 'available' && s.holdId === null)).toBe(true);
    expect(await Hold.countDocuments()).toBe(1);
  });

  test.each([
    ['no seats', () => []],
    ['seven seats', (ids) => ids.slice(0, 7)],
    ['a duplicate seat', (ids) => [ids[0], ids[0]]],
    ['a malformed id', () => ['xyz']],
  ])('rejects %s with 400', async (_label, pick) => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    await hold(fan.auth, event.id, pick(seatIds)).expect(400);
    expect(await Seat.countDocuments({ status: 'held' })).toBe(0);
  });

  test('a seat from another event is a 400, not a 409', async () => {
    const fan = await createUser();
    const one = await createOnSaleEvent();
    const two = await createOnSaleEvent();
    const res = await hold(fan.auth, one.event.id, [one.seatIds[0], two.seatIds[0]]).expect(400);
    expect(res.body.error.message).toMatch(/do not belong/);
    expect(await Seat.countDocuments({ status: 'held' })).toBe(0);
  });

  test('a seat ID that does not exist is a 400', async () => {
    const fan = await createUser();
    const { event } = await createOnSaleEvent();
    await hold(fan.auth, event.id, [new Types.ObjectId().toHexString()]).expect(400);
  });

  test('403 SALE_NOT_STARTED before saleStartsAt and after the event ends', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();

    await Event.updateOne({ _id: event.id }, { saleStartsAt: new Date(Date.now() + HOUR) });
    expect((await hold(fan.auth, event.id, [seatIds[0]]).expect(403)).body.error.code).toBe('SALE_NOT_STARTED');

    await Event.updateOne({ _id: event.id }, { saleStartsAt: new Date(Date.now() - HOUR), status: 'ended' });
    await hold(fan.auth, event.id, [seatIds[0]]).expect(403);
  });

  test('404 for a draft or unknown event', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    await Event.updateOne({ _id: event.id }, { status: 'draft' });
    await hold(fan.auth, event.id, [seatIds[0]]).expect(404);
    await hold(fan.auth, new Types.ObjectId().toHexString(), [seatIds[0]]).expect(404);
  });

  test('only users can hold: organisers get 403, guests 401', async () => {
    const org = await createUser('organiser');
    const { event, seatIds } = await createOnSaleEvent();
    await hold(org.auth, event.id, [seatIds[0]]).expect(403);
    await request(app).post(`/api/v1/events/${event.id}/holds`).send({ seatIds: [seatIds[0]] }).expect(401);
  });

  test('429 TOO_MANY_HOLDS on a third active hold for the same event (FR-29)', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    await hold(fan.auth, event.id, [seatIds[0]]).expect(201);
    await hold(fan.auth, event.id, [seatIds[1]]).expect(201);

    const res = await hold(fan.auth, event.id, [seatIds[2]]).expect(429);
    expect(res.body.error.code).toBe('TOO_MANY_HOLDS');

    // Expired holds do not count toward the cap.
    await Hold.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    await hold(fan.auth, event.id, [seatIds[2]]).expect(201);
  });
});

describe('DELETE /holds/:id (FR-10)', () => {
  test('the owner releases a hold and its seats become available', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const { body } = await hold(fan.auth, event.id, seatIds.slice(0, 2)).expect(201);

    await request(app).delete(`/api/v1/holds/${body.hold.id}`).set('Authorization', fan.auth).expect(204);

    expect((await Hold.findById(body.hold.id).lean()).status).toBe('released');
    const seats = await Seat.find({ _id: { $in: seatIds.slice(0, 2) } }).lean();
    expect(seats.every((s) => s.status === 'available' && s.holdId === null)).toBe(true);

    // The released seats can be held again.
    await hold(fan.auth, event.id, seatIds.slice(0, 2)).expect(201);
  });

  test('releasing twice gives 410; someone else gets 404', async () => {
    const [owner, other] = [await createUser(), await createUser()];
    const { event, seatIds } = await createOnSaleEvent();
    const { body } = await hold(owner.auth, event.id, [seatIds[0]]).expect(201);
    const del = (auth) => request(app).delete(`/api/v1/holds/${body.hold.id}`).set('Authorization', auth);

    await del(other.auth).expect(404);
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('held');

    await del(owner.auth).expect(204);
    expect((await del(owner.auth).expect(410)).body.error.code).toBe('HOLD_EXPIRED');
  });

  test('a converted hold is never released, so its seats stay booked', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const { body } = await hold(fan.auth, event.id, [seatIds[0]]).expect(201);

    // Simulate a confirm (phase 4).
    await Hold.updateOne({ _id: body.hold.id }, { status: 'converted' });
    await Seat.updateOne({ _id: seatIds[0] }, { status: 'booked' });

    await request(app).delete(`/api/v1/holds/${body.hold.id}`).set('Authorization', fan.auth).expect(410);
    expect((await Seat.findById(seatIds[0]).lean()).status).toBe('booked');
  });
});
