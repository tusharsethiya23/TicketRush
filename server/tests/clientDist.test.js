const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// CLIENT_DIST is read when the config loads, so load a fresh copy of the app with it set.
function appWithDist(dist) {
  let createApp;
  process.env.CLIENT_DIST = dist;
  try {
    jest.isolateModules(() => {
      ({ createApp } = require('../src/app'));
    });
  } finally {
    delete process.env.CLIENT_DIST;
  }
  return createApp();
}

describe('serving the built React app (CLIENT_DIST)', () => {
  let dist;
  let app;

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    app = appWithDist(dist);
  });

  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

  test('serves static files and index.html for client routes', async () => {
    const asset = await request(app).get('/assets/app.js').expect(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);

    for (const url of ['/', '/events/abc', '/checkout/123']) {
      const page = await request(app).get(url).expect(200);
      expect(page.text).toContain('id="root"');
      expect(page.headers['cache-control']).toBe('no-cache');
    }
  });

  test('API paths still return JSON 404s, not the app', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await request(app).get('/apix').expect(200); // only the /api prefix itself is reserved
  });
});
