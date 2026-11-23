const mongoose = require('mongoose');
const { Types } = mongoose;
const { Seat, Booking, Hold, IdempotencyKey, User } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(closeTestDb);

const id = () => new Types.ObjectId();

function booking(seatIds, overrides = {}) {
  return {
    userId: id(),
    holdId: id(),
    eventId: id(),
    seatIds,
    totalPaise: 1000,
    ticketCode: new Types.ObjectId().toHexString(),
    ...overrides,
  };
}

describe('indexes from SRS 7.1', () => {
  test('a seat position is unique within an event', async () => {
    const eventId = id();
    const seat = { eventId, section: 'A', row: '1', number: 1, pricePaise: 50000 };
    await Seat.create(seat);
    await expect(Seat.create(seat)).rejects.toMatchObject({ code: 11000 });
    await expect(Seat.create({ ...seat, eventId: id() })).resolves.toBeDefined();
  });

  test('two confirmed bookings can never share a seat (NFR-1 last guard)', async () => {
    const [s1, s2, s3] = [id(), id(), id()];
    await Booking.create(booking([s1, s2]));
    await expect(Booking.create(booking([s2, s3]))).rejects.toMatchObject({ code: 11000 });
  });

  test('a cancelled booking frees its seats for a new confirmed booking', async () => {
    const seat = id();
    await Booking.create(booking([seat], { status: 'cancelled' }));
    await expect(Booking.create(booking([seat]))).resolves.toBeDefined();
  });

  test('a hold can be converted into at most one booking', async () => {
    const holdId = id();
    await Booking.create(booking([id()], { holdId }));
    await expect(Booking.create(booking([id()], { holdId }))).rejects.toMatchObject({ code: 11000 });
  });

  test('idempotency keys are unique per user, not globally', async () => {
    const [u1, u2] = [id(), id()];
    await IdempotencyKey.create({ userId: u1, key: 'k1', requestHash: 'h' });
    await expect(IdempotencyKey.create({ userId: u2, key: 'k1', requestHash: 'h' })).resolves.toBeDefined();
    await expect(IdempotencyKey.create({ userId: u1, key: 'k1', requestHash: 'h' })).rejects.toMatchObject({
      code: 11000,
    });
  });

  test('user emails are unique and stored lowercase', async () => {
    await User.create({ email: 'A@Example.com', passwordHash: 'x' });
    await expect(User.create({ email: 'a@example.com', passwordHash: 'x' })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('validation', () => {
  test('a hold needs 1 to 6 seats', async () => {
    const base = { userId: id(), eventId: id(), expiresAt: new Date() };
    await expect(Hold.create({ ...base, seatIds: [] })).rejects.toThrow(/1 to 6 seats/);
    await expect(Hold.create({ ...base, seatIds: Array.from({ length: 7 }, id) })).rejects.toThrow(/1 to 6 seats/);
    await expect(Hold.create({ ...base, seatIds: [id()] })).resolves.toBeDefined();
  });

  test('prices must be whole paise', async () => {
    const seat = { eventId: id(), section: 'A', row: '1', number: 1, pricePaise: 499.5 };
    await expect(Seat.create(seat)).rejects.toThrow(/integer/);
  });
});

describe('replica set', () => {
  test('multi-document transactions commit and abort as a unit', async () => {
    const eventId = id();
    const session = await mongoose.startSession();

    await session.withTransaction(async () => {
      await Seat.create([{ eventId, section: 'A', row: '1', number: 1, pricePaise: 100 }], { session });
      await Seat.create([{ eventId, section: 'A', row: '1', number: 2, pricePaise: 100 }], { session });
    });

    await expect(
      session.withTransaction(async () => {
        await Seat.create([{ eventId, section: 'A', row: '1', number: 3, pricePaise: 100 }], { session });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    await session.endSession();
    expect(await Seat.countDocuments({ eventId })).toBe(2);
  });
});
