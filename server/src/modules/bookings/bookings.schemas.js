const { z } = require('zod');

/** Confirm takes no body; the hold ID in the path is the whole request. */
const confirmBodySchema = z.strictObject({});

/** Idempotency-Key: 1 to 255 visible ASCII characters (a UUID from the client is typical). */
const idempotencyKey = z.string().regex(/^[\x21-\x7E]{1,255}$/, 'Must be 1 to 255 visible ASCII characters');

const listBookingsQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

module.exports = { confirmBodySchema, idempotencyKey, listBookingsQuery };
