import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import Notice from '../../components/Notice.jsx';
import { dateTime } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';

const STATUS = {
  draft: ['Draft', 'badge-muted'],
  on_sale: ['On sale', 'badge-good'],
  sold_out: ['Sold out', 'badge-info'],
  ended: ['Ended', 'badge-muted'],
};

/** FR-25: the organiser's events with Edit, Publish and Sales. */
export default function OrganiserEventsPage() {
  const { data, error, loading, reload } = useLoad(() => api('/organiser/events?limit=50'), []);
  const [publishing, setPublishing] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function publish(id) {
    setPublishing(id);
    setActionError(null);
    try {
      await api(`/events/${id}/publish`, { method: 'POST' });
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setPublishing(null);
      setConfirmId(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>My events</h1>
        <Link to="/organiser/events/new" className="btn btn-primary">
          New event
        </Link>
      </div>
      <Notice kind="error" error={error ?? actionError} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && data.events.length === 0 && (
        <div className="empty">
          <p>You have no events yet.</p>
          <Link to="/organiser/events/new" className="btn btn-primary">
            Create your first event
          </Link>
        </div>
      )}
      {data && data.events.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Starts</th>
                <th scope="col">Sale opens</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => {
                const [label, cls] = STATUS[e.status];
                return (
                  <tr key={e.id}>
                    <td>
                      <strong>{e.name}</strong>
                      <div className="muted small">
                        {e.venue}, {e.city}
                      </div>
                    </td>
                    <td>{dateTime(e.startsAt)}</td>
                    <td>{dateTime(e.saleStartsAt)}</td>
                    <td>
                      <span className={`badge ${cls}`}>{label}</span>
                    </td>
                    <td className="row-actions">
                      {e.status === 'draft' ? (
                        confirmId === e.id ? (
                          <span role="group" aria-label={`Publish ${e.name}?`}>
                            <span className="small">Publish? It can't be edited after. </span>
                            <button type="button" className="btn btn-primary btn-sm" disabled={publishing === e.id} onClick={() => publish(e.id)}>
                              {publishing === e.id ? 'Publishing…' : 'Yes, publish'}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmId(null)}>
                              No
                            </button>
                          </span>
                        ) : (
                          <>
                            <Link to={`/organiser/events/${e.id}/edit`} className="btn btn-ghost btn-sm">
                              Edit
                            </Link>
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirmId(e.id)}>
                              Publish
                            </button>
                          </>
                        )
                      ) : (
                        <>
                          <Link to={`/organiser/events/${e.id}/sales`} className="btn btn-ghost btn-sm">
                            Sales
                          </Link>
                          <Link to={`/events/${e.id}`} className="btn btn-ghost btn-sm">
                            View
                          </Link>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
