import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import BarChart, { bucket, niceTicks } from './BarChart.jsx';

const data = [0, 3, 1, 0, 7].map((value, i) => ({ x: `10:0${i}`, value }));

describe('BarChart (FR-18 admin chart)', () => {
  test('ticks are clean whole numbers that cover the peak', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(130)).toEqual([0, 50, 100, 150]);
  });

  test('too many points are summed into wider buckets', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ x: i, value: 1 }));
    expect(bucket(many, 3)).toEqual([
      { x: 0, xEnd: 3, value: 4 },
      { x: 4, xEnd: 7, value: 4 },
      { x: 8, xEnd: 9, value: 2 },
    ]);
  });

  test('the chart summary names the total and the peak; zero bars draw no mark', () => {
    const { container } = render(<BarChart title="Bookings per minute" data={data} formatX={(x) => x} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/Bookings per minute: 11 bookings in total, peak 7 bookings at 10:04/);
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(3);
  });

  test('hover and arrow keys show a tooltip; the table lists every value', async () => {
    const { container } = render(<BarChart title="Bookings per minute" data={data} formatX={(x) => x} />);
    fireEvent.mouseEnter(container.querySelectorAll('rect')[1]);
    expect(screen.getByRole('status')).toHaveTextContent('3 bookings10:01');

    const svg = screen.getByRole('img');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('1 booking10:02');
    fireEvent.keyDown(svg, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('7 bookings10:04');
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const rows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['10:000', '10:013', '10:021', '10:030', '10:047']);
  });
});
