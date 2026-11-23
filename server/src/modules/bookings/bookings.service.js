const crypto = require('node:crypto');
const AppError = require('../../lib/AppError');
const logger = require('../../lib/logger');
const payments = require('../../lib/payments');
const { runTransaction } = require('../../lib/transaction');
const { invalidate, keys } = require('../../lib/cache');
const { Booking, Event, Hold, IdempotencyKey, Payment, Seat } = require('../../models');

/** A `processing` key older than this belongs to a request that crashed; it can be taken over. */
const STALE_PROCESSING_MS = 60_000;
const CANCEL_CUTOFF_MS = 24 * 60 * 60 * 1000;

/** Thrown inside the booking transaction when the hold or its seats are no longer ours. */
class HoldGoneError extends Error {}

const inProgress = () =>
  new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');

const toPublicBooking = (b) => ({
  id: String(b._id),
  eventId: String(b.eventId),
  holdId: String(b.holdId),
  seatIds: b.seatIds.map(String),
  totalPaise: b.totalPaise,
  ticketCode: b.ticketCode,
  status: b.status,
  createdAt: b.createdAt,
  cancelledAt: b.cancelledAt ?? null,
});

/** Confirm takes no body, so the hold is the whole request: one key, one hold. */
const requestHash = (holdId) => crypto.createHash('sha256').update(`POST /holds/${holdId}/confirm`).digest('hex');

const newTicketCode = () => `TR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

/**
 * SRS 6.2 step 1. The unique (userId, key) index lets exactly one request claim a key.
 * @returns {{ claim }} for the request that should do the work, or {{ replay }} with a stored response
 */
async function claimKey(userId, key, hash) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { claim: await IdempotencyKey.create({ userId, key, requestHash: hash }) };
    } catch (err) {
      if (err.code !== 11000) throw err;
    }

    const existing = await IdempotencyKey.findOne({ userId, key }).lean();
    if (!existing) continue; // freed by a 402 between our insert and this read; claim again

    if (existing.requestHash !== hash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    if (existing.status === 'completed') {
      return { replay: { status: existing.responseStatus, body: existing.responseBody } };
    }
    if (Date.now() - existing.createdAt.getTime() < STALE_PROCESSING_MS) throw inProgress();

    // The first request crashed. Only one taker wins, because the filter pins the old createdAt.
    const taken = await IdempotencyKey.findOneAndUpdate(
      { _id: existing._id, status: 'processing', createdAt: existing.createdAt },
      { $set: { createdAt: new Date() } },
      { new: true },
    );
    if (taken) return { claim: taken };
  }
  throw inProgress();
}

/** Stores a finished 410 so every repeat of the key gets the same answer (FR-11). */
async function finishExpired(claim, message) {
  const body = { error: { code: 'HOLD_EXPIRED', message } };
  await IdempotencyKey.updateOne(
    { _id: claim._id, status: 'processing' },
    { $set: { status: 'completed', responseStatus: 410, responseBody: body } },
  );
  return { status: 410, body };
}

/** FR-13: the money goes back whenever a successful charge does not end in a booking. */
async function refund(paymentId) {
  try {
    await Payment.updateOne({ _id: paymentId, status: 'succeeded' }, { $set: { status: 'refunded' } });
  } catch (err) {
    logger.error({ err, paymentId: String(paymentId) }, 'Could not record refund');
  }
}

/**
 * FR-28: once every seat is booked, the event is sold_out. soldOutAt is set only the
 * first time, so a cancel and a second sell-out keep the original time-to-sell-out.
 * Best effort after the booking commits; it must never fail the confirm.
 */
async function markSoldOutIfFull(eventId) {
  try {
    if (await Seat.exists({ eventId, status: { $ne: 'booked' } })) return;
    const now = new Date();
    const { modifiedCount } = await Event.updateOne({ _id: eventId, status: 'on_sale' }, [
      { $set: { status: 'sold_out', soldOutAt: { $ifNull: ['$soldOutAt', now] } } },
    ]);
    if (modifiedCount) await invalidate(keys.event(String(eventId)));
  } catch (err) {
    logger.error({ err, eventId: String(eventId) }, 'Could not mark event sold out');
  }
}

/** SRS 6.2 steps 2 to 6, run by the request that holds the claimed key. */
async function confirmClaimed(userId, holdId, claim) {
  // Step 2: check the hold.
  const hold = await Hold.findOne({ _id: holdId, userId }).lean();
  if (!hold) throw new AppError(404, 'NOT_FOUND', 'Hold not found');
  if (hold.status !== 'active') return finishExpired(claim, `This hold is already ${hold.status}`);
  if (hold.expiresAt <= new Date()) return finishExpired(claim, 'This hold has expired');

  const seats = await Seat.find({ _id: { $in: hold.seatIds }, holdId: hold._id, status: 'held' })
    .select('pricePaise')
    .lean();
  if (seats.length !== hold.seatIds.length) return finishExpired(claim, 'This hold has expired');
  const amountPaise = seats.reduce((sum, s) => sum + s.pricePaise, 0);

  // Step 3: pay, outside any transaction. A decline frees the key (the caller deletes it).
  const paid = await payments.charge({ amountPaise });
  const payment = await Payment.create({ userId, holdId, amountPaise, status: paid ? 'succeeded' : 'failed' });
  if (!paid) {
    throw new AppError(402, 'PAYMENT_FAILED', 'Payment was declined. Retry with the same Idempotency-Key.');
  }

  // Step 4: book. The hold, the seats, the booking and the stored response commit together.
  let result;
  try {
    result = await runTransaction(async (session) => {
      const now = new Date();
      const converted = await Hold.updateOne(
        { _id: hold._id, status: 'active', expiresAt: { $gt: now } },
        { $set: { status: 'converted' } },
        { session },
      );
      if (converted.modifiedCount !== 1) throw new HoldGoneError();

      const booked = await Seat.updateMany(
        { _id: { $in: hold.seatIds }, holdId: hold._id, status: 'held' },
        { $set: { status: 'booked' } },
        { session },
      );
      if (booked.modifiedCount !== hold.seatIds.length) throw new HoldGoneError();

      const [booking] = await Booking.create(
        [
          {
            userId,
            holdId: hold._id,
            eventId: hold.eventId,
            seatIds: hold.seatIds,
            totalPaise: amountPaise,
            ticketCode: newTicketCode(),
          },
        ],
        { session },
      );

      const body = { booking: toPublicBooking(booking) };
      await IdempotencyKey.updateOne(
        { _id: claim._id },
        { $set: { status: 'completed', responseStatus: 201, responseBody: body } },
        { session },
      );
      return { status: 201, body };
    });
  } catch (err) {
    await refund(payment._id);
    // Step 5: the hold expired (or was released) while the payment ran.
    if (err instanceof HoldGoneError) {
      return finishExpired(claim, 'The hold expired during payment. The payment has been refunded.');
    }
    throw err;
  }

  // Step 6. The confirmation email and removing the release-hold job come with phase 5.
  await markSoldOutIfFull(hold.eventId);
  return result;
}

/**
 * POST /holds/:id/confirm (FR-11 to FR-13, SRS 6.2).
 * @returns {{ status: number, body: object, replayed?: boolean }}
 */
async function confirmHold({ userId, holdId, key }) {
  const { claim, replay } = await claimKey(userId, key, requestHash(holdId));
  if (replay) return { ...replay, replayed: true };

  try {
    return await confirmClaimed(userId, holdId, claim);
  } catch (err) {
    // Only 201 and 410 are stored. Anything else (402, 404, 409, 500) frees the key for a retry.
    await IdempotencyKey.deleteOne({ _id: claim._id, status: 'processing' }).catch((e) =>
      logger.error({ err: e }, 'Could not free idempotency key'),
    );
    throw err;
  }
}

/** GET /me/bookings (FR-14): newest first, with the event and seat details a ticket needs. */
async function listMyBookings(userId, { page, limit }) {
  const filter = { userId };
  const [rows, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Booking.countDocuments(filter),
  ]);

  const [events, seats] = await Promise.all([
    Event.find({ _id: { $in: [...new Set(rows.map((b) => String(b.eventId)))] } })
      .select('name venue city startsAt status')
      .lean(),
    Seat.find({ _id: { $in: rows.flatMap((b) => b.seatIds) } })
      .select('section row number pricePaise')
      .lean(),
  ]);
  const eventById = new Map(events.map((e) => [String(e._id), e]));
  const seatById = new Map(seats.map((s) => [String(s._id), s]));

  const bookings = rows.map((b) => {
    const e = eventById.get(String(b.eventId));
    return {
      ...toPublicBooking(b),
      event: e && { id: String(e._id), name: e.name, venue: e.venue, city: e.city, startsAt: e.startsAt, status: e.status },
      seats: b.seatIds
        .map((id) => seatById.get(String(id)))
        .filter(Boolean)
        .map((s) => ({ id: String(s._id), section: s.section, row: s.row, number: s.number, pricePaise: s.pricePaise })),
    };
  });

  return { bookings, page, limit, total };
}

/**
 * POST /bookings/:id/cancel (FR-14, FR-30, SRS 6.4). Cancelling an already cancelled
 * booking returns it unchanged, so a retried request is harmless.
 */
async function cancelBooking(userId, bookingId) {
  const booking = await Booking.findOne({ _id: bookingId, userId }).lean();
  if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking not found');
  if (booking.status === 'cancelled') return toPublicBooking(booking);

  const event = await Event.findById(booking.eventId).select('startsAt').lean();
  if (!event || event.startsAt.getTime() - Date.now() <= CANCEL_CUTOFF_MS) {
    throw new AppError(409, 'CANCEL_WINDOW_CLOSED', 'Bookings can only be cancelled up to 24 hours before the event');
  }

  const { cancelled, reopened } = await runTransaction(async (session) => {
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'confirmed' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { session, new: true },
    ).lean();
    if (!updated) return { cancelled: null }; // a parallel cancel won

    await Seat.updateMany(
      { _id: { $in: booking.seatIds }, holdId: booking.holdId, status: 'booked' },
      { $set: { status: 'available', holdId: null } },
      { session },
    );
    // FR-28: back on sale, but soldOutAt keeps the first sell-out time.
    const ev = await Event.updateOne(
      { _id: booking.eventId, status: 'sold_out' },
      { $set: { status: 'on_sale' } },
      { session },
    );
    return { cancelled: updated, reopened: ev.modifiedCount === 1 };
  });

  if (!cancelled) return toPublicBooking(await Booking.findById(booking._id).lean());
  if (reopened) await invalidate(keys.event(String(booking.eventId)));
  return toPublicBooking(cancelled);
}

module.exports = {
  confirmHold,
  listMyBookings,
  cancelBooking,
  markSoldOutIfFull,
  toPublicBooking,
  STALE_PROCESSING_MS,
};
