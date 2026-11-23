/** Phase 6a: admin stats (FR-18), user search, block and unblock (FR-32). */
const request = require('supertest');
const { createApp } = require('../src/app');
const { Booking, Event, RefreshToken } = require('../src/models');
const { getRedis, setRedis } = require('../src/lib/redis');
const { connectTestDb, clearTestDb, closeTestDb, brokenRedis } = require('./helpers/db');
const { createUser, createOnSaleEvent, HOUR } = require('./helpers/factories');

const app = createApp();

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(closeTestDb);

const MINUTE = 60_000;

describe('GET /admin/stats (FR-18)', () => {
  test('bookings per minute over the window, with empty minutes as 0', async () => {
    const admin = await createUser('admin');
    const fan = await createUser();
    const { event, seatIds } = await createOnSaleEvent();
    const now = Date.now();
    const base = { userId: fan.id, eventId: event.id, totalPaise: 100 };
    await Booking.insertMany([
      { ...base, holdId: event.id.replace(/.$/, '1'), seatIds: [seatIds[0]], ticketCode: 'TR-1', createdAt: new Date(now) },
      { ...base, holdId: event.id.replace(/.$/, '2'), seatIds: [seatIds[1]], ticketCode: 'TR-2', createdAt: new Date(now) },
      { ...base, holdId: event.id.replace(/.$/, '3'), seatIds: [seatIds[2]], ticketCode: 'TR-3', createdAt: new Date(now - 2 * MINUTE) },
      { ...base, holdId: event.id.replace(/.$/, '4'), seatIds: [seatIds[3]], ticketCode: 'TR-4', createdAt: new Date(now - 30 * MINUTE) },
    ]);

    const res = await request(app).get('/api/v1/admin/stats?minutes=5').set('Authorization', admin.auth).expect(200);
    expect(res.body.windowMinutes).toBe(5);
    expect(res.body.bookingsPerMinute).toHaveLength(5);
    const counts = res.body.bookingsPerMinute.map((m) => m.count);
    expect(counts.at(-1)).toBe(2); // this minute
    expect(counts.at(-3)).toBe(1); // two minutes ago
    expect(res.body.totalBookings).toBe(3); // the 30-minute-old booking is outside the window

    const minutes = res.body.bookingsPerMinute.map((m) => new Date(m.minute).getTime());
    expect(minutes.every((t) => t % MINUTE === 0)).toBe(true);
    expect(minutes[1] - minutes[0]).toBe(MINUTE);

    const day = await request(app).get('/api/v1/admin/stats').set('Authorization', admin.auth).expect(200);
    expect(day.body.windowMinutes).toBe(60);
    expect(day.body.totalBookings).toBe(4);
  });

  test('failed holds per event from Redis, most first, with event names', async () => {
    const admin = await createUser('admin');
    const [a, b] = [await createUser(), await createUser()];
    const { event: busy, seatIds } = await createOnSaleEvent({ name: 'Busy' });
    const { event: quiet } = await createOnSaleEvent({ name: 'Quiet' });

    const hold = (u) => request(app).post(`/api/v1/events/${busy.id}/holds`).set('Authorization', u.auth).send({ seatIds: [seatIds[0]] });
    await hold(a).expect(201);
    await hold(b).expect(409);
    await hold(b).expect(409);
    await getRedis().set(`stats:failedHolds:${quiet.id}`, '1');
    await new Promise((r) => setImmediate(r));

    const res = await request(app).get('/api/v1/admin/stats').set('Authorization', admin.auth).expect(200);
    expect(res.body.failedHolds).toEqual([
      { eventId: busy.id, name: 'Busy', count: 2 },
      { eventId: quiet.id, name: 'Quiet', count: 1 },
    ]);
  });

  test('failedHolds is null while Redis is down; the rest still works', async () => {
    const admin = await createUser('admin');
    const real = getRedis();
    setRedis(brokenRedis());
    try {
      const res = await request(app).get('/api/v1/admin/stats').set('Authorization', admin.auth).expect(200);
      expect(res.body.failedHolds).toBeNull();
      expect(res.body.bookingsPerMinute).toHaveLength(60);
    } finally {
      setRedis(real);
    }
  });

  test('time to sell out, from saleStartsAt to soldOutAt, kept after a cancel', async () => {
    const admin = await createUser('admin');
    const { event } = await createOnSaleEvent({ name: 'Flash' });
    const saleStartsAt = new Date(Date.now() - HOUR);
    await Event.updateOne(
      { _id: event.id },
      { saleStartsAt, soldOutAt: new Date(saleStartsAt.getTime() + 95_000), status: 'on_sale' },
    );
    await createOnSaleEvent({ name: 'Never sold out' });

    const res = await request(app).get('/api/v1/admin/stats').set('Authorization', admin.auth).expect(200);
    expect(res.body.sellOutTimes).toEqual([
      expect.objectContaining({ eventId: event.id, name: 'Flash', status: 'on_sale', secondsToSellOut: 95 }),
    ]);
  });

  test('admins only; minutes must be 1 to 1440', async () => {
    const [admin, org, fan] = [await createUser('admin'), await createUser('organiser'), await createUser()];
    await request(app).get('/api/v1/admin/stats').set('Authorization', org.auth).expect(403);
    await request(app).get('/api/v1/admin/stats').set('Authorization', fan.auth).expect(403);
    await request(app).get('/api/v1/admin/stats').expect(401);
    await request(app).get('/api/v1/admin/stats?minutes=0').set('Authorization', admin.auth).expect(400);
    await request(app).get('/api/v1/admin/stats?minutes=1441').set('Authorization', admin.auth).expect(400);
  });
});

describe('GET /admin/users', () => {
  test('finds accounts by email prefix, role and status; regex characters are literal', async () => {
    const admin = await createUser('admin');
    const org = await createUser('organiser');
    const fan = await createUser('user');
    await request(app).post(`/api/v1/admin/users/${fan.id}/block`).set('Authorization', admin.auth).expect(200);

    const all = await request(app).get('/api/v1/admin/users').set('Authorization', admin.auth).expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.users[0]).toEqual({
      id: fan.id,
      email: fan.user.email,
      role: 'user',
      status: 'blocked',
      createdAt: expect.any(String),
    });

    const byPrefix = await request(app)
      .get(`/api/v1/admin/users?q=${encodeURIComponent(org.user.email.slice(0, 10).toUpperCase())}`)
      .set('Authorization', admin.auth)
      .expect(200);
    expect(byPrefix.body.users.map((u) => u.id)).toEqual([org.id]);

    const blocked = await request(app).get('/api/v1/admin/users?status=blocked').set('Authorization', admin.auth).expect(200);
    expect(blocked.body.users.map((u) => u.id)).toEqual([fan.id]);
    const admins = await request(app).get('/api/v1/admin/users?role=admin').set('Authorization', admin.auth).expect(200);
    expect(admins.body.users.map((u) => u.id)).toEqual([admin.id]);

    const regex = await request(app).get('/api/v1/admin/users?q=.*').set('Authorization', admin.auth).expect(200);
    expect(regex.body.total).toBe(0);
  });
});

describe('block and unblock (FR-32)', () => {
  test('blocking revokes refresh tokens and stops the current access token at once', async () => {
    const admin = await createUser('admin');
    await request(app).post('/api/v1/auth/register').send({ email: 'victim@example.com', password: 'password123' }).expect(201);
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'victim@example.com', password: 'password123' }).expect(200);
    const auth = `Bearer ${login.body.accessToken}`;
    const cookie = login.headers['set-cookie'];
    const userId = login.body.user.id;
    await request(app).get('/api/v1/me').set('Authorization', auth).expect(200);

    const res = await request(app).post(`/api/v1/admin/users/${userId}/block`).set('Authorization', admin.auth).expect(200);
    expect(res.body.user).toMatchObject({ id: userId, status: 'blocked' });

    const me = await request(app).get('/api/v1/me').set('Authorization', auth).expect(403);
    expect(me.body.error.code).toBe('FORBIDDEN');
    expect(await RefreshToken.countDocuments({ userId, revokedAt: null })).toBe(0);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    await request(app).post('/api/v1/auth/login').send({ email: 'victim@example.com', password: 'password123' }).expect(403);

    // Blocking twice is harmless.
    await request(app).post(`/api/v1/admin/users/${userId}/block`).set('Authorization', admin.auth).expect(200);

    const unblocked = await request(app).post(`/api/v1/admin/users/${userId}/unblock`).set('Authorization', admin.auth).expect(200);
    expect(unblocked.body.user.status).toBe('active');
    await request(app).get('/api/v1/me').set('Authorization', auth).expect(200);
    await request(app).post('/api/v1/auth/login').send({ email: 'victim@example.com', password: 'password123' }).expect(200);
  });

  test('admins cannot be blocked (not even themselves); unknown users are 404; non-admins get 403', async () => {
    const [admin, other] = [await createUser('admin'), await createUser('admin')];
    const fan = await createUser();

    await request(app).post(`/api/v1/admin/users/${admin.id}/block`).set('Authorization', admin.auth).expect(403);
    await request(app).post(`/api/v1/admin/users/${other.id}/block`).set('Authorization', admin.auth).expect(403);
    await request(app).post('/api/v1/admin/users/0123456789abcdef01234567/block').set('Authorization', admin.auth).expect(404);
    await request(app).post('/api/v1/admin/users/not-an-id/block').set('Authorization', admin.auth).expect(400);
    await request(app).post(`/api/v1/admin/users/${admin.id}/block`).set('Authorization', fan.auth).expect(403);
  });
});
