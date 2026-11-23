const AppError = require('../../lib/AppError');
const { runTransaction } = require('../../lib/transaction');
const { Event, Seat } = require('../../models');
const { CITY_COLLATION } = require('../../models/Event');
const { checkTimes } = require('./events.schemas');

const PUBLIC_STATUSES = ['on_sale', 'sold_out', 'ended'];
const notFound = () => new AppError(404, 'NOT_FOUND', 'Event not found');

const toPublicEvent = (e) => ({
  id: String(e._id),
  organiserId: String(e.organiserId),
  name: e.name,
  venue: e.venue,
  city: e.city,
  startsAt: e.startsAt,
  saleStartsAt: e.saleStartsAt,
  status: e.status,
  soldOutAt: e.soldOutAt ?? null,
});

function buildSeats(eventId, seatMap) {
  const seats = [];
  for (const section of seatMap.sections) {
    for (const row of section.rows) {
      for (let number = 1; number <= row.seatCount; number++) {
        seats.push({ eventId, section: section.name, row: row.label, number, pricePaise: row.pricePaise });
      }
    }
  }
  return seats;
}

/** FR-4: the event and all its seats are written together or not at all. */
async function createEvent(organiserId, { seatMap, ...fields }) {
  return runTransaction(async (session) => {
    const [event] = await Event.create([{ ...fields, organiserId }], { session });
    const seats = await Seat.insertMany(buildSeats(event._id, seatMap), { session });
    return { event: toPublicEvent(event), seatCount: seats.length };
  });
}

/**
 * Loads an event the organiser owns that is still a draft. Another organiser's event
 * is reported as missing, not forbidden, so IDs cannot be probed (NFR-14).
 */
async function loadOwnDraft(organiserId, eventId, session) {
  const event = await Event.findOne({ _id: eventId, organiserId }).session(session ?? null);
  if (!event) throw notFound();
  if (event.status !== 'draft') {
    throw new AppError(409, 'EVENT_NOT_EDITABLE', 'Only a draft event can be changed');
  }
  return event;
}

/** FR-4: edit a draft; a new seat map replaces every seat. */
async function updateEvent(organiserId, eventId, { seatMap, ...fields }) {
  return runTransaction(async (session) => {
    const event = await loadOwnDraft(organiserId, eventId, session);

    const problems = checkTimes(fields.startsAt ?? event.startsAt, fields.saleStartsAt ?? event.saleStartsAt);
    if (problems.length) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Request is invalid', problems.map((p) => ({ ...p, path: p.path.join('.') })));
    }

    event.set(fields);
    await event.save({ session });

    if (seatMap) {
      await Seat.deleteMany({ eventId: event._id }, { session });
      await Seat.insertMany(buildSeats(event._id, seatMap), { session });
    }
    const seatCount = await Seat.countDocuments({ eventId: event._id }).session(session);
    return { event: toPublicEvent(event), seatCount };
  });
}

/** FR-27: a draft goes on sale; holds still wait for saleStartsAt. */
async function publishEvent(organiserId, eventId) {
  const event = await Event.findOneAndUpdate(
    { _id: eventId, organiserId, status: 'draft' },
    { $set: { status: 'on_sale' } },
    { new: true },
  );
  if (event) return toPublicEvent(event);

  // Not updated: find out why, so the caller gets 404 or 409 EVENT_NOT_EDITABLE.
  await loadOwnDraft(organiserId, eventId);
  throw notFound();
}

/** FR-5: published, upcoming events, filtered by city and date, oldest first. */
async function listEvents({ city, from, to, page, limit }) {
  const filter = { status: { $in: ['on_sale', 'sold_out'] }, startsAt: { $gte: from ?? new Date() } };
  if (to) filter.startsAt.$lte = to;
  if (city) filter.city = city;

  const [events, total] = await Promise.all([
    Event.find(filter)
      .collation(CITY_COLLATION)
      .sort({ startsAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Event.countDocuments(filter).collation(CITY_COLLATION),
  ]);

  return { events: events.map(toPublicEvent), page, limit, total };
}

async function getPublishedEvent(eventId) {
  const event = await Event.findOne({ _id: eventId, status: { $in: PUBLIC_STATUSES } }).lean();
  if (!event) throw notFound();
  return event;
}

/** FR-6: every seat with its status. holdId is internal and never exposed. */
async function getSeatMap(eventId) {
  await getPublishedEvent(eventId);
  const seats = await Seat.find({ eventId })
    .select('section row number pricePaise status')
    .sort({ section: 1, row: 1, number: 1 })
    .lean();

  return seats.map((s) => ({
    id: String(s._id),
    section: s.section,
    row: s.row,
    number: s.number,
    pricePaise: s.pricePaise,
    status: s.status,
  }));
}

module.exports = {
  createEvent,
  updateEvent,
  publishEvent,
  listEvents,
  getPublishedEvent,
  getSeatMap,
  toPublicEvent,
  buildSeats,
};
