# CONTRACT-GAPS.md

Things the pinned contracts (MEMORY.md, ARCHITECTURE.md, REQUIREMENTS.md) left
underspecified, surfaced while writing the Phase 3-7 tests. Each lists the requirement
it touches, what the test **assumed** so it could be written, and what must be pinned in
MEMORY.md before the coding agent implements. Per the working rules: tests do not invent
a contract silently — assumptions are logged here.

The test harness is wire-compatible with the existing throwaway Postgres
(`docker-compose.test.yml`: `localhost:5433`, db `billing`, roles `app_owner` /
`app_ingest` / `app_ledger`). Migrations + seed are applied by `runMigrations` in
`test/global-setup.ts`, so `tenant_alpha`, `tenant_beta`, and webhook secret
`whk_alpha_meterco` are present.

---

## GAP-1 — JWT secret env var + claim shape (API-1, INV-4, INV-6) — Phase 3

MEMORY's "Open" section says the JWT claim shape and `JWT_SECRET` handling are to be
"finalized before Phase 3." ARCHITECTURE §6 pins HS256, a single env secret with no
default, tenant scope in the `tenant_id` claim, `exp` verified, `alg:none` and
algorithm-confusion rejected. Not pinned: the secret's **env var name** and whether any
other claim is required.

**Assumed by the tests** (`test/helpers/jwt.ts`):
- Secret env var name: `JWT_SECRET` (the name MEMORY uses), no default/fallback.
- Algorithm: HS256, pinned server-side (never read from the token header).
- Tenant scope claim: `tenant_id`.
- `exp` present and enforced (numeric seconds since epoch).
- No `iss` / `aud` required; tests mint only `{ tenant_id, iat, exp }`.

**Pin before implementing:** confirm the env var name and that no additional claim
(`iss`/`aud`/`sub`) is required, or tests must add it.

## GAP-2 — Ingest service boot/run contract (API-1) — Phase 3

Tests spawn the real service: `node src/ingest/main.ts` with env. `DATABASE_URL` and
`PORT` are already the established contract (Phase 0 entrypoints, Phase 2 worker);
`JWT_SECRET` is newly required here.

**Assumed:** the Ingest service reads `PORT`, `DATABASE_URL` (an `app_ingest`
connection string), and `JWT_SECRET`; `GET /healthz` returns 200 once listening.

**Pin before implementing:** the Ingest service must read `JWT_SECRET` and connect to
`DATABASE_URL` as `app_ingest`.

## GAP-3 — HTTP error/response body shape (API-1..6) — all API phases

Status codes are pinned (400/401/403/409/202, etc.); the JSON **body** of responses is
not. Tests therefore assert on **status codes only** and on resulting DB state, never on
an error body shape, to avoid inventing a contract the implementation must then match.

**Pin if desired:** a standard error body (e.g. `{ "error": "..." }`) — optional; tests
do not depend on it.

## GAP-4 — Rejections must not enqueue (API-1, INV-6) — Phase 3

The contracts imply validation/auth happen before the queue write, but do not state that
a rejected request (400/401/403/409) leaves **no** `event_queue` row. Tests assert
"reject before side effect": a rejected `POST /events` writes no queue row.

**Pin before implementing:** authenticate → authorize (`body.tenant` vs token) →
validate → only then enqueue.

## GAP-5 — event_date boundary inclusivity (API-1) — Phase 3

MEMORY pins the open interval `(now - 1y, now + 1d)`. Inclusivity exactly at the bounds
is ambiguous. Tests deliberately use clearly-out values (≈2 years ago, ≈2 days ahead)
and a clearly-in value (≈30 days ago), so they do not depend on the exact boundary.

**Pin if a boundary test is wanted later:** whether the endpoints are open or closed.

## GAP-6 — Ingest crash-before-commit hook (INV-3, API-1) — Phase 3

PLAN Phase 3 lists "crash before enqueue commit: client retries safely." Proving this
under a real crash needs an Ingest-side crash hook, the analogue of the consumer's
`CRASH_POINT` env (used by `test/phase2_crash.test.ts`). The Ingest entrypoint has none.

**Assumed by the test** (`events_crash.e2e.test.ts`): a test-only env
`INGEST_CRASH_POINT=before-enqueue-commit` SIGKILLs the Ingest process after building
the row but before COMMIT. The test asserts: nothing committed, and a client retry with
the same key enqueues exactly one event. Stays red until the hook exists.

The black-box, no-hook observable — "the 202 is returned only after the row is committed"
— is covered separately in `events_contract.test.ts` (a fresh connection sees the
committed row immediately after the 202).

**Pin before implementing:** add `INGEST_CRASH_POINT` (test-only) to the Ingest service,
matching the worker's `CRASH_POINT` convention, or drop the crash variant and rely on the
commit-before-response observable.

## GAP-7 — Admin authorization claim (INV-6) — Phase 6 / 7

MEMORY: admin is "a distinct check, not merely a valid tenant token." The actual
mechanism (a claim such as `admin: true` / `role: "admin"`, a separate admin secret, or
a dedicated pre-minted admin JWT) is **not pinned**. The Phase 0 seed deferred the admin
credential to "Phase 3 where auth lands"; it is still absent from `seed/seed.sql`.

**Assumed by the tests** (`test/helpers/jwt.ts` `adminToken`): admin is asserted by an
`admin: true` claim in the same HS256 token, verified with the same `JWT_SECRET`. Used by
Phase 6/7 admin-route tests.

**Pin before implementing Phase 6:** the admin claim/credential shape, and seed the admin
credential.
