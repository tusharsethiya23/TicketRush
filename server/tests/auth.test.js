const request = require('supertest');
const express = require('express');
const { createApp } = require('../src/app');
const { User, RefreshToken } = require('../src/models');
const { authenticate, requireRole } = require('../src/middleware/auth');
const requestLogger = require('../src/middleware/requestLogger');
const { errorHandler } = require('../src/middleware/errorHandler');
const { signAccessToken } = require('../src/lib/tokens');
const { connectTestDb, clearTestDb, closeTestDb } = require('./helpers/db');

const app = createApp();
const PASSWORD = 'correct-horse-battery';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(closeTestDb);

/** Returns the raw `rt=...` cookie pair from a response, or undefined. */
function refreshCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  const rt = cookies.find((c) => c.startsWith('rt=') && !c.startsWith('rt=;'));
  return rt?.split(';')[0];
}

async function registerAndLogin(email = 'fan@example.com', role = 'user') {
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, role }).expect(201);
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { accessToken: res.body.accessToken, cookie: refreshCookie(res), user: res.body.user };
}

describe('POST /auth/register (FR-1)', () => {
  test('creates a user with a bcrypt hash and never returns it', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: '  Fan@Example.com ', password: PASSWORD })
      .expect(201);

    expect(res.body.user).toEqual({ id: expect.any(String), email: 'fan@example.com', role: 'user' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const stored = await User.findOne({ email: 'fan@example.com' }).lean();
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  test('allows organiser sign-up', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'org@example.com', password: PASSWORD, role: 'organiser' })
      .expect(201);
    expect(res.body.user.role).toBe('organiser');
  });

  test('rejects self sign-up as admin', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'x@example.com', password: PASSWORD, role: 'admin' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('returns 409 EMAIL_TAKEN for a duplicate email, case-insensitively', async () => {
    await request(app).post('/api/v1/auth/register').send({ email: 'fan@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'FAN@example.com', password: PASSWORD })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test.each([
    ['bad email', { email: 'not-an-email', password: PASSWORD }],
    ['short password', { email: 'a@example.com', password: 'short' }],
    ['password over 72 bytes', { email: 'a@example.com', password: 'é'.repeat(37) }],
    ['unknown field', { email: 'a@example.com', password: PASSWORD, isAdmin: true }],
    ['missing body', undefined],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await request(app).post('/api/v1/auth/register').send(body).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
  });

  test('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/login (FR-2)', () => {
  beforeEach(async () => {
    await request(app).post('/api/v1/auth/register').send({ email: 'fan@example.com', password: PASSWORD });
  });

  test('returns an access token and sets an httpOnly strict refresh cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'fan@example.com', password: PASSWORD })
      .expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('fan@example.com');

    const setCookie = res.headers['set-cookie'].find((c) => c.startsWith('rt='));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/);

    // Only the hash is stored.
    const raw = refreshCookie(res).slice('rt='.length);
    const stored = await RefreshToken.findOne().lean();
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.tokenHash).toHaveLength(64);
  });

  test('access token expires in 15 minutes', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'fan@example.com', password: PASSWORD });
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  test.each([
    ['wrong password', { email: 'fan@example.com', password: 'wrong-password' }],
    ['unknown email', { email: 'nobody@example.com', password: PASSWORD }],
  ])('returns the same 401 for %s', async (_label, body) => {
    const res = await request(app).post('/api/v1/auth/login').send(body).expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('returns 403 for a blocked account', async () => {
    await User.updateOne({ email: 'fan@example.com' }, { status: 'blocked' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'fan@example.com', password: PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('rejects NoSQL operator injection in the email (NFR-7)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: { $gt: '' }, password: PASSWORD })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/refresh (FR-2, FR-26)', () => {
  test('rotates the refresh token and returns a new access token', async () => {
    const { cookie } = await registerAndLogin();

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    const next = refreshCookie(res);
    expect(next).toBeDefined();
    expect(next).not.toBe(cookie);

    // The new token works once more.
    await request(app).post('/api/v1/auth/refresh').set('Cookie', next).expect(200);
  });

  test('reusing a rotated token revokes every live token of the user', async () => {
    const { cookie: first } = await registerAndLogin();
    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', first).expect(200);
    const second = refreshCookie(rotated);

    // Replay of the old token: rejected, and the cookie is cleared.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', first).expect(401);
    expect(replay.headers['set-cookie'].some((c) => c.startsWith('rt=;'))).toBe(true);

    // The legitimate newer token is now revoked too.
    await request(app).post('/api/v1/auth/refresh').set('Cookie', second).expect(401);
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(0);
  });

  test('two parallel refreshes with one token: exactly one succeeds', async () => {
    const { cookie } = await registerAndLogin();
    const results = await Promise.all([
      request(app).post('/api/v1/auth/refresh').set('Cookie', cookie),
      request(app).post('/api/v1/auth/refresh').set('Cookie', cookie),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  test('returns 401 without a cookie or with an unknown token', async () => {
    await request(app).post('/api/v1/auth/refresh').expect(401);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', 'rt=made-up').expect(401);
  });

  test('returns 401 for an expired refresh token', async () => {
    const { cookie } = await registerAndLogin();
    await RefreshToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  test('returns 403 when the account was blocked', async () => {
    const { cookie } = await registerAndLogin();
    await User.updateMany({}, { status: 'blocked' });
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /auth/logout (FR-26)', () => {
  test('revokes the refresh token and clears the cookie', async () => {
    const { cookie } = await registerAndLogin();

    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    expect(res.headers['set-cookie'].some((c) => c.startsWith('rt=;'))).toBe(true);

    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  test('succeeds without a cookie', async () => {
    await request(app).post('/api/v1/auth/logout').expect(204);
  });
});

describe('authenticate and requireRole (FR-3)', () => {
  const roleApp = express();
  roleApp.use(requestLogger);
  roleApp.get('/organiser-only', authenticate, requireRole('organiser'), (req, res) => res.json({ ok: true }));
  roleApp.use(errorHandler);

  test('GET /me returns the current user', async () => {
    const { accessToken } = await registerAndLogin();
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(res.body.user).toMatchObject({ email: 'fan@example.com', role: 'user' });
  });

  test.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['garbage token', 'Bearer not.a.jwt'],
  ])('returns 401 for %s', async (_label, header) => {
    const req = request(app).get('/api/v1/me');
    if (header) req.set('Authorization', header);
    const res = await req.expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('returns 401 for an expired access token', async () => {
    const { user } = await registerAndLogin();
    const jwt = require('jsonwebtoken');
    const expired = jwt.sign({ role: 'user' }, process.env.JWT_ACCESS_SECRET, { subject: user.id, expiresIn: -10 });
    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${expired}`).expect(401);
  });

  test('a block takes effect on an access token that is still valid', async () => {
    const { accessToken } = await registerAndLogin();
    await User.updateMany({}, { status: 'blocked' });
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('requireRole returns 403 for the wrong role and passes the right one', async () => {
    const fan = await registerAndLogin('fan@example.com', 'user');
    const org = await registerAndLogin('org@example.com', 'organiser');

    const denied = await request(roleApp)
      .get('/organiser-only')
      .set('Authorization', `Bearer ${fan.accessToken}`)
      .expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    await request(roleApp).get('/organiser-only').set('Authorization', `Bearer ${org.accessToken}`).expect(200);
  });

  test('the role is read from the database, not trusted from the token', async () => {
    const fan = await registerAndLogin('fan@example.com', 'user');
    const forged = signAccessToken({ _id: fan.user.id, role: 'organiser' });
    await request(roleApp).get('/organiser-only').set('Authorization', `Bearer ${forged}`).expect(403);
  });
});

describe('cross-cutting', () => {
  test('unknown routes return 404 in the error shape with a request ID header', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });

  test('a safe incoming X-Request-Id is reused; an unsafe one is replaced', async () => {
    const kept = await request(app).get('/api/v1/nope').set('X-Request-Id', 'trace-123');
    expect(kept.headers['x-request-id']).toBe('trace-123');

    const replaced = await request(app).get('/api/v1/nope').set('X-Request-Id', 'bad id\twith spaces');
    expect(replaced.headers['x-request-id']).not.toContain(' ');
  });

  test('GET /health reports MongoDB as ok (FR-19)', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { api: 'ok', mongo: 'ok' } });
  });
});
