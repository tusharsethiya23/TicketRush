const AppError = require('../lib/AppError');
const asyncHandler = require('../lib/asyncHandler');
const { verifyAccessToken } = require('../lib/tokens');
const User = require('../models/User');

/**
 * Requires a valid Bearer access token and an active account (FR-3).
 * The account is re-read on every request so a block takes effect at once,
 * not only when the 15-minute access token expires.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Missing access token');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired access token');
  }

  const user = await User.findById(payload.sub).select('email role status').lean();
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Account no longer exists');
  if (user.status === 'blocked') throw new AppError(403, 'FORBIDDEN', 'Account is blocked');

  req.user = { id: String(user._id), email: user.email, role: user.role };
  next();
});

/** Allows the request only for the given roles. Use after authenticate. */
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) return next();
    next(new AppError(403, 'FORBIDDEN', 'You do not have access to this resource'));
  };

module.exports = { authenticate, requireRole };
