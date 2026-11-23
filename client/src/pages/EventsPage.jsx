import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import Notice from '../components/Notice.jsx';
import { dateLong } from '../lib/format.js';
import { useLoad } from '../lib/hooks.js';

const PAGE_SIZE = 12;

/** Builds the query string for GET /events from the filter form. */
export function eventsQuery({ city, from, to, page }) {
  const q = new URLSearchParams();
  if (city) q.set('city', city);
  if (from) q.set('from', new Date(`${from}T00:00`).toISOString());
  if (to) q.set('to', new Date(`${to}T23:59:59`).toISOString());
  q.set('page', String(page || 1));
  q.set('limit', String(PAGE_SIZE));
  return q.toString();
}

/** FR-21: upcoming events, filtered by city and dates. The filters live in the URL. */
export default function EventsPage() {
  const [params, setParams] = useSearchParams();
  const filters = { city: params.get('city') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const page = Number(params.get('page')) || 1;
  const [form, setForm] = useState(filters);

  const { data, error, loading } = useLoad(
    () => api(`/events?${eventsQuery({ ...filters, page })}`, { auth: false }),
    [filters.city, filters.from, filters.to, page],
  );

  function apply(e) {
    e.preventDefault();
    const next = {};
    for (const [k, v] of Object.entries(form)) if (v.trim()) next[k] = v.trim();
    setParams(next);
  }

  function clear() {
    setForm({ city: '', from: '', to: '' });
    setParams({});
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const goTo = (p) => setParams({ ...Object.fromEntries(params), page: String(p) });

  return (
    <>
      <h1>Upcoming events</h1>
      <form className="filters" onSubmit={apply} role="search">
        <label>
          City
          <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Any city" />
        </label>
        <label>
          From
          <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </label>
        <div className="filters-actions">
          <button type="submit" className="btn btn-primary">
            Search
          </button>
          {(filters.city || filters.from || filters.to) && (
            <button type="button" className="btn btn-ghost" onClick={clear}>
              Clear
            </button>
          )}
        </div>
      </form>

      <Notice kind="error" error={error} />
      {loading && !data && <p className="muted">Loading events…</p>}
      {data && data.events.length === 0 && (
        <div className="empty">
          <p>No events match these filters.</p>
        </div>
      )}

      <ul className="event-grid">
        {data?.events.map((e) => (
          <li key={e.id} className="card event-card">
            <Link to={`/events/${e.id}`} className="event-card-link">
              <span className="event-date">{dateLong(e.startsAt)}</span>
              <span className="event-name">{e.name}</span>
              <span className="muted">
                {e.venue}, {e.city}
              </span>
              {e.status === 'sold_out' && <span className="badge badge-muted">Sold out</span>}
            </Link>
          </li>
        ))}
      </ul>

      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => goTo(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page} of {pages}
          </span>
          <button type="button" className="btn btn-ghost" disabled={page >= pages} onClick={() => goTo(page + 1)}>
            Next
          </button>
        </nav>
      )}
    </>
  );
}
