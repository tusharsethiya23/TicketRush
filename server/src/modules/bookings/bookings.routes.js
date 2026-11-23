const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/auth');
const { idParams } = require('../../lib/schemas');
const bookingsService = require('./bookings.service');

const router = Router();

/** FR-14, FR-30: cancel your own booking up to 24 hours before the event. */
router.post(
  '/:id/cancel',
  authenticate,
  requireRole('user'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ booking: await bookingsService.cancelBooking(req.user.id, req.params.id) });
  }),
);

module.exports = router;
