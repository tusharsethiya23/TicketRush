/**
 * TicketRush flash-sale load test (SRS 9, NFR-1, NFR-4).
 *
 * setup():   an organiser creates an event with SEATS seats and publishes it; USERS fans
 *            sign up and log in; the sale opens a few seconds later, and setup waits for it.
 * each VU:   one fan. Waits on the event page in the LOBBY_MS before the sale opens (one
 *            seat-map read, which opens its connection), then at opening holds 1 random
 *            available seat and pays with an Idempotency-Key. Lost
 *            races (409) retry with a fresh map, up to MAX_ATTEMPTS. REPLAY_RATE of buyers
 *            send the same confirm twice, which must return the same booking.
 *            ABANDON_RATE of holders never pay (their holds must expire).
 * teardown:  reads the organiser's sales numbers.
 *
 * Correctness is checked afterwards by loadtest/verify.js against MongoDB.
 *
 *   k6 run loadtest/flash-sale.js                       # 1,000 fans, 100 seats, all at once
 *   k6 run -e MODE=steady -e DURATION=60s loadtest/flash-sale.js   # steady arrivals, for the Redis restart test
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const USERS = Number(__ENV.USERS || 1000);
const SEATS = Number(__ENV.SEATS || 100);
const MAX_ATTEMPTS = Number(__ENV.MAX_ATTEMPTS || 5);
const REPLAY_RATE = Number(__ENV.REPLAY_RATE || 0.1);
const ABANDON_RATE = Number(__ENV.ABANDON_RATE || 0);
// Fans are already on the event page when the sale opens: they arrive during the LOBBY_MS
// before opening, so the burst at opening is requests, not 1,000 new TCP connections
// (which a host's accept queue, about 200 on Windows, would refuse). Under 5 s, so Node's
// keep-alive timeout does not close the connections before the sale opens.
const LOBBY_MS = Number(__ENV.LOBBY_MS ?? 3000);
const SALE_OPENS_AFTER_SETUP_MS = LOBBY_MS + 1000;
const MODE = __ENV.MODE || 'burst';
const DURATION = __ENV.DURATION || '60s';
const RUN = __ENV.RUN_ID || `${Date.now()}`;

const bookings = new Counter('bookings');
const holdConflicts = new Counter('hold_conflicts');
const abandonedHolds = new Counter('abandoned_holds');
const gaveUp = new Counter('gave_up');
const soldOutSeen = new Counter('sold_out_seen');
const serverErrors = new Counter('server_errors');
const unexpected = new Counter('unexpected_responses');
const replayMismatch = new Counter('replay_mismatch');

const scenario =
  MODE === 'steady'
    ? {
        // Fans arrive at a steady rate for DURATION, so a Redis restart lands mid-sale.
        executor: 'constant-arrival-rate',
        rate: Math.ceil(USERS / parseDuration(DURATION)),
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: Math.min(USERS, 200),
        maxVUs: USERS,
      }
    : // Everyone hits the sale the moment it opens.
      { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: '5m' };

export const options = {
  setupTimeout: '15m',
  teardownTimeout: '1m',
  scenarios: { flash_sale: scenario },
  thresholds: {
    // NFR-4: hold and confirm p95 under 300 ms at 1,000 concurrent users.
    'http_req_duration{name:hold}': ['p(95)<300'],
    'http_req_duration{name:confirm}': ['p(95)<300'],
    // NFR-13: no 500s, ever (status 0 = connection refused or reset also counts).
    server_errors: ['count==0'],
    unexpected_responses: ['count==0'],
    replay_mismatch: ['count==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function parseDuration(d) {
  const m = /^(\d+)(s|m)$/.exec(d);
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : 60;
}

const json = (token, extra = {}) => ({
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...extra },
});

function must(res, status, what) {
  if (res.status !== status) throw new Error(`${what}: expected ${status}, got ${res.status} ${res.body}`);
  return res.json();
}

const signUp = (email) => ({
  method: 'POST',
  url: `${API}/auth/register`,
  body: JSON.stringify({ email, password: 'loadtest-password', role: 'user' }),
  params: json(),
});
const logIn = (email) => ({
  method: 'POST',
  url: `${API}/auth/login`,
  body: JSON.stringify({ email, password: 'loadtest-password' }),
  params: json(),
});

export function setup() {
  const orgEmail = `org-${RUN}@loadtest.local`;
  must(
    http.post(`${API}/auth/register`, JSON.stringify({ email: orgEmail, password: 'loadtest-password', role: 'organiser' }), json()),
    201,
    'organiser sign-up',
  );
  const org = must(http.post(`${API}/auth/login`, JSON.stringify({ email: orgEmail, password: 'loadtest-password' }), json()), 200, 'organiser login');

  // Fans, in batches of 50 parallel requests.
  const emails = Array.from({ length: USERS }, (_, i) => `fan-${RUN}-${i}@loadtest.local`);
  const tokens = [];
  for (let i = 0; i < emails.length; i += 50) {
    const batch = emails.slice(i, i + 50);
    http.batch(batch.map(signUp)).forEach((r, j) => must(r, 201, `sign-up ${batch[j]}`));
    http.batch(batch.map(logIn)).forEach((r, j) => tokens.push(must(r, 200, `login ${batch[j]}`).accessToken));
  }

  // The event: rows of 10 seats. The sale opens a moment after setup, so the fans'
  // lobby phase ends exactly at opening (burst mode).
  const rows = Math.ceil(SEATS / 10);
  const saleStartsAt = new Date(Date.now() + (MODE === 'steady' ? 3000 : 3000 + SALE_OPENS_AFTER_SETUP_MS));
  const seatMap = {
    sections: [
      {
        name: 'Floor',
        rows: Array.from({ length: rows }, (_, r) => ({
          label: `R${r + 1}`,
          seatCount: r === rows - 1 ? SEATS - 10 * (rows - 1) : 10,
          pricePaise: 99_900,
        })),
      },
    ],
  };
  const created = must(
    http.post(
      `${API}/events`,
      JSON.stringify({
        name: `Load test ${RUN}`,
        venue: 'k6 Arena',
        city: 'Loadtown',
        startsAt: new Date(Date.now() + 7 * 24 * 3600e3).toISOString(),
        saleStartsAt: saleStartsAt.toISOString(),
        seatMap,
      }),
      json(org.accessToken),
    ),
    201,
    'create event',
  );
  const eventId = created.event.id;
  must(http.post(`${API}/events/${eventId}/publish`, null, json(org.accessToken)), 200, 'publish');

  // Steady mode starts selling as soon as setup ends; burst mode waits in the lobby.
  const lead = MODE === 'steady' ? 0 : SALE_OPENS_AFTER_SETUP_MS;
  const wait = saleStartsAt.getTime() - Date.now() - lead + 100;
  if (wait > 0) sleep(wait / 1000);
  console.log(`Event ${eventId}: ${SEATS} seats, ${USERS} fans, mode ${MODE}. Sale opens at ${saleStartsAt.toISOString()}.`);
  return { eventId, orgToken: org.accessToken, tokens, saleStartsAt: saleStartsAt.getTime() };
}

function track(res) {
  if (res.status >= 500 || res.status === 0) serverErrors.add(1);
}

export default function (data) {
  const n = MODE === 'steady' ? exec.scenario.iterationInTest : exec.vu.idInTest - 1;
  if (n >= data.tokens.length) return;
  const token = data.tokens[n];
  if (MODE !== 'steady') {
    // The lobby: arrive at a random moment, look at the map, wait for the opening.
    const untilOpen = data.saleStartsAt - Date.now();
    sleep((Math.random() * Math.max(0, untilOpen - 500)) / 1000);
    track(http.get(`${API}/events/${data.eventId}/seats`, { tags: { name: 'lobby' } }));
    const rest = data.saleStartsAt - Date.now();
    if (rest > 0) sleep(rest / 1000);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const map = http.get(`${API}/events/${data.eventId}/seats`, { tags: { name: 'seatmap' } });
    track(map);
    if (map.status !== 200) {
      unexpected.add(1, { step: 'seatmap', status: String(map.status) });
      return;
    }
    const available = map.json('seats').filter((s) => s.status === 'available');
    if (available.length === 0) {
      soldOutSeen.add(1);
      return;
    }
    const seat = available[Math.floor(Math.random() * available.length)];

    const hold = http.post(`${API}/events/${data.eventId}/holds`, JSON.stringify({ seatIds: [seat.id] }), {
      ...json(token),
      tags: { name: 'hold' },
    });
    track(hold);

    if (hold.status === 409) {
      holdConflicts.add(1);
      sleep(0.05 + Math.random() * 0.25); // the seat map is cached for up to 2 s
      continue;
    }
    if (hold.status !== 201) {
      unexpected.add(1, { step: 'hold', status: String(hold.status) });
      return;
    }

    const holdId = hold.json('hold.id');
    if (Math.random() < ABANDON_RATE) {
      abandonedHolds.add(1); // walks away: the hold must expire and free the seat
      return;
    }

    const key = `k6-${RUN}-${n}`;
    const params = { ...json(token, { 'Idempotency-Key': key }), tags: { name: 'confirm' } };
    const paid = http.post(`${API}/holds/${holdId}/confirm`, null, params);
    track(paid);
    if (!check(paid, { 'confirm is 201': (r) => r.status === 201 })) {
      unexpected.add(1, { step: 'confirm', status: String(paid.status) });
      return;
    }
    bookings.add(1);

    if (Math.random() < REPLAY_RATE) {
      // A double-click or a retry after a lost response: same key, same booking, no new charge.
      const again = http.post(`${API}/holds/${holdId}/confirm`, null, { ...params, tags: { name: 'confirm_replay' } });
      track(again);
      if (!(again.status === 201 && again.json('booking.id') === paid.json('booking.id'))) replayMismatch.add(1);
    }
    return;
  }
  gaveUp.add(1);
}

export function teardown(data) {
  const res = http.get(`${API}/organiser/events/${data.eventId}/sales`, json(data.orgToken));
  if (res.status === 200) {
    const s = res.json();
    console.log(
      `Sales: ${s.seats.booked}/${s.seats.total} booked, ${s.seats.held} held, ${s.bookings.confirmed} bookings, revenue ${s.revenuePaise / 100} INR`,
    );
  }
  console.log(`Verify with: node loadtest/verify.js ${data.eventId}`);
}
