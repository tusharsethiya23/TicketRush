import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resetClient } from '../api/client.js';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { loadCheckout } from '../lib/checkout.js';
import { apiError, json, mockApi } from '../test/http.js';
import EventPage, { SEAT_REFRESH_MS } from './EventPage.jsx';

afterEach(() => {
  resetClient();
  vi.useRealTimers();
});

const event = {
  id: 'e1',
  name: 'Arijit Singh Live',
  venue: 'NSCI Dome',
  city: 'Mumbai',
  startsAt: '2027-01-20T14:30:00Z',
  saleStartsAt: '2026-01-01T00:00:00Z',
  status: 'on_sale',
};
const seats = (statuses) =>
  statuses.map((status, i) => ({ id: `s${i + 1}`, section: 'Gold', row: 'A', number: i + 1, pricePaise: 50_000, status }));

function renderEvent({ role = 'user', seatResponses }) {
  const api = mockApi({
    'POST /auth/refresh': role ? json(200, { user: { id: 'u1', email: 'fan@example.com', role }, accessToken: 'tok' }) : apiError(401, 'UNAUTHENTICATED'),
    'GET /events/e1': json(200, { event }),
    'GET /events/e1/seats': seatResponses,
    'POST /events/e1/holds': json(201, { hold: { id: 'h9', eventId: 'e1', seatIds: ['s1'], status: 'active', expiresAt: '2027-01-01T00:05:00Z' } }),
  });
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/events/e1']}>
        <Routes>
          <Route path="/events/:id" element={<EventPage />} />
          <Route path="/checkout/:holdId" element={<p>Checkout page</p>} />
          <Route path="/login" element={<p>Login page</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
  return api;
}

const seatButton = (n) => screen.findByRole('button', { name: new RegExp(`^Gold A${n},`) });

describe('EventPage (FR-21, FR-22, FR-7)', () => {
  test('pick seats and hold them: goes to checkout with a saved checkout and a fresh key', async () => {
    const { callsTo } = renderEvent({ seatResponses: json(200, { seats: seats(['available', 'available', 'booked']) }) });
    await userEvent.click(await seatButton(1));
    await userEvent.click(await seatButton(2));
    expect(screen.getByRole('complementary', { name: 'Your selection' })).toHaveTextContent('₹1,000.00');

    await userEvent.click(screen.getByRole('button', { name: 'Hold 2 seats' }));
    expect(await screen.findByText('Checkout page')).toBeInTheDocument();
    expect(callsTo('POST', '/events/e1/holds')[0].body).toEqual({ seatIds: ['s1', 's2'] });
    const checkout = loadCheckout('h9');
    expect(checkout.seats.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(checkout.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('SEAT_TAKEN: says so, refreshes the map and drops the lost seat from the selection', async () => {
    const api = renderEvent({
      seatResponses: [
        json(200, { seats: seats(['available', 'available']) }),
        json(200, { seats: seats(['held', 'available']) }),
      ],
    });
    await userEvent.click(await seatButton(1));
    await userEvent.click(await seatButton(2));
    api.fetchMock.mockImplementationOnce(async () => apiError(409, 'SEAT_TAKEN'));

    await userEvent.click(screen.getByRole('button', { name: 'Hold 2 seats' }));
    expect(await screen.findByText(/Someone else just took/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Gold A1, ₹500.00, held by someone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Gold A2, ₹500.00, selected' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold 1 seat' })).toBeEnabled();
  });

  test('at most 6 seats can be picked', async () => {
    renderEvent({ seatResponses: json(200, { seats: seats(Array(8).fill('available')) }) });
    for (let n = 1; n <= 7; n++) await userEvent.click(await seatButton(n));
    expect(screen.getByText('You can pick up to 6 seats at a time.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold 6 seats' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Gold A7/ })).toHaveAttribute('aria-pressed', 'false');
  });

  test('FR-22: the map refreshes every 5 s, and a picked seat someone took is dropped with a message', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { callsTo } = renderEvent({
      seatResponses: [json(200, { seats: seats(['available', 'available']) }), json(200, { seats: seats(['booked', 'available']) })],
    });
    await userEvent.click(await seatButton(1));
    expect(callsTo('GET', '/events/e1/seats')).toHaveLength(1);

    await act(async () => vi.advanceTimersByTime(SEAT_REFRESH_MS));
    expect(await screen.findByText('Gold A1 was just taken by someone else.')).toBeInTheDocument();
    expect(callsTo('GET', '/events/e1/seats')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Gold A1, ₹500.00, booked' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hold seats' })).toBeDisabled();
  });

  test('a guest is sent to log in; an organiser cannot pick seats', async () => {
    renderEvent({ role: null, seatResponses: json(200, { seats: seats(['available']) }) });
    await userEvent.click(await seatButton(1));
    await userEvent.click(screen.getByRole('button', { name: 'Log in to book' }));
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  test('organisers see the map but cannot pick', async () => {
    renderEvent({ role: 'organiser', seatResponses: json(200, { seats: seats(['available']) }) });
    expect(await screen.findByText(/Only fan accounts can book seats/)).toBeInTheDocument();
    expect(await seatButton(1)).toBeDisabled();
  });
});
