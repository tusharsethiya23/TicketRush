/** Phase 3: caching (NFR-3), rate limits (FR-17), Redis outages (NFR-5), stats counter. */
const express = require('express');
const request = require('supertest');
const { createApp } = require('../src/app');
const { Event, Seat } = require('../src/models');
const { getRedis, setRedis } = require('../src/lib/redis');
const { rateLimit } = require('../src/middleware/rateLimit');
const requestLogger = require('../src/middleware/requestLogger');
const { errorHandler } = require('../src/middleware/errorHandler');
const { connectTestDb, clearTestDb, closeTestDb, brokenRedis } = require('./helpers/db');
const { createUser, createOnSaleEvent } = require('./helpers/factories');

const app = createApp();

beforeAll(connectTestDb);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});
afterAll(closeTestDb);

const hold = (auth, eventId, seatIds) =>
  request(app).post(`/api/v1/events/${eventId}/holds`).set('Authorization', auth).send({ seatIds });

describe('event cache: event:<id>, 60 s (NFR-3)', () => {
  test('the second read is served from Redis without touching MongoDB', async () => {
    const { event } = await createOnSaleEvent();
    const findOne = jest.spyOn(Event, 'findOne');

    const first = await request(app).get(`/api/v1/events/${event.id}`).expect(200);
    const second = await request(app).get(`/api/v1/events/${event.id}`).expect(200);

    expect(second.body).toEqual(first.body);
    expect(findOne).toHaveBeenCalledTimes(1);

    const ttl = await getRedis().ttl(`event:${event.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('a 404 is not cached', async () => {
    const { event } = await createOnSaleEvent();
    await Event.updateOne({ _id: event.id }, { status: 'draft' });
    await request(app).get(`/api/v1/events/${event.id}`).expect(404);
    expect(await getRedis().exists(`event:${event.id}`)).toBe(0);
  });

  test('publishing clears the cached event', async () => {
    const org = await createUser('organiser');
    const draft = await request(app)
      .post('/api/v1/events')
      .set('Authorization', org.auth)
      .send(require('./helpers/factories').eventInput());
    const id = draft.body.event.id;
    await getRedis().set(`event:${id}`, '{"stale":true}');

    await request(app).post(`/api/v1/events/${id}/publish`).set('Authorization', org.auth).expect(200);
    expect(await getRedis().exists(`event:${id}`)).toBe(0);
  });
});

describe('seat map cache: seatmap:<eventId>, 2 s, not cleared on writes (SRS 7.2)', () => {
  test('a read within 2 s may be stale, but holds are still decided by MongoDB', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const { event, seatIds } = await createOnSaleEvent({ seats: { seatsPerRow: 2 } });

    await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200);
    expect(await getRedis().ttl(`seatmap:${event.id}`)).toBeLessThanOrEqual(2);

    await hold(a.auth, event.id, [seatIds[0]]).expect(201);

    // The cached copy still says available...
    const stale = await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200);
    expect(stale.body.seats[0].status).toBe('available');
    // ...but nobody can win the seat from it.
    await hold(b.auth, event.id, [seatIds[0]]).expect(409);

    // Once the entry expires, the map is fresh.
    await getRedis().del(`seatmap:${event.id}`);
    const fresh = await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200);
    expect(fresh.body.seats[0].status).toBe('held');
  });

  test('cached seat-map reads are fast (NFR-3 smoke check)', async () => {
    const { event } = await createOnSaleEvent({ seats: { sections: 5, rows: 10, seatsPerRow: 20 } });
    await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200); // warm

    const start = process.hrtime.bigint();
    const res = await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;

    expect(res.body.seats).toHaveLength(1000);
    expect(ms).toBeLessThan(100);
  });
});

describe('Redis down (NFR-5)', () => {
  let realRedis;
  beforeEach(() => {
    realRedis = getRedis();
    setRedis(brokenRedis());
  });
  afterEach(() => setRedis(realRedis));

  test('reads fall back to MongoDB and holds still work; rate limits fail open', async () => {
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();

    await request(app).get(`/api/v1/events/${event.id}`).expect(200);
    const seats = await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200);
    expect(seats.body.seats).toHaveLength(seatIds.length);

    await hold(fan.auth, event.id, [seatIds[0]]).expect(201);
    await hold(fan.auth, event.id, [seatIds[0]]).expect(409); // MongoDB still refuses the double hold
  });

  test('/health reports Redis down with 503', async () => {
    const res = await request(app).get('/health').expect(503);
    expect(res.body).toEqual({ status: 'degraded', checks: { api: 'ok', mongo: 'ok', redis: 'down' } });
  });
});

describe('rate limiting (FR-17)', () => {
  function limitedApp(options) {
    const mini = express();
    mini.use(requestLogger);
    mini.get('/x', rateLimit({ name: 'test', limit: 3, by: 'ip', enabled: true, ...options }), (req, res) =>
      res.json({ ok: true }),
    );
    mini.use(errorHandler);
    return mini;
  }

  test('allows the limit, then 429 RATE_LIMITED with Retry-After', async () => {
    const mini = limitedApp();
    for (let i = 3; i > 0; i--) {
      const ok = await request(mini).get('/x').expect(200);
      expect(ok.headers['ratelimit-remaining']).toBe(String(i - 1));
    }
    const res = await request(mini).get('/x').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  test('every window key gets a TTL, and a new window starts fresh', async () => {
    const mini = limitedApp();
    await request(mini).get('/x');
    const [key] = await getRedis().keys('rl:test:ip:*');
    const pttl = await getRedis().pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);

    for (let i = 0; i < 3; i++) await request(mini).get('/x');
    await request(mini).get('/x').expect(429);

    await getRedis().del(key); // the window expires
    await request(mini).get('/x').expect(200);
  });

  test('a disabled limiter lets everything through', async () => {
    const mini = limitedApp({ enabled: false });
    for (let i = 0; i < 5; i++) await request(mini).get('/x').expect(200);
  });

  test('the hold route allows 10 per user per minute, then 429', async () => {
    const fan = await createUser();
    const other = await createUser();
    const { event } = await createOnSaleEvent();

    // Invalid bodies still count: the limiter runs before validation.
    for (let i = 0; i < 10; i++) await hold(fan.auth, event.id, []).expect(400);
    const res = await hold(fan.auth, event.id, []).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();

    // Limits are per user.
    await hold(other.auth, event.id, []).expect(400);
  });
});

describe('failed-holds counter (FR-18 input)', () => {
  test('each lost race increments stats:failedHolds:<eventId>; a 400 does not', async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const { event, seatIds } = await createOnSaleEvent();

    await hold(a.auth, event.id, [seatIds[0]]).expect(201);
    await hold(b.auth, event.id, [seatIds[0]]).expect(409);
    await hold(c.auth, event.id, [seatIds[0], seatIds[1]]).expect(409);
    await hold(c.auth, event.id, ['0123456789abcdef01234567']).expect(400);

    await new Promise((r) => setImmediate(r)); // the counter is written without awaiting
    const key = `stats:failedHolds:${event.id}`;
    expect(await getRedis().get(key)).toBe('2');
    expect(await getRedis().ttl(key)).toBeGreaterThan(0);
    expect(await Seat.countDocuments({ status: 'held' })).toBe(1);
  });
});
