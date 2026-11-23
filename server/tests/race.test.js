/**
 * Phase 2 acceptance tests (SRS 9): concurrent holds never share a seat.
 * Requests go through a real HTTP server so they truly run in parallel.
 */
const http = require('node:http');
const request = require('supertest');
const { createApp } = require('../src/app');
const { Seat, Hold } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUsers, createOnSaleEvent } = require('./helpers/factories');

let server;

beforeAll(async () => {
  await connectTestDb();
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
});
afterEach(clearTestDb);
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeTestDb();
});

const hold = (auth, eventId, seatIds) =>
  request(server).post(`/api/v1/events/${eventId}/holds`).set('Authorization', auth).send({ seatIds });

const countBy = (values) => values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

test('100 parallel holds on the same seat: exactly 1 wins, 99 get 409, none get 500', async () => {
  const users = await createUsers(100);
  const { event, seatIds } = await createOnSaleEvent({ seats: { seatsPerRow: 1 } });
  const [seatId] = seatIds;

  const responses = await Promise.all(users.map((u) => hold(u.auth, event.id, [seatId])));
  const statuses = countBy(responses.map((r) => r.status));

  expect(statuses).toEqual({ 201: 1, 409: 99 });
  expect(responses.filter((r) => r.status === 409).every((r) => r.body.error.code === 'SEAT_TAKEN')).toBe(true);

  const winner = responses.find((r) => r.status === 201).body.hold;
  const seat = await Seat.findById(seatId).lean();
  expect(seat.status).toBe('held');
  expect(String(seat.holdId)).toBe(winner.id);
  expect(await Hold.countDocuments()).toBe(1);
});

test('50 parallel holds on overlapping seat pairs: no seat in two holds, every hold all-or-nothing', async () => {
  const users = await createUsers(50);
  const { event, seatIds } = await createOnSaleEvent({ seats: { seatsPerRow: 51 } });

  // User i wants seats i and i+1, so every request overlaps its neighbours.
  const responses = await Promise.all(users.map((u, i) => hold(u.auth, event.id, [seatIds[i], seatIds[i + 1]])));
  const statuses = countBy(responses.map((r) => r.status));

  expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
  expect(statuses[201]).toBeGreaterThanOrEqual(1);

  const holds = await Hold.find().lean();
  expect(holds).toHaveLength(statuses[201]);

  // Every successful hold owns both of its seats.
  for (const h of holds) {
    const seats = await Seat.find({ _id: { $in: h.seatIds } }).lean();
    expect(seats).toHaveLength(2);
    expect(seats.every((s) => s.status === 'held' && String(s.holdId) === String(h._id))).toBe(true);
  }

  // No seat appears in two holds, and no seat is held without a hold (failed holds left nothing behind).
  const heldInHolds = holds.flatMap((h) => h.seatIds.map(String));
  expect(new Set(heldInHolds).size).toBe(heldInHolds.length);
  expect(await Seat.countDocuments({ eventId: event.id, status: 'held' })).toBe(heldInHolds.length);
});
