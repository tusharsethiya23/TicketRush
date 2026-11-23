const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const AppError = require('../../lib/AppError');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const { idParams } = require('../../lib/schemas');
const { confirmBodySchema, idempotencyKey } = require('../bookings/bookings.schemas');
const holdsService = require('./holds.service');
const bookingsService = require('../bookings/bookings.service');

const router = Router();

/** FR-11: the header is required (428) and must be well formed (400). */
function requireIdempotencyKey(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (key === undefined) {
    return next(new AppError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required'));
  }
  const parsed = idempotencyKey.safeParse(key);
  if (!parsed.success) {
    return next(
      new AppError(400, 'VALIDATION_FAILED', 'Request is invalid', [
        { path: 'Idempotency-Key', message: parsed.error.issues[0].message },
      ]),
    );
  }
  req.idempotencyKey = parsed.data;
  next();
}

/** FR-10: release your own active hold early. */
router.delete(
  '/:id',
  authenticate,
  requireRole('user'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await holdsService.releaseOwnHold(req.user.id, req.params.id);
    res.status(204).end();
  }),
);

/** FR-11 to FR-13 (SRS 6.2): pay for a hold and book its seats. */
router.post(
  '/:id/confirm',
  limiters.confirmByIp(),
  authenticate,
  requireRole('user'),
  limiters.confirmByUser(),
  validate({ params: idParams, body: confirmBodySchema }),
  requireIdempotencyKey,
  asyncHandler(async (req, res) => {
    const { status, body, replayed } = await bookingsService.confirmHold({
      userId: req.user.id,
      holdId: req.params.id,
      key: req.idempotencyKey,
    });
    if (replayed) res.set('Idempotent-Replayed', 'true');
    // A stored error is replayed with this request's ID, in the usual error shape.
    res.status(status).json(status >= 400 ? { error: { ...body.error, requestId: req.id } } : body);
  }),
);

module.exports = router;
