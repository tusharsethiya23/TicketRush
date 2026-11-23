const { z } = require('zod');

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Must be a valid email'));

// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes');

const registerSchema = z.strictObject({
  email,
  password,
  role: z.enum(['user', 'organiser']).default('user'),
});

const loginSchema = z.strictObject({
  email,
  password: z.string().min(1).max(200),
});

module.exports = { registerSchema, loginSchema };
