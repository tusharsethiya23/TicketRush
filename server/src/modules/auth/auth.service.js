const { randomUUID } = require('node:crypto');
const bcrypt = require('bcrypt');
const config = require('../../config/env');
const AppError = require('../../lib/AppError');
const { signAccessToken, generateRefreshToken, hashToken } = require('../../lib/tokens');
const { User, RefreshToken } = require('../../models');

const DAY_MS = 24 * 60 * 60 * 1000;
const invalidRefresh = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired refresh token');

const toPublicUser = (user) => ({ id: String(user._id), email: user.email, role: user.role });

// Compared against when the email is unknown, so login takes the same time either way.
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= bcrypt.hash('not-a-real-password', config.BCRYPT_ROUNDS));

async function issueRefreshToken(userId, familyId = randomUUID()) {
  const token = generateRefreshToken();
  await RefreshToken.create({
    userId,
    tokenHash: hashToken(token),
    familyId,
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
  });
  return token;
}

async function issueSession(user, familyId) {
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user._id, familyId),
  };
}

/** FR-1 */
async function register({ email, password, role }) {
  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);
  try {
    const user = await User.create({ email, passwordHash, role });
    return toPublicUser(user);
  } catch (err) {
    if (err.code === 11000) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
}

/** FR-1, FR-2 */
async function login({ email, password }) {
  const user = await User.findOne({ email });
  const passwordOk = await bcrypt.compare(password, user ? user.passwordHash : await dummyHash());

  if (!user || !passwordOk) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  if (user.status === 'blocked') throw new AppError(403, 'FORBIDDEN', 'Account is blocked');

  return issueSession(user);
}

/**
 * FR-26: consumes the refresh token and issues a new one in the same family.
 * The conditional update means two parallel refreshes cannot both use one token.
 * Presenting a token that was already revoked is treated as theft: every live
 * refresh token of that user is revoked.
 */
async function refresh(token) {
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Missing refresh token');

  const tokenHash = hashToken(token);
  const now = new Date();

  const consumed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now } },
  );

  if (!consumed) {
    const known = await RefreshToken.findOne({ tokenHash }).select('userId revokedAt').lean();
    if (known?.revokedAt) {
      await RefreshToken.updateMany({ userId: known.userId, revokedAt: null }, { $set: { revokedAt: now } });
    }
    throw invalidRefresh();
  }

  const user = await User.findById(consumed.userId);
  if (!user) throw invalidRefresh();
  if (user.status === 'blocked') throw new AppError(403, 'FORBIDDEN', 'Account is blocked');

  return issueSession(user, consumed.familyId);
}

/** FR-26: revokes the presented refresh token. Unknown or missing tokens are ignored. */
async function logout(token) {
  if (!token) return;
  await RefreshToken.updateOne({ tokenHash: hashToken(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

module.exports = { register, login, refresh, logout, toPublicUser };
