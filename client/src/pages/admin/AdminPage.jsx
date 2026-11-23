import { useState } from 'react';
import { api } from '../../api/client.js';
import BarChart from '../../components/BarChart.jsx';
import Notice from '../../components/Notice.jsx';
import { dateTime, duration } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';

const WINDOWS = [
  [15, 'Last 15 min'],
  [60, 'Last hour'],
  [360, 'Last 6 hours'],
  [1440, 'Last 24 hours'],
];

const hhmm = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** FR-18: bookings per minute, failed holds per event and time to sell out. */
function Stats() {
  const [minutes, setMinutes] = useState(60);
  const { data, error } = useLoad(() => api(`/admin/stats?minutes=${minutes}`), [minutes], { intervalMs: 15_000 });

  return (
    <section aria-labelledby="stats-title" className="admin-section">
      <div className="page-head">
        <h2 id="stats-title">Live stats</h2>
        <div className="segmented" role="group" aria-label="Time window">
          {WINDOWS.map(([m, label]) => (
            <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <Notice kind="error" error={error} />
      {data && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="stat-label">Bookings</span>
              <span className="stat-value">{data.totalBookings.toLocaleString('en-IN')}</span>
              <span className="stat-sub muted">{WINDOWS.find(([m]) => m === minutes)[1].toLowerCase()}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Busiest minute</span>
              <span className="stat-value">{Math.max(0, ...data.bookingsPerMinute.map((b) => b.count)).toLocaleString('en-IN')}</span>
              <span className="stat-sub muted">bookings</span>
            </div>
            <div className="stat">
              <span className="stat-label">Failed hold attempts</span>
              <span className="stat-value">
                {data.failedHolds ? data.failedHolds.reduce((s, f) => s + f.count, 0).toLocaleString('en-IN') : '—'}
              </span>
              <span className="stat-sub muted">{data.failedHolds ? 'all events, last 7 days' : 'unavailable while Redis is down'}</span>
            </div>
          </div>

          <div className="card">
            <BarChart
              title="Bookings per minute"
              data={data.bookingsPerMinute.map((b) => ({ x: b.minute, value: b.count }))}
              formatX={hhmm}
              formatRange={(a, b) => `${hhmm(a)}–${hhmm(b)}`}
            />
          </div>

          <div className="two-col">
            <div className="card">
              <h3>Failed holds per event</h3>
              {data.failedHolds === null ? (
                <Notice kind="warning">Redis is down, so these counters are unavailable. Bookings are not affected.</Notice>
              ) : data.failedHolds.length === 0 ? (
                <p className="muted">No failed holds.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col" className="num">
                          Failed attempts
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.failedHolds.map((f) => (
                        <tr key={f.eventId}>
                          <td>{f.name ?? <span className="muted">Deleted event</span>}</td>
                          <td className="num">{f.count.toLocaleString('en-IN')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="card">
              <h3>Time to sell out</h3>
              {data.sellOutTimes.length === 0 ? (
                <p className="muted">No event has sold out yet.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">Sold out</th>
                        <th scope="col" className="num">
                          Took
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sellOutTimes.map((s) => (
                        <tr key={s.eventId}>
                          <td>{s.name}</td>
                          <td>{dateTime(s.soldOutAt)}</td>
                          <td className="num">{duration(s.secondsToSellOut)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** FR-32: find accounts and block or unblock them. */
function Users() {
  const [query, setQuery] = useState({ q: '', status: '' });
  const [form, setForm] = useState(query);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const params = new URLSearchParams({ limit: '20', ...(query.q && { q: query.q }), ...(query.status && { status: query.status }) });
  const { data, error, reload } = useLoad(() => api(`/admin/users?${params}`), [query.q, query.status]);

  async function setBlocked(user, block) {
    setBusy(user.id);
    setActionError(null);
    try {
      await api(`/admin/users/${user.id}/${block ? 'block' : 'unblock'}`, { method: 'POST' });
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="users-title" className="admin-section">
      <h2 id="users-title">Users</h2>
      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ q: form.q.trim(), status: form.status });
        }}
      >
        <label>
          Email starts with
          <input value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="name@" />
        </label>
        <label>
          Status
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
          </select>
        </label>
        <div className="filters-actions">
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </div>
      </form>
      <Notice kind="error" error={error ?? actionError} />
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td className="break">{u.email}</td>
                  <td>{u.role}</td>
                  <td>
                    <span className={`badge ${u.status === 'blocked' ? 'badge-bad' : 'badge-good'}`}>{u.status}</span>
                  </td>
                  <td>{dateTime(u.createdAt)}</td>
                  <td className="row-actions">
                    {u.role !== 'admin' &&
                      (u.status === 'blocked' ? (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy === u.id} onClick={() => setBlocked(u, false)}>
                          Unblock
                        </button>
                      ) : (
                        <button type="button" className="btn btn-danger btn-sm" disabled={busy === u.id} onClick={() => setBlocked(u, true)}>
                          Block
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.users.length === 0 && <p className="muted">No accounts match.</p>}
          {data.total > data.users.length && (
            <p className="muted small">
              Showing {data.users.length} of {data.total}. Narrow the search to find someone.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default function AdminPage() {
  return (
    <>
      <h1>Admin</h1>
      <Stats />
      <Users />
    </>
  );
}
