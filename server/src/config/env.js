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

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.optional(),
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
