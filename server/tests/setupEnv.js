// Runs in every test worker before any module is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BCRYPT_ROUNDS = '4';
process.env.COOKIE_SECURE = 'false';
// Every test request comes from one IP, like k6; per-IP limits are tested with their own limiter.
process.env.RATE_LIMIT_IP_ENABLED = 'false';
// Payments always succeed instantly; tests force a failure with jest.spyOn(payments, 'charge').
process.env.PAYMENT_SUCCESS_RATE = '1';
process.env.PAYMENT_DELAY_MS = '0';
// MONGO_URI is set by globalSetup.js.
