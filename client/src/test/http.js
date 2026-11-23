import { vi } from 'vitest';

/** A JSON Response like the API's. */
export function json(status, body, headers = {}) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const apiError = (status, code, message = code, headers) =>
  json(status, { error: { code, message, requestId: `req-${code}` } }, headers);

/**
 * Replaces fetch with a router of "METHOD /path" → handler. A handler is a Response
 * factory, a function of the request, or an array used one item per call (the last
 * one repeats). Every call is recorded with its parsed headers and body.
 */
export function mockApi(routes) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));

  const fetchMock = vi.fn(async (url, init = {}) => {
    const path = url.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const call = { method, path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);

    const key = Object.keys(queues).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (p === path || (p.endsWith('*') && path.startsWith(p.slice(0, -1))));
    });
    if (!key) return apiError(404, 'NOT_FOUND', `No mock for ${method} ${path}`);

    let handler = queues[key];
    if (Array.isArray(handler)) handler = handler.length > 1 ? handler.shift() : handler[0];
    const res = typeof handler === 'function' ? await handler(call) : handler;
    return res instanceof Response ? res : json(200, res);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock, callsTo: (method, path) => calls.filter((c) => c.method === method && c.path === path) };
}
