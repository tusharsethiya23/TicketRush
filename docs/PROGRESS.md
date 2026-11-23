# TicketRush — Progress and Next Steps

Read this file first in every new session. Update it at the end of every step.

- **Spec:** [docs/SRS.md](SRS.md) (SRS v2) is the source of truth. The live doc at https://claude.ai/artifact/XDy24h8RPCbb2onVi1qmW3 has the same content, minus the small additions made during the build.
- **Current phase:** Phases 1 to 7 are built. The load test, the Redis restart test and the README are done. Still open: deploy (needs a host decision), re-running the load test on Docker, and a click-through in a real browser.
- **Last updated:** 2026-11-23

## Workflow rules

1. Work one step at a time, in the phase order from SRS section 10.
2. After each step:
   - update this file (the Done log, Next steps and Decisions)
   - give a one-line commit message
   - ask before pushing
3. Reference requirement IDs (FR-x, NFR-x) in commits and tests.

## How to run

```bash
# Tests (in-memory MongoDB replica set; no Docker needed)
# tests/worker.redis.test.js also needs a real Redis at REDIS_TEST_URL
# (default redis://127.0.0.1:6379/15) and skips itself when none answers
cd server && npm install && npm test

# Whole stack: MongoDB replica set, Redis, API (:4000), worker, and the app on http://localhost:5173
docker compose up -d --build

# API on the host against the Docker MongoDB
cp server/.env.example server/.env   # then set JWT_ACCESS_SECRET
cd server && npm run dev
cd server && npm run dev:worker      # in a second terminal: jobs and the sweep
cd client && npm install && npm run dev   # React app on http://localhost:5173, proxies /api to :4000

# Frontend tests (Vitest + React Testing Library)
cd client && npm test

# Admin account (needs ADMIN_EMAIL and ADMIN_PASSWORD in env or .env)
cd server && npm run seed:admin
```

## Done

| Date | Step | Result |
| --- | --- | --- |
| 2026-11-23 | Phase 7: Prove it | k6 flash sale (1,000 fans and 100 seats: 0 double-bookings, 0 server errors), sustained load (p95 hold 124 ms, confirm 204 ms), Redis killed mid-sale (all checks pass), `WEB_CONCURRENCY` cluster mode, README with results; the burst p95 misses 300 ms on this laptop (see Phase 7 details) |
| 2026-11-23 | Phase 6b: React frontend | Vite and React 19 app with every SRS 4.2 page, the client in Compose behind nginx; 36 frontend tests; an end-to-end smoke test through the Vite proxy (19 checks) passed |
| 2026-11-23 | Phase 6a: Organiser, admin, Swagger | Organiser events, edit view and sales; admin stats, user search, block and unblock; Swagger at `/docs`, with a test that every route is documented; 153 tests, 93% line coverage |
| 2026-11-23 | Phase 5: Worker and jobs | BullMQ release-hold and email jobs, QR-code email, the sweep, a worker process in Compose; 136 tests, including real BullMQ on local Redis; 91% line coverage; an end-to-end smoke test with real API and worker processes passed |
| 2026-11-23 | Phase 4: Booking | Confirm with idempotency and simulated payment, refund on paid-but-expired, sold out, my bookings, cancel; 114 tests, 94% line coverage; the parallel tests pass 5 runs out of 5 |
| 2026-11-23 | Phase 3: Redis | Event and seat-map cache, rate limits, failed-holds counter, Redis in `/health`, fallback when Redis is down; 95 tests, 92% line coverage |
| 2026-11-23 | Phase 2: Events and safe holds | Event create, edit, publish, list and seat map; holds and early release; bounded-retry transactions. The race tests pass 6 runs out of 6; 83 tests in all, with 94% line coverage |
| 2026-11-23 | Phase 1: Foundation | Express API, 8 models with SRS 7.1 indexes, auth with refresh rotation, admin seed, Docker Compose; 44 tests pass with 93% line coverage |
| 2026-11-23 | Wrote SRS v2 | Saved to `docs/SRS.md` and as a live doc |
| 2026-11-23 | Reviewed SRS v1 | Found race conditions around confirm, idempotency gaps and missing requirements |

### Phase 1 details

- `server/src` layout:
  - `config/env.js`: environment variables validated with zod
  - `lib/`: logger, AppError, tokens, asyncHandler
  - `middleware/`: requestLogger, errorHandler, validate, auth
  - `models/`: the 8 collections
  - `modules/auth`, `modules/me`, `modules/health`
  - `db/mongo.js`: creates every collection and syncs its indexes at startup
- Routes:
  - `POST /api/v1/auth/register`, `login`, `refresh` and `logout`
  - `GET /api/v1/me`
  - `GET /health` (MongoDB only for now)
- Tests:
  - `tests/auth.test.js` covers FR-1 to FR-3 and FR-26, including refresh-token reuse detection, parallel refresh, blocked accounts, NoSQL injection and request IDs
  - `tests/models.test.js` covers the unique indexes (including the partial unique index on confirmed seats) and replica-set transactions
- A smoke test showed the real `server.js` and `seed:admin` working against a temporary replica set.

### Phase 2 details

- `src/lib/transaction.js` has `runTransaction(work)`:
  - snapshot reads and majority writes
  - up to 3 retries on `TransientTransactionError` with jittered backoff, then `TransactionConflictError`
  - holds turn that error into 409 `SEAT_TAKEN`; everywhere else it becomes 409 `CONFLICT`
  - the driver's own `withTransaction` was not used, because it keeps retrying for 120 s
- `modules/events`:
  - create a draft with its seats in one transaction
  - edit a draft; a new seat map replaces every seat
  - publish
  - list published, upcoming events (city match ignores case through a collation index; date window; pagination with a maximum of 50)
  - view one event
  - seat map, which never exposes `holdId`
  - another organiser's event returns 404; a non-draft event returns 409 `EVENT_NOT_EDITABLE`
- `modules/holds`:
  - `createHold` follows SRS 6.1, with the sale-window check, the cap of 2 active holds, and `updateMany` on `status: 'available'` that aborts if any seat is missing
  - a seat from another event or an unknown seat ID returns 400, not 409
  - `releaseHold(holdId, { reason, userId })` follows SRS 6.3; phase 5's expiry job and sweep will reuse it
  - `DELETE /holds/:id` releases a hold (FR-10)
- New config: `HOLD_TTL_SECONDS` (300) and `MAX_ACTIVE_HOLDS_PER_EVENT` (2).
- Tests:
  - `events.test.js`
  - `holds.test.js`
  - `race.test.js`: 100 holds on one seat and 50 overlapping pairs, through a real HTTP server
  - `transaction.test.js`: retry, give-up after 3 retries, rollback
  - `helpers/factories.js`

### Phase 3 details

- `src/lib/redis.js` is the API's Redis client.
  - It fails fast: offline queue off, 1 retry, 200 ms command timeout.
  - It reconnects in the background, warns once per outage, and is swappable for tests (`setRedis`).
  - The API starts without Redis.
- `src/lib/cache.js`:
  - `cached(key, ttl, loader)` is a read-through cache. Any Redis error falls back to the loader, and a thrown 404 is never cached.
  - `invalidate()` deletes keys.
  - `keys` and `TTL` follow SRS 7.2.
- Caches:
  - `event:<id>` for 60 s, cleared on publish
  - `seatmap:<eventId>` for 2 s, not cleared on writes; a test proves a stale map cannot win a seat
- `src/middleware/rateLimit.js` is a fixed window, `MULTI` of `SET NX PX`, `INCR` and `PTTL`, so a key can never be left without a TTL.
  - It fails open when Redis is down.
  - It returns 429 `RATE_LIMITED` with `Retry-After`, and sets `RateLimit-Limit` and `RateLimit-Remaining`.
  - The per-IP limit for everything under `/api/v1` is set in `app.js`.
  - The per-user limit for everything runs inside `authenticate`.
  - The auth routes have a per-IP limit; the hold route has both per-IP and per-user limits.
- `stats:failedHolds:<eventId>` is incremented on each lost hold race (not on a 400), with a 7-day TTL and without awaiting.
- `/health` checks MongoDB and Redis, and returns 503 with `redis: down` when Redis is down.
- New config:
  - `REDIS_URL` and `TRUST_PROXY`
  - `RATE_LIMIT_ENABLED`, `RATE_LIMIT_IP_ENABLED` and `RATE_LIMIT_WINDOW_SECONDS`
  - `RL_*` limits
- Tests:
  - `redis.test.js`: cache hits, a 404 is not cached, invalidation, stale-map safety, a smoke check that cached reads stay under 100 ms, the Redis-down fallback, limiter behaviour, the hold limit of 10 per user, the failed-holds counter
  - Tests use `ioredis-mock`, with per-IP limits off in the test env.
- A smoke test with the real server and no Redis gave: `/health` 503 in 11 ms, register 201, events 200, one warning line.

### Phase 4 details

- `src/lib/payments.js` is the payment simulator.
  - It waits `PAYMENT_DELAY_MS` (200) and succeeds with probability `PAYMENT_SUCCESS_RATE` (0.9).
  - Code calls `payments.charge`, so tests force an outcome with `jest.spyOn(payments, 'charge')`. The test env sets the rate to 1 and the delay to 0.
- `modules/bookings/bookings.service.js`:
  - `confirmHold` follows SRS 6.2:
    - claim the key: the unique `(userId, key)` insert wins; a loser replays the stored result, or gets 422, 409 `REQUEST_IN_PROGRESS`, or takes over a `processing` key older than 60 s
    - the request hash is the hold ID, because confirm takes no body; one key on a different hold gives 422
    - check the hold: not the user's gives 404; not active or expired gives a stored 410, with no charge
    - pay outside the transaction, and record a `payments` row (succeeded or failed)
    - book in one transaction: hold active → converted, seats held → booked, insert the booking (`ticketCode` like `TR-3F9A1C2B7D4E`), mark the key completed with the 201 body
  - Only 201 and 410 are stored. Every other outcome (402, 404, 409, 500) deletes the key, so the same key can retry.
  - Any failure after a successful charge records a refund. A hold that expired or was released during payment gives a stored 410.
  - `markSoldOutIfFull` runs after commit. When every seat of the event is booked it sets `sold_out`, sets `soldOutAt` only if empty, and clears `event:<id>`. It never fails the confirm.
  - `listMyBookings` returns bookings newest first with event and seat details, paginated (max 50).
  - `cancelBooking` follows SRS 6.4. The 24-hour window gives 409 `CANCEL_WINDOW_CLOSED`. One transaction sets the booking cancelled, the seats back to available with `holdId: null`, and `sold_out` back to `on_sale` with `soldOutAt` kept. A second cancel returns the cancelled booking.
- Routes:
  - `POST /holds/:id/confirm`: confirm limiters, then `authenticate`, user role, empty body. A missing `Idempotency-Key` gives 428; a malformed one gives 400. A replay carries `Idempotent-Replayed: true`, and a replayed 410 carries the new request ID.
  - `GET /me/bookings` and `POST /bookings/:id/cancel`
- CORS now exposes `Retry-After`, `RateLimit-*`, `Idempotent-Replayed` and `X-Request-Id` to the frontend.
- New config: `PAYMENT_SUCCESS_RATE` and `PAYMENT_DELAY_MS`, also passed through in Compose.
- Tests in `bookings.test.js` (19), through a real HTTP server:
  - SRS 9 idempotency: 5 parallel confirms with one key give 1 booking and 1 charge, and a sixth gets the identical 201
  - SRS 9 payment retry: 402 frees the key, then the same key gives 201
  - paid-but-expired: 410, refund recorded, the 410 replayed
  - two keys racing on one hold: 1 booking, and the loser is refunded
  - stale-key takeover, 422, 428, 400, 403, 404, the confirm rate limit
  - sold out, including the cache cleared
  - my bookings
  - SRS 9 cancel then rebook, a second sell-out keeping the first `soldOutAt`, the 24-hour window, cancelling twice

### Phase 5 details

- `src/jobs/queues.js` is the producer side, used by the API.
  - It has two BullMQ queues: `holds` (`release-hold`, `jobId = holdId`) and `emails` (`booking-email`, `jobId = booking-email-<id>`).
  - `jobs.scheduleHoldRelease`, `jobs.cancelHoldRelease` and `jobs.enqueueBookingEmail` are never awaited by callers and never throw. They give up after 1 s (NFR-5).
  - The release job is due at `expiresAt` plus 500 ms, because the release requires `expiresAt <= now`.
  - Email jobs: `attempts: 4`, a custom backoff of 1 s, 4 s and 16 s, kept in the failed set.
  - `setQueueFactory` swaps in fake queues (most tests) or real BullMQ queues on a test Redis.
- `src/jobs/processors.js`:
  - `processReleaseHold` calls `releaseHold(id, { reason: 'expired' })`, a no-op for converted or released holds.
  - `sweepExpiredHolds` releases active holds past `expiresAt`, in batches of `SWEEP_BATCH_SIZE`, through the `(status, expiresAt)` index. It also reopens `sold_out` events that have a free seat, which fixes the Phase 4 known limitation.
  - `processBookingEmail` sends the ticket details with an inline QR PNG of `ticketCode`, escapes HTML, and sets `bookings.emailSentAt` so a re-run never sends twice. It skips cancelled or missing bookings, and throws on a send failure so BullMQ retries.
- `src/jobs/workers.js` has `createWorkers(connection)` (holds concurrency 20, emails 5) and `startSweep()`: a `setInterval` that never overlaps and runs at once on start.
- `src/worker.js` is the process (`npm run worker`, `npm run dev:worker`). It is also the `worker` service in Compose, which shares the API's environment through a YAML anchor.
- `src/lib/mailer.js` uses nodemailer over `SMTP_URL` (any provider). When it is not set, the email is rendered and logged instead.
- API hooks:
  - hold created: schedule release
  - early release: remove job
  - confirm: queue email and remove the release job
- New config: `QUEUE_PREFIX`, `SWEEP_INTERVAL_SECONDS`, `SWEEP_BATCH_SIZE`, `EMAIL_BACKOFF_BASE_MS`, `SMTP_URL`, `MAIL_FROM`. New dependencies: `bullmq` 6, `nodemailer` 10, `qrcode`.
- Tests:
  - `jobs.test.js` (17) uses a fake queue:
    - jobs scheduled and removed
    - a broken or hanging queue never fails or slows a request
    - the release job and the sweep, including the SRS 9 expiry test
    - SRS 9 confirm vs expiry race, 12 rounds with fast, slow and near-deadline payments: always exactly one outcome
    - the email content, the QR code, HTML escaping, sending once, the retry on failure, the backoff values
  - `worker.redis.test.js` (5) runs on a real Redis (local Memurai, database 15) and skips when none is found:
    - the rate limiter's `MULTI` on real Redis
    - delayed job → worker frees the seat
    - confirm removes the job and the worker emails
    - email retry, then success
    - email failing 4 times ends in the failed set
- An end-to-end smoke test ran the real `server.js` and `worker.js` processes against a temporary MongoDB and Redis database 14, with a 3 s TTL:
  - the job freed a seat at 3.5 s
  - confirm gave 201, the job was removed and the email was logged
  - with the worker stopped, the seat stayed held, then was freed when the worker restarted
  - a hold whose job was deleted was freed by the sweep alone

### Phase 6a details

- Phase 6 is split into 6a (the rest of the API) and 6b (the React frontend), so each lands as its own commit.
- `modules/organiser` (organiser role; someone else's event is 404):
  - `GET /organiser/events`: own events with drafts, newest first, `?status=`
  - `GET /organiser/events/:id`: the event plus the seat map rebuilt from its seats (sorted by `_id`, which keeps the original section and row order), for the edit form
  - `GET /organiser/events/:id/sales` (FR-31): seats by status, confirmed and cancelled bookings, revenue from confirmed bookings only, and active holds (unexpired only)
- `modules/admin` (admin role):
  - `GET /admin/stats` (FR-18):
    - bookings per minute from MongoDB (`$dateTrunc`), with empty minutes as 0, over `?minutes=` (default 60)
    - failed holds per event from `stats:failedHolds:*` through SCAN and MGET, joined with event names; `null` while Redis is down
    - time to sell out from `soldOutAt - saleStartsAt`
  - `GET /admin/users`: `?q=` email prefix (regex characters escaped), `role`, `status`
  - `POST /admin/users/:id/block` and `/unblock` (FR-32): blocking sets the status and revokes every refresh token. `authenticate` re-reads the user, so the current access token stops at once. Admin accounts cannot be blocked, which also stops an admin blocking themselves.
- Swagger (NFR-10):
  - `src/docs/openapi.js` is a hand-written OpenAPI 3.0 spec: shared schemas, bearer and refresh-cookie security, error codes per route
  - served at `/docs` (Swagger UI) and `/docs/openapi.json`
  - helmet's CSP no longer sends `upgrade-insecure-requests`, which would break Swagger UI's assets on http://localhost
- Tests:
  - `organiser.test.js` (6)
  - `admin.test.js` (8): stats windows, failed holds with Redis up and down, sell-out times, search, block with token revocation and instant lockout, unblock, admin protection
  - `docs.test.js` (3): walks Express's router stack and fails if any route is missing from the spec, or the spec lists a route that does not exist
- New dependency: `swagger-ui-express` 5.

### Phase 6b details

- `client/` uses Vite 8, React 19, React Router 7 and `qrcode`. It is plain CSS with colour tokens and a dark mode chosen step by step, works from phone width (NFR-12), and has no UI framework.
- `src/api/client.js` is the only way the app reaches the API.
  - The access token is kept in memory only.
  - A 401 triggers one silent refresh through the `rt` cookie and one retry. Parallel 401s share one refresh, because the server rotates refresh tokens.
  - It tracks the clock offset from the `Date` header, so countdowns follow the server clock.
  - Every error is an `ApiError` carrying `code`, `requestId` and `retryAfter`.
- `src/api/errors.js` turns each error code into plain language, saying what happened and what to do (NFR-12).
- `AuthContext` restores the session on load through refresh (FR-20); `RequireAuth` guards routes by role.
- Pages:
  - events list with city and date filters kept in the URL (FR-21)
  - event page (FR-21, FR-22):
    - the seat map is polled every 5 s while the tab is visible
    - a picked seat that someone else takes is dropped, with a message
    - on SEAT_TAKEN the map is refreshed
    - at most 6 seats can be picked
    - only fan accounts can pick seats
  - checkout (FR-23):
    - a countdown to the server's `expiresAt`
    - an `Idempotency-Key` from `crypto.randomUUID()`, saved with the hold in sessionStorage, so a reload or a Pay retry reuses it
    - 402, 409 and network errors keep the same key for a retry; 410 ends the checkout
    - a Release seats button
  - my bookings (FR-24): QR tickets drawn in the browser, cancel with an inline confirmation, the 24-hour rule shown
  - organiser (FR-25): my events, create and edit a draft with a section and row seat-map builder (prices typed in rupees, sent in paise), publish with a confirmation, sales tiles refreshed every 10 s
  - admin (FR-18, FR-32): stat tiles, a bookings-per-minute column chart, failed holds and sell-out tables, user search with block and unblock
- The chart (`BarChart.jsx`) follows the dataviz method:
  - a single series, so no legend
  - columns at most 24 px with a 4 px rounded top and a 2 px gap
  - hairline gridlines and clean whole-number ticks
  - a hover tooltip, plus arrow-key navigation on the focused chart
  - a "Show table" view
  - minutes grouped into buckets on narrow screens
  - series colour `#2a78d6` (light) and `#3987e5` (dark), both passing the palette validator against their surfaces
- Accessibility:
  - a skip link
  - seats have text labels and distinct shapes (dashed for held, hatched for booked), not colour alone
  - `aria-pressed` on picked seats
  - errors use `role="alert"`
  - the countdown is announced each minute, not each second
  - 44 px touch targets
- Docker:
  - `client/Dockerfile` builds with Node 22, then serves with `nginx:1.27-alpine`
  - `nginx.conf` proxies `/api`, `/health` and `/docs` to `api:4000`, so the app and API share one origin (the cookie is SameSite=Strict)
  - nginx serves `index.html` for client-side routes and caches hashed assets for a year
  - Compose has a `client` service on port 5173, and the API gets `TRUST_PROXY=1`
- Tests (`npm test`, 36):
  - API client: refresh and retry, a shared refresh, session expiry, error fields, network errors
  - Countdown: ticks, a single onExpire, urgency
  - SeatMap: labels, which seats can be picked
  - EventPage: hold → checkout, SEAT_TAKEN, the 6-seat cap, the 5 s refresh dropping a taken seat, guests and organisers
  - CheckoutPage: SRS 9 "one key reused on Pay retry" (402 then 201), the key kept across a reload and a network error, 410, countdown expiry, release
  - BarChart: ticks, bucketing, summary, hover, keyboard, table
  - EventFormPage: rupees to paise, the edit load and PATCH, a published event locked
- `client/scripts/vitest.mjs` starts Vitest with an upper-case drive letter. From a `c:\...` terminal (VS Code's default), Vitest otherwise loads itself twice and every test file fails with "failed to find the current suite".
- An end-to-end smoke test ran the real API and worker, a temporary MongoDB, Redis database 14 and the Vite dev server. All 19 checks passed through the proxy:
  - the app shell, client-side routes, `/health` and `/docs`
  - the refresh cookie set on the app origin, and a silent refresh
  - organiser create, edit view and publish
  - list, hold, confirm, a replay with `Idempotent-Replayed`, my bookings
  - sold out, sales, the worker email, logout

### Phase 7 details

- `loadtest/flash-sale.js` is the k6 script.
  - `setup` makes an organiser, an event with `SEATS` seats and `USERS` fans, then publishes it.
  - Burst mode: fans wait in a 3 s lobby (one seat-map read, which opens their keep-alive connection), then all buy at the opening.
  - Steady mode: fans arrive at a constant rate.
  - Each fan holds 1 random available seat, pays with an Idempotency-Key, and retries a lost race up to 5 times. `REPLAY_RATE` re-sends the confirm and checks it returns the same booking; `ABANDON_RATE` walks away from the hold.
  - Thresholds: hold and confirm p95 under 300 ms, 0 server errors or connection failures, 0 unexpected statuses, 0 replay mismatches.
- `loadtest/verify.js` (Node, uses the server's mongoose and `MONGO_URI`) checks:
  - the SRS 9 duplicate-seat aggregation
  - booked seats against confirmed bookings, and each booked seat's hold
  - successful charges against bookings
  - no stale active holds
  - held seats against active holds
- `loadtest/docker-compose.loadtest.yml` is the load-test profile: per-IP limits off, per-user limits raised, payment 0 ms and always succeeding, bcrypt 4, `LOG_LEVEL=warn`, `WEB_CONCURRENCY=4`.
- Results (native stack on the i5-12500H laptop, 4 API processes; summaries in `loadtest/results/`):
  - burst, 1,000 fans and 100 seats: 100 bookings, 0 double-bookings, 0 server errors; hold p95 3.18 s, confirm p95 2.15 s
  - sustained, 1,000 fans over 20 s and 1,000 seats: 996 bookings, all thresholds pass; hold p95 124 ms, confirm p95 204 ms
  - Redis killed for 12 s mid-sale and restarted empty (600 fans over 60 s, 300 seats, 30% abandon, 20% replay, 20 s TTL, 5 s sweep):
    - 285 bookings, 0 server errors, all verify checks pass
    - 130 release jobs were lost in the outage, and the sweep still released all 90 abandoned holds
- What the investigation found:
  - **Refused connections:** 1,000 fans connecting in the same instant overflowed the listen backlog. The API now asks for a backlog of 4,096, but Windows caps it at about 200 and answers the overflow with a reset (Linux drops it, and the client retries). The lobby phase models fans who are already on the page, which removed every refusal.
  - **The API was CPU-bound on one core** (118%). A profile showed no hotspot: the time was spread across the MongoDB driver, Mongoose and BSON, about 38%. Hence `WEB_CONCURRENCY` (node:cluster): 4 processes cut the burst hold p95 from about 4.8 s to about 3 s; 8 were no better.
  - **The real limit is MongoDB transaction throughput:** about 1,000 a second from one process and about 1,900 from four, on this laptop's single-node replica set (measured). The burst needs over 2,000 in its first second, so the tail waits 2–3 s. Uncontended, a hold takes about 30 ms and a confirm about 50 ms server-side.
  - **Tried and reverted:** a read-only pre-check that answers lost races without a transaction, and reading the event through the Redis cache in the hold path. Neither changed the burst numbers beyond run-to-run noise, so the code stays simpler.
- `WEB_CONCURRENCY` (default 1): the primary process syncs indexes once (`connectMongo(..., { syncIndexes })`), forks N API processes sharing the port, and replaces any that crash. The crash-and-replace path has not been tested.

## Next steps

- [ ] **Check Docker (left over from Phases 1, 3, 5 and 6):** real Redis behaviour is now checked on Memurai; only the Docker stack is left.
    - start Docker Desktop
    - run `docker compose up -d --build --wait`
    - `curl localhost:4000/health` should show mongo and redis `ok`
    - `docker compose logs worker` should show "Worker started"
    - `docker compose stop redis` should leave the API serving with `/health` at 503, and the worker should log that it lost Redis
    - `docker compose stop worker` should exit cleanly (SIGTERM). This could not be tested on Windows, where Node cannot receive SIGTERM
    - open http://localhost:5173: the app loads through nginx, and a reload keeps you logged in (the Secure cookie on http://localhost)
- [ ] **Click through in a real browser** (`npm run dev` in `client/`, or Compose). There was no browser in the build session; the flows were checked with tests and HTTP only.
    - sign up as a fan, pick seats, hold, watch the countdown, pay, see the QR ticket, cancel
    - with two browsers on one event, see the other's hold appear within 5 s
    - sign up as an organiser: create an event with two sections, edit it, publish, view sales
    - make an admin (`npm run seed:admin`): stats chart, block a user and watch their tab get logged out
    - try it at phone width, and in dark mode

### Still open after Phase 7

- [ ] **Deploy** (open question: where). It needs a MongoDB replica set (for example Atlas), a Redis, the API, the worker as its own process, and the client behind one origin (nginx, or a host that proxies `/api`). Do not publish the API port directly, because of `TRUST_PROXY`.
- [ ] **Re-run the load test on Docker** once Docker Desktop runs, and add those numbers to the README:
    - `docker compose -f docker-compose.yml -f loadtest/docker-compose.loadtest.yml up -d --build --wait`
    - `k6 run loadtest/flash-sale.js`
    - `node loadtest/verify.js <eventId>`
    - for the restart test: `HOLD_TTL_SECONDS=20 SWEEP_INTERVAL_SECONDS=5`, then `k6 run -e MODE=steady -e DURATION=60s -e USERS=600 -e SEATS=300 -e ABANDON_RATE=0.3 loadtest/flash-sale.js`, with `docker restart redis` during the run
- [ ] **Optional, if the burst p95 matters:** measure on Linux or Docker first. If it still misses, the levers are MongoDB hardware or a three-member replica set on separate disks, and fewer round trips per hold.

## Decisions made

- **Stack choices**
  - Express 4, not 5, because express-mongo-sanitize breaks on Express 5.
  - zod 4, not 3, because zod 3 has a high-severity advisory (GHSA-mrhx-c7xc-m3w5).
  - The code is CommonJS JavaScript, not TypeScript or ESM, which keeps Jest simple.
  - The API image is `node:22-slim`, not Alpine, because bcrypt ships prebuilt binaries for glibc.
- **Auth**
  - The refresh token goes in an httpOnly SameSite=Strict cookie limited to path `/api/v1/auth`.
  - It is rotated on every refresh. Reusing a revoked token revokes all of that user's tokens.
  - Only its SHA-256 hash is stored.
  - `authenticate` re-reads the user on every request, so blocks and role changes apply at once and a role claim in the JWT is never trusted.
  - Login gives the same 401 `INVALID_CREDENTIALS` for an unknown email and a wrong password. It also runs a bcrypt compare against a dummy hash for unknown emails, so both cases take the same time.
- **API additions to the SRS:** `GET /me` and the error codes `EMAIL_TAKEN`, `INVALID_CREDENTIALS` and `PAYLOAD_TOO_LARGE`.
- **MongoDB and Docker**
  - Indexes are built by `syncIndexes()` at startup, with `autoIndex` off.
  - From the host, MongoDB needs `?directConnection=true`, because the replica set member advertises itself as `mongo:27017`.
- **Phase 2**
  - Only the `user` role can hold seats; organisers get 403.
  - `sold_out` events still accept hold attempts, and the seats answer with 409.
  - `ended` events and events before their sale start return 403 `SALE_NOT_STARTED`.
  - `GET /events/:id` hides drafts. The organiser sees a draft through the create and edit responses, and an organiser "my events" list can come with the phase 6 frontend.
  - A released seat gets `holdId: null` rather than an unset field; the SRS is updated to match.
  - Expired holds keep their seats `held` until phase 5 adds the expiry job and sweep. They already stop counting toward the hold cap.
- **Phase 3**
  - ioredis 5, not 6: ioredis-mock and BullMQ both need 5.
  - Rate limits fail open, because Redis is not the source of truth (NFR-5).
  - The per-user overall limit (120 a minute) is enforced inside `authenticate`, so every signed-in route gets it with no extra wiring.
  - Invalid requests (400) still count toward limits, because the limiter runs before validation.
  - `/health` returns 503 when Redis alone is down. That is the SRS rule, but bookings keep working.
- **Phase 4**
  - The idempotency request hash covers only the hold ID, because confirm takes no body (a body gives 400).
  - Only 201 and 410 are stored. A 404 or a 409 `CONFLICT` also frees the key, like a 402.
  - A refund is recorded for any failure after a successful charge, not only an expired hold, so a payment never ends with neither a booking nor a refund.
  - Sold out means every seat is `booked`. Seats still held do not count, because their holds can expire.
  - The sold-out check runs after commit, outside the booking transaction. Inside it, two parallel last-seat bookings would each miss the other's seats (write skew), and a shared event-document counter would make every confirm conflict under load.
  - Cancelling an already cancelled booking returns 200 with the booking, so retries are safe. No new error code was needed.
  - `GET /me/bookings` works for any signed-in role; organisers and admins just get an empty list.
- **Phase 5**
  - BullMQ 6 (current), with ioredis 5 shared with the API.
  - The sweep is a `setInterval` in the worker, not a BullMQ repeatable job, so it keeps releasing holds while Redis is down (SRS 9 Redis restart test). Several workers sweeping at once is harmless, because releases are conditional.
  - Enqueue calls are fire-and-forget with a 1 s cap. A lost release job costs at most one sweep interval. A lost email job is the only real loss while Redis is down.
  - The release job is scheduled 500 ms after `expiresAt`, so it never runs a moment too early and does nothing.
  - Email goes through any SMTP service set by `SMTP_URL`. Without it, emails are logged, so local runs and the demo need no account. This narrows the email open question to which service the demo uses.
  - `bookings.emailSentAt` makes the email job safe to re-run.
  - A real-Redis test file runs when Redis answers at `REDIS_TEST_URL`. It only touches `trtest:*` and its own `rl:*` keys, and never runs FLUSHALL. The ioredis-mock restore is in a `finally`, because `clearTestDb` flushes whatever `getRedis()` returns.
- **Phase 6a**
  - The organiser edit view rebuilds the seat map from the seats instead of storing a second copy on the event, so there is one source of truth.
  - Sales revenue counts confirmed bookings only. A cancel has no refund (SRS 6.4), but its seats are back on sale.
  - Failed-hold stats come back as `null` (not 503) when Redis is down, so the rest of the admin page still loads.
  - Admins cannot be blocked through the API.
  - The OpenAPI spec is hand-written rather than generated from the zod schemas. A test keeps it in step with the routes.
- **Phase 6b**
  - Plain CSS with tokens, no UI kit. That keeps the bundle small (about 105 KB gzipped) and gives full control over seat states and dark mode.
  - The app reaches the API only through relative `/api` paths: the Vite proxy in development, nginx in Compose. One origin means the SameSite=Strict cookie just works, and CORS is not needed in the browser.
  - The checkout key lives in sessionStorage beside the hold, never in a component, so a reload cannot create a second key for the same hold.
  - QR codes are drawn in the browser from `ticketCode`; there is no image endpoint.
  - The countdown uses the server clock (from the `Date` header) when the device clock is more than 1.5 s off.
  - The seat map polls every 5 s and only while the tab is visible, which lightens load during a sale.
  - Admin stats refresh every 15 s and sales every 10 s.
- **Phase 7**
  - The load test runs natively here (Docker was unavailable): a throwaway Memurai on a spare port and an in-memory MongoDB replica set, the API and worker as real processes, k6 2.4 as a portable binary. The repo's instructions use Docker.
  - The burst models fans already on the event page (a 3 s lobby) rather than 1,000 new TCP connections in one instant. Real fans load the page first, and Windows' backlog cap would otherwise turn the test into a test of the OS.
  - Results are reported as measured, including the burst p95 miss. The target was not redefined to pass.
  - Optimisations that did not measurably help were reverted.
  - `WEB_CONCURRENCY` defaults to 1 so small deployments are unchanged; the load profile uses 4.
- **Unchanged SRS decisions**
  - A failed payment (402) is not stored under the idempotency key, so the same key can retry.
  - The seat-map cache has a 2 s TTL and is not cleared on writes.
  - Load tests run on the local Docker stack, not on Atlas M0.

## Known limitations

- A cancel can commit between the sold-out check and the sold-out update of a confirm. The event then shows `sold_out` with one seat available. This is rare and only cosmetic, because holds check the seats, not the event status. Since phase 5, the sweep puts such an event back on sale within a minute.
- While Redis is down, booking emails are not queued and are lost. Holds still expire through the sweep. A later fix could have the sweep queue emails for confirmed bookings with no `emailSentAt`.
- On Windows, `npm run worker` cannot shut down gracefully on Ctrl+C or a kill. That is harmless, because jobs and releases are safe to re-run; Docker and Linux get the SIGTERM handler.

- Two browser tabs refreshing at the same moment share one refresh token. The loser triggers reuse detection, which logs the user out. The frontend makes this rare, because one tab shares a single refresh across its own requests, but two tabs opened at once can still hit it. The fix, if the browser check shows it, is a short grace window on the server for a just-rotated token.

- In Compose the API trusts one proxy hop (`TRUST_PROXY=1`) for nginx, but port 4000 is also published directly. A client calling :4000 directly could set `X-Forwarded-For` to dodge per-IP limits. Per-user limits still apply. For a deployment, do not publish the API port.

- Burst latency: at 1,000 fans pressing Book in the same instant, hold and confirm p95 are 2–3 s on the test laptop, because MongoDB's transaction rate is the limit there (NFR-4 misses; sustained load meets it). Correctness is unaffected.

## Open questions

- [ ] Where is the demo deployed (API, worker and Redis host)?
- [ ] Which email service for the demo: Ethereal, Mailtrap or a real provider? Any of them works by setting `SMTP_URL`; without it, emails are logged.
- [ ] Hold cap of 2 per user per event, or 1?
