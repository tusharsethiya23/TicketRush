const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const { pingMongo } = require('../../db/mongo');
const { pingRedis } = require('../../lib/redis');

const router = Router();

/**
 * FR-19: 200 when MongoDB and Redis both answer, else 503. A 503 for Redis alone means
 * degraded, not broken: bookings stay correct without Redis (NFR-5).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [mongoOk, redisOk] = await Promise.all([pingMongo(), pingRedis()]);
    const checks = { api: 'ok', mongo: mongoOk ? 'ok' : 'down', redis: redisOk ? 'ok' : 'down' };
    const healthy = mongoOk && redisOk;
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  }),
);

module.exports = router;
