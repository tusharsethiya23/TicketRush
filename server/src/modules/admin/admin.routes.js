const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/auth');
const { idParams } = require('../../lib/schemas');
const { ROLES } = require('../../models/User');
const adminService = require('./admin.service');

const router = Router();
router.use(authenticate, requireRole('admin'));

const statsQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).default(60),
});

const usersQuery = z.object({
  q: z.string().trim().min(1).max(254).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'blocked']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** FR-18: bookings per minute, failed holds per event, time to sell out. */
router.get(
  '/stats',
  validate({ query: statsQuery }),
  asyncHandler(async (req, res) => {
    res.json(await adminService.getStats(req.query));
  }),
);

/** Find accounts to block or unblock. */
router.get(
  '/users',
  validate({ query: usersQuery }),
  asyncHandler(async (req, res) => {
    res.json(await adminService.listUsers(req.query));
  }),
);

/** FR-32 */
router.post(
  '/users/:id/block',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ user: await adminService.blockUser(req.params.id) });
  }),
);

/** FR-32 */
router.post(
  '/users/:id/unblock',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ user: await adminService.unblockUser(req.params.id) });
  }),
);

module.exports = router;
