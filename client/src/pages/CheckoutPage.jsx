import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import Countdown from '../components/Countdown.jsx';
import Notice from '../components/Notice.jsx';
import TicketQr from '../components/TicketQr.jsx';
import { clearCheckout, loadCheckout } from '../lib/checkout.js';
import { dateLong, rupees, seatLabel } from '../lib/format.js';

/**
 * FR-23: pay for a hold before it runs out. The Idempotency-Key is created once per
 * checkout (with the hold) and sent with every Pay attempt, so retrying after a decline,
 * a timeout or a reload can never book or charge twice.
 */
export default function CheckoutPage() {
  const { holdId } = useParams();
  const navigate = useNavigate();
  const [checkout] = useState(() => loadCheckout(holdId));
  const [phase, setPhase] = useState('ready'); // ready | paying | booked | expired
  const [error, setError] = useState(null);
  const [booking, setBooking] = useState(null);

  if (!checkout && phase !== 'booked') {
    return (
      <Notice kind="info" action={<Link to="/">Find events</Link>}>
        This checkout is no longer open. Your seats may have been released.
      </Notice>
    );
  }

  const { hold, event, seats, idempotencyKey } = checkout;
  const total = seats.reduce((sum, s) => sum + s.pricePaise, 0);

  async function pay() {
    setPhase('paying');
    setError(null);
    try {
      const res = await api(`/holds/${hold.id}/confirm`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      clearCheckout(hold.id);
      setBooking(res.booking);
      setPhase('booked');
    } catch (err) {
      setError(err);
      if (err.code === 'HOLD_EXPIRED') {
        clearCheckout(hold.id);
        setPhase('expired');
      } else {
        setPhase('ready'); // 402, 409 and network errors: Pay again with the same key
      }
    }
  }

  async function release() {
    try {
      await api(`/holds/${hold.id}`, { method: 'DELETE' });
    } catch {
      // Already expired or released: either way the seats are free.
    }
    clearCheckout(hold.id);
    navigate(`/events/${event.id}`);
  }

  function onExpire() {
    // A payment already in flight is decided by the server, not the local clock.
    setPhase((p) => (p === 'ready' ? 'expired' : p));
  }

  if (phase === 'booked') {
    return (
      <div className="card confirm-card">
        <Notice kind="success">You're going! Your booking is confirmed and a confirmation email is on its way.</Notice>
        <h1>{event.name}</h1>
        <p className="muted">
          {dateLong(event.startsAt)} · {event.venue}, {event.city}
        </p>
        <p>
          {seats.map(seatLabel).join(', ')} · <strong>{rupees(booking.totalPaise)}</strong>
        </p>
        <TicketQr code={booking.ticketCode} size={176} />
        <div className="actions">
          <Link to="/bookings" className="btn btn-primary">
            My bookings
          </Link>
          <Link to="/" className="btn btn-ghost">
            More events
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout">
      <h1>Checkout</h1>
      <div className="card">
        <p className="eyebrow">{dateLong(event.startsAt)}</p>
        <h2>{event.name}</h2>
        <p className="muted">
          {event.venue}, {event.city}
        </p>

        {phase === 'expired' ? (
          <Notice
            kind="error"
            error={error ?? { code: 'HOLD_EXPIRED' }}
            action={
              <Link to={`/events/${event.id}`} className="btn btn-sm btn-ghost">
                Pick seats again
              </Link>
            }
          />
        ) : (
          <Countdown expiresAt={hold.expiresAt} onExpire={onExpire} />
        )}

        <ul className="summary-list">
          {seats.map((s) => (
            <li key={s.id}>
              <span>{seatLabel(s)}</span>
              <span>{rupees(s.pricePaise)}</span>
            </li>
          ))}
        </ul>
        <div className="summary-total">
          <span>Total</span>
          <strong>{rupees(total)}</strong>
        </div>

        {phase !== 'expired' && <Notice kind="error" error={error} />}

        {phase !== 'expired' && (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={pay} disabled={phase === 'paying'}>
              {phase === 'paying' ? 'Paying…' : error ? 'Try payment again' : `Pay ${rupees(total)}`}
            </button>
            <button type="button" className="btn btn-ghost" onClick={release} disabled={phase === 'paying'}>
              Release seats
            </button>
          </div>
        )}
        <p className="muted small">This is a demo: no real money is taken.</p>
      </div>
    </div>
  );
}
