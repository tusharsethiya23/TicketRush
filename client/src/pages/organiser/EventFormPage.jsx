import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import Notice from '../../components/Notice.jsx';
import { fromLocalInput, rupees, toLocalInput } from '../../lib/format.js';

const MAX_SEATS = 10_000;
const newRow = (label = 'A') => ({ label, seatCount: 10, price: '500' });
const newSection = (name = 'Section 1') => ({ name, rows: [newRow()] });
const nextLabel = (rows) => String.fromCharCode(65 + (rows.length % 26)) + (rows.length >= 26 ? Math.floor(rows.length / 26) : '');

/** Form state (prices in rupees, as typed) → the API's seat map (prices in paise). */
export function toSeatMap(sections) {
  return {
    sections: sections.map((s) => ({
      name: s.name.trim(),
      rows: s.rows.map((r) => ({
        label: String(r.label).trim(),
        seatCount: Number(r.seatCount),
        pricePaise: Math.round(Number(r.price) * 100),
      })),
    })),
  };
}

const fromSeatMap = (seatMap) =>
  seatMap.sections.map((s) => ({
    name: s.name,
    rows: s.rows.map((r) => ({ label: r.label, seatCount: r.seatCount, price: String(r.pricePaise / 100) })),
  }));

export const seatTotal = (sections) => sections.reduce((n, s) => n + s.rows.reduce((m, r) => m + (Number(r.seatCount) || 0), 0), 0);

/** FR-25: create or edit a draft event and its seat map. */
export default function EventFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', venue: '', city: '', startsAt: '', saleStartsAt: '' });
  const [sections, setSections] = useState([newSection()]);
  const [loaded, setLoaded] = useState(!editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!editing) return;
    api(`/organiser/events/${id}`)
      .then(({ event, seatMap }) => {
        setForm({
          name: event.name,
          venue: event.venue,
          city: event.city,
          startsAt: toLocalInput(event.startsAt),
          saleStartsAt: toLocalInput(event.saleStartsAt),
        });
        setSections(fromSeatMap(seatMap));
        if (event.status !== 'draft') setError({ code: 'EVENT_NOT_EDITABLE' });
        setLoaded(true);
      })
      .catch((err) => {
        setError(err);
        setLoaded(true);
      });
  }, [editing, id]);

  const updateSection = (i, patch) => setSections(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const updateRow = (i, r, patch) =>
    updateSection(i, { rows: sections[i].rows.map((row, k) => (k === r ? { ...row, ...patch } : row)) });

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      venue: form.venue.trim(),
      city: form.city.trim(),
      startsAt: fromLocalInput(form.startsAt),
      saleStartsAt: fromLocalInput(form.saleStartsAt),
      seatMap: toSeatMap(sections),
    };
    try {
      await api(editing ? `/events/${id}` : '/events', { method: editing ? 'PATCH' : 'POST', body });
      navigate('/organiser/events');
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  if (!loaded) return <p className="muted">Loading…</p>;
  const total = seatTotal(sections);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  return (
    <form className="event-form" onSubmit={submit}>
      <div className="page-head">
        <h1>{editing ? 'Edit draft event' : 'New event'}</h1>
        <Link to="/organiser/events" className="btn btn-ghost">
          Back
        </Link>
      </div>
      <Notice kind="error" error={error} />

      <fieldset className="card">
        <legend>Details</legend>
        <div className="form-grid">
          <label>
            Name
            <input required maxLength={200} value={form.name} onChange={set('name')} />
          </label>
          <label>
            Venue
            <input required maxLength={200} value={form.venue} onChange={set('venue')} />
          </label>
          <label>
            City
            <input required maxLength={100} value={form.city} onChange={set('city')} />
          </label>
          <label>
            Event starts
            <input type="datetime-local" required value={form.startsAt} onChange={set('startsAt')} />
          </label>
          <label>
            Tickets go on sale
            <input type="datetime-local" required value={form.saleStartsAt} onChange={set('saleStartsAt')} />
          </label>
        </div>
        <p className="muted small">Times are in your local time zone. The sale must open before the event starts.</p>
      </fieldset>

      <fieldset className="card">
        <legend>Seat map</legend>
        {sections.map((section, i) => (
          <div key={i} className="section-editor">
            <div className="section-editor-head">
              <label>
                Section name
                <input required maxLength={50} value={section.name} onChange={(e) => updateSection(i, { name: e.target.value })} />
              </label>
              {sections.length > 1 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSections(sections.filter((_, j) => j !== i))}>
                  Remove section
                </button>
              )}
            </div>
            <table className="table rows-table">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Seats</th>
                  <th scope="col">Price (₹)</th>
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, r) => (
                  <tr key={r}>
                    <td>
                      <input
                        aria-label={`${section.name} row ${r + 1} label`}
                        required
                        maxLength={10}
                        value={row.label}
                        onChange={(e) => updateRow(i, r, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${section.name} row ${r + 1} seats`}
                        type="number"
                        min={1}
                        max={100}
                        required
                        value={row.seatCount}
                        onChange={(e) => updateRow(i, r, { seatCount: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${section.name} row ${r + 1} price in rupees`}
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        value={row.price}
                        onChange={(e) => updateRow(i, r, { price: e.target.value })}
                      />
                    </td>
                    <td>
                      {section.rows.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={`Remove ${section.name} row ${row.label}`}
                          onClick={() => updateSection(i, { rows: section.rows.filter((_, k) => k !== r) })}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => updateSection(i, { rows: [...section.rows, { ...newRow(nextLabel(section.rows)), price: section.rows.at(-1).price }] })}
            >
              Add row
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={sections.length >= 20}
          onClick={() => setSections([...sections, newSection(`Section ${sections.length + 1}`)])}
        >
          Add section
        </button>
        <p className={total > MAX_SEATS ? 'error-text' : 'muted'}>
          {total.toLocaleString('en-IN')} seats in total{total > MAX_SEATS && ` (the limit is ${MAX_SEATS.toLocaleString('en-IN')})`}
          {' · '}from {rupees(Math.min(...sections.flatMap((s) => s.rows.map((r) => Math.round(Number(r.price) * 100) || 0))))}
        </p>
      </fieldset>

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={saving || total > MAX_SEATS || error?.code === 'EVENT_NOT_EDITABLE'}>
          {saving ? 'Saving…' : editing ? 'Save draft' : 'Create draft'}
        </button>
        <span className="muted small">Drafts are private. Publish from My events when it's ready.</span>
      </div>
    </form>
  );
}
