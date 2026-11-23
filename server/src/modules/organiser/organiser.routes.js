const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/auth');
const { idParams } = require('../../lib/schemas');
const { EVENT_STATUSES } = require('../../models/Event');
const organiserService = require('./organiser.service');

const router = Router();
router.use(authenticate, requireRole('organiser'));

const listQuery = z.object({
  status: z.enum(EVENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** The organiser's own events, drafts included (FR-25 dashboard). */
router.get(
  '/events',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    res.json(await organiserService.listOwnEvents(req.user.id, req.query));
  }),
);

/** One own event with its seat map, for the edit form (FR-4, FR-25). */
router.get(
  '/events/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(await organiserService.getOwnEvent(req.user.id, req.params.id));
  }),
);

/** FR-31: seats sold, revenue and active holds. */
router.get(
  '/events/:id/sales',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(await organiserService.getSales(req.user.id, req.params.id));
  }),
);

module.exports = router;
