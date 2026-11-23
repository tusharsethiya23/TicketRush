/**
 * Creates or promotes the admin account. Admins are never created through the API (SRS 2.1).
 * Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin
 */
const bcrypt = require('bcrypt');
const { z } = require('zod');
const config = require('../src/config/env');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const { User } = require('../src/models');

const input = z
  .object({
    ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
    ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters'),
  })
  .safeParse(process.env);

async function main() {
  if (!input.success) {
    console.error(input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = input.data;

  await connectMongo();
  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);
  const admin = await User.findOneAndUpdate(
    { email },
    { $set: { passwordHash, role: 'admin', status: 'active' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  console.log(`Admin ready: ${admin.email}`);
  await disconnectMongo();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectMongo();
  process.exit(1);
});
