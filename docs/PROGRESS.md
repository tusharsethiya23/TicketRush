# TicketRush — Progress and Next Steps

Read this file first in every new session. Update it at the end of every step.

- **Spec:** [docs/SRS.md](SRS.md) (SRS v2) is the source of truth. The live doc at https://claude.ai/artifact/XDy24h8RPCbb2onVi1qmW3 has the same content, minus the small additions made during the build.
- **Current phase:** Phases 1 to 4 are done. The Docker and real-Redis check is still pending, because Docker Desktop wasn't running. Next up is Phase 5 (BullMQ worker, emails, expiry and sweep).
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
cd server && npm install && npm test

# Whole stack: MongoDB replica set, Redis and the API on http://localhost:4000
docker compose up -d --build

# API on the host against the Docker MongoDB
cp server/.env.example server/.env   # then set JWT_ACCESS_SECRET
cd server && npm run dev

# Admin account (needs ADMIN_EMAIL and ADMIN_PASSWORD in env or .env)
cd server && npm run seed:admin
```

## Done

| Date | Step | Result |
| --- | --- | --- |
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

## Next steps

- [ ] **Check Docker and real Redis (left over from Phases 1 and 3):**
    - start Docker Desktop
    - run `docker compose up -d --build --wait`
    - `curl localhost:4000/health` should show mongo and redis `ok`
    - check that rate limiting works on real Redis (`MULTI` with `SET NX PX` has only been tested on ioredis-mock)
    - `docker compose stop redis` should leave the API serving with `/health` at 503

### Phase 5: Worker and jobs (FR-9, FR-15, FR-16, NFR-6)

- [ ] BullMQ queue and a separate worker process (`src/worker.js`), sharing models and config with the API
- [ ] `release-hold` delayed job, with `jobId = holdId` and a delay equal to the TTL, added after a hold commits; the job calls `releaseHold(holdId, { reason: 'expired' })`
- [ ] Remove the `release-hold` job after a confirm or an early release (best effort; the release is a no-op on a converted hold anyway)
- [ ] Sweep every minute: find active holds with `expiresAt <= now` through the `(status, expiresAt)` index and release each one. This also covers the time Redis is down
- [ ] Confirmation email job after a booking, with a QR code of `ticketCode`. Retries 3 times with exponential backoff (1 s, 4 s, 16 s), then stays in the failed set (FR-16). Email service still to be decided (open question)
- [ ] Enqueue failures must never fail a hold or a confirm (NFR-5); the sweep is the safety net
- [ ] Add the worker to Docker Compose
- [ ] Tests:
    - expiry with `HOLD_TTL_SECONDS=5` and the sweep triggered directly: the seat is available again
    - confirm vs expiry race with `PAYMENT_DELAY_MS` near the TTL: either booked or 410 with the seats available and a refund, never both, never neither
    - email job retries and backoff
- [ ] **Done when:** the expiry and confirm-vs-expiry tests pass

### Later phases (SRS section 10)

- [ ] Phase 6: React frontend, admin and organiser pages, Swagger, worker and client in Compose
- [ ] Phase 7: k6 load test, Redis restart test, deploy, README results

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
- **Unchanged SRS decisions**
  - A failed payment (402) is not stored under the idempotency key, so the same key can retry.
  - The seat-map cache has a 2 s TTL and is not cleared on writes.
  - Load tests run on the local Docker stack, not on Atlas M0.

## Known limitations

- A cancel can commit between the sold-out check and the sold-out update of a confirm. The event then shows `sold_out` with one seat available. This is very rare and only cosmetic, because holds check the seats, not the event status, and `sold_out` events still accept holds. The phase 5 sweep could re-check it.

- Two browser tabs refreshing at the same moment share one refresh token. The loser triggers reuse detection, which logs the user out. A short grace window can fix this in phase 6 if it shows up in the frontend.

## Open questions

- [ ] Where is the demo deployed (API, worker and Redis host)?
- [ ] Which email service: Ethereal, Mailtrap or a real provider?
- [ ] Hold cap of 2 per user per event, or 1?
