const { Router } = require('express');
const config = require('../../config/env');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { limiters } = require('../../middleware/rateLimit');
const { registerSchema, loginSchema } = require('./auth.schemas');
const authService = require('./auth.service');

const REFRESH_COOKIE = 'rt';
const cookieOptions = {
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'strict',
  path: '/api/v1/auth', // sent only to refresh and logout, never to other routes
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions, maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000 });
}

const router = Router();
const authByIp = limiters.authByIp(); // FR-17: slows down password guessing and sign-up spam

router.post(
  '/register',
  authByIp,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const user = await authService.register(req.body);
    res.status(201).json({ user });
  }),
);

router.post(
  '/login',
  authByIp,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { user, accessToken, refreshToken } = await authService.login(req.body);
    setRefreshCookie(res, refreshToken);
    res.json({ user, accessToken });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    try {
      const { user, accessToken, refreshToken } = await authService.refresh(req.cookies[REFRESH_COOKIE]);
      setRefreshCookie(res, refreshToken);
      res.json({ user, accessToken });
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions);
      throw err;
    }
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(req.cookies[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  }),
);

module.exports = router;
module.exports.REFRESH_COOKIE = REFRESH_COOKIE;
