import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resetClient } from '../api/client.js';
import { loadCheckout, saveCheckout } from '../lib/checkout.js';
import { apiError, json, mockApi } from '../test/http.js';
import CheckoutPage from './CheckoutPage.jsx';

afterEach(resetClient);

function startCheckout({ expiresInMs = 5 * 60_000 } = {}) {
  return saveCheckout({
    hold: { id: 'h1', eventId: 'e1', seatIds: ['s1', 's2'], status: 'active', expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
    event: { id: 'e1', name: 'Arijit Singh Live', venue: 'NSCI Dome', city: 'Mumbai', startsAt: '2026-12-20T14:30:00Z' },
    seats: [
      { id: 's1', section: 'Gold', row: 'A', number: 1, pricePaise: 50_000 },
      { id: 's2', section: 'Gold', row: 'A', number: 2, pricePaise: 50_000 },
    ],
  });
}

function renderCheckout() {
  return render(
    <MemoryRouter initialEntries={['/checkout/h1']}>
      <Routes>
        <Route path="/checkout/:holdId" element={<CheckoutPage />} />
        <Route path="/events/:id" element={<p>Event page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const booking = { id: 'b1', eventId: 'e1', holdId: 'h1', seatIds: ['s1', 's2'], totalPaise: 100_000, ticketCode: 'TR-ABCDEF123456', status: 'confirmed' };

describe('CheckoutPage (FR-23)', () => {
  test('SRS 9: Pay declined (402), then Pay again succeeds, both with the same Idempotency-Key', async () => {
    const key = startCheckout().idempotencyKey;
    const { callsTo } = mockApi({
      'POST /holds/h1/confirm': [apiError(402, 'PAYMENT_FAILED'), json(201, { booking })],
    });
    renderCheckout();

    expect(screen.getByRole('timer')).toHaveTextContent(/^[45]:\d\d$/);
    await userEvent.click(screen.getByRole('button', { name: 'Pay ₹1,000.00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your payment was declined');

    await userEvent.click(screen.getByRole('button', { name: 'Try payment again' }));
    expect(await screen.findByText(/You're going!/)).toBeInTheDocument();
    expect(screen.getByText('TR-ABCDEF123456')).toBeInTheDocument();

    const confirms = callsTo('POST', '/holds/h1/confirm');
    expect(confirms).toHaveLength(2);
    expect(confirms.map((c) => c.headers['Idempotency-Key'])).toEqual([key, key]);
    expect(loadCheckout('h1')).toBeNull(); // done: the checkout is cleared
  });

  test('the key survives a reload: a remounted page sends the same key', async () => {
    const { idempotencyKey } = startCheckout();
    const { callsTo } = mockApi({ 'POST /holds/h1/confirm': apiError(503, 'INTERNAL') });

    const first = renderCheckout();
    await userEvent.click(screen.getByRole('button', { name: /^Pay/ }));
    await screen.findByRole('alert');
    first.unmount();

    renderCheckout();
    await userEvent.click(screen.getByRole('button', { name: 'Pay ₹1,000.00' }));
    await screen.findByRole('alert');
    expect(callsTo('POST', '/holds/h1/confirm').map((c) => c.headers['Idempotency-Key'])).toEqual([idempotencyKey, idempotencyKey]);
  });

  test('a lost connection keeps the checkout open to retry with the same key', async () => {
    const { idempotencyKey } = startCheckout();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(201, { booking }));
    vi.stubGlobal('fetch', fetchMock);
    renderCheckout();

    await userEvent.click(screen.getByRole('button', { name: /^Pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach TicketRush');
    await userEvent.click(screen.getByRole('button', { name: 'Try payment again' }));
    await screen.findByText(/You're going!/);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers['Idempotency-Key'])).toEqual([idempotencyKey, idempotencyKey]);
  });

  test('410 HOLD_EXPIRED ends the checkout with a way back to the seats', async () => {
    startCheckout();
    mockApi({ 'POST /holds/h1/confirm': apiError(410, 'HOLD_EXPIRED', 'The hold expired during payment. The payment has been refunded.') });
    renderCheckout();

    await userEvent.click(screen.getByRole('button', { name: /^Pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your hold ran out');
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Pick seats again' })).toHaveAttribute('href', '/events/e1');
    expect(loadCheckout('h1')).toBeNull();
  });

  test('when the countdown hits zero, Pay is replaced by the expired message', async () => {
    startCheckout({ expiresInMs: -1000 });
    mockApi({});
    renderCheckout();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your hold ran out');
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });

  test('Release seats frees the hold and goes back to the event', async () => {
    startCheckout();
    const { callsTo } = mockApi({ 'DELETE /holds/h1': new Response(null, { status: 204 }) });
    renderCheckout();

    await userEvent.click(screen.getByRole('button', { name: 'Release seats' }));
    expect(await screen.findByText('Event page')).toBeInTheDocument();
    expect(callsTo('DELETE', '/holds/h1')).toHaveLength(1);
    expect(loadCheckout('h1')).toBeNull();
  });

  test('an unknown checkout explains itself instead of crashing', () => {
    mockApi({});
    renderCheckout();
    expect(screen.getByText(/This checkout is no longer open/)).toBeInTheDocument();
  });
});
