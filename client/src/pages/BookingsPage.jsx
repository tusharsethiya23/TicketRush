import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, serverNow } from '../api/client.js';
import Notice from '../components/Notice.jsx';
import TicketQr from '../components/TicketQr.jsx';
import { dateLong, rupees, seatLabel } from '../lib/format.js';
import { useLoad } from '../lib/hooks.js';

const CANCEL_CUTOFF_MS = 24 * 60 * 60 * 1000;

function BookingCard({ booking, onCancelled }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const startsAt = booking.event ? new Date(booking.event.startsAt).getTime() : 0;
  const cancellable = booking.status === 'confirmed' && startsAt - serverNow() > CANCEL_CUTOFF_MS;
  const past = startsAt < serverNow();

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/bookings/${booking.id}/cancel`, { method: 'POST' });
      onCancelled(res.booking);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className={`card booking${booking.status === 'cancelled' ? ' booking-cancelled' : ''}`}>
      <div className="booking-info">
        <p className="eyebrow">{booking.event ? dateLong(booking.event.startsAt) : ''}</p>
        <h2>{booking.event?.name ?? 'Event'}</h2>
        <p className="muted">{booking.event && `${booking.event.venue}, ${booking.event.city}`}</p>
        <p>
          {booking.seats.map(seatLabel).join(', ')} · {rupees(booking.totalPaise)}
        </p>
        <p>
          {booking.status === 'cancelled' ? (
            <span className="badge badge-muted">Cancelled</span>
          ) : past ? (
            <span className="badge badge-muted">Past</span>
          ) : (
            <span className="badge badge-good">Confirmed</span>
          )}
        </p>
        <Notice kind="error" error={error} />
        {cancellable &&
          (confirming ? (
            <div className="actions" role="group" aria-label="Confirm cancellation">
              <span>Cancel this booking? The seats go back on sale.</span>
              <button type="button" className="btn btn-danger btn-sm" onClick={cancel} disabled={busy}>
                {busy ? 'Cancelling…' : 'Yes, cancel'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
              Cancel booking
            </button>
          ))}
        {booking.status === 'confirmed' && !cancellable && !past && (
          <p className="muted small">Cancellation closes 24 hours before the event.</p>
        )}
      </div>
      {booking.status === 'confirmed' && <TicketQr code={booking.ticketCode} />}
    </li>
  );
}

/** FR-24: your bookings, newest first, with QR tickets and cancel. */
export default function BookingsPage() {
  const [page, setPage] = useState(1);
  const { data, error, loading, setData } = useLoad(() => api(`/me/bookings?page=${page}&limit=10`), [page]);

  function replace(updated) {
    setData({ ...data, bookings: data.bookings.map((b) => (b.id === updated.id ? { ...b, ...updated } : b)) });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <>
      <h1>My bookings</h1>
      <Notice kind="error" error={error} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && data.bookings.length === 0 && (
        <div className="empty">
          <p>No bookings yet.</p>
          <Link to="/" className="btn btn-primary">
            Find an event
          </Link>
        </div>
      )}
      <ul className="booking-list">
        {data?.bookings.map((b) => (
          <BookingCard key={b.id} booking={b} onCancelled={replace} />
        ))}
      </ul>
      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Newer
          </button>
          <span className="muted">
            Page {page} of {pages}
          </span>
          <button type="button" className="btn btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Older
          </button>
        </nav>
      )}
    </>
  );
}
