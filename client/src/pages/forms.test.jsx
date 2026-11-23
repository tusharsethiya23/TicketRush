import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { resetClient } from '../api/client.js';
import { json, mockApi } from '../test/http.js';
import { eventsQuery } from './EventsPage.jsx';
import EventFormPage, { seatTotal, toSeatMap } from './organiser/EventFormPage.jsx';

afterEach(resetClient);

describe('EventsPage filters (FR-21)', () => {
  test('city and a whole-day date range become the API query', () => {
    const q = new URLSearchParams(eventsQuery({ city: 'Pune', from: '2026-12-01', to: '2026-12-31', page: 2 }));
    expect(q.get('city')).toBe('Pune');
    expect(new Date(q.get('from')).getTime()).toBe(new Date('2026-12-01T00:00').getTime());
    expect(new Date(q.get('to')).getTime()).toBe(new Date('2026-12-31T23:59:59').getTime());
    expect(q.get('page')).toBe('2');
  });
});

describe('EventFormPage (FR-25)', () => {
  test('rupees typed in the form are sent as paise', () => {
    const sections = [{ name: ' Gold ', rows: [{ label: 'A', seatCount: '10', price: '1499.50' }] }];
    expect(toSeatMap(sections)).toEqual({ sections: [{ name: 'Gold', rows: [{ label: 'A', seatCount: 10, pricePaise: 149_950 }] }] });
    expect(seatTotal([...sections, { name: 'B', rows: [{ label: 'A', seatCount: '5', price: '1' }] }])).toBe(15);
  });

  test('editing a draft loads its seat map and PATCHes the event', async () => {
    const { callsTo } = mockApi({
      'GET /organiser/events/e1': json(200, {
        event: { id: 'e1', name: 'Old name', venue: 'Hall', city: 'Pune', startsAt: '2027-01-20T14:30:00Z', saleStartsAt: '2027-01-01T04:30:00Z', status: 'draft' },
        seatMap: { sections: [{ name: 'Gold', rows: [{ label: 'A', seatCount: 4, pricePaise: 250_000 }] }] },
      }),
      'PATCH /events/e1': json(200, { event: { id: 'e1' } }),
    });
    render(
      <MemoryRouter initialEntries={['/organiser/events/e1/edit']}>
        <Routes>
          <Route path="/organiser/events/:id/edit" element={<EventFormPage />} />
          <Route path="/organiser/events" element={<p>My events</p>} />
        </Routes>
      </MemoryRouter>,
    );

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Old name');
    expect(screen.getByLabelText('Gold row 1 price in rupees')).toHaveValue(2500);
    await userEvent.clear(name);
    await userEvent.type(name, 'New name');
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(screen.getByLabelText('Gold row 2 label')).toHaveValue('B');

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('My events')).toBeInTheDocument();
    const [patch] = callsTo('PATCH', '/events/e1');
    expect(patch.body.name).toBe('New name');
    expect(patch.body.startsAt).toBe('2027-01-20T14:30:00.000Z');
    expect(patch.body.seatMap.sections[0].rows).toEqual([
      { label: 'A', seatCount: 4, pricePaise: 250_000 },
      { label: 'B', seatCount: 10, pricePaise: 250_000 },
    ]);
  });

  test('a published event cannot be saved', async () => {
    mockApi({
      'GET /organiser/events/e1': json(200, {
        event: { id: 'e1', name: 'Live', venue: 'Hall', city: 'Pune', startsAt: '2027-01-20T14:30:00Z', saleStartsAt: '2027-01-01T04:30:00Z', status: 'on_sale' },
        seatMap: { sections: [{ name: 'Gold', rows: [{ label: 'A', seatCount: 4, pricePaise: 100 }] }] },
      }),
    });
    render(
      <MemoryRouter initialEntries={['/organiser/events/e1/edit']}>
        <Routes>
          <Route path="/organiser/events/:id/edit" element={<EventFormPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('already published');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });
});
