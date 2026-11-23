const { Schema, model } = require('mongoose');

const BOOKING_STATUSES = ['confirmed', 'cancelled'];

const bookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    holdId: { type: Schema.Types.ObjectId, ref: 'Hold', required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    seatIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Seat' }],
      validate: { validator: (ids) => ids.length >= 1, message: 'A booking needs at least one seat' },
    },
    totalPaise: { type: Number, required: true, min: 0 },
    ticketCode: { type: String, required: true },
    status: { type: String, enum: BOOKING_STATUSES, default: 'confirmed' },
    cancelledAt: { type: Date, default: null },
    emailSentAt: { type: Date, default: null }, // set by the email job, so a re-run never emails twice
  },
  { timestamps: true },
);

bookingSchema.index({ holdId: 1 }, { unique: true });
bookingSchema.index({ ticketCode: 1 }, { unique: true });
bookingSchema.index({ userId: 1, createdAt: -1 });
// Last guard against double-booking (NFR-1): a multikey unique index over the seats
// of confirmed bookings only, so a cancelled booking frees its seats for rebooking.
bookingSchema.index(
  { seatIds: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' }, name: 'uniq_confirmed_seat' },
);

module.exports = model('Booking', bookingSchema);
module.exports.BOOKING_STATUSES = BOOKING_STATUSES;
