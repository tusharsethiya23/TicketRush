/**
 * Correctness checks after a load test (SRS 9). Exits 1 if any check fails.
 *
 *   node loadtest/verify.js [eventId]          # MONGO_URI from the environment or server/.env
 *
 * Checks, for the whole database and (with an eventId) for that event:
 *   1. the SRS 9 aggregation: no seat in two confirmed bookings (NFR-1)
 *   2. booked seats == seats in confirmed bookings, and every booked seat points at its booking's hold
 *   3. every successful charge became a booking (succeeded payments == confirmed bookings)
 *   4. no hold is still active long after it expired (NFR-6: the sweep frees them within a minute)
 *   5. held seats belong to active holds only
 */
const path = require('node:path');
const { createRequire } = require('node:module');

const serverRequire = createRequire(path.join(__dirname, '..', 'server', 'package.json'));
serverRequire('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env'), quiet: true });
const mongoose = serverRequire('mongoose');

const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/ticketrush?directConnection=true';
const eventId = process.argv[2];
const SWEEP_GRACE_MS = Number(process.env.SWEEP_GRACE_MS || 90_000);

let failed = 0;
function report(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `: ${detail}` : ''}`);
  if (!ok) failed++;
}

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  const scope = eventId ? { eventId: new mongoose.Types.ObjectId(eventId) } : {};
  console.log(`Database ${db.databaseName}${eventId ? `, event ${eventId}` : ', all events'}\n`);

  // 1. SRS 9: this must return an empty array.
  const duplicates = await db
    .collection('bookings')
    .aggregate([
      { $match: { status: 'confirmed', ...scope } },
      { $unwind: '$seatIds' },
      { $group: { _id: '$seatIds', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  report('No seat in two confirmed bookings (SRS 9 aggregation is empty)', duplicates.length === 0, JSON.stringify(duplicates));

  // 2. Seats agree with bookings.
  const confirmed = await db.collection('bookings').find({ status: 'confirmed', ...scope }).project({ seatIds: 1, holdId: 1 }).toArray();
  const seatsInBookings = confirmed.reduce((n, b) => n + b.seatIds.length, 0);
  const bookedSeats = await db.collection('seats').countDocuments({ status: 'booked', ...scope });
  report('Booked seats == seats in confirmed bookings', bookedSeats === seatsInBookings, `${bookedSeats} booked, ${seatsInBookings} in bookings`);

  const holdBySeat = new Map(confirmed.flatMap((b) => b.seatIds.map((s) => [String(s), String(b.holdId)])));
  const booked = await db.collection('seats').find({ status: 'booked', ...scope }).project({ holdId: 1 }).toArray();
  const orphans = booked.filter((s) => holdBySeat.get(String(s._id)) !== String(s.holdId));
  report('Every booked seat belongs to its booking’s hold', orphans.length === 0, `${orphans.length} mismatched`);

  // 3. Money: every successful charge has a booking; failures and refunds do not.
  const holdIds = eventId ? (await db.collection('holds').find(scope).project({ _id: 1 }).toArray()).map((h) => h._id) : null;
  const payScope = holdIds ? { holdId: { $in: holdIds } } : {};
  const succeeded = await db.collection('payments').countDocuments({ status: 'succeeded', ...payScope });
  const refunded = await db.collection('payments').countDocuments({ status: 'refunded', ...payScope });
  report('Successful charges == confirmed bookings (refunds counted apart)', succeeded === confirmed.length, `${succeeded} charged, ${confirmed.length} bookings, ${refunded} refunded`);

  // 4. NFR-6: expired holds do not linger.
  const stale = await db
    .collection('holds')
    .countDocuments({ status: 'active', expiresAt: { $lt: new Date(Date.now() - SWEEP_GRACE_MS) }, ...scope });
  report(`No active hold expired more than ${SWEEP_GRACE_MS / 1000} s ago`, stale === 0, `${stale} stale`);

  // 5. Held seats point at active holds.
  const activeHoldIds = new Set(
    (await db.collection('holds').find({ status: 'active', ...scope }).project({ _id: 1 }).toArray()).map((h) => String(h._id)),
  );
  const held = await db.collection('seats').find({ status: 'held', ...scope }).project({ holdId: 1 }).toArray();
  const strayHeld = held.filter((s) => !activeHoldIds.has(String(s.holdId)));
  report('Every held seat belongs to an active hold', strayHeld.length === 0, `${held.length} held, ${strayHeld.length} stray`);

  // Summary for the README.
  const holdStates = await db
    .collection('holds')
    .aggregate([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray();
  const seatStates = await db
    .collection('seats')
    .aggregate([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray();
  const fmt = (rows) => rows.map((r) => `${r._id} ${r.n}`).join(', ');
  console.log(`\nBookings: ${confirmed.length} confirmed`);
  console.log(`Seats:    ${fmt(seatStates)}`);
  console.log(`Holds:    ${fmt(holdStates)}`);
  console.log(`\n${failed ? `${failed} check(s) FAILED` : 'All checks passed'}`);

  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
