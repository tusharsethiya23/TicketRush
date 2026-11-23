const { Types } = require('mongoose');
const config = require('../../config/env');
const AppError = require('../../lib/AppError');
const { runTransaction, TransactionConflictError } = require('../../lib/transaction');
const { Event, Seat, Hold } = require('../../models');
const { getRedis } = require('../../lib/redis');
const { keys, TTL } = require('../../lib/cache');
const logger = require('../../lib/logger');
const { jobs } = require('../../jobs/queues');

const seatTaken = () => new AppError(409, 'SEAT_TAKEN', 'One or more seats are no longer available');

const toPublicHold = (h) => ({
  id: String(h._id),
  eventId: String(h.eventId),
  seatIds: h.seatIds.map(String),
  status: h.status,
  expiresAt: h.expiresAt,
});

async function checkEventOnSale(eventId, now) {
  const event = await Event.findById(eventId).select('status saleStartsAt').lean();
  if (!event || event.status === 'draft') throw new AppError(404, 'NOT_FOUND', 'Event not found');
  // sold_out is let through: the seats themselves decide, and the answer is 409.
  const open = ['on_sale', 'sold_out'].includes(event.status) && event.saleStartsAt <= now;
  if (!open) throw new AppError(403, 'SALE_NOT_STARTED', 'Tickets for this event are not on sale');
}

/** FR-29: anti-abuse cap. Outside the transaction on purpose; it does not guard double-booking. */
async function checkHoldCap(userId, eventId, now) {
  const active = await Hold.countDocuments({ userId, eventId, status: 'active', expiresAt: { $gt: now } });
  if (active >= config.MAX_ACTIVE_HOLDS_PER_EVENT) {
    throw new AppError(
      429,
      'TOO_MANY_HOLDS',
      `You already have ${config.MAX_ACTIVE_HOLDS_PER_EVENT} active holds for this event`,
    );
  }
}

/**
 * FR-7, FR-8, NFR-2 (SRS 6.1). Each seat moves from available to held only if it is
 * still available, so two holds can never win the same seat. If any seat is missing,
 * the transaction aborts and no seat stays held.
 */
async function createHold({ userId, eventId, seatIds }) {
  const now = new Date();
  await checkEventOnSale(eventId, now);
  await checkHoldCap(userId, eventId, now);

  const holdId = new Types.ObjectId();
  const expiresAt = new Date(now.getTime() + config.HOLD_TTL_SECONDS * 1000);

  try {
    const hold = await runTransaction(async (session) => {
      const { modifiedCount } = await Seat.updateMany(
        { _id: { $in: seatIds }, eventId, status: 'available' },
        { $set: { status: 'held', holdId } },
        { session },
      );
      if (modifiedCount !== seatIds.length) throw seatTaken();

      const [created] = await Hold.create([{ _id: holdId, userId, eventId, seatIds, expiresAt }], { session });
      return created;
    });
    // SRS 6.1 step 5. Not awaited and never throws; the sweep covers a lost job.
    jobs.scheduleHoldRelease(hold._id, hold.expiresAt);
    return toPublicHold(hold);
  } catch (err) {
    if (err instanceof TransactionConflictError) {
      recordFailedHold(eventId);
      throw seatTaken();
    }
    if (err.code === 'SEAT_TAKEN') {
      await explainShortfall(eventId, seatIds);
      recordFailedHold(eventId);
    }
    throw err;
  }
}

/** FR-18 input: lost races per event. Best effort and never awaited (SRS 7.2). */
function recordFailedHold(eventId) {
  const key = keys.failedHolds(eventId);
  getRedis()
    .multi()
    .incr(key)
    .expire(key, TTL.stats)
    .exec()
    .catch((err) => logger.warn({ err: err.message }, 'Could not record failed hold'));
}

/** Only on the failure path: a seat ID from another event is a bad request, not a lost race. */
async function explainShortfall(eventId, seatIds) {
  const found = await Seat.countDocuments({ _id: { $in: seatIds }, eventId });
  if (found !== seatIds.length) {
    throw new AppError(400, 'VALIDATION_FAILED', 'One or more seats do not belong to this event');
  }
}

/**
 * SRS 6.3: the one way a hold's seats go back to available. Used for an early release
 * (FR-10), and by the release-hold job and the sweep (src/jobs/processors.js). The hold changes only while
 * it is still active, so this can never undo a confirmed booking.
 *
 * @returns true if this call released the hold, false if it was no longer active.
 */
async function releaseHold(holdId, { reason, userId } = {}) {
  const status = reason === 'expired' ? 'expired' : 'released';
  const filter = { _id: holdId, status: 'active' };
  if (userId) filter.userId = userId;
  if (reason === 'expired') filter.expiresAt = { $lte: new Date() };

  return runTransaction(async (session) => {
    const { modifiedCount } = await Hold.updateOne(filter, { $set: { status } }, { session });
    if (modifiedCount === 0) return false;

    await Seat.updateMany(
      { holdId, status: 'held' },
      { $set: { status: 'available', holdId: null } },
      { session },
    );
    return true;
  });
}

/** FR-10: DELETE /holds/:id */
async function releaseOwnHold(userId, holdId) {
  if (await releaseHold(holdId, { reason: 'released', userId })) {
    jobs.cancelHoldRelease(holdId);
    return;
  }

  const hold = await Hold.findOne({ _id: holdId, userId }).select('status').lean();
  if (!hold) throw new AppError(404, 'NOT_FOUND', 'Hold not found');
  throw new AppError(410, 'HOLD_EXPIRED', `This hold is already ${hold.status}`);
}

module.exports = { createHold, releaseHold, releaseOwnHold, toPublicHold };
