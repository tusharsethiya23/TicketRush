const { z } = require('zod');

// Tests set their own env in tests/setupEnv.js; never let a local .env leak into them.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ quiet: true });
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGO_URI: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_ACTIVE_HOLDS_PER_EVENT: z.coerce.number().int().positive().default(2),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.optional(),
  // Number of proxy hops to trust for req.ip (0 = none). Set to 1 behind one reverse proxy.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Rate limits (FR-17, SRS 8.3). Requests per window.
  RATE_LIMIT_ENABLED: bool.default(true),
  RATE_LIMIT_IP_ENABLED: bool.default(true), // false for k6 load tests, which send from one IP
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RL_ALL_USER: z.coerce.number().int().positive().default(120),
  RL_ALL_IP: z.coerce.number().int().positive().default(300),
  RL_AUTH_IP: z.coerce.number().int().positive().default(10),
  RL_HOLD_USER: z.coerce.number().int().positive().default(10),
  RL_HOLD_IP: z.coerce.number().int().positive().default(30),
  RL_CONFIRM_USER: z.coerce.number().int().positive().default(10),
  RL_CONFIRM_IP: z.coerce.number().int().positive().default(30),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // Logger depends on config, so fail loudly with plain stderr.
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

const config = {
  ...parsed.data,
  COOKIE_SECURE: parsed.data.COOKIE_SECURE ?? parsed.data.NODE_ENV === 'production',
};

module.exports = Object.freeze(config);
