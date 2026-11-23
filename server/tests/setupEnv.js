// Runs in every test worker before any module is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BCRYPT_ROUNDS = '4';
process.env.COOKIE_SECURE = 'false';
// MONGO_URI is set by globalSetup.js.
