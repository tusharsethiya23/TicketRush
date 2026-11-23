const { z } = require('zod');
const { objectId } = require('../../lib/schemas');
const { MAX_SEATS_PER_HOLD } = require('../../models/Hold');

/** FR-7: 1 to 6 distinct seats. Duplicates would let one hold count a seat twice (SRS 7.1). */
const createHoldSchema = z.strictObject({
  seatIds: z
    .array(objectId)
    .min(1, 'Pick at least one seat')
    .max(MAX_SEATS_PER_HOLD, `Pick at most ${MAX_SEATS_PER_HOLD} seats`)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'Seat IDs must be unique'),
});

module.exports = { createHoldSchema };
