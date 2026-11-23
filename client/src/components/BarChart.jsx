import { useEffect, useMemo, useRef, useState } from 'react';

const HEIGHT = 220;
const M = { top: 14, right: 8, bottom: 28, left: 40 };
const MAX_BAR = 24; // bars never fill the slot
const GAP = 2; // surface gap between touching bars
const MIN_SLOT = 6; // narrower than this, minutes are grouped into wider buckets

/** Clean axis ticks (1, 2, 5 × 10ⁿ) covering 0..max, about 4 of them. */
export function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  // Counts are whole numbers, so a step is never below 1.
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw));
  const ticks = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v));
  return ticks;
}

/** Sums consecutive points so that at most `maxBars` remain. */
export function bucket(data, maxBars) {
  if (data.length <= maxBars) return data.map((d) => ({ ...d, xEnd: d.x }));
  const size = Math.ceil(data.length / maxBars);
  const out = [];
  for (let i = 0; i < data.length; i += size) {
    const group = data.slice(i, i + size);
    out.push({ x: group[0].x, xEnd: group.at(-1).x, value: group.reduce((s, d) => s + d.value, 0) });
  }
  return out;
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
function columnPath(x, w, base, h) {
  const r = Math.min(4, w / 2, h);
  const top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

/**
 * A single-series column chart (no legend: the title names the series). Hover, or focus
 * and use the arrow keys, for a value; "Show table" lists every value.
 */
export default function BarChart({ title, data, formatX, formatRange, unit = ['booking', 'bookings'] }) {
  const wrap = useRef(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const bars = useMemo(() => bucket(data, Math.max(1, Math.floor(innerW / MIN_SLOT))), [data, innerW]);
  const peak = Math.max(0, ...bars.map((b) => b.value));
  const ticks = niceTicks(peak);
  const yMax = ticks.at(-1);
  const slot = innerW / Math.max(1, bars.length);
  const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const base = M.top + innerH;
  const y = (v) => (v / yMax) * innerH;
  const label = (b) => (b.xEnd !== b.x && formatRange ? formatRange(b.x, b.xEnd) : formatX(b.x));
  const count = (v) => `${v.toLocaleString('en-IN')} ${v === 1 ? unit[0] : unit[1]}`;

  const total = data.reduce((s, d) => s + d.value, 0);
  const peakBar = bars.find((b) => b.value === peak);
  const summary = `${title}: ${count(total)} in total${peak > 0 ? `, peak ${count(peak)} at ${label(peakBar)}` : ''}.`;

  const xLabelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(innerW / 90))));

  function onKeyDown(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return setActive(null);
    const last = bars.length - 1;
    const cur = active ?? (e.key === 'ArrowLeft' ? last + 1 : -1);
    const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: last }[e.key];
    setActive(Math.min(last, Math.max(0, next)));
  }

  const tip = active !== null ? bars[active] : null;

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <div className="chart-plot" ref={wrap}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${summary} Use the arrow keys to read each bar.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onMouseLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={M.left} x2={width - M.right} y1={base - y(t)} y2={base - y(t)} />
              <text className="chart-tick" x={M.left - 6} y={base - y(t)} dy="0.32em" textAnchor="end">
                {t.toLocaleString('en-IN')}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const x = M.left + i * slot + (slot - barW) / 2;
            return (
              <g key={String(b.x)}>
                {b.value > 0 && (
                  <path
                    className={`chart-bar${active === i ? ' is-active' : ''}${active !== null && active !== i ? ' is-dim' : ''}`}
                    d={columnPath(x, barW, base, y(b.value))}
                  />
                )}
                {/* The hit target is the whole column slot, not just the bar. */}
                <rect
                  x={M.left + i * slot}
                  y={M.top}
                  width={slot}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setActive(i)}
                />
                {i % xLabelEvery === 0 && (
                  <text className="chart-tick" x={M.left + i * slot + slot / 2} y={base + 18} textAnchor="middle">
                    {formatX(b.x)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <div
            className="chart-tooltip"
            role="status"
            style={{
              left: Math.min(width - 90, Math.max(90, M.left + active * slot + slot / 2)),
              top: Math.max(0, base - y(tip.value) - 8),
            }}
          >
            <strong>{count(tip.value)}</strong>
            <span>{label(tip)}</span>
          </div>
        )}
      </div>
      <button type="button" className="btn btn-link btn-sm" aria-expanded={showTable} onClick={() => setShowTable((s) => !s)}>
        {showTable ? 'Hide table' : 'Show table'}
      </button>
      {showTable && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Minute</th>
                <th scope="col" className="num">
                  {unit[1][0].toUpperCase() + unit[1].slice(1)}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={String(d.x)}>
                  <td>{formatX(d.x)}</td>
                  <td className="num">{d.value.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
