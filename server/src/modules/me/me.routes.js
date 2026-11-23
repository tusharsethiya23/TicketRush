const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const { listBookingsQuery } = require('../bookings/bookings.schemas');
const bookingsService = require('../bookings/bookings.service');

const router = Router();

/** The signed-in account; the React app uses it after a silent refresh. */
router.get('/', authenticate, (req, res) => {
  res.json({ user: req.user });
});

/** FR-14: your bookings with ticket codes, newest first. */
router.get(
  '/bookings',
  authenticate,
  validate({ query: listBookingsQuery }),
  asyncHandler(async (req, res) => {
    res.json(await bookingsService.listMyBookings(req.user.id, req.query));
  }),
);

module.exports = router;
