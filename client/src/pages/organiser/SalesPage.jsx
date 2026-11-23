import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import Notice from '../../components/Notice.jsx';
import { dateLong, rupees } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub muted">{sub}</span>}
    </div>
  );
}

/** FR-31: seats sold, revenue and active holds; refreshes every 10 s. */
export default function SalesPage() {
  const { id } = useParams();
  const { data, error } = useLoad(() => api(`/organiser/events/${id}/sales`), [id], { intervalMs: 10_000 });

  if (error) return <Notice kind="error" error={error} action={<Link to="/organiser/events">My events</Link>} />;
  if (!data) return <p className="muted">Loading…</p>;

  const { event, seats, bookings, revenuePaise, activeHolds } = data;
  const soldPct = seats.total ? Math.round((seats.booked / seats.total) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">{dateLong(event.startsAt)}</p>
          <h1>{event.name} · sales</h1>
        </div>
        <Link to="/organiser/events" className="btn btn-ghost">
          My events
        </Link>
      </div>
      <div className="stats">
        <Stat label="Seats sold" value={`${seats.booked.toLocaleString('en-IN')} / ${seats.total.toLocaleString('en-IN')}`} sub={`${soldPct}% sold`} />
        <Stat label="Revenue" value={rupees(revenuePaise)} sub={`${bookings.confirmed} bookings`} />
        <Stat label="Active holds" value={activeHolds} sub={`${seats.held} seats held right now`} />
        <Stat label="Available" value={seats.available.toLocaleString('en-IN')} sub={bookings.cancelled ? `${bookings.cancelled} cancelled bookings` : 'seats left'} />
      </div>
      <p className="muted small">Updates every 10 seconds. Revenue counts confirmed bookings only.</p>
    </>
  );
}
