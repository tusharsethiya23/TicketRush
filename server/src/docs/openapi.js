/**
 * OpenAPI 3 description of the API, served by Swagger UI at /docs (NFR-10).
 * tests/docs.test.js fails if an Express route is missing from `paths`.
 */
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description) => ({ ...(description && { description }), content: { 'application/json': { schema } } });
const ok = (schema, description = 'OK') => json(schema, description);
const err = (description) => json(ref('Error'), description);
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const array = (items) => ({ type: 'array', items });

const id = { type: 'string', pattern: '^[a-f0-9]{24}$', example: '6741c0ffee0000000000abcd' };
const dateTime = { type: 'string', format: 'date-time' };
const paise = { type: 'integer', minimum: 0, description: 'Amount in paise (₹1 = 100)' };

const idParam = { name: 'id', in: 'path', required: true, schema: id };
const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
];
const pageFields = { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } };

const bearer = [{ bearerAuth: [] }];
const common = {
  400: err('VALIDATION_FAILED'),
  429: err('RATE_LIMITED (with Retry-After), or TOO_MANY_HOLDS on holds'),
};
const authed = { ...common, 401: err('UNAUTHENTICATED'), 403: err('FORBIDDEN: wrong role or blocked account') };

const seatMap = object({
  sections: array(
    object({
      name: { type: 'string', maxLength: 50 },
      rows: array(
        object({
          label: { type: 'string', maxLength: 10 },
          seatCount: { type: 'integer', minimum: 1, maximum: 100 },
          pricePaise: { ...paise, maximum: 100_000_000 },
        }),
      ),
    }),
  ),
});

const schemas = {
  Error: object({
    error: object(
      {
        code: { type: 'string', example: 'SEAT_TAKEN' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: array(object({ path: { type: 'string' }, message: { type: 'string' } })),
      },
      ['code', 'message', 'requestId'],
    ),
  }),
  User: object({ id, email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['user', 'organiser', 'admin'] } }),
  AdminUser: object({
    id,
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['user', 'organiser', 'admin'] },
    status: { type: 'string', enum: ['active', 'blocked'] },
    createdAt: dateTime,
  }),
  Credentials: object({
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8, description: 'At most 72 bytes' },
  }),
  SeatMap: seatMap,
  EventInput: object({
    name: { type: 'string', maxLength: 200 },
    venue: { type: 'string', maxLength: 200 },
    city: { type: 'string', maxLength: 100 },
    startsAt: { ...dateTime, description: 'In the future, with a timezone' },
    saleStartsAt: { ...dateTime, description: 'Before startsAt' },
    seatMap: ref('SeatMap'),
  }),
  Event: object({
    id,
    organiserId: id,
    name: { type: 'string' },
    venue: { type: 'string' },
    city: { type: 'string' },
    startsAt: dateTime,
    saleStartsAt: dateTime,
    status: { type: 'string', enum: ['draft', 'on_sale', 'sold_out', 'ended'] },
    soldOutAt: { ...dateTime, nullable: true },
  }),
  Seat: object({
    id,
    section: { type: 'string' },
    row: { type: 'string' },
    number: { type: 'integer' },
    pricePaise: paise,
    status: { type: 'string', enum: ['available', 'held', 'booked'] },
  }),
  Hold: object({
    id,
    eventId: id,
    seatIds: array(id),
    status: { type: 'string', enum: ['active', 'converted', 'expired', 'released'] },
    expiresAt: dateTime,
  }),
  Booking: object({
    id,
    eventId: id,
    holdId: id,
    seatIds: array(id),
    totalPaise: paise,
    ticketCode: { type: 'string', example: 'TR-3F9A1C2B7D4E' },
    status: { type: 'string', enum: ['confirmed', 'cancelled'] },
    createdAt: dateTime,
    cancelledAt: { ...dateTime, nullable: true },
  }),
};

// An edit sends any subset of the event fields, at least one.
schemas.EventPatch = { type: 'object', properties: schemas.EventInput.properties, minProperties: 1 };

const auth = (summary, extra = {}) => ({ tags: ['Auth'], summary, ...extra });

const paths = {
  '/health': {
    get: {
      tags: ['Ops'],
      summary: 'API, MongoDB and Redis status (FR-19)',
      responses: {
        200: ok(object({ status: { type: 'string', enum: ['ok'] }, checks: { type: 'object' } })),
        503: ok(object({ status: { type: 'string', enum: ['degraded'] }, checks: { type: 'object' } }), 'A store is down'),
      },
    },
  },

  '/api/v1/auth/register': {
    post: auth('Create a user or organiser account (FR-1)', {
      requestBody: json({ allOf: [ref('Credentials'), { properties: { role: { type: 'string', enum: ['user', 'organiser'], default: 'user' } } }] }),
      responses: { 201: ok(object({ user: ref('User') }), 'Created'), 409: err('EMAIL_TAKEN'), ...common },
    }),
  },
  '/api/v1/auth/login': {
    post: auth('Log in: returns an access token and sets the httpOnly refresh cookie `rt` (FR-2)', {
      requestBody: json(ref('Credentials')),
      responses: {
        200: ok(object({ user: ref('User'), accessToken: { type: 'string' } })),
        401: err('INVALID_CREDENTIALS'),
        403: err('FORBIDDEN: account blocked'),
        ...common,
      },
    }),
  },
  '/api/v1/auth/refresh': {
    post: auth('Rotate the refresh cookie and get a new access token (FR-2, FR-26)', {
      security: [{ refreshCookie: [] }],
      responses: { 200: ok(object({ user: ref('User'), accessToken: { type: 'string' } })), 401: err('UNAUTHENTICATED: missing, expired or reused refresh token') },
    }),
  },
  '/api/v1/auth/logout': {
    post: auth('Revoke the refresh token and clear the cookie (FR-26)', {
      security: [{ refreshCookie: [] }],
      responses: { 204: { description: 'Logged out' } },
    }),
  },

  '/api/v1/me': {
    get: { tags: ['Me'], summary: 'The signed-in account', security: bearer, responses: { 200: ok(object({ user: ref('User') })), ...authed } },
  },
  '/api/v1/me/bookings': {
    get: {
      tags: ['Me'],
      summary: 'Your bookings with ticket codes, newest first (FR-14)',
      security: bearer,
      parameters: pageParams,
      responses: {
        200: ok(
          object({
            bookings: array({
              allOf: [
                ref('Booking'),
                object({ event: ref('Event'), seats: array(ref('Seat')) }),
              ],
            }),
            ...pageFields,
          }),
        ),
        ...authed,
      },
    },
  },

  '/api/v1/events': {
    get: {
      tags: ['Events'],
      summary: 'Published, upcoming events (FR-5)',
      parameters: [
        { name: 'city', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive' },
        { name: 'from', in: 'query', schema: dateTime },
        { name: 'to', in: 'query', schema: dateTime },
        ...pageParams,
      ],
      responses: { 200: ok(object({ events: array(ref('Event')), ...pageFields })), ...common },
    },
    post: {
      tags: ['Events'],
      summary: 'Create a draft event with its seat map (FR-4). Organiser only',
      security: bearer,
      requestBody: json(ref('EventInput')),
      responses: { 201: ok(object({ event: ref('Event'), seatCount: { type: 'integer' } }), 'Created'), ...authed },
    },
  },
  '/api/v1/events/{id}': {
    parameters: [idParam],
    get: { tags: ['Events'], summary: 'One published event, cached 60 s (FR-5)', responses: { 200: ok(object({ event: ref('Event') })), 404: err('NOT_FOUND (drafts too)'), ...common } },
    patch: {
      tags: ['Events'],
      summary: 'Edit your draft; a new seat map replaces all seats (FR-4)',
      security: bearer,
      requestBody: json(ref('EventPatch')),
      responses: {
        200: ok(object({ event: ref('Event'), seatCount: { type: 'integer' } })),
        404: err('NOT_FOUND (or not yours)'),
        409: err('EVENT_NOT_EDITABLE'),
        ...authed,
      },
    },
  },
  '/api/v1/events/{id}/publish': {
    parameters: [idParam],
    post: {
      tags: ['Events'],
      summary: 'Publish your draft: status becomes on_sale (FR-27)',
      security: bearer,
      responses: { 200: ok(object({ event: ref('Event') })), 404: err('NOT_FOUND'), 409: err('EVENT_NOT_EDITABLE'), ...authed },
    },
  },
  '/api/v1/events/{id}/seats': {
    parameters: [idParam],
    get: {
      tags: ['Events'],
      summary: 'Seat map with each seat’s status; cached, at most 2 s stale (FR-6)',
      responses: { 200: ok(object({ seats: array(ref('Seat')) })), 404: err('NOT_FOUND'), ...common },
    },
  },
  '/api/v1/events/{id}/holds': {
    parameters: [idParam],
    post: {
      tags: ['Holds'],
      summary: 'Hold 1 to 6 seats for HOLD_TTL_SECONDS (FR-7, FR-8, FR-29). User role only',
      security: bearer,
      requestBody: json(object({ seatIds: { ...array(id), minItems: 1, maxItems: 6, uniqueItems: true } })),
      responses: {
        201: ok(object({ hold: ref('Hold') }), 'Held'),
        403: err('SALE_NOT_STARTED, or FORBIDDEN'),
        404: err('NOT_FOUND'),
        409: err('SEAT_TAKEN: no seat was held'),
        ...authed,
      },
    },
  },

  '/api/v1/holds/{id}': {
    parameters: [idParam],
    delete: {
      tags: ['Holds'],
      summary: 'Release your active hold early (FR-10)',
      security: bearer,
      responses: { 204: { description: 'Released' }, 404: err('NOT_FOUND'), 410: err('HOLD_EXPIRED'), ...authed },
    },
  },
  '/api/v1/holds/{id}/confirm': {
    parameters: [
      idParam,
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 255 },
        description: 'One key per checkout, reused for every retry. Visible ASCII only.',
      },
    ],
    post: {
      tags: ['Holds'],
      summary: 'Pay for a hold and book its seats (FR-11 to FR-13, SRS 6.2). No body',
      description:
        'A 201 or 410 is stored for 24 h and replayed for the same key, with `Idempotent-Replayed: true`. A 402 frees the key so the same key can retry.',
      security: bearer,
      responses: {
        201: ok(object({ booking: ref('Booking') }), 'Booked'),
        402: err('PAYMENT_FAILED: retry with the same key'),
        404: err('NOT_FOUND'),
        409: err('REQUEST_IN_PROGRESS, or CONFLICT'),
        410: err('HOLD_EXPIRED (a payment taken meanwhile is refunded)'),
        422: err('IDEMPOTENCY_KEY_REUSED'),
        428: err('IDEMPOTENCY_KEY_REQUIRED'),
        ...authed,
      },
    },
  },

  '/api/v1/bookings/{id}/cancel': {
    parameters: [idParam],
    post: {
      tags: ['Bookings'],
      summary: 'Cancel your booking up to 24 h before the event (FR-14, FR-30)',
      security: bearer,
      responses: { 200: ok(object({ booking: ref('Booking') })), 404: err('NOT_FOUND'), 409: err('CANCEL_WINDOW_CLOSED'), ...authed },
    },
  },

  '/api/v1/organiser/events': {
    get: {
      tags: ['Organiser'],
      summary: 'Your events, drafts included, newest first',
      security: bearer,
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'on_sale', 'sold_out', 'ended'] } }, ...pageParams],
      responses: { 200: ok(object({ events: array(ref('Event')), ...pageFields })), ...authed },
    },
  },
  '/api/v1/organiser/events/{id}': {
    parameters: [idParam],
    get: {
      tags: ['Organiser'],
      summary: 'One of your events with its seat map, for editing',
      security: bearer,
      responses: { 200: ok(object({ event: ref('Event'), seatMap: ref('SeatMap'), seatCount: { type: 'integer' } })), 404: err('NOT_FOUND'), ...authed },
    },
  },
  '/api/v1/organiser/events/{id}/sales': {
    parameters: [idParam],
    get: {
      tags: ['Organiser'],
      summary: 'Seats sold, revenue and active holds (FR-31)',
      security: bearer,
      responses: {
        200: ok(
          object({
            event: ref('Event'),
            seats: object({ total: { type: 'integer' }, available: { type: 'integer' }, held: { type: 'integer' }, booked: { type: 'integer' } }),
            bookings: object({ confirmed: { type: 'integer' }, cancelled: { type: 'integer' } }),
            revenuePaise: paise,
            activeHolds: { type: 'integer' },
          }),
        ),
        404: err('NOT_FOUND'),
        ...authed,
      },
    },
  },

  '/api/v1/admin/stats': {
    get: {
      tags: ['Admin'],
      summary: 'Bookings per minute, failed holds per event, time to sell out (FR-18)',
      security: bearer,
      parameters: [{ name: 'minutes', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1440, default: 60 } }],
      responses: {
        200: ok(
          object({
            windowMinutes: { type: 'integer' },
            bookingsPerMinute: array(object({ minute: dateTime, count: { type: 'integer' } })),
            totalBookings: { type: 'integer' },
            failedHolds: {
              ...array(object({ eventId: id, name: { type: 'string', nullable: true }, count: { type: 'integer' } })),
              nullable: true,
              description: 'null while Redis is down',
            },
            sellOutTimes: array(
              object({ eventId: id, name: { type: 'string' }, status: { type: 'string' }, saleStartsAt: dateTime, soldOutAt: dateTime, secondsToSellOut: { type: 'integer' } }),
            ),
          }),
        ),
        ...authed,
      },
    },
  },
  '/api/v1/admin/users': {
    get: {
      tags: ['Admin'],
      summary: 'Find accounts; q matches the start of the email',
      security: bearer,
      parameters: [
        { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'role', in: 'query', schema: { type: 'string', enum: ['user', 'organiser', 'admin'] } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'blocked'] } },
        ...pageParams,
      ],
      responses: { 200: ok(object({ users: array(ref('AdminUser')), ...pageFields })), ...authed },
    },
  },
  '/api/v1/admin/users/{id}/block': {
    parameters: [idParam],
    post: {
      tags: ['Admin'],
      summary: 'Block a user and revoke their refresh tokens (FR-32)',
      security: bearer,
      responses: { 200: ok(object({ user: ref('AdminUser') })), 403: err('FORBIDDEN: admins cannot be blocked'), 404: err('NOT_FOUND'), ...authed },
    },
  },
  '/api/v1/admin/users/{id}/unblock': {
    parameters: [idParam],
    post: {
      tags: ['Admin'],
      summary: 'Unblock a user (FR-32)',
      security: bearer,
      responses: { 200: ok(object({ user: ref('AdminUser') })), 403: err('FORBIDDEN'), 404: err('NOT_FOUND'), ...authed },
    },
  },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'TicketRush API',
    version: '1.0.0',
    description:
      'Flash-sale ticket booking that never double-books a seat. Errors share one shape (see Error). Money is in paise.',
  },
  servers: [{ url: '/' }],
  tags: ['Auth', 'Me', 'Events', 'Holds', 'Bookings', 'Organiser', 'Admin', 'Ops'].map((name) => ({ name })),
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from login or refresh (15 min)' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'rt', description: 'httpOnly refresh token cookie' },
    },
    schemas,
  },
  paths,
};

module.exports = spec;
