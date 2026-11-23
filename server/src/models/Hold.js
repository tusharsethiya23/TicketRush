const { Schema, model } = require('mongoose');

const HOLD_STATUSES = ['active', 'converted', 'expired', 'released'];
const MAX_SEATS_PER_HOLD = 6;

const holdSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    seatIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Seat' }],
      validate: {
        validator: (ids) => ids.length >= 1 && ids.length <= MAX_SEATS_PER_HOLD,
        message: `A hold must have 1 to ${MAX_SEATS_PER_HOLD} seats`,
      },
    },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: HOLD_STATUSES, default: 'active' },
  },
  { timestamps: true },
);

holdSchema.index({ status: 1, expiresAt: 1 }); // sweep job (NFR-6)
holdSchema.index({ userId: 1, eventId: 1, status: 1 }); // hold cap (FR-29)

module.exports = model('Hold', holdSchema);
module.exports.HOLD_STATUSES = HOLD_STATUSES;
module.exports.MAX_SEATS_PER_HOLD = MAX_SEATS_PER_HOLD;
