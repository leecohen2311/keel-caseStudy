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

**Algorithm confusion (scope note):** tests exercise `alg:none`, expired, wrong-secret,
and missing tokens. The classic RS/HS confusion attack (signing with the RSA public key
as the HMAC secret) does not apply to this design — the server holds a single shared HMAC
secret and no asymmetric key exists — so it is intentionally not tested. Pinning HS256
server-side and ignoring the header-named `alg` covers it by construction.

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

## GAP-8 — body.tenant absent (API-1, INV-4) — Phase 3

Tests cover `body.tenant` **mismatch** (claims B while authenticated as A → 403). The case
where `body.tenant` is **absent** is underspecified: does a missing `tenant` field return
400 (missing required field) or fall back to the token's tenant? The tests assert neither,
to avoid inventing the contract.

**Pin before implementing:** missing `body.tenant` → 400, or default to the token tenant.

## GAP-9 — webhook dedup key `{source}` segment (INV-8, INV-2) — Phase 4

The dedup key is pinned as `wh:{source}:{event_id}` (MEMORY, ARCHITECTURE §6). `{event_id}`
is the delivery id from the signed body. `{source}` is not explicitly defined; the only
per-source identifier in the schema is `webhook_secrets.key_id` (the `X-Key-Id` value).

**Assumed:** `{source}` is the `X-Key-Id` (so the queue `event_id` is
`wh:{key_id}:{delivery_id}`). Tests do not hard-code the middle segment — they assert the
queue row's `event_id` starts with `wh:` and ends with `:{delivery_id}` — so they pass
under any reasonable source naming as long as the delivery id is in the key.

**Pin before implementing:** that `{source}` is the `X-Key-Id`.

An `X-Key-Id` that resolves to **no** secret is assumed to return **401** (indistinguishable
from a bad signature, so the boundary does not leak key existence) and enqueue nothing. A
test asserts this with a global `event_queue` count (no tenant exists for an unknown key).

## GAP-10 — X-Signature encoding, X-Timestamp format, freshness tolerance (INV-8) — Phase 4

The wire contract pins the string-to-sign (`{timestamp}.{key_id}.{raw_body}`), HMAC-SHA256,
raw-bytes-before-parse, constant-time compare, and a "~5 min" staleness window. Not pinned:
the **encoding** of `X-Signature` and the **format** of `X-Timestamp`.

**Assumed by the helper** (`test/helpers/webhook.ts`): `X-Signature` is lowercase **hex**;
`X-Timestamp` is **unix seconds** (string). The stale test uses now − 10 min (well outside
the window); the fresh tests use now.

**Pin before implementing:** signature encoding (hex vs base64), timestamp unit, and the
exact freshness tolerance (tests only rely on "10 min is rejected, now is accepted").

## GAP-11 — webhook request body shape (API-2) — Phase 4

Pinned: the delivery id is the body field `event_id`; the payload is "usage"; the tenant is
the secret owner, not the body. The rest of the body shape is not pinned.

**Assumed:** body `{ event_id, metric, quantity, event_date?, tenant? }`, where `tenant` is
ignored and `metric`/`quantity` rate exactly like `POST /events`. The "body tenant ignored"
test includes a `tenant` field to prove it is dropped.

**Pin before implementing:** the webhook body fields and whether `event_date` is accepted
(defaulting to now() if absent, like `/events`).

## GAP-12 — admin route response codes (API-5, API-6, INV-7) — Phase 6

Pinned/derivable: `/adjustments` returns 202 (enqueued) and 409 (same key, different
payload); both routes 401/403 on auth. **Not pinned:** the **success** code of
`/periods/close`. Tests assert close success is **2xx** (and verify the `period_closures`
row + status), and that the loser of a re-close / concurrent close gets **409**.

**Pin before implementing:** the close success code (200 vs 204) if an exact assertion is
wanted; 409 for re-close and the concurrent loser is assumed.

## GAP-13 — Ledger boot: disable the internal consumer in tests (INV-3 harness) — Phase 6/5/7

`src/ledger/main.ts` spawns the in-process consumer when `DATABASE_URL` is set. Contract
tests need the enqueued adjustment to stay `pending` for inspection, so the harness starts
the Ledger with a test-only env to skip the worker; e2e tests run an explicit worker.

**Assumed:** `DISABLE_CONSUMER=1` makes `src/ledger/main.ts` serve HTTP without spawning the
consumer. (Today the entrypoint ignores it; in the red phase the routes 404 so no race
occurs yet.)

**Pin before implementing:** honor `DISABLE_CONSUMER` (test-only), or provide another way to
run the Ledger HTTP API without the worker.

## GAP-14 — adjustment amount_minor validation range (API-5) — Phase 6

MEMORY: `amount_minor` is "a nonzero integer in range." The numeric range is not pinned.
Tests assert a **nonzero integer** is required (zero → 400, fractional → 400) and that
`reason` and `idempotency_key` are required; they do not assert a specific min/max magnitude.

**Pin before implementing:** the accepted magnitude bound for `amount_minor`, if any.

## GAP-15 — GET /balance response shape (API-3, INV-5) — Phase 5

The balance value's JSON shape is not pinned. Money is BigInt minor units and `pg` returns
`int8` as a string, so a numeric JSON field would lose precision past 2^53.

**Assumed by the tests:** `GET /balance` → 200 with `{ balance_minor: "<string>" }`, a
BigInt-safe decimal string the test parses with `BigInt(...)`. Auth required (401 without a
token); tenant from the token (no tenant query param).

**Pin before implementing:** the balance field name and that it is a string (not a JS number).

## GAP-16 — GET /statement response shape + period param (API-4, INV-4) — Phase 5

Pinned: tenant-scoped; `?period=YYYY-MM`, defaulting to the current period. The response
**shape** (line items, totals, amount encoding) is not pinned. Tests are therefore
shape-agnostic: they assert the default-period body equals the explicit current-period body,
and that a closed period's statement is stable across reads even as the tenant accrues new
usage in a later period.

**Pin before implementing:** the statement body (e.g. per-transaction metric/quantity/
amount_minor + period + total) and that amounts are BigInt-safe strings; confirm the query
param is `period` in `YYYY-MM`.
