# TicketRush — Progress and Next Steps

Read this file first in every new session. Update it at the end of every step.

- **Spec:** [docs/SRS.md](SRS.md) (SRS v2) is the source of truth. The live doc at https://claude.ai/artifact/XDy24h8RPCbb2onVi1qmW3 has the same content, minus the small additions made during the build.
- **Current phase:** Phases 1 and 2 are done. The Docker check from Phase 1 is still pending, because Docker Desktop wasn't running. Next up is Phase 3 (Redis).
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

## Next steps

- [ ] **Check Docker (left over from Phase 1):** start Docker Desktop, run `docker compose up -d --build --wait`, then `curl localhost:4000/health` should show `mongo: ok`

### Phase 3: Redis (FR-17, FR-29 done, NFR-3)

- [ ] Redis client (ioredis) with config `REDIS_URL`, connected at startup and closed on shutdown; tests use a real Redis or an in-memory substitute (decide: `ioredis-mock` versus Testcontainers or Docker)
- [ ] Add Redis to `GET /health`; return 503 if it is down (FR-19)
- [ ] Cache `GET /events/:id` in `event:<id>` (60 s); delete it on edit and publish
- [ ] Cache `GET /events/:id/seats` in `seatmap:<eventId>` (2 s, not cleared on writes)
- [ ] If Redis is down, reads fall back to MongoDB (NFR-5): a cache error must never fail a request
- [ ] Rate limiting (FR-17) with the limits in SRS 8.3:
    - per user and per IP
    - stricter on holds, confirm, login and register
    - 429 `RATE_LIMITED` with `Retry-After`
    - env switches, including `RATE_LIMIT_IP_ENABLED`
    - set `trust proxy` correctly
- [ ] `stats:failedHolds:<eventId>` counter, incremented on 409 `SEAT_TAKEN`
- [ ] Add a `redis` service URL to the API in `docker-compose.yml`
- [ ] **Done when:** cached reads are under 100 ms and the 429 tests pass

### Later phases (SRS section 10)
- [ ] Phase 4: confirm with idempotency, payments and cancel
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
