const { z } = require('zod');
const { isoDate } = require('../../lib/schemas');

const MAX_SEATS_PER_EVENT = 10_000;

const text = (max) => z.string().trim().min(1).max(max);
const unique = (values) => new Set(values).size === values.length;

const rowSchema = z.strictObject({
  label: text(10),
  seatCount: z.int().min(1).max(100),
  pricePaise: z.int().min(0).max(100_000_000), // up to ₹10 lakh per seat
});

const sectionSchema = z.strictObject({
  name: text(50),
  rows: z
    .array(rowSchema)
    .min(1)
    .max(100)
    .refine((rows) => unique(rows.map((r) => r.label.toLowerCase())), 'Row labels must be unique within a section'),
});

/** Sections → rows → numbered seats; each row has one price (FR-4). */
const seatMapSchema = z
  .strictObject({ sections: z.array(sectionSchema).min(1).max(20) })
  .refine((m) => unique(m.sections.map((s) => s.name.toLowerCase())), 'Section names must be unique')
  .refine(
    (m) => countSeats(m) <= MAX_SEATS_PER_EVENT,
    `An event can have at most ${MAX_SEATS_PER_EVENT} seats`,
  );

function countSeats(seatMap) {
  return seatMap.sections.reduce((sum, s) => sum + s.rows.reduce((n, r) => n + r.seatCount, 0), 0);
}

const eventFields = {
  name: text(200),
  venue: text(200),
  city: text(100),
  startsAt: isoDate,
  saleStartsAt: isoDate,
  seatMap: seatMapSchema,
};

/** Checked here for creates, and again in the service for edits once merged with stored values. */
function checkTimes(startsAt, saleStartsAt) {
  const problems = [];
  if (startsAt <= new Date()) problems.push({ path: ['startsAt'], message: 'startsAt must be in the future' });
  if (saleStartsAt >= startsAt) problems.push({ path: ['saleStartsAt'], message: 'saleStartsAt must be before startsAt' });
  return problems;
}

const createEventSchema = z.strictObject(eventFields).superRefine((e, ctx) => {
  for (const p of checkTimes(e.startsAt, e.saleStartsAt)) ctx.addIssue({ code: 'custom', ...p });
});

const updateEventSchema = z
  .strictObject(eventFields)
  .partial()
  .refine((e) => Object.keys(e).length > 0, 'Send at least one field to change');

const listEventsQuery = z.object({
  city: text(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

module.exports = { createEventSchema, updateEventSchema, listEventsQuery, checkTimes, countSeats, MAX_SEATS_PER_EVENT };
