# MEMORY.md

Working state and decision log. Read this at the start of every session. This is the
continuity file (what is decided, what is in progress, what is next). The graded
narrative lives in NOTES.md; the grading contract is REQUIREMENTS.md; this is for
keeping the engineer and the coding agent from drifting or relitigating settled calls.

_Last updated: 2026-06-10 (post second adversarial review)._

## Current status

**Done:** Design docs written and through two adversarial review passes. The second pass
(verified against the brief in REQUIREMENTS.md) found brief-compliance gaps, real
concurrency races in the pinned design, and schema holes. All folded into the docs
below before any code.

**Next:** `git init`, commit the docs as the baseline (no code yet, small commits, do
not squash, per DEL-1), then the coding agent runs **Phases 0 through 2** under TDD.
**Phase 2 is a hard checkpoint:** exactly-once and real SIGKILL crash-injection tests
green and the consumer transaction surfaced for review before any API work.

**Not started:** all code.

## Decisions (decided / why / rejected)

- **Postgres for both the ledger store and the message channel** (table-backed queue,
  `SELECT ... FOR UPDATE SKIP LOCKED`). Why: dedup and the posting write commit in one
  transaction, so exactly-once is free. Rejected Kafka/NATS/Redis: their flow is read
  from the bus, write to the DB, confirm back to the bus, which leaves a gap between
  processes where a crash double-charges or loses the event.
- **Money dedup boundary at the point of ledger effect**: `transactions` header,
  `UNIQUE(tenant_id, originating_event_id)`, `originating_event_id` NOT NULL, inserted
  `ON CONFLICT DO NOTHING` in the same transaction as the postings. This is the
  authoritative guarantee. Rejected dedup-only-at-ingest.
- **Ingest request-idempotency is a separate, labeled layer** (not the money guarantee):
  `event_queue` has `UNIQUE(tenant_id, event_id)` plus a stored `payload_hash`. A
  retried request with the same key and same payload gets the original response; same
  key with a **different payload returns 409**. If ingest and the ledger ever disagree,
  the ledger wins.
- **Dedup keys are namespaced at construction** to prevent cross-channel collision (a
  charge-suppression attack otherwise): `api:{idempotency_key}`,
  `wh:{source}:{delivery_id}`, `adj:{idempotency_key}`.
- **Zero-sum by construction plus a standing invariant query**
  (`GROUP BY txn_id HAVING SUM(amount_minor) <> 0` returns zero rows). Rejected the
  deferred constraint trigger as exotic and error-prone.
- **Append-only enforced by database grant**, not code convention.
- **Two runtime roles, not one:** `app_ingest` (queue insert plus credential lookups
  only) and `app_ledger` (the financial grants). Why: a compromised Ingest then cannot
  forge financial rows, which makes the isolation claim true as written. Owner role
  (`app_owner`) holds DDL and seeds.
- **Closed-period guard by row lock plus authoritative closure table.** Consumer takes
  `FOR SHARE` on the period row; close takes `FOR UPDATE`. The authoritative
  closed-check is the existence of a `period_closures` row (append-only, cannot be
  un-closed), with `billing_periods.status` as a cache. Rejected the bare status check
  (check-then-act race) and a trigger alone (cannot see an uncommitted concurrent
  close).
- **Reroute is a locked loop, not a plain assignment** (the earlier reroute reopened the
  exact race the close protocol eliminates). See the reroute rule below.
- **Concurrent closes resolve via `UNIQUE(tenant_id, period_id)`** on `period_closures`.
  Close does get-or-create on the period row first (an idle, never-touched period has no
  row to lock otherwise).
- **JWT (HS256)**: tenant scope from the verified `tenant_id` claim, admin a distinct
  check. The brief's `POST /events` body carries `tenant`; the token is authoritative,
  and a mismatching `body.tenant` returns 403. No default/fallback secret.
- **One flat integer price book.** Rejected a tiered book as gold-plating.
- **Retry/dead-letter** at 5 caught transient failures, bumped in a separate transaction
  guarded by `AND status='pending'` (else it can flip a successfully-posted row).
  Serialization errors are retryable and do not count toward dead-letter. Known gap: a
  process-crashing poison event is not durably counted; documented, not hidden.
- **Reconciliation is a first-class requirement (REC-1..3), `POST /reconcile`.** The
  queue's `done` rows are the independent record; re-rate them and compare to posted
  amounts. This is why **`done` queue rows are never purged.**
- **Adjustments flow through the queue, not a synchronous post.** `POST /adjustments`
  enqueues a `kind='adjustment'` event (202) that the consumer posts through the
  identical dedup, period-lock, and crash-safe path as usage. One idempotency mechanism
  (the queue hash), so no `payload_hash` on the header. The authorization guarantee is
  preserved by a **column-level INSERT grant**: `app_ingest` cannot write the `kind`
  column (defaults to `usage`), so a compromised Ingest cannot forge an admin credit.
  Bonus: adjustments are now reconcilable against the queue row's `amount_minor`, which a
  synchronous post would not be. Rejected the synchronous post (a second 409 path, no
  independent record for reconcile).
- **In-process consumer worker** in the Ledger service, but run as a **spawnable child
  process from day one** so the real SIGKILL harness works in Phase 2.
- **Phase 8 UI is kept** despite OOS-1, on the graders' explicit in-person instruction.
  Noted as an override in DESIGN.md. Still last and first-cut.

## Pinned contracts for the coding agent

Defaults chosen so the agent does not improvise. Change here first if you disagree.

**API surface (serve the brief's exact paths and shapes; no `/v1` prefix).**
- `POST /events` body `{tenant, metric, quantity, idempotency_key}`, optional
  `event_date`. Token authoritative; `body.tenant` must match token or 403.
- `POST /webhooks/usage` (wire contract below).
- `GET /balance` (tenant from token).
- `GET /statement?period=YYYY-MM` (defaults to current period).
- `POST /adjustments` body `{tenant, amount_minor, idempotency_key, reason}`, admin only;
  enqueues (202), posted asynchronously by the consumer.
- `POST /periods/close` body `{tenant, period}`, admin only, concurrent-safe.
- `POST /reconcile`, admin only.

**Money and validation.**
- Integer minor units, `BIGINT`. No float column anywhere. In Node, amounts are strings
  / BigInt end-to-end (pg returns int8 as a string; `Number()` loses precision past
  2^53); all arithmetic in BigInt.
- `quantity` is an integer, `1 <= quantity <= 10^12`. `metric` must exist in the price
  book. `event_date` absent defaults to `now()`; if present it must parse and fall in
  `(now - 1y, now + 1d)`, else 400. Re-validate in the consumer (queue payloads are
  data, not trust). Body size limit on the raw-body webhook route.

**Periods.**
- Monthly. `period_key` is the UTC year-month of `event_date`, e.g. `2026-06`. Created
  lazily, `ON CONFLICT (tenant_id, period_key) DO NOTHING`.
- **Reroute rule:** `target = max(month_of(event_date), current UTC month)`. Loop:
  get-or-create the period, `FOR SHARE` lock it, if it has a `period_closures` row
  advance one month and repeat; otherwise post here. Insert the header only while
  holding the `FOR SHARE` lock on a period verified open under that lock. Terminates at
  the first not-yet-closed future month.

**Price book (flat, integer minor units):** `api_call` = 1, `storage_gb_hour` = 5.
`amount = rate[metric] * quantity`. Pure, in-memory, no rounding.

**Webhook wire contract.**
- Headers: `X-Key-Id`, `X-Timestamp`, `X-Signature`.
- string-to-sign = `{timestamp}.{key_id}.{raw_body}`; HMAC-SHA256; algorithm pinned
  server-side (do not trust a header-named alg).
- Verify over **raw bytes before any JSON parse**, `crypto.timingSafeEqual`
  (length-checked), reject stale timestamp (tolerance ~5 min) and missing/empty
  signature.
- The **delivery id is a field inside the signed body** (so the webhook payload includes
  `event_id`); a header-only delivery id would let a replay mutate it past the
  signature. Dedup key = `wh:{source}:{event_id}`.
- Tenant = owner of the secret found by `X-Key-Id`, never the body.

**Roles and grants.**
- `app_owner`: DDL, migrations, seed.
- `app_ingest`: **column-level** `INSERT` on `event_queue` **excluding `kind`** (so it
  defaults to `usage`), plus `SELECT` on `event_queue`; `SELECT` on `tenants`,
  `webhook_secrets`. Nothing on the financial tables, and cannot enqueue an adjustment.
- `app_ledger`: `INSERT, SELECT` on `transactions`, `postings`, `period_closures`;
  `SELECT, UPDATE(status)` on `billing_periods` (column-limited); `INSERT` (all columns,
  including `kind`)`, SELECT, UPDATE` on `event_queue`; `SELECT` on `tenants`,
  `webhook_secrets`. No `UPDATE`/`DELETE`/`TRUNCATE` on the financial tables.

**Schema hardening (Phase 1 migrations).**
- `transactions`: `txn_id` PK, `tenant_id`, `originating_event_id` NOT NULL,
  `booked_period_id`, `kind` (`usage`|`adjustment`), `metric`, `quantity`, `event_date`,
  `created_at`. `UNIQUE(tenant_id, originating_event_id)`,
  `UNIQUE(txn_id, tenant_id)`, composite FK `(booked_period_id, tenant_id)` to
  `billing_periods(period_id, tenant_id)`.
- `postings`: `UNIQUE(txn_id, account)`, `CHECK(account IN ('receivable','revenue'))`,
  `CHECK(amount_minor <> 0)`, NOT NULLs, composite FK `(txn_id, tenant_id)` to
  `transactions(txn_id, tenant_id)`.
- `billing_periods`: `UNIQUE(tenant_id, period_key)`, `UNIQUE(period_id, tenant_id)`.
- `period_closures`: `UNIQUE(tenant_id, period_id)`, append-only.
- `event_queue`: `kind` (`usage`|`adjustment`, DEFAULT `usage`),
  `UNIQUE(tenant_id, event_id)`, `payload_hash`, `status` (`pending`|`done`|`dead`),
  `attempts`. **`done` rows are never purged** (reconcile source of truth).

**Adjustments.** Admin only. `POST /adjustments` validates (`amount_minor` a nonzero
integer in range, `reason` present), then **enqueues** a `kind='adjustment'` event with
`event_id = adj:{key}` and the payload hash (202). The consumer posts it through the
identical dedup, `FOR SHARE` period-lock, and reroute path as usage, taking the explicit
signed `amount_minor` instead of rating. 409 on payload-hash mismatch is decided at
enqueue against the queue, the same as usage.

**Isolation.** Consumer / adjustments / close run at `READ COMMITTED` (the
block-reread-reroute pattern depends on it). `POST /reconcile` runs at
`REPEATABLE READ` for a stable snapshot (prevents false positives from in-flight
events).

**Infra (Phase 0).** `git init` first. One `migrate` container runs migrations and the
seed as `app_owner`; services depend on it (avoids the two-service migration race).
README.md documents the single run command, seeded credentials (pre-minted JWTs: 2-3
tenants plus 1 admin, no signup), sample curls, the webhook signing recipe, and how to
run tests. Test infra uses a throwaway Postgres compose service (not testcontainers).

## Reconciliation design (REC-1..3)

`POST /reconcile` (admin), one `REPEATABLE READ` transaction. Per tenant: re-rate each
`done` usage queue row through the price book and compare to the posted usage amount;
flag a `done` row with no transaction header (catches a deleted balanced pair); check
each `done` adjustment row against its posting (posted amount equals the enqueued
`amount_minor`, header present, exactly two postings one per account, nets to zero); plus
the global zero-sum and orphan checks. The queue is independent of
the postings, so a symmetric tamper that fools zero-sum still shows up. Tests: connect
as `app_owner`, tamper a posting or delete a pair, expect a flag; run under concurrent
consumer load, expect zero flags.

## Phase log (what happened / what review found / what was solved)

### Phase 0 — scaffold and infra (2026-06-10)

**What happened:** Baseline docs committed and pushed to GitHub
(leecohen2311/keel-caseStudy, author leecohen23@gmail.com). TDD: failing infra
tests committed first (migrations recorded, runner idempotent, runtime roles
cannot CREATE/DROP, healthz 200), then the implementation: raw-SQL migration
runner (per-file transactions, advisory lock), 0001 tenants+webhook_secrets,
idempotent seed, healthz entrypoints, compose with one-shot migrate container,
throwaway tmpfs test Postgres, README. One-command `docker compose up --build`
verified end to end. New working rules added to CLAUDE.md this session:
per-phase review gate (review + fix-commit + MEMORY entry between phases) and
simplicity-always.

**Review found (adversarial pass, verdict pass-with-fixes):**
1. Advisory lock taken after `CREATE TABLE IF NOT EXISTS schema_migrations` —
   two first-run migrators can race the DDL. 2. Test compose shared the
   directory-derived project name — `npm test`'s `down -v --remove-orphans`
   could delete the running dev stack. 3. README overclaimed (advertised
   SIGKILL/concurrency tests that don't exist yet). 4. Interrupted first boot
   leaves a half-initialized pgdata volume with no documented reset.
   5. `webhook_secrets.algo` column contradicted the pinned
   "algorithm pinned server-side" contract. 6. Idempotency test passed
   vacuously on silent no-op. 7. Host port 5432 mapping breaks machines with
   local Postgres.

**Solved:** all of the above — lock before DDL, `name: billing-test`, honest
README + `down -v` reset line, dropped `algo`, stdout assert
`0 newly applied`, dropped the 5432 mapping.

**Accepted (logged, not hidden):** no failed-migration-path test (runner
correctness verified by review; PLAN doesn't require it); runtime roles retain
default CONNECT to postgres/template1 (no persistent CREATE anywhere, claim
holds); admin credential / pre-minted JWTs deferred from the Phase 0 seed to
Phase 3 where auth lands.

### Phase 1 — schema and invariant foundations (2026-06-10)

**What happened:** TDD: 14 failing schema/grant tests committed first, then
migrations 0002 (hardened financial schema) and 0003 (two-role grants). All
pinned constraints landed: dedup boundary `UNIQUE(tenant_id,
originating_event_id)`, `UNIQUE(txn_id, account)` + account/amount CHECKs,
composite FKs for tenant binding, `UNIQUE(tenant_id, period_id)` on closures,
queue request-idempotency. 18 tests green.

**Two deviations from the pinned grant list (both deliberate, in 0003
comments):** (1) app_ledger gets INSERT on billing_periods — the pinned list
omitted it but the consumer's get-or-create reroute loop cannot work without
it; (2) app_ledger's event_queue UPDATE is column-limited to
(status, attempts, processed_at) — stricter than pinned, makes the reconcile
source of truth (payload, event_id, payload_hash, event_date) immutable to
the runtime roles.

**Review found (adversarial pass with live-DB attack battery, verdict PASS):**
all forge paths blocked empirically (cross-tenant FK violations, header
immutability, setval/TRUNCATE denied, app_ingest fully boxed). Key subtlety
verified: Postgres row locks (FOR SHARE/FOR UPDATE) require an UPDATE
privilege, so the column-limited UPDATE(status) grant on billing_periods is
load-bearing for the consumer's lock — do not "tighten" it away. NITs: month
regex accepted 2026-13; lock test didn't cover the queue claim lease.

**Solved:** valid-month CHECK regex; lock test now also takes
FOR UPDATE SKIP LOCKED on event_queue.

**Carried forward loudly (the one soft edge, by design):** zero-sum,
exactly-two-postings, and no-orphan-header are NOT schema-enforceable against
app_ledger — a compromised ledger role can write an unbalanced or single-leg
posting. INV-1's proof lives in the Phase 2 consumer's single-statement pair
construction + the standing zero-sum query test, and in Phase 7 reconcile.
Those tests are mandatory, not optional. Also intentional: usage headers
allow NULL metric/quantity (nullable for adjustments); reconcile re-rates
from the queue, never trusts the header.

## Open / pick up next time

JWT claim shape and `JWT_SECRET` handling finalized before Phase 3 (auth hardening,
alg-pinning, `exp`, `alg:none` rejection ship in Phase 3 where auth lands, not Phase 7).
Webhook secret seeding is a Phase 4 concern. Key-reuse-different-payload resolved: 409.
