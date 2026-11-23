const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/auth');
const { idParams } = require('../../lib/schemas');
const holdsService = require('./holds.service');

const router = Router();

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

module.exports = router;
