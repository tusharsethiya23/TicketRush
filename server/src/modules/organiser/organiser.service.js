const { Types } = require('mongoose');
const AppError = require('../../lib/AppError');
const { Booking, Event, Hold, Seat } = require('../../models');
const { toPublicEvent } = require('../events/events.service');

const notFound = () => new AppError(404, 'NOT_FOUND', 'Event not found');

/** An event the organiser owns, in any status. Someone else's event is 404 (NFR-14). */
async function loadOwnEvent(organiserId, eventId) {
  const event = await Event.findOne({ _id: eventId, organiserId }).lean();
  if (!event) throw notFound();
  return event;
}

/** The organiser's events, drafts included, newest first. */
async function listOwnEvents(organiserId, { status, page, limit }) {
  const filter = { organiserId };
  if (status) filter.status = status;
  const [events, total] = await Promise.all([
    Event.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Event.countDocuments(filter),
  ]);
  return { events: events.map(toPublicEvent), page, limit, total };
}

/**
 * Rebuilds the seat map an event was created from, for the edit form (FR-25).
 * Seats were inserted in seat-map order, so sorting by _id keeps the organiser's
 * section and row order. Each row has one price (SRS 7.1).
 */
function seatMapFromSeats(seats) {
  const sections = [];
  const byName = new Map();
  for (const seat of seats) {
    let section = byName.get(seat.section);
    if (!section) {
      section = { name: seat.section, rows: [], rowByLabel: new Map() };
      byName.set(seat.section, section);
      sections.push(section);
    }
    let row = section.rowByLabel.get(seat.row);
    if (!row) {
      row = { label: seat.row, seatCount: 0, pricePaise: seat.pricePaise };
      section.rowByLabel.set(seat.row, row);
      section.rows.push(row);
    }
    row.seatCount = Math.max(row.seatCount, seat.number);
  }
  return { sections: sections.map(({ name, rows }) => ({ name, rows })) };
}

async function getOwnEvent(organiserId, eventId) {
  const event = await loadOwnEvent(organiserId, eventId);
  const seats = await Seat.find({ eventId: event._id }).sort({ _id: 1 }).select('section row number pricePaise').lean();
  return { event: toPublicEvent(event), seatMap: seatMapFromSeats(seats), seatCount: seats.length };
}

/** FR-31: seats sold, revenue and active holds for one of the organiser's events. */
async function getSales(organiserId, eventId) {
  const event = await loadOwnEvent(organiserId, eventId);
  const id = new Types.ObjectId(String(event._id));

  const [seatGroups, bookingGroups, activeHolds] = await Promise.all([
    Seat.aggregate([{ $match: { eventId: id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Booking.aggregate([
      { $match: { eventId: id } },
      { $group: { _id: '$status', count: { $sum: 1 }, totalPaise: { $sum: '$totalPaise' } } },
    ]),
    Hold.countDocuments({ eventId: id, status: 'active', expiresAt: { $gt: new Date() } }),
  ]);

  const seats = { total: 0, available: 0, held: 0, booked: 0 };
  for (const g of seatGroups) {
    seats[g._id] = g.count;
    seats.total += g.count;
  }
  const confirmed = bookingGroups.find((g) => g._id === 'confirmed');
  const cancelled = bookingGroups.find((g) => g._id === 'cancelled');

  return {
    event: toPublicEvent(event),
    seats,
    bookings: { confirmed: confirmed?.count ?? 0, cancelled: cancelled?.count ?? 0 },
    revenuePaise: confirmed?.totalPaise ?? 0, // cancelled bookings are not revenue
    activeHolds,
  };
}

module.exports = { listOwnEvents, getOwnEvent, getSales, seatMapFromSeats };
