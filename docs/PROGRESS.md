# TicketRush — Progress and Next Steps

Read this file first in every new session. Update it at the end of every step.

- **Spec:** [docs/SRS.md](SRS.md) (SRS v2). The live, editable copy is at https://claude.ai/artifact/XDy24h8RPCbb2onVi1qmW3. If the two differ, ask which one is current.
- **Current phase:** Phase 0 is done. Next up is Phase 1 (Foundation).
- **Last updated:** 2026-11-23

## Workflow rules

1. Work one step at a time, in the phase order from SRS section 10.
2. After each step:
   - update this file (the Done log, Next steps and Decisions)
   - give a one-line commit message
   - ask before pushing
3. Reference requirement IDs (FR-x, NFR-x) in commits and tests.

## Done

| Date | Step | Result |
| --- | --- | --- |
| 2026-11-23 | Reviewed SRS v1 | Found race conditions around confirm, idempotency gaps, missing requirements and wording issues |
| 2026-11-23 | Wrote SRS v2 | Saved to `docs/SRS.md` and as a live doc; added FR-26 to FR-32, NFR-13 and NFR-14, the core flows (section 6) and error codes |
| 2026-11-23 | Created this progress file and a local `CLAUDE.md` (gitignored) | Each new session picks up here |

## Next steps

### Phase 1: Foundation (FR-1 to FR-3, FR-26)

- [ ] `git init` with a `.gitignore` (node_modules, .env, coverage), then add the GitHub remote
- [ ] Monorepo layout: `server/` (API and worker), `client/` (React), `docs/`, `docker-compose.yml`
- [ ] Docker Compose with a single-node MongoDB replica set (`rs0`) and Redis
- [ ] Express 4 app with pino and request IDs, express-mongo-sanitize, CORS, the error-shape middleware and zod validation
- [ ] Config module that reads env vars, with `.env.example`
- [ ] All 8 Mongoose models with indexes (SRS 7.1)
- [ ] Auth: register, login, refresh with rotation, logout, role and blocked-account middleware
- [ ] `npm run seed:admin`
- [ ] Jest and Supertest setup with `MongoMemoryReplSet`; auth tests
- [ ] **Done when:** users can register, log in, refresh and log out, and the tests pass

### Later phases (SRS section 10)

- [ ] Phase 2: events and safe holds (100-parallel race test and overlap race test)
- [ ] Phase 3: Redis caching, rate limits and the hold cap
- [ ] Phase 4: confirm with idempotency, payments and cancel
- [ ] Phase 5: BullMQ worker, emails, QR codes, expiry and sweep
- [ ] Phase 6: React frontend, admin and organiser pages, Swagger, `docker compose up`
- [ ] Phase 7: k6 load test, Redis restart test, deploy, README results

## Decisions made

- Express 4, not 5, because express-mongo-sanitize breaks on Express 5.
- The refresh token goes in an httpOnly SameSite=Strict cookie and is rotated on every refresh.
- A failed payment (402) is not stored under the idempotency key, so the same key can retry.
- The seat-map cache has a 2 s TTL and is not cleared on writes.
- Load tests run on the local Docker stack, not on Atlas M0.

## Open questions

- [ ] Where is the demo deployed (API, worker and Redis host)?
- [ ] Which email service: Ethereal, Mailtrap or a real provider?
- [ ] Hold cap of 2 per user per event, or 1?
