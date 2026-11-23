const QRCode = require('qrcode');
const config = require('../config/env');
const logger = require('../lib/logger');
const mailer = require('../lib/mailer');
const { invalidate, keys } = require('../lib/cache');
const { releaseHold } = require('../modules/holds/holds.service');
const { Booking, Event, Hold, Seat, User } = require('../models');

/** FR-9: the delayed release-hold job. A converted or released hold is left alone (SRS 6.3). */
async function processReleaseHold(job) {
  const released = await releaseHold(job.data.holdId, { reason: 'expired' });
  return { released };
}

/**
 * NFR-6: the every-minute sweep. It releases every active hold past expiresAt, so holds
 * expire even when a release job was lost or Redis was down. Running it twice is harmless.
 */
async function sweepExpiredHolds({ batchSize = config.SWEEP_BATCH_SIZE } = {}) {
  const expired = await Hold.find({ status: 'active', expiresAt: { $lte: new Date() } })
    .sort({ expiresAt: 1 })
    .limit(batchSize)
    .select('_id')
    .lean();

  let released = 0;
  for (const { _id } of expired) {
    try {
      if (await releaseHold(_id, { reason: 'expired' })) released++;
    } catch (err) {
      logger.error({ err, holdId: String(_id) }, 'Sweep could not release a hold');
    }
  }

  const reopened = await reopenSoldOutEvents();
  return { found: expired.length, released, reopened };
}

/**
 * FR-28 repair: a cancel that lands between a confirm's sold-out check and its update
 * can leave a sold_out event with a free seat. Put such events back on sale.
 */
async function reopenSoldOutEvents() {
  const soldOut = await Event.find({ status: 'sold_out', startsAt: { $gt: new Date() } }).select('_id').lean();
  let reopened = 0;
  for (const { _id } of soldOut) {
    if (!(await Seat.exists({ eventId: _id, status: { $ne: 'booked' } }))) continue;
    const { modifiedCount } = await Event.updateOne({ _id, status: 'sold_out' }, { $set: { status: 'on_sale' } });
    if (modifiedCount) {
      reopened++;
      await invalidate(keys.event(String(_id)));
    }
  }
  return reopened;
}

/** FR-16: retry delays of 1 s, 4 s and 16 s (with the default base of 1000 ms). */
function emailBackoff(attemptsMade, baseMs = config.EMAIL_BACKOFF_BASE_MS) {
  return baseMs * 4 ** (attemptsMade - 1);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

function buildBookingEmail({ user, booking, event, seats, qrPng }) {
  const when = event.startsAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
  const seatList = seats.map((s) => `${s.section} ${s.row}${s.number}`).join(', ');
  const text = [
    'Your booking is confirmed.',
    '',
    `Event: ${event.name}`,
    `Venue: ${event.venue}, ${event.city}`,
    `When: ${when} IST`,
    `Seats: ${seatList}`,
    `Total: ${rupees(booking.totalPaise)}`,
    `Ticket code: ${booking.ticketCode}`,
    '',
    'Show the QR code in this email at the entrance.',
  ].join('\n');
  const html = `
    <h2>Your booking is confirmed</h2>
    <p><strong>${escapeHtml(event.name)}</strong><br>
       ${escapeHtml(event.venue)}, ${escapeHtml(event.city)}<br>
       ${escapeHtml(when)} IST</p>
    <p>Seats: ${escapeHtml(seatList)}<br>Total: ${escapeHtml(rupees(booking.totalPaise))}</p>
    <p>Ticket code: <strong>${escapeHtml(booking.ticketCode)}</strong></p>
    <p><img src="cid:ticket-qr" alt="QR code for ${escapeHtml(booking.ticketCode)}" width="240" height="240"></p>
    <p>Show this QR code at the entrance.</p>`;
  return {
    to: user.email,
    subject: `Your tickets for ${event.name}`,
    text,
    html,
    attachments: [{ filename: `${booking.ticketCode}.png`, content: qrPng, cid: 'ticket-qr', contentType: 'image/png' }],
  };
}

/**
 * FR-15: the confirmation email with a QR code of the ticket code. Throwing makes BullMQ
 * retry (FR-16). emailSentAt stops a re-run from sending the same email twice.
 */
async function processBookingEmail(job) {
  const booking = await Booking.findById(job.data.bookingId).lean();
  if (!booking) return { skipped: 'booking not found' };
  if (booking.emailSentAt) return { skipped: 'already sent' };
  if (booking.status !== 'confirmed') return { skipped: 'booking cancelled' };

  const [user, event, seats] = await Promise.all([
    User.findById(booking.userId).select('email').lean(),
    Event.findById(booking.eventId).select('name venue city startsAt').lean(),
    Seat.find({ _id: { $in: booking.seatIds } })
      .select('section row number')
      .sort({ section: 1, row: 1, number: 1 })
      .lean(),
  ]);
  if (!user || !event) return { skipped: 'user or event not found' };

  const qrPng = await QRCode.toBuffer(booking.ticketCode, { errorCorrectionLevel: 'M', width: 480, margin: 2 });
  await mailer.send(buildBookingEmail({ user, booking, event, seats, qrPng }));
  await Booking.updateOne({ _id: booking._id }, { $set: { emailSentAt: new Date() } });
  return { sent: true };
}

module.exports = {
  processReleaseHold,
  sweepExpiredHolds,
  reopenSoldOutEvents,
  processBookingEmail,
  buildBookingEmail,
  emailBackoff,
};
