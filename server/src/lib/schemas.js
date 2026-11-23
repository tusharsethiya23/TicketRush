const { z } = require('zod');

/** Shared zod building blocks. */
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

/** ISO 8601 date-time with a timezone (UTC stored, SRS 2.4). */
const isoDate = z.iso
  .datetime({ offset: true, message: 'Must be an ISO 8601 date-time with a timezone' })
  .transform((s) => new Date(s));

const idParams = z.object({ id: objectId });

module.exports = { objectId, isoDate, idParams };
