const { Schema, model } = require('mongoose');

const EVENT_STATUSES = ['draft', 'on_sale', 'sold_out', 'ended'];

const eventSchema = new Schema(
  {
    organiserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    venue: { type: String, required: true, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    startsAt: { type: Date, required: true },
    saleStartsAt: { type: Date, required: true },
    status: { type: String, enum: EVENT_STATUSES, default: 'draft' },
    soldOutAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Case-insensitive collation so "mumbai" finds "Mumbai"; queries must use CITY_COLLATION to hit it.
const CITY_COLLATION = { locale: 'en', strength: 2 };
eventSchema.index({ city: 1, startsAt: 1 }, { collation: CITY_COLLATION });
eventSchema.index({ organiserId: 1 });

module.exports = model('Event', eventSchema);
module.exports.EVENT_STATUSES = EVENT_STATUSES;
module.exports.CITY_COLLATION = CITY_COLLATION;
