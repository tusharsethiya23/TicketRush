const { Schema, model } = require('mongoose');

const SEAT_STATUSES = ['available', 'held', 'booked'];

const seatSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  section: { type: String, required: true, trim: true, maxlength: 50 },
  row: { type: String, required: true, trim: true, maxlength: 10 },
  number: { type: Number, required: true, min: 1 },
  pricePaise: {
    type: Number,
    required: true,
    min: 0,
    validate: { validator: Number.isInteger, message: 'pricePaise must be an integer' },
  },
  status: { type: String, enum: SEAT_STATUSES, default: 'available' },
  holdId: { type: Schema.Types.ObjectId, ref: 'Hold', default: null },
});

seatSchema.index({ eventId: 1, section: 1, row: 1, number: 1 }, { unique: true });
seatSchema.index({ eventId: 1, status: 1 });
seatSchema.index({ holdId: 1 });

module.exports = model('Seat', seatSchema);
module.exports.SEAT_STATUSES = SEAT_STATUSES;
