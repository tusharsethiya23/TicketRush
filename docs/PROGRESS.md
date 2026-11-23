# TicketRush — Progress and Next Steps

Read this file first in every new session. Update it at the end of every step.

- **Spec:** [docs/SRS.md](SRS.md) (SRS v2) is the source of truth. The live doc at https://claude.ai/artifact/XDy24h8RPCbb2onVi1qmW3 has the same content, minus the small additions made during the build.
- **Current phase:** Phases 1 to 3 are done. The Docker and real-Redis check is still pending, because Docker Desktop wasn't running. Next up is Phase 4 (booking).
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

## Next steps

- [ ] **Check Docker and real Redis (left over from Phases 1 and 3):**
    - start Docker Desktop
    - run `docker compose up -d --build --wait`
    - `curl localhost:4000/health` should show mongo and redis `ok`
    - check that rate limiting works on real Redis (`MULTI` with `SET NX PX` has only been tested on ioredis-mock)
    - `docker compose stop redis` should leave the API serving with `/health` at 503

### Phase 4: Booking (FR-11 to FR-14, FR-28, FR-30)

- [ ] Payment simulator: `PAYMENT_SUCCESS_RATE` and `PAYMENT_DELAY_MS`, with a way to force the outcome in tests
- [ ] `POST /holds/:id/confirm` following SRS 6.2:
    - claim the idempotency key, keyed on `(userId, key)`, with a request hash
    - check the hold
    - pay outside the transaction
    - book in one transaction: hold active → converted, seats held → booked, insert the booking with a `ticketCode`, mark the key completed
    - if the hold expired during payment, refund and return 410
- [ ] Idempotency responses:
    - same key and same body after completion: the stored response
    - a different body: 422
    - still in flight: 409 `REQUEST_IN_PROGRESS`, with a stale `processing` record taken over after 60 s
    - a 402 deletes the key so the same key can retry
    - a missing header: 428
- [ ] Apply the confirm limiters (`limiters.confirmByUser/confirmByIp` already exist)
- [ ] Mark the event `sold_out` with `soldOutAt` when the last seat is booked (FR-28), and invalidate `event:<id>`
- [ ] `GET /me/bookings` (newest first, with ticket codes) and `POST /bookings/:id/cancel` (SRS 6.4: the 24-hour window, seats back to available, `sold_out` back to `on_sale`)
- [ ] Tests:
    - idempotency: 5 parallel requests with one key give 1 booking
    - payment retry: 402 then 201
    - paid-but-expired: 410 and a refund
    - cancel, then rebook
- [ ] **Done when:** the idempotency, payment-retry and cancel tests pass

### Later phases (SRS section 10)

- [ ] Phase 5: BullMQ worker, emails, QR codes, expiry and sweep
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
- **Unchanged SRS decisions**
  - A failed payment (402) is not stored under the idempotency key, so the same key can retry.
  - The seat-map cache has a 2 s TTL and is not cleared on writes.
  - Load tests run on the local Docker stack, not on Atlas M0.

## Known limitations

- Two browser tabs refreshing at the same moment share one refresh token. The loser triggers reuse detection, which logs the user out. A short grace window can fix this in phase 6 if it shows up in the frontend.

## Open questions

- [ ] Where is the demo deployed (API, worker and Redis host)?
- [ ] Which email service: Ethereal, Mailtrap or a real provider?
- [ ] Hold cap of 2 per user per event, or 1?
