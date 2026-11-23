const request = require('supertest');
const { createApp } = require('../src/app');
const { Event, Seat } = require('../src/models');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');
const { createUser, eventInput, seatMap, createOnSaleEvent, HOUR } = require('./helpers/factories');

const app = createApp();

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(closeTestDb);

const createDraft = (auth, body = eventInput()) => request(app).post('/api/v1/events').set('Authorization', auth).send(body);
const publish = (auth, id) => request(app).post(`/api/v1/events/${id}/publish`).set('Authorization', auth);

describe('POST /events (FR-4)', () => {
  test('an organiser creates a draft event with all its seats', async () => {
    const org = await createUser('organiser');
    const res = await createDraft(org.auth, eventInput({ seatMap: seatMap({ sections: 2, rows: 3, seatsPerRow: 5 }) })).expect(201);

    expect(res.body.event).toMatchObject({ status: 'draft', organiserId: org.id, city: 'Mumbai' });
    expect(res.body.seatCount).toBe(30);

    const seats = await Seat.find({ eventId: res.body.event.id }).lean();
    expect(seats).toHaveLength(30);
    expect(seats.every((s) => s.status === 'available' && s.pricePaise === 50_000)).toBe(true);
  });

  test('a user cannot create events (403) and a guest gets 401', async () => {
    const fan = await createUser('user');
    expect((await createDraft(fan.auth).expect(403)).body.error.code).toBe('FORBIDDEN');
    await request(app).post('/api/v1/events').send(eventInput()).expect(401);
  });

  test.each([
    ['sale starting after the event', { saleStartsAt: new Date(Date.now() + 9 * 24 * HOUR).toISOString() }],
    ['event in the past', { startsAt: new Date(Date.now() - HOUR).toISOString() }],
    ['date without a timezone', { startsAt: '2027-01-01T20:00:00' }],
    ['duplicate section names', { seatMap: { sections: [seatMap().sections[0], seatMap().sections[0]] } }],
    ['duplicate row labels', { seatMap: { sections: [{ name: 'A', rows: [{ label: 'R', seatCount: 1, pricePaise: 1 }, { label: 'r', seatCount: 1, pricePaise: 1 }] }] } }],
    ['fractional price', { seatMap: seatMap({ pricePaise: 99.5 }) }],
    ['more than 10,000 seats', { seatMap: seatMap({ sections: 2, rows: 51, seatsPerRow: 100 }) }],
    ['unknown field', { status: 'on_sale' }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const org = await createUser('organiser');
    const res = await createDraft(org.auth, eventInput(overrides)).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await Event.countDocuments()).toBe(0);
    expect(await Seat.countDocuments()).toBe(0);
  });
});

describe('PATCH /events/:id (FR-4)', () => {
  test('the owner edits a draft; a new seat map replaces every seat', async () => {
    const org = await createUser('organiser');
    const { body } = await createDraft(org.auth);

    const res = await request(app)
      .patch(`/api/v1/events/${body.event.id}`)
      .set('Authorization', org.auth)
      .send({ name: 'New name', seatMap: seatMap({ seatsPerRow: 3, pricePaise: 1000 }) })
      .expect(200);

    expect(res.body.event.name).toBe('New name');
    expect(res.body.seatCount).toBe(3);
    expect(await Seat.countDocuments({ eventId: body.event.id, pricePaise: 1000 })).toBe(3);
  });

  test('checks times against the stored values', async () => {
    const org = await createUser('organiser');
    const { body } = await createDraft(org.auth);
    const res = await request(app)
      .patch(`/api/v1/events/${body.event.id}`)
      .set('Authorization', org.auth)
      .send({ saleStartsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString() })
      .expect(400);
    expect(res.body.error.details[0].path).toBe('saleStartsAt');
  });

  test('another organiser gets 404; a published event gets 409', async () => {
    const owner = await createUser('organiser');
    const other = await createUser('organiser');
    const { body } = await createDraft(owner.auth);
    const patch = (auth) => request(app).patch(`/api/v1/events/${body.event.id}`).set('Authorization', auth).send({ name: 'x' });

    await patch(other.auth).expect(404);
    await publish(owner.auth, body.event.id).expect(200);
    expect((await patch(owner.auth).expect(409)).body.error.code).toBe('EVENT_NOT_EDITABLE');
  });
});

describe('POST /events/:id/publish (FR-27)', () => {
  test('publishes a draft once; again gives 409; another organiser gets 404', async () => {
    const owner = await createUser('organiser');
    const other = await createUser('organiser');
    const { body } = await createDraft(owner.auth);

    await publish(other.auth, body.event.id).expect(404);
    const res = await publish(owner.auth, body.event.id).expect(200);
    expect(res.body.event.status).toBe('on_sale');
    expect((await publish(owner.auth, body.event.id).expect(409)).body.error.code).toBe('EVENT_NOT_EDITABLE');
  });

  test('an invalid id is a 400', async () => {
    const owner = await createUser('organiser');
    await publish(owner.auth, 'not-an-id').expect(400);
  });
});

describe('GET /events and /events/:id (FR-5)', () => {
  test('drafts are hidden from the list and from the detail route', async () => {
    const org = await createUser('organiser');
    const { body } = await createDraft(org.auth);

    expect((await request(app).get('/api/v1/events').expect(200)).body.total).toBe(0);
    await request(app).get(`/api/v1/events/${body.event.id}`).expect(404);
    await request(app).get(`/api/v1/events/${body.event.id}/seats`).expect(404);

    await publish(org.auth, body.event.id);
    const one = await request(app).get(`/api/v1/events/${body.event.id}`).expect(200);
    expect(one.body.event).toMatchObject({ id: body.event.id, status: 'on_sale' });
  });

  test('filters by city case-insensitively, by date, and paginates in start order', async () => {
    const day = 24 * HOUR;
    for (const [city, inDays] of [['Mumbai', 3], ['Mumbai', 5], ['Pune', 4], ['Mumbai', 20]]) {
      await createOnSaleEvent({ city, name: `${city} ${inDays}`, seats: { seatsPerRow: 1 } }).then(({ event }) =>
        Event.updateOne({ _id: event.id }, { startsAt: new Date(Date.now() + inDays * day) }),
      );
    }

    const mumbai = await request(app).get('/api/v1/events').query({ city: 'mumbai' }).expect(200);
    expect(mumbai.body.total).toBe(3);
    expect(mumbai.body.events.map((e) => e.name)).toEqual(['Mumbai 3', 'Mumbai 5', 'Mumbai 20']);

    const window = await request(app)
      .get('/api/v1/events')
      .query({ to: new Date(Date.now() + 10 * day).toISOString() })
      .expect(200);
    expect(window.body.total).toBe(3);

    const page2 = await request(app).get('/api/v1/events').query({ limit: 2, page: 2 }).expect(200);
    expect(page2.body).toMatchObject({ page: 2, limit: 2, total: 4 });
    expect(page2.body.events.map((e) => e.name)).toEqual(['Mumbai 5', 'Mumbai 20']);
  });

  test('rejects a page size over 50', async () => {
    await request(app).get('/api/v1/events').query({ limit: 51 }).expect(400);
  });
});

describe('GET /events/:id/seats (FR-6)', () => {
  test('returns every seat with its status and never the holdId', async () => {
    const { event, seatIds } = await createOnSaleEvent({ seats: { rows: 2, seatsPerRow: 3 } });
    await Seat.updateOne({ _id: seatIds[0] }, { status: 'held' });
    await Seat.updateOne({ _id: seatIds[1] }, { status: 'booked' });

    const res = await request(app).get(`/api/v1/events/${event.id}/seats`).expect(200);
    expect(res.body.seats).toHaveLength(6);
    expect(res.body.seats.slice(0, 3).map((s) => s.status)).toEqual(['held', 'booked', 'available']);
    expect(res.body.seats[0]).toEqual({ id: seatIds[0], section: 'S1', row: 'A', number: 1, pricePaise: 50_000, status: 'held' });
  });
});
