# PLAN.md: Phased Build Plan

Usage-metering and billing system: two services (**Ingest**, **Ledger**) over an
at-least-once channel, Postgres for both the ledger store and the message channel. This
plan is the build order I feed the coding agent, one phase at a time. The grading
contract is REQUIREMENTS.md; the pinned contracts the agent must not improvise are in
MEMORY.md.

> **UI note (Phase 9):** The brief lists OOS-1 "Any UI" as out of scope. The graders
> instructed in person to build it anyway, so Phase 9 is included as an explicit
> override of OOS-1 (noted in DESIGN.md). It is built last and is the first thing cut
> under time pressure.

---

## Operating principles

1. **TDD, no exceptions.** Red, green, refactor. For every invariant, the test that
   proves it is written and failing before the code that satisfies it exists. The
   invariant tests are the spec; the agent codes to them.
2. **Airtight core first.** Queue plus dedup plus balanced double-entry (Phases 1 and 2)
   is the whole game. We do not start the API until the consumer survives a real SIGKILL
   crash pass.
3. **Every phase is demoable and leaves all invariants intact.** No phase is "done" with
   a known broken invariant.
4. **Review before merge.** Every phase: I check the exact transaction boundaries and
   the test list before the agent's code lands. "Where does the process dying on this
   line leave us?" is asked of every phase.
5. **Single transaction is sacred.** Claim, dedup, post, and complete are one DB
   transaction in the Ledger consumer. Nothing that breaks that atomicity ships.
6. **Commit history is graded (DEL-1).** `git init` before any code, small meaningful
   commits, test-commit then implementation-commit so TDD is visible. Do not squash.

---

## Invariant and requirement coverage map

Each requirement is enforced in a specific phase and pinned by a named test.

| ID | Requirement | Enforced by | Phase | Proving test |
|----|-------------|-------------|-------|--------------|
| INV-1 | Zero-sum, append-only | Balanced pair in one statement; append-only by grant; `UNIQUE(txn_id, account)`; `CHECK(amount_minor<>0)`; global query. **By construction, not a deferred trigger.** | 1, 2, 7 | `GROUP BY txn_id HAVING SUM<>0 returns 0 rows`; `cannot append a 3rd posting` |
| INV-2 | Exactly-once | `UNIQUE(tenant_id, originating_event_id)` on `transactions`, `ON CONFLICT DO NOTHING`, same tx as posting; namespaced keys; ingest `UNIQUE(tenant_id, event_id)` + payload hash for 409 | 2, 3, 4 | `same event twice to one posting`; `queue redelivery to one`; `reused key + diff payload to 409`; `cross-channel key collision does not suppress` |
| INV-3 | Crash safety | The DB transaction; SKIP LOCKED lock is the lease; real SIGKILL harness | 2, 8 | `SIGKILL at each boundary: no partial state, no double post` |
| INV-4 | Tenant isolation | Tenant from JWT claim or verifying secret; reads filtered by token; composite FKs; `body.tenant` must match token | 3, 4, 5 | `body tenant mismatch to 403`; `cross-tenant read denied` |
| INV-5 | No drift | Balance derived on read; no stored balance; integer minor units; BigInt end-to-end | 5, 7 | `balance == SUM(postings)` |
| INV-6 | Authorization | Distinct admin check; per-source webhook secret; quantity validation (no self-issued credit) | 3, 4, 6 | `tenant token on admin route to 403`; `negative quantity to 400` |
| INV-7 | Immutable close | `UNIQUE(tenant_id, period_id)` on `period_closures` (authoritative); `FOR SHARE`/`FOR UPDATE` row lock; locked reroute loop | 6 | `concurrent close to one winner`; `post during close cannot land in closed period`; `close the reroute target mid-reroute` |
| INV-8 | Webhook integrity | HMAC over raw bytes before parse, `timingSafeEqual`, timestamp freshness, delivery id inside signed body, dedup at ledger | 4 | `bad sig 401`; `stale ts reject`; `mutated-delivery-id replay to 0 new postings` |
| REC-1..3 | Reconciliation | `POST /reconcile`, REPEATABLE READ, re-rate `done` queue rows vs postings | 7 | `tamper/delete posting as owner to flagged`; `reconcile under load to 0 false positives` |
| DEL-1,2,3 | Git, one-command compose, tests | `git init`, migrate container, README, crash + concurrency tests | 0, 8 | `docker compose up from clean machine`; `test suite green` |

---

## Phases

Each phase: **Goal, Build, Tests-first, Done when.**

### Phase 0: Scaffold and infra
**Goal:** `git init`, one documented command brings up Postgres plus both services, migrations and seed apply, health checks pass.
**Build:**
- `git init` and the docs baseline commit before any code.
- `docker-compose.yml`: `postgres`, a one-shot `migrate` container (runs migrations and seed as `app_owner`), `ingest`, `ledger`. Services depend on `migrate` completing, which removes the two-service migration race.
- TypeScript plus Node, one repo, two service entrypoints, shared `db`/`auth` modules.
- Raw-SQL migration runner: numbered `migrations/0001_*.sql`, each applied in its own transaction, tracked in `schema_migrations`.
- **Three roles:** `app_owner` (DDL, migrations, seed), `app_ingest`, `app_ledger` (grants in Phase 1). Each service connects with its own role's connection string.
- **Seed (API-7):** 2-3 tenants, 1 admin credential, webhook secret(s), the price book. Credentials are pre-minted long-lived JWTs printed in the README; no signup.
- `README.md` (DEL-2): the single run command, seeded credentials, sample curls, webhook signing recipe, how to run tests.
- Test runner (vitest) plus `npm test` that spins a throwaway Postgres compose service and runs migrations.
- `GET /healthz` on both services.
**Tests first:** `migrations apply cleanly`; `app_ingest/app_ledger cannot CREATE/DROP`; health returns 200.
**Done when:** clean machine, one command, both services healthy, README accurate, tests green.

### Phase 1: Schema and invariant foundations
**Goal:** tables, constraints, and grants that make the invariants structural before any logic.
**Build (migrations):** the full hardened schema and grants pinned in MEMORY.md, including `UNIQUE(tenant_id, originating_event_id)` and `UNIQUE(txn_id, tenant_id)` on `transactions` with `metric`/`quantity`/`event_date`/`payload_hash`; `UNIQUE(txn_id, account)`, `CHECK(account IN (...))`, `CHECK(amount_minor<>0)`, composite FK on `postings`; `UNIQUE(tenant_id, period_key)` and `UNIQUE(period_id, tenant_id)` on `billing_periods`; `UNIQUE(tenant_id, period_id)` on `period_closures`; `UNIQUE(tenant_id, event_id)` plus `payload_hash` on `event_queue`. Two-role grants, column-limited `UPDATE(status)` on `billing_periods`, `SELECT` on `tenants`/`webhook_secrets`.
**Tests first:** `app_ledger UPDATE/DELETE on postings: permission denied`; `app_ingest has no financial grants`; `app_ingest cannot insert kind='adjustment' (column denied, defaults to usage)`; `third posting on a txn: unique violation`; `amount is integer`; `duplicate (tenant, originating_event_id): unique violation`; `posting with wrong tenant_id: FK violation`.
**Done when:** append-only, single-pair, dedup, and tenant binding are all enforced by the database, proven by failing-as-expected tests.

### Phase 2: Ledger consumer (the heart)
**Goal:** events become balanced, deduped, crash-safe postings, proven under real kills.
**Build, one `READ COMMITTED` transaction:** claim via `FOR UPDATE SKIP LOCKED`; resolve the booked period with the **locked reroute loop** (`max(event month, current month)`, get-or-create, `FOR SHARE`, advance while a `period_closures` row exists); insert the `transactions` header (final period known first, header is immutable) `ON CONFLICT (tenant_id, originating_event_id) DO NOTHING RETURNING txn_id`; if duplicate, mark `done` and commit; if new, re-validate the payload, compute the amount (rate `metric`x`quantity` for `kind='usage'`, or take the explicit signed `amount_minor` for `kind='adjustment'`), insert the balanced pair (BigInt), mark `done`, commit.
- **Retry:** on caught transient exception, `ROLLBACK`, then a separate tx bumps `attempts` and flips to `dead` at 5, guarded by `AND status='pending'`. Serialization errors are retryable and do not count.
- **Run the consumer as a spawnable child process now** so the SIGKILL harness is real this phase, not deferred.
**Tests first:** `same event_id twice to exactly one transaction`; `queue redelivery to one posting`; **`SIGKILL at each boundary (claim, post, mark-done): no partial postings, row recovers`**; `postings net to zero`; `poison event dead after 5`; `retry bookkeeping cannot mark a posted row dead`; `event in a closed period reroutes forward`; `close the reroute target mid-reroute still cannot post into a closed period`; `close current month then send current-month event`.
**Done when:** the consumer survives a real SIGKILL pass with every invariant intact.

### Phase 3: Ingest, tenant API
**Goal:** authenticated tenants submit usage events that land durably, with request idempotency.
**Build:**
- `POST /events` body `{tenant, metric, quantity, idempotency_key}`, optional `event_date`. JWT (tenant); token authoritative; `body.tenant` mismatch returns 403.
- **Validation:** `quantity` integer in `[1, 10^12]`; `metric` in the price book; `event_date` absent defaults to `now()`, if present must parse and fall in `(now-1y, now+1d)`, else 400.
- **Idempotency:** `event_id = api:{idempotency_key}`; insert the queue row with `payload_hash`, `UNIQUE(tenant_id, event_id)`. New row to 202; same key same hash to the stored response; same key different hash to 409. **Return only after the queue row is committed.**
- **JWT hardening lands here** (where auth ships): pin `alg`, verify `exp`, reject `alg:none` and algorithm confusion, no default secret.
**Tests first:** `missing/invalid field to 400`; `negative or fractional quantity to 400`; `unknown metric to 400`; `body tenant mismatch to 403`; `client retry same key/payload to one queued event`; `same key different payload to 409`; `alg:none / expired token rejected`; `crash before enqueue commit: client retries safely`.
**Done when:** the tenant path is validated, idempotent, and at-least-once safe with ledger dedup behind it.

### Phase 4: Ingest, signed webhook
**Goal:** external providers post usage over an HMAC-verified webhook.
**Build:** `POST /webhooks/usage` per the pinned wire contract (`X-Key-Id`, `X-Timestamp`, `X-Signature`; string-to-sign `{timestamp}.{key_id}.{raw_body}`; HMAC-SHA256 over raw bytes before parse; `timingSafeEqual`; stale-timestamp and missing-signature rejection; delivery id is a signed body field; dedup key `wh:{source}:{event_id}`; tenant = secret owner). Request body size limit on the raw-body route.
**Tests first:** `bad signature 401`; `stale timestamp reject`; `tampered body: signature fails`; `mutated-delivery-id replay produces 0 new postings`; `replayed delivery within window charges once`; `body tenant ignored, secret owner wins`.
**Done when:** the webhook threat model items each have a passing test.

### Phase 5: Ledger read APIs
**Goal:** balances and statements, derived and tenant-isolated.
**Build:** `GET /balance` (`SUM(amount_minor)` over the token tenant's receivable account, BigInt; no stored balance). `GET /statement?period=YYYY-MM` (defaults to current period; reads `metric`/`quantity`/`event_date` from the header, not the mutable queue). Every query filtered by tenant from the auth context.
**Tests first:** `balance == SUM(postings)`; `cross-tenant read denied`; `closed-period statement is reproducible`.
**Done when:** no-drift holds and reads cannot cross tenants.

### Phase 6: Admin, adjustments and period close
**Goal:** privileged actions, correctly gated, idempotent, and immutable.
**Build:**
- `POST /adjustments` body `{tenant, amount_minor, idempotency_key, reason}`, **admin only**. Validates, then **enqueues** a `kind='adjustment'` event (`event_id = adj:{key}`, 202); the consumer posts it through the same dedup, `FOR SHARE` period-lock, and reroute path as usage, taking the explicit signed `amount_minor`. 409 on payload-hash mismatch is decided at enqueue. A column-level grant stops `app_ingest` forging an adjustment.
- `POST /periods/close` body `{tenant, period}`, **admin only**. Get-or-create the period row first, `FOR UPDATE`, insert `period_closures` (`UNIQUE(tenant_id, period_id)`), flip status; loser of a concurrent close gets the conflict.
- Admin check is distinct: a validly signed tenant token is rejected on both routes.
**Tests first:** `tenant token on admin route to 403`; `retried adjustment posts once`; `adjustment nets to zero, append-only`; `adjustment during concurrent close cannot land in the closed period`; `concurrent close: exactly one winner`; `close an idle never-touched period`; `re-close a closed period rejected`.
**Done when:** authorization and immutable-close hold under concurrent close plus post, and adjustments are dedup-safe.

### Phase 7: Reconciliation
**Goal:** detect injected corruption, no false positives (REC-1..3).
**Build:** `POST /reconcile` (admin), one `REPEATABLE READ` transaction. Per tenant: re-rate each `done` queue row through the price book and compare to the posted amount; flag a `done` row with no header (deleted pair); check adjustments as their own class (header present, exactly two postings, nets to zero); plus global zero-sum and orphan checks. `done` queue rows are never purged.
**Tests first:** `tamper a posting as app_owner to flagged`; `delete a balanced pair to flagged`; `scale both legs symmetrically to flagged`; `reconcile under concurrent consumer load to zero flags`.
**Done when:** reconcile catches every injected corruption class and stays silent under normal concurrency.

### Phase 8: Invariant verification and adversarial hardening
**Goal:** prove the system to a hostile grader (DEL-3).
**Build:** consolidate the crash-restart and concurrency tests; expand the SIGKILL matrix across both services and the admin paths; a runnable invariant self-check.
**Tests first:** the full adversarial suite: redelivery, double-submit, mid-transaction kill of either service, concurrent close, forged/expired tokens, replayed webhook, corruption injection.
**Done when:** the adversarial suite is green.

### Phase 9: UI (kept by explicit instruction; overrides OOS-1)
**Goal:** a thin read-only lens; **must not touch any invariant.**
**Build:** minimal page showing balance, statements, period status, submit a test event, trigger a close (admin); read-only against the existing APIs; no new privileged path or business logic; built against `ui-design.md`.
**Tests first:** light smoke tests that pages render and call the API.
**Done when:** it renders and round-trips one event and one close. First thing cut under time pressure.

### Phase 10: Docs finalization
**Goal:** the graded documents.
**Build:** finalize `DESIGN.md` (three pages or fewer, DEL-4) and `NOTES.md` (DEL-5, including "where I had to learn something new"); polish `ARCHITECTURE.md`; confirm `REQUIREMENTS.md` traceability.
**Done when:** both graded docs are complete and consistent with the code.

---

## Full API surface (brief-exact)

**Ingest:** `POST /events`, `POST /webhooks/usage`, `GET /healthz`.
**Ledger:** `GET /balance`, `GET /statement`, `POST /adjustments` (admin),
`POST /periods/close` (admin), `POST /reconcile` (admin), `GET /healthz`.

---

## Explicitly cut / out of scope (see DESIGN.md)

Tiered price book, statement pagination, multiple channels, multi-currency, plus the
brief's own exclusions (real payment processor, SSO/signup, autoscaling/HA,
multi-region). **Honest known gap:** a process-crashing poison event is not durably
dead-lettered (the attempt counter cannot live in the rolled-back transaction); accepted
for scope and documented. **UI (Phase 9)** is built only on the graders' explicit
instruction overriding OOS-1, and is cut first under time pressure.
