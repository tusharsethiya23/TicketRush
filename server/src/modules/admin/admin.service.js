const AppError = require('../../lib/AppError');
const logger = require('../../lib/logger');
const { getRedis } = require('../../lib/redis');
const { keys } = require('../../lib/cache');
const { Booking, Event, RefreshToken, User } = require('../../models');

const MINUTE_MS = 60_000;
const FAILED_HOLDS_PREFIX = keys.failedHolds('');

const toAdminUser = (u) => ({
  id: String(u._id),
  email: u.email,
  role: u.role,
  status: u.status,
  createdAt: u.createdAt,
});

/** Bookings made per minute over the window, from MongoDB, with empty minutes as 0. */
async function bookingsPerMinute(minutes) {
  const end = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS; // start of the current minute
  const since = new Date(end - (minutes - 1) * MINUTE_MS);
  const rows = await Booking.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'minute' } }, count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [r._id.getTime(), r.count]));
  const series = [];
  for (let t = since.getTime(); t <= end; t += MINUTE_MS) {
    series.push({ minute: new Date(t), count: counts.get(t) ?? 0 });
  }
  return series;
}

/**
 * Failed hold attempts per event, from the Redis counters (SRS 7.2). They are best effort,
 * so a Redis outage gives null instead of failing the whole stats page.
 */
async function failedHoldsPerEvent() {
  let counters;
  try {
    const redis = getRedis();
    const found = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${FAILED_HOLDS_PREFIX}*`, 'COUNT', 200);
      found.push(...batch);
      cursor = next;
    } while (cursor !== '0' && found.length < 10_000);
    const values = found.length ? await redis.mget(...found) : [];
    counters = found.map((key, i) => ({ eventId: key.slice(FAILED_HOLDS_PREFIX.length), count: Number(values[i]) || 0 }));
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed-hold counters unavailable');
    return null;
  }

  const ids = counters.map((c) => c.eventId).filter((id) => /^[a-f\d]{24}$/i.test(id));
  const events = await Event.find({ _id: { $in: ids } }).select('name').lean();
  const names = new Map(events.map((e) => [String(e._id), e.name]));
  return counters
    .map((c) => ({ ...c, name: names.get(c.eventId) ?? null }))
    .sort((a, b) => b.count - a.count);
}

/** Time from sale start to sell-out, from events.soldOutAt (kept through cancels). */
async function sellOutTimes(limit = 50) {
  const events = await Event.find({ soldOutAt: { $ne: null } })
    .sort({ soldOutAt: -1 })
    .limit(limit)
    .select('name saleStartsAt soldOutAt status')
    .lean();
  return events.map((e) => ({
    eventId: String(e._id),
    name: e.name,
    status: e.status,
    saleStartsAt: e.saleStartsAt,
    soldOutAt: e.soldOutAt,
    secondsToSellOut: Math.max(0, Math.round((e.soldOutAt - e.saleStartsAt) / 1000)),
  }));
}

/** FR-18: GET /admin/stats */
async function getStats({ minutes }) {
  const [perMinute, failedHolds, sellOuts] = await Promise.all([
    bookingsPerMinute(minutes),
    failedHoldsPerEvent(),
    sellOutTimes(),
  ]);
  return {
    windowMinutes: minutes,
    bookingsPerMinute: perMinute,
    totalBookings: perMinute.reduce((sum, m) => sum + m.count, 0),
    failedHolds,
    sellOutTimes: sellOuts,
  };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds accounts for the block and unblock buttons. `q` matches the start of the email. */
async function listUsers({ q, role, status, page, limit }) {
  const filter = {};
  if (q) filter.email = { $regex: `^${escapeRegex(q.toLowerCase())}` };
  if (role) filter.role = role;
  if (status) filter.status = status;
  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('email role status createdAt')
      .lean(),
    User.countDocuments(filter),
  ]);
  return { users: users.map(toAdminUser), page, limit, total };
}

async function loadBlockable(userId) {
  const user = await User.findById(userId).select('email role status createdAt').lean();
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  // This also stops an admin blocking themselves, which could lock everyone out.
  if (user.role === 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin accounts cannot be blocked');
  return user;
}

/**
 * FR-32: block a user and revoke all their refresh tokens. authenticate re-reads the
 * account on every request, so their current access token stops working at once.
 */
async function blockUser(userId) {
  const user = await loadBlockable(userId);
  const now = new Date();
  await User.updateOne({ _id: user._id }, { $set: { status: 'blocked' } });
  await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: now } });
  return toAdminUser({ ...user, status: 'blocked' });
}

/** FR-32. The user logs in again; their old refresh tokens stay revoked. */
async function unblockUser(userId) {
  const user = await loadBlockable(userId);
  await User.updateOne({ _id: user._id }, { $set: { status: 'active' } });
  return toAdminUser({ ...user, status: 'active' });
}

module.exports = { getStats, listUsers, blockUser, unblockUser };
