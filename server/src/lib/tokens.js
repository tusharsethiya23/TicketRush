const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

const ALGORITHM = 'HS256';

function signAccessToken(user) {
  return jwt.sign({ role: user.role }, config.JWT_ACCESS_SECRET, {
    subject: String(user._id),
    expiresIn: config.ACCESS_TOKEN_TTL,
    algorithm: ALGORITHM,
  });
}

/** Throws if the token is invalid or expired. */
function verifyAccessToken(token) {
  return jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: [ALGORITHM] });
}

/** Opaque random refresh token; only its hash is stored (NFR-8). */
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashToken };
