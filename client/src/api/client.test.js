import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, ApiError, onSessionExpired, refreshSession, resetClient, setAccessToken } from './client.js';
import { apiError, json, mockApi } from '../test/http.js';
import { errorMessage } from './errors.js';

afterEach(resetClient);

const user = { id: 'u1', email: 'fan@example.com', role: 'user' };

describe('api client (FR-20)', () => {
  test('sends the in-memory token, and JSON bodies', async () => {
    const { calls } = mockApi({ 'POST /events/e1/holds': json(201, { hold: { id: 'h1' } }) });
    setAccessToken('tok');
    await expect(api('/events/e1/holds', { method: 'POST', body: { seatIds: ['s1'] } })).resolves.toEqual({ hold: { id: 'h1' } });
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(calls[0].body).toEqual({ seatIds: ['s1'] });
  });

  test('a 401 refreshes once through the cookie, then retries with the new token', async () => {
    const { calls } = mockApi({
      'GET /me': [apiError(401, 'UNAUTHENTICATED'), json(200, { user })],
      'POST /auth/refresh': json(200, { user, accessToken: 'new' }),
    });
    setAccessToken('old');

    await expect(api('/me')).resolves.toEqual({ user });
    expect(calls.map((c) => `${c.method} ${c.path} ${c.headers.Authorization ?? ''}`)).toEqual([
      'GET /me Bearer old',
      'POST /auth/refresh ',
      'GET /me Bearer new',
    ]);
  });

  test('parallel 401s share one refresh, because the refresh token rotates', async () => {
    const { callsTo } = mockApi({
      'GET /me': ({ headers }) => (headers.Authorization === 'Bearer new' ? json(200, { user }) : apiError(401, 'UNAUTHENTICATED')),
      'GET /me/bookings': ({ headers }) =>
        headers.Authorization === 'Bearer new' ? json(200, { bookings: [] }) : apiError(401, 'UNAUTHENTICATED'),
      'POST /auth/refresh': async () => {
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { user, accessToken: 'new' });
      },
    });
    setAccessToken('old');

    await Promise.all([api('/me'), api('/me/bookings'), api('/me')]);
    expect(callsTo('POST', '/auth/refresh')).toHaveLength(1);
  });

  test('when the refresh fails too, the session-expired listeners run and the 401 is thrown', async () => {
    mockApi({ 'GET /me': apiError(401, 'UNAUTHENTICATED'), 'POST /auth/refresh': apiError(401, 'UNAUTHENTICATED') });
    const expired = vi.fn();
    onSessionExpired(expired);
    setAccessToken('old');

    await expect(api('/me')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test('errors carry the code, request ID and Retry-After', async () => {
    mockApi({ 'POST /holds/h1/confirm': apiError(429, 'RATE_LIMITED', 'Too many', { 'retry-after': '12' }) });
    const err = await api('/holds/h1/confirm', { method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED', requestId: 'req-RATE_LIMITED', retryAfter: 12 });
    expect(errorMessage(err)).toBe('Too many requests. Please wait 12 s and try again.');
  });

  test('a network failure is an ApiError with code NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/events')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  test('refreshSession resolves null when there is no session', async () => {
    mockApi({ 'POST /auth/refresh': apiError(401, 'UNAUTHENTICATED') });
    await expect(refreshSession()).resolves.toBeNull();
  });
});

describe('error messages (NFR-12)', () => {
  test('known codes get plain-language text; validation lists the fields', () => {
    expect(errorMessage({ code: 'SEAT_TAKEN' })).toMatch(/Someone else just took/);
    expect(errorMessage({ code: 'PAYMENT_FAILED' })).toMatch(/never be charged twice/);
    expect(
      errorMessage({ code: 'VALIDATION_FAILED', details: [{ path: 'startsAt', message: 'startsAt must be in the future' }] }),
    ).toBe('startsAt: startsAt must be in the future');
    expect(errorMessage({ code: 'WHO_KNOWS', message: 'Server said no' })).toBe('Server said no');
  });
});
