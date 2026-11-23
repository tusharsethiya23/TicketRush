/** NFR-10: Swagger UI is served, and every Express route is documented in the OpenAPI spec. */
const request = require('supertest');
const { createApp } = require('../src/app');
const openapi = require('../src/docs/openapi');

const app = createApp();

/** Mount prefix of a router layer, from Express 4's path regexp, e.g. /api/v1/events. */
function mountPath(layer) {
  if (layer.regexp.fast_slash) return '';
  return layer.regexp.source
    .replace('^\\', '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/');
}

/** Every "METHOD /path" Express serves, with :params written as OpenAPI {params}. */
function expressRoutes(stack, prefix = '') {
  const routes = [];
  for (const layer of stack) {
    if (layer.route) {
      const path = (prefix + layer.route.path).replace(/\/$/, '') || '/';
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`);
      }
    } else if (layer.name === 'router' && layer.handle.stack) {
      routes.push(...expressRoutes(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return routes;
}

const documented = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k))
    .map((method) => `${method.toUpperCase()} ${path}`),
);

test('every API route is in the OpenAPI spec, and the spec lists no route that does not exist', () => {
  const served = expressRoutes(app._router.stack).filter((r) => !r.includes('/docs'));
  expect(served.length).toBeGreaterThan(20);
  expect([...served].sort()).toEqual([...documented].sort());
});

test('every documented operation has a summary and responses; every $ref resolves', () => {
  for (const item of Object.values(openapi.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      expect(op.summary).toBeTruthy();
      expect(Object.keys(op.responses).length).toBeGreaterThan(0);
    }
  }
  const refs = JSON.stringify(openapi).match(/#\/components\/schemas\/\w+/g);
  for (const ref of new Set(refs)) {
    expect(openapi.components.schemas[ref.split('/').pop()]).toBeDefined();
  }
});

test('GET /docs serves Swagger UI and /docs/openapi.json the spec', async () => {
  const page = await request(app).get('/docs/').expect(200);
  expect(page.text).toContain('TicketRush API');
  expect(page.text).not.toMatch(/<script>(?!<\/script>)/); // no inline scripts: the CSP blocks them
  expect(page.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');

  const spec = await request(app).get('/docs/openapi.json').expect(200);
  expect(spec.body.openapi).toBe('3.0.3');
  expect(spec.body.paths['/api/v1/holds/{id}/confirm'].post.responses).toHaveProperty('428');
});
