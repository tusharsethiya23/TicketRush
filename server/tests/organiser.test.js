/** Phase 6a: the organiser's own events, the edit view and sales (FR-25, FR-31, NFR-14). */
const request = require('supertest');
const { createApp } = require('../src/app');
const { Hold } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUser, createUsers, createOnSaleEvent, eventInput } = require('./helpers/factories');

const app = createApp();

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(closeTestDb);

let keyCounter = 0;

async function book(user, eventId, seatIds) {
  const hold = await request(app)
    .post(`/api/v1/events/${eventId}/holds`)
    .set('Authorization', user.auth)
    .send({ seatIds })
    .expect(201);
  const res = await request(app)
    .post(`/api/v1/holds/${hold.body.hold.id}/confirm`)
    .set('Authorization', user.auth)
    .set('Idempotency-Key', `org-${++keyCounter}`)
    .expect(201);
  return res.body.booking;
}

describe('GET /organiser/events', () => {
  test('lists only your events, drafts included, newest first, with a status filter', async () => {
    const [org, other] = [await createUser('organiser'), await createUser('organiser')];
    const { event: live } = await createOnSaleEvent({ organiserId: org.id, name: 'Live one' });
    const draft = await request(app)
      .post('/api/v1/events')
      .set('Authorization', org.auth)
      .send(eventInput({ name: 'Draft one' }))
      .expect(201);
    await createOnSaleEvent({ organiserId: other.id });

    const res = await request(app).get('/api/v1/organiser/events').set('Authorization', org.auth).expect(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.events.map((e) => e.id)).toEqual([draft.body.event.id, live.id]);
    expect(res.body.events[0].status).toBe('draft');

    const drafts = await request(app)
      .get('/api/v1/organiser/events?status=draft')
      .set('Authorization', org.auth)
      .expect(200);
    expect(drafts.body.events.map((e) => e.name)).toEqual(['Draft one']);
  });

  test('only organisers: users get 403, guests 401, a bad status 400', async () => {
    const [fan, org] = [await createUser(), await createUser('organiser')];
    await request(app).get('/api/v1/organiser/events').set('Authorization', fan.auth).expect(403);
    await request(app).get('/api/v1/organiser/events').expect(401);
    await request(app).get('/api/v1/organiser/events?status=nope').set('Authorization', org.auth).expect(400);
  });
});

describe('GET /organiser/events/:id', () => {
  test('returns the event with the seat map it was created from, in the original order', async () => {
    const org = await createUser('organiser');
    const seatMap = {
      sections: [
        { name: 'Gold', rows: [{ label: 'B', seatCount: 2, pricePaise: 300_000 }, { label: 'A', seatCount: 3, pricePaise: 250_000 }] },
        { name: 'Bronze', rows: [{ label: 'A', seatCount: 4, pricePaise: 50_000 }] },
      ],
    };
    const created = await request(app)
      .post('/api/v1/events')
      .set('Authorization', org.auth)
      .send(eventInput({ seatMap }))
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/organiser/events/${created.body.event.id}`)
      .set('Authorization', org.auth)
      .expect(200);
    expect(res.body.event.status).toBe('draft');
    expect(res.body.seatMap).toEqual(seatMap);
    expect(res.body.seatCount).toBe(9);
  });

  test('another organiser’s event is 404 (NFR-14)', async () => {
    const [org, other] = [await createUser('organiser'), await createUser('organiser')];
    const { event } = await createOnSaleEvent({ organiserId: org.id });
    await request(app).get(`/api/v1/organiser/events/${event.id}`).set('Authorization', other.auth).expect(404);
    await request(app).get(`/api/v1/organiser/events/${event.id}/sales`).set('Authorization', other.auth).expect(404);
  });
});

describe('GET /organiser/events/:id/sales (FR-31)', () => {
  test('counts seats by status, confirmed revenue only, and active holds', async () => {
    const org = await createUser('organiser');
    const [a, b, c] = await createUsers(3);
    const { event, seatIds } = await createOnSaleEvent({ organiserId: org.id, seats: { seatsPerRow: 10, pricePaise: 50_000 } });

    await book(a, event.id, seatIds.slice(0, 2)); // ₹1,000
    const cancelled = await book(b, event.id, [seatIds[2]]);
    await request(app).post(`/api/v1/bookings/${cancelled.id}/cancel`).set('Authorization', b.auth).expect(200);
    await book(b, event.id, [seatIds[3]]); // ₹500
    await request(app).post(`/api/v1/events/${event.id}/holds`).set('Authorization', c.auth).send({ seatIds: [seatIds[4]] }).expect(201);
    const stale = await request(app)
      .post(`/api/v1/events/${event.id}/holds`)
      .set('Authorization', c.auth)
      .send({ seatIds: [seatIds[5]] })
      .expect(201);
    // An expired hold the sweep has not reached yet is not counted as active.
    await Hold.updateOne({ _id: stale.body.hold.id }, { expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/v1/organiser/events/${event.id}/sales`).set('Authorization', org.auth).expect(200);
    expect(res.body).toMatchObject({
      event: { id: event.id, status: 'on_sale' },
      seats: { total: 10, booked: 3, held: 2, available: 5 },
      bookings: { confirmed: 2, cancelled: 1 },
      revenuePaise: 150_000,
      activeHolds: 1,
    });
  });

  test('an event with no sales has zeros', async () => {
    const org = await createUser('organiser');
    const { event } = await createOnSaleEvent({ organiserId: org.id, seats: { seatsPerRow: 4 } });
    const res = await request(app).get(`/api/v1/organiser/events/${event.id}/sales`).set('Authorization', org.auth).expect(200);
    expect(res.body).toMatchObject({
      seats: { total: 4, available: 4, held: 0, booked: 0 },
      bookings: { confirmed: 0, cancelled: 0 },
      revenuePaise: 0,
      activeHolds: 0,
    });
  });
});
