const { User, Seat } = require('../../src/models');
const { signAccessToken } = require('../../src/lib/tokens');
const eventsService = require('../../src/modules/events/events.service');

const HOUR = 60 * 60 * 1000;
let counter = 0;

/** A user row plus a valid access token, skipping bcrypt for speed. */
async function createUser(role = 'user') {
  const user = await User.create({ email: `${role}${++counter}@example.com`, passwordHash: 'not-used', role });
  return { user, id: String(user._id), token: signAccessToken(user), auth: `Bearer ${signAccessToken(user)}` };
}

/** Bulk users for race tests. */
async function createUsers(n, role = 'user') {
  const docs = await User.insertMany(
    Array.from({ length: n }, () => ({ email: `${role}${++counter}@example.com`, passwordHash: 'not-used', role })),
  );
  return docs.map((user) => ({ user, id: String(user._id), auth: `Bearer ${signAccessToken(user)}` }));
}

function seatMap({ sections = 1, rows = 1, seatsPerRow = 10, pricePaise = 50_000 } = {}) {
  return {
    sections: Array.from({ length: sections }, (_, s) => ({
      name: `S${s + 1}`,
      rows: Array.from({ length: rows }, (_, r) => ({ label: String.fromCharCode(65 + r), seatCount: seatsPerRow, pricePaise })),
    })),
  };
}

function eventInput(overrides = {}) {
  return {
    name: 'Arijit Singh Live',
    venue: 'NSCI Dome',
    city: 'Mumbai',
    startsAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    saleStartsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    seatMap: seatMap(),
    ...overrides,
  };
}

/**
 * An event that is published and already on sale, with its seats.
 * saleStartsAt is in the past, which the API itself would not accept on create.
 */
async function createOnSaleEvent({ organiserId, seats = {}, ...overrides } = {}) {
  const orgId = organiserId ?? (await createUser('organiser')).id;
  const input = {
    ...eventInput(overrides),
    saleStartsAt: new Date(Date.now() - HOUR),
    startsAt: new Date(Date.now() + 7 * 24 * HOUR),
    seatMap: seatMap(seats),
  };
  const { event } = await eventsService.createEvent(orgId, input);
  await eventsService.publishEvent(orgId, event.id);
  const seatDocs = await Seat.find({ eventId: event.id }).sort({ section: 1, row: 1, number: 1 }).lean();
  return { event, seatIds: seatDocs.map((s) => String(s._id)), organiserId: orgId };
}

module.exports = { createUser, createUsers, seatMap, eventInput, createOnSaleEvent, HOUR };
