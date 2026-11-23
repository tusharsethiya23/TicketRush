import { rupees, seatLabel } from '../lib/format.js';

const STATUS_TEXT = { available: 'available', held: 'held by someone', booked: 'booked' };

/** Groups seats into sections and rows, keeping the order the API returns them in. */
export function groupSeats(seats) {
  const sections = new Map();
  for (const seat of seats) {
    if (!sections.has(seat.section)) sections.set(seat.section, new Map());
    const rows = sections.get(seat.section);
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  return [...sections].map(([name, rows]) => ({ name, rows: [...rows].map(([label, list]) => ({ label, seats: list })) }));
}

/**
 * FR-22: seats coloured by status. Only available seats can be picked. Every seat has a
 * text label and a distinct shape, so status never relies on colour alone.
 */
export default function SeatMap({ seats, selected, onToggle, disabled = false }) {
  const sections = groupSeats(seats);

  return (
    <div className="seatmap">
      <div className="stage" aria-hidden="true">
        Stage
      </div>
      {sections.map((section) => {
        const prices = [...new Set(section.rows.flatMap((r) => r.seats.map((s) => s.pricePaise)))];
        return (
          <section key={section.name} className="seat-section" aria-label={`Section ${section.name}`}>
            <h3 className="seat-section-title">
              {section.name}
              <span className="muted"> · {prices.map(rupees).join(' / ')}</span>
            </h3>
            {section.rows.map((row) => (
              <div key={row.label} className="seat-row" role="group" aria-label={`Row ${row.label}`}>
                <span className="seat-row-label" aria-hidden="true">
                  {row.label}
                </span>
                <div className="seat-row-seats">
                  {row.seats.map((seat) => {
                    const isSelected = selected.has(seat.id);
                    const status = isSelected ? 'selected' : seat.status;
                    const pickable = seat.status === 'available' && !disabled;
                    return (
                      <button
                        key={seat.id}
                        type="button"
                        className={`seat seat-${status}`}
                        aria-pressed={seat.status === 'available' ? isSelected : undefined}
                        aria-label={`${seatLabel(seat)}, ${rupees(seat.pricePaise)}, ${isSelected ? 'selected' : STATUS_TEXT[seat.status]}`}
                        title={`${seatLabel(seat)} · ${rupees(seat.pricePaise)}`}
                        disabled={!pickable}
                        onClick={() => onToggle(seat)}
                      >
                        <span aria-hidden="true">{seat.number}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        );
      })}
      <ul className="seat-legend" aria-label="Seat key">
        <li>
          <span className="seat seat-available seat-key" aria-hidden="true" /> Available
        </li>
        <li>
          <span className="seat seat-selected seat-key" aria-hidden="true" /> Your pick
        </li>
        <li>
          <span className="seat seat-held seat-key" aria-hidden="true" /> Held
        </li>
        <li>
          <span className="seat seat-booked seat-key" aria-hidden="true" /> Booked
        </li>
      </ul>
    </div>
  );
}
