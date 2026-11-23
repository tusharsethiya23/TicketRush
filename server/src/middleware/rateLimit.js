const config = require('../config/env');
const AppError = require('../lib/AppError');
const logger = require('../lib/logger');
const { getRedis } = require('../lib/redis');

/**
 * Fixed-window counter in Redis: rl:<name>:<user|ip>:<id> (SRS 6.2).
 * Returns { count, ttlMs }. SET NX starts the window with its expiry and INCR counts
 * in the same MULTI, so a key can never be left without a TTL.
 */
async function hit(key, windowMs) {
  const results = await getRedis().multi().set(key, 0, 'PX', windowMs, 'NX').incr(key).pttl(key).exec();
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
  return { count: results[1][1], ttlMs: results[2][1] };
}

/**
 * Express middleware for FR-17. `by: 'user'` must run after authenticate.
 * Fails open: if Redis is down, requests are allowed and a warning is logged,
 * because MongoDB still guarantees correctness (NFR-5).
 *
 * @param {{ name: string, limit: number, by: 'ip' | 'user', windowSeconds?: number, enabled?: boolean }} options
 */
function rateLimit({ name, limit, by, windowSeconds = config.RATE_LIMIT_WINDOW_SECONDS, enabled }) {
  const isEnabled =
    enabled ?? (config.RATE_LIMIT_ENABLED && (by === 'user' || config.RATE_LIMIT_IP_ENABLED));
  const windowMs = windowSeconds * 1000;

  return async function rateLimiter(req, res, next) {
    if (!isEnabled) return next();

    const id = by === 'user' ? req.user?.id : req.ip;
    if (!id) return next();

    let result;
    try {
      result = await hit(`rl:${name}:${by}:${id}`, windowMs);
    } catch (err) {
      logger.warn({ err: err.message, limiter: name }, 'Rate limiter unavailable; allowing request');
      return next();
    }

    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - result.count));

    if (result.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((result.ttlMs > 0 ? result.ttlMs : windowMs) / 1000));
      res.setHeader('Retry-After', retryAfter);
      return next(new AppError(429, 'RATE_LIMITED', `Too many requests, try again in ${retryAfter} s`));
    }
    next();
  };
}

/** The limits from SRS 8.3. */
const limiters = {
  allByIp: () => rateLimit({ name: 'all', by: 'ip', limit: config.RL_ALL_IP }),
  allByUser: () => rateLimit({ name: 'all', by: 'user', limit: config.RL_ALL_USER }),
  authByIp: () => rateLimit({ name: 'auth', by: 'ip', limit: config.RL_AUTH_IP }),
  holdByUser: () => rateLimit({ name: 'hold', by: 'user', limit: config.RL_HOLD_USER }),
  holdByIp: () => rateLimit({ name: 'hold', by: 'ip', limit: config.RL_HOLD_IP }),
  confirmByUser: () => rateLimit({ name: 'confirm', by: 'user', limit: config.RL_CONFIRM_USER }),
  confirmByIp: () => rateLimit({ name: 'confirm', by: 'ip', limit: config.RL_CONFIRM_IP }),
};

module.exports = { rateLimit, limiters };
