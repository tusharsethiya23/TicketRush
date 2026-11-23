const { Schema, model } = require('mongoose');

const PAYMENT_STATUSES = ['succeeded', 'failed', 'refunded'];

/** Simulated payments; a 'refunded' row records a paid-but-expired hold (FR-13). */
const paymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    holdId: { type: Schema.Types.ObjectId, ref: 'Hold', required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    status: { type: String, enum: PAYMENT_STATUSES, required: true },
  },
  { timestamps: true },
);

paymentSchema.index({ holdId: 1 });

module.exports = model('Payment', paymentSchema);
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
