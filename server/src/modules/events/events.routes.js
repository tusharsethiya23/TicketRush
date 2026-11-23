const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const { idParams } = require('../../lib/schemas');
const { createEventSchema, updateEventSchema, listEventsQuery } = require('./events.schemas');
const { createHoldSchema } = require('../holds/holds.schemas');
const eventsService = require('./events.service');
const holdsService = require('../holds/holds.service');

const router = Router();
const organiser = [authenticate, requireRole('organiser')];
const holdByIp = limiters.holdByIp();
const holdByUser = limiters.holdByUser();

/** FR-4 */
router.post(
  '/',
  ...organiser,
  validate({ body: createEventSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await eventsService.createEvent(req.user.id, req.body));
  }),
);

/** FR-4 */
router.patch(
  '/:id',
  ...organiser,
  validate({ params: idParams, body: updateEventSchema }),
  asyncHandler(async (req, res) => {
    res.json(await eventsService.updateEvent(req.user.id, req.params.id, req.body));
  }),
);

/** FR-27 */
router.post(
  '/:id/publish',
  ...organiser,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ event: await eventsService.publishEvent(req.user.id, req.params.id) });
  }),
);

/** FR-5 */
router.get(
  '/',
  validate({ query: listEventsQuery }),
  asyncHandler(async (req, res) => {
    res.json(await eventsService.listEvents(req.query));
  }),
);

/** FR-5 */
router.get(
  '/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ event: await eventsService.getPublicEvent(req.params.id) });
  }),
);

/** FR-6 */
router.get(
  '/:id/seats',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ seats: await eventsService.getSeatMap(req.params.id) });
  }),
);

/** FR-7, FR-8, FR-29 */
router.post(
  '/:id/holds',
  holdByIp,
  authenticate,
  requireRole('user'),
  holdByUser,
  validate({ params: idParams, body: createHoldSchema }),
  asyncHandler(async (req, res) => {
    const hold = await holdsService.createHold({
      userId: req.user.id,
      eventId: req.params.id,
      seatIds: req.body.seatIds,
    });
    res.status(201).json({ hold });
  }),
);

module.exports = router;
