import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import SeatMap, { groupSeats } from './SeatMap.jsx';

const seat = (id, section, row, number, status, pricePaise = 50_000) => ({ id, section, row, number, status, pricePaise });
const seats = [
  seat('a1', 'Gold', 'A', 1, 'available', 150_000),
  seat('a2', 'Gold', 'A', 2, 'held', 150_000),
  seat('a3', 'Gold', 'A', 3, 'booked', 150_000),
  seat('b1', 'Gold', 'B', 1, 'available', 150_000),
  seat('c1', 'Silver', 'A', 1, 'available'),
];

describe('SeatMap (FR-22)', () => {
  test('groups seats by section and row in API order', () => {
    expect(groupSeats(seats).map((s) => [s.name, s.rows.map((r) => `${r.label}:${r.seats.length}`)])).toEqual([
      ['Gold', ['A:3', 'B:1']],
      ['Silver', ['A:1']],
    ]);
  });

  test('each seat says its status in words; only available seats can be picked', () => {
    render(<SeatMap seats={seats} selected={new Map()} onToggle={() => {}} />);
    const gold = screen.getByRole('region', { name: 'Section Gold' });
    expect(within(gold).getByRole('button', { name: 'Gold A1, ₹1,500.00, available' })).toBeEnabled();
    expect(within(gold).getByRole('button', { name: 'Gold A2, ₹1,500.00, held by someone' })).toBeDisabled();
    expect(within(gold).getByRole('button', { name: 'Gold A3, ₹1,500.00, booked' })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Seat key' })).toHaveTextContent('Available Your pick Held Booked');
  });

  test('clicking a seat toggles it; a picked seat is pressed', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<SeatMap seats={seats} selected={new Map()} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('button', { name: /Gold A1/ }));
    expect(onToggle).toHaveBeenCalledWith(seats[0]);

    rerender(<SeatMap seats={seats} selected={new Map([['a1', seats[0]]])} onToggle={onToggle} />);
    const picked = screen.getByRole('button', { name: 'Gold A1, ₹1,500.00, selected' });
    expect(picked).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Gold B1/ })).toHaveAttribute('aria-pressed', 'false');
  });

  test('disabled turns off picking everywhere (sale not open, or not a fan account)', () => {
    render(<SeatMap seats={seats} selected={new Map()} onToggle={() => {}} disabled />);
    expect(screen.getAllByRole('button').every((b) => b.disabled)).toBe(true);
  });
});
