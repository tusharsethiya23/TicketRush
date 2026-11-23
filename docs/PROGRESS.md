# TicketRush — Progress and Next Steps

Read this file first in every new session. Update it at the end of every step.

- **Spec:** [docs/SRS.md](SRS.md) (SRS v2) is the source of truth. The live doc at https://claude.ai/artifact/XDy24h8RPCbb2onVi1qmW3 has the same content, minus the small additions made during the build.
- **Current phase:** Phase 1 is done in code. Its Docker check is still pending, because Docker Desktop wasn't running. Next up is Phase 2.
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

## Next steps

- [ ] **Check Docker (left over from Phase 1):** start Docker Desktop, run `docker compose up -d --build --wait`, then `curl localhost:4000/health` should show `mongo: ok`

### Phase 2: Events and safe holds (FR-4 to FR-8, FR-27, NFR-2, NFR-13)

- [ ] Event schemas (zod): create and edit, with a seat map of sections → rows → seats → prices; `saleStartsAt` before `startsAt`
- [ ] `POST /events` (organiser) creates a draft event and inserts its seats in one transaction
- [ ] `PATCH /events/:id` (owner, draft only) and `POST /events/:id/publish` (FR-27)
- [ ] `GET /events` (published only, city and date filters, paginated) and `GET /events/:id`
- [ ] `GET /events/:id/seats` (no cache yet; Redis comes in phase 3)
- [ ] A `withTransaction` helper: 3 retries on `TransientTransactionError`, then 409 (NFR-13)
- [ ] `POST /events/:id/holds`, following SRS 6.1: `updateMany` on `status: 'available'`, abort if `modifiedCount` is short, cap of 2 active holds
- [ ] `DELETE /holds/:id` (FR-10, SRS 6.3) can come here or in phase 5
- [ ] Race test: 100 parallel holds on one seat gives 1 × 201 and 99 × 409, with no 500s
- [ ] Overlap race test: 50 parallel holds on overlapping seat pairs, all-or-nothing
- [ ] **Done when:** both race tests pass

### Later phases (SRS section 10)

- [ ] Phase 3: Redis caching, rate limits, the hold cap and Redis in `/health`
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
