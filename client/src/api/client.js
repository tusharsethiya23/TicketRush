/**
 * The only way the app talks to the API (FR-20).
 *
 * - The access token lives in memory only, never in localStorage, so a script injected
 *   into the page cannot read it from storage.
 * - A 401 triggers one silent refresh through the httpOnly `rt` cookie, then one retry.
 *   Parallel 401s share a single refresh, because the server rotates the refresh token
 *   and a second refresh with the old one would look like token theft.
 * - The server's Date header gives the clock offset, so hold countdowns follow the
 *   server's expiresAt even when the device clock is wrong (FR-23).
 */
const BASE = '/api/v1';

let accessToken = null;
let clockOffsetMs = 0;
let refreshing = null;
const sessionListeners = new Set();

export class ApiError extends Error {
  constructor(status, body, headers) {
    const error = body?.error ?? {};
    super(error.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code ?? (status === 0 ? 'NETWORK' : 'UNKNOWN');
    this.details = error.details ?? [];
    this.requestId = error.requestId ?? headers?.get?.('x-request-id') ?? null;
    this.retryAfter = Number(headers?.get?.('retry-after')) || null;
  }
}

export const getAccessToken = () => accessToken;

export function setAccessToken(token) {
  accessToken = token;
}

/** Called with no arguments when a refresh fails, so the app can show the login page. */
export function onSessionExpired(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Now, by the server's clock. */
export const serverNow = () => Date.now() + clockOffsetMs;

function trackClock(res) {
  const date = res.headers.get('date');
  if (!date) return;
  const server = Date.parse(date);
  // The Date header has 1-second resolution; ignore offsets smaller than that.
  if (!Number.isNaN(server) && Math.abs(server - Date.now()) > 1500) clockOffsetMs = server - Date.now();
}

async function send(path, { method, body, headers, auth }) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(auth && accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach TicketRush. Check your connection and try again.' } });
  }
  trackClock(res);
  return res;
}

/**
 * Uses the refresh cookie to get a new access token. Resolves to the user, or null
 * when there is no valid session. Concurrent callers share one request.
 */
export function refreshSession() {
  refreshing ??= (async () => {
    try {
      const res = await send('/auth/refresh', { method: 'POST', auth: false });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const { user, accessToken: token } = await res.json();
      accessToken = token;
      return user;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Calls the API and resolves to the parsed JSON body (null for 204).
 * Throws ApiError with the server's error code for any non-2xx answer.
 */
export async function api(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  let res = await send(path, { method, body, headers, auth });

  if (res.status === 401 && auth) {
    const hadToken = accessToken !== null;
    const user = await refreshSession();
    if (user) {
      res = await send(path, { method, body, headers, auth });
    } else if (hadToken) {
      sessionListeners.forEach((l) => l());
    }
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  return data;
}

/** Tests only. */
export function resetClient() {
  accessToken = null;
  clockOffsetMs = 0;
  refreshing = null;
  sessionListeners.clear();
}
