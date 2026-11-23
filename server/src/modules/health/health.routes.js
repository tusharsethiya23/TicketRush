const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const { pingMongo } = require('../../db/mongo');

const router = Router();

/** FR-19. Redis is added to the checks in phase 3. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const mongo = (await pingMongo()) ? 'ok' : 'down';
    const healthy = mongo === 'ok';
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks: { api: 'ok', mongo } });
  }),
);

module.exports = router;
