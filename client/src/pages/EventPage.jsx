import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, serverNow } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';
import SeatMap from '../components/SeatMap.jsx';
import { saveCheckout } from '../lib/checkout.js';
import { dateLong, rupees, seatLabel } from '../lib/format.js';
import { useLoad } from '../lib/hooks.js';

export const MAX_SEATS = 6;
export const SEAT_REFRESH_MS = 5000; // FR-22

/** FR-21, FR-22: the event, its live seat map, and holding the picked seats (FR-7). */
export default function EventPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(() => new Map());
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState(null);
  const [notice, setNotice] = useState(null);

  const event = useLoad(() => api(`/events/${id}`, { auth: false }).then((r) => r.event), [id]);
  const seats = useLoad(() => api(`/events/${id}/seats`, { auth: false }).then((r) => r.seats), [id], {
    intervalMs: SEAT_REFRESH_MS,
  });

  // A picked seat someone else took drops out of the selection on the next refresh.
  useEffect(() => {
    if (!seats.data) return;
    const status = new Map(seats.data.map((s) => [s.id, s.status]));
    const lost = [...selected.values()].filter((s) => status.get(s.id) !== 'available');
    if (lost.length) {
      setSelected((cur) => {
        const next = new Map(cur);
        lost.forEach((s) => next.delete(s.id));
        return next;
      });
      setNotice(`${lost.map(seatLabel).join(', ')} ${lost.length === 1 ? 'was' : 'were'} just taken by someone else.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seats.data]);

  function toggle(seat) {
    setHoldError(null);
    setNotice(null);
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(seat.id)) next.delete(seat.id);
      else if (next.size < MAX_SEATS) next.set(seat.id, seat);
      else setNotice(`You can pick up to ${MAX_SEATS} seats at a time.`);
      return next;
    });
  }

  async function hold() {
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(`/events/${id}`)}`);
      return;
    }
    setHolding(true);
    setHoldError(null);
    try {
      const picked = [...selected.values()];
      const { hold: created } = await api(`/events/${id}/holds`, { method: 'POST', body: { seatIds: picked.map((s) => s.id) } });
      const e = event.data;
      saveCheckout({
        hold: created,
        event: { id: e.id, name: e.name, venue: e.venue, city: e.city, startsAt: e.startsAt },
        seats: picked,
      });
      navigate(`/checkout/${created.id}`);
    } catch (err) {
      setHoldError(err);
      if (err.code === 'SEAT_TAKEN') {
        const fresh = await seats.reload();
        if (fresh) {
          const free = new Set(fresh.filter((s) => s.status === 'available').map((s) => s.id));
          setSelected((cur) => new Map([...cur].filter(([sid]) => free.has(sid))));
        }
      }
    } finally {
      setHolding(false);
    }
  }

  if (event.error) return <Notice kind="error" error={event.error} action={<Link to="/">All events</Link>} />;
  if (!event.data) return <p className="muted">Loading…</p>;

  const e = event.data;
  const onSale = ['on_sale', 'sold_out'].includes(e.status) && new Date(e.saleStartsAt).getTime() <= serverNow();
  const canHold = !user || user.role === 'user';
  const picked = [...selected.values()];
  const total = picked.reduce((sum, s) => sum + s.pricePaise, 0);
  const available = seats.data?.filter((s) => s.status === 'available').length ?? 0;

  return (
    <div className="event-page">
      <header className="event-header">
        <p className="eyebrow">
          {e.city} · {e.venue}
        </p>
        <h1>{e.name}</h1>
        <p className="muted">{dateLong(e.startsAt)}</p>
        {e.status === 'sold_out' && <span className="badge badge-muted">Sold out</span>}
        {!onSale && e.status !== 'ended' && (
          <Notice kind="info">Tickets go on sale {dateLong(e.saleStartsAt)}.</Notice>
        )}
        {user && user.role !== 'user' && <Notice kind="info">Only fan accounts can book seats. You are signed in as {user.role}.</Notice>}
      </header>

      <div className="event-layout">
        <div className="card seatmap-card">
          <div className="seatmap-head">
            <h2>Pick your seats</h2>
            {seats.data && (
              <span className="muted" aria-live="polite">
                {available} available · updates every 5 s
              </span>
            )}
          </div>
          <Notice kind="error" error={seats.error} />
          {seats.data ? (
            <SeatMap seats={seats.data} selected={selected} onToggle={toggle} disabled={!onSale || !canHold || holding} />
          ) : (
            <p className="muted">Loading seats…</p>
          )}
        </div>

        <aside className="card summary" aria-label="Your selection">
          <h2>Your selection</h2>
          {picked.length === 0 ? (
            <p className="muted">Tap available seats to pick up to {MAX_SEATS}.</p>
          ) : (
            <ul className="summary-list">
              {picked.map((s) => (
                <li key={s.id}>
                  <span>{seatLabel(s)}</span>
                  <span>{rupees(s.pricePaise)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="summary-total">
            <span>Total</span>
            <strong>{rupees(total)}</strong>
          </div>
          <Notice kind="warning">{notice}</Notice>
          <Notice kind="error" error={holdError} />
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={picked.length === 0 || holding || !onSale || !canHold}
            onClick={hold}
          >
            {holding
              ? 'Holding…'
              : !user
                ? 'Log in to book'
                : picked.length
                  ? `Hold ${picked.length} seat${picked.length === 1 ? '' : 's'}`
                  : 'Hold seats'}
          </button>
          <p className="muted small">Held seats are yours for 5 minutes while you pay.</p>
        </aside>
      </div>
    </div>
  );
}
