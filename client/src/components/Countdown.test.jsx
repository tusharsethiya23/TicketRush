import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Countdown from './Countdown.jsx';

describe('Countdown (FR-23)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  test('counts down to the server expiresAt and calls onExpire exactly once at 0:00', () => {
    const onExpire = vi.fn();
    render(<Countdown expiresAt="2026-11-23T10:01:05Z" onExpire={onExpire} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('1:05');

    act(() => vi.advanceTimersByTime(5_000));
    expect(timer).toHaveTextContent('1:00');
    expect(screen.getByText('1 minute left')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(59_000));
    expect(timer).toHaveTextContent('0:01');
    expect(onExpire).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000));
    expect(timer).toHaveTextContent('0:00');
    expect(onExpire).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(10_000));
    expect(timer).toHaveTextContent('0:00'); // never negative
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Hold expired')).toBeInTheDocument();
  });

  test('turns urgent in the last minute', () => {
    const { container } = render(<Countdown expiresAt="2026-11-23T10:02:00Z" />);
    expect(container.querySelector('.countdown-urgent')).toBeNull();
    act(() => vi.advanceTimersByTime(61_000));
    expect(container.querySelector('.countdown-urgent')).not.toBeNull();
  });

  test('an already expired hold shows 0:00 and expires at once', () => {
    const onExpire = vi.fn();
    render(<Countdown expiresAt="2026-11-23T09:59:00Z" onExpire={onExpire} />);
    expect(screen.getByRole('timer')).toHaveTextContent('0:00');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
