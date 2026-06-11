# MEMORY.md

Working state and decision log. Read this at the start of every session. This is the
continuity file (what is decided, what is in progress, what is next). The graded
narrative lives in NOTES.md; the grading contract is REQUIREMENTS.md; this is for
keeping the engineer and the coding agent from drifting or relitigating settled calls.

_Last updated: 2026-06-11 (ALL PHASES 0-11 complete; code phases individually gated;
full suite 150/150 green from a clean DB; REVIEW.md audit: all 42 requirement IDs met.
Phase 11 = console hardening (ENABLE_DEV_CORS gate, XSS-inert render layer, mobile +
design polish). The build is delivery-ready on local main — NOT pushed; the final push
is the engineer's call)._

## Current status

**Done:** Design docs through two adversarial review passes, then **Phases 0-2 built
under TDD and pushed to main** (red commit, green commit, review-fix pair, MEMORY phase
log — per phase; see the Phase log below). 37 tests green from a clean database:
infra, schema/grant invariants, and the consumer with real SIGKILL crash injection at
four in-transaction boundaries, redelivery dedup, poison dead-letter, the three
closed-period reroute scenarios, and a two-worker concurrency drain. **The Phase 2
hard checkpoint passed**: each phase's adversarial review verdicts and fixes are in
the Phase log. Grant deviation (app_ledger INSERT on billing_periods) approved by the
engineer and folded into the pinned contract.

**Phase 3 (ingest tenant API) is built and gate-checked:** implementation commit
`7034d77` plus a gate-fix commit; 64 tests green from a clean DB; the one-command
compose stack proven end to end by the new `phase-gate` workflow (see the Phase 3 log
below and the production-readiness-gate decision above).

**Phase 4 (signed webhook) is built and gated:** pin commit `f41741e`, green commit
`9fa12a4`, README recipe `ed84fc6`; 76 tests green from a clean DB; gate **ready: true**
(0 blocking; 4 confirmed minors accepted with pins amended — see the Phase 4 log).

**Phase 5 (read APIs) is built and gated:** pin commit `c58aa55`, green commit
`fa696cb`, README `e81e1ac`, review-fix `58ea8ac` (ledger compose `JWT_SECRET`);
85 tests green from a clean DB; gate **ready: true** with zero confirmed findings
(see the Phase 5 log).

**Phase 6 (admin adjustments + close) is built and gated:** pin commit `abd2d07`,
green commit `e6cb758`, README `262d184`; 106 tests green from a clean DB; gate
**ready: true** (0 blocking; 3 confirmed minors accepted — see the Phase 6 log).

**Phase 7 (reconcile) is built and gated:** pin commit `044c29d`, green commit
`d50ad44`, README `fcc8a44`; **the full suite is green — 115/115 from a clean DB**
(the TDD scaffold has no remaining red); gate **ready: true** (0 blocking; 2 distinct
confirmed minors accepted — see the Phase 7 log).

**Engineer sign-off received (2026-06-10):** the Phase 4-7 run is cleared. The three
surfaced items were closed per the engineer's decisions — `src/healthz.ts` deleted
(dead code, nothing referenced it); the reconcile queue-orphan non-check accepted as a
documented DESIGN.md known gap (do not fix); the NUL/surrogate 500-class, unbounded
`reason`, unbounded reconcile scan, and admin-transaction SIGKILL coverage recorded in
DESIGN.md as explicit Phase 8 deferrals (do not build early).

**Phase 8 (hardening) is built and gated:** red commit `f27b0b5`, green commit
`1378812`, gate-fix docs commit; **127 tests green from a clean DB**; gate
**ready: true** after one docs-only review-fix pass (1 confirmed major — stale pins —
plus 2 minors; see the Phase 8 log).

**Phase 9 (UI console) is built and gated:** red commit `41df701`, green commit
`75b9d76`, review-fix `a087c95`, gate-fix docs commit; **133 tests green from a
clean DB**; gate **ready: true** with zero confirmed code findings (2 docs-only
readiness minors fixed at the gate; see the Phase 9 log).

**Phase 10 (docs finalization) is done:** DESIGN.md carries the period-rule paragraph,
the updated cut/known-gaps sections (Phase 8 closures vs. what stays: REC-2 orphan
non-check, unbounded reconcile scan, the cut liveness trio), and the refreshed UI
override note, at ~3 pages (DEL-4). NOTES.md folds in the per-phase living log
(Phases 3-9 catches, the refuted Phase 4 finding, the Phase 8 U+FFFD lesson) and all
DEL-5 elements. README verified accurate by the Phase 9 gate (one-command boot incl.
the console, 133-test green suite, credentials, curls).

**Next:** engineer sign-off on the Phase 8-10 run, then the engineer pushes. Nothing
is pushed; local main only.

**In progress elsewhere:** nothing — the `tests/phases-3-7` scaffold branch is merged
to main.

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
- **The UI (shipped as Phase 9 after the d786fa2 re-scope) is kept** despite OOS-1, on
  the graders' explicit in-person instruction. Noted as an override in DESIGN.md. Still
  last and first-cut.
- **Phase-boundary production-readiness gate, mechanized (2026-06-10).** Every phase
  ends with the saved `phase-gate` workflow (`.claude/workflows/phase-gate.js`, or
  `/phase-gate <phase>`), run right **after** the implementation commit so review fixes
  land as their own visible commits (the graded catch-and-fix story, DEL-5/EVAL-5).
  Gate = clean-DB phase+regression suites, one-command compose boot + README-credential
  smoke, 3-lens adversarial review with a skeptic verifying every non-nit finding, and
  a docs/history honesty checklist; `ready: true` plus engineer sign-off gates the next
  phase. Why: the Phase 3 review caught two verified majors no test covered (JS-vs-PG
  event_date parser gap 500-vs-400; bare-BEGIN isolation regression of a pinned Phase 2
  fix) while the diff was one phase wide and cheap to fix. Rejected: an end-of-build
  batch gate (defects compound across phases, review quality drops with diff size, and
  failures discovered at hour 22 are unfixable) and hook-based automation (a phase
  boundary is not a harness-detectable event). The heavyweight whole-system pass remains
  Phase 8; the per-phase gate feeds it.
- **Grant deviation approved by the engineer (2026-06-10):** `app_ledger` holds
  `INSERT` on `billing_periods` (shipped in 0003, surfaced in the Phase 1 review, now
  folded into the pinned contract above). Why: the consumer's reroute loop and close
  both get-or-create period rows lazily; the pinned design cannot run without it. Safe
  because creating an open period row has no financial effect — the guarded action is
  closure (append-only `period_closures`), and with no DELETE a period can be created
  and closed but never removed. Rejected: pre-creating periods on a schedule (extra
  moving part, new failure mode) and owner-mediated creation (crosses the role boundary
  inside the consumer transaction).

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

**Auth (JWT), pinned from CONTRACT-GAPS GAP-1 and GAP-7.**
- HS256, secret in env `JWT_SECRET`, no default/fallback. Algorithm pinned server-side;
  never read `alg` from the token header; reject `alg:none` and algorithm confusion.
- Tenant token claims `{ tenant_id, iat, exp }`; `exp` enforced; no `iss`/`aud`/`sub`
  required. Tenant scope is the verified `tenant_id` claim, never a request field.
- The Ingest service reads `PORT`, `DATABASE_URL` (an `app_ingest` connection string),
  and `JWT_SECRET`; `GET /healthz` returns 200 once listening.
- Admin is an `admin: true` claim in the same HS256 token, same `JWT_SECRET`, with **no**
  `tenant_id` (admin is cross-tenant and takes its target tenant from the request body,
  the one allowed exception to scope-from-claim). A valid tenant token is rejected on
  admin routes. **Admin credential closed in Phase 3:** the admin JWT is a claim, not a
  database row — nothing is seeded in `seed/seed.sql` (its comment says so); the
  pre-minted dev admin JWT (`admin: true`, no `tenant_id`, signed with the compose
  `JWT_SECRET`) is documented in README.md alongside the tenant JWTs.

**Money and validation.**
- Integer minor units, `BIGINT`. No float column anywhere. In Node, amounts are strings
  / BigInt end-to-end (pg returns int8 as a string; `Number()` loses precision past
  2^53); all arithmetic in BigInt.
- `quantity` is an integer, `1 <= quantity <= 10^12`. `metric` must exist in the price
  book. `event_date` absent defaults to `now()`; if present it must parse and fall in
  `(now - 1y, now + 1d)`, else 400. Re-validate in the consumer (queue payloads are
  data, not trust). Body size limit on the raw-body webhook route.
- **Request ordering (GAP-4):** authenticate -> authorize (`body.tenant` must equal the
  token tenant, else 403) -> validate -> only then enqueue. A rejected request
  (400/401/403/409) writes **no** `event_queue` row.
- **Payload numeric types:** the queue payload stores `quantity` and `amount_minor` as
  JSON **numbers** in safe-integer range, never strings, so the consumer's
  `computeAmount` accepts them (the DB columns are `BIGINT`; the in-transit JSON doubles
  are exact because bounded below 2^53).
- **GAP-8 pinned (Phase 3, surfaced for review):** a missing/non-string `body.tenant` on
  `POST /events` returns **400** (it is a documented field of the brief's payload), not a
  silent default to the token tenant; a present-but-mismatching `body.tenant` returns 403
  before validation runs. No test constrains the missing case; flagged at the Phase 3
  review gate.
- **event_date wire format pinned (Phase 3):** a full timestamp with an explicit `Z` or
  `±HH:MM` offset (`YYYY-MM-DD[T ]HH:MM:SS[.ffffff](Z|±HH:MM)`), else 400. Exactly the
  shapes JS `Date` and Postgres `timestamptz` parse to the same instant; the divergent
  shapes (JS `toString` format, date-only, timezone-less) are rejected up front so the
  pinned else-400 can never degrade into an INSERT-time 500 (adversarial review finding,
  reproduced live).
- **idempotency_key bound pinned (Phase 3):** 1..200 UTF-8 bytes, else 400. The key feeds
  `UNIQUE(tenant_id, event_id)`; an unbounded incompressible key overflows the btree
  index-row cap (~2.7KB) into a 500, and an accepted giant key bloats the never-purged
  queue. Apply the same bound to `/adjustments` (GAP-14) and the webhook delivery id when
  those land. Phase 8 adds well-formedness (the boundary string gate below); the 400
  message for gated key fields reads "must be a well-formed string of 1..N bytes".
- **Boundary string gate pinned (Phase 8):** every validated free-form string on the
  four body routes — `/events` `tenant` + `idempotency_key`, webhook `event_id`,
  `/adjustments` `tenant` + `reason` + `idempotency_key`, `/periods/close` `tenant` —
  must be well-formed: no U+0000 and no unpaired UTF-16 surrogate, else 400 at the
  boundary (`src/validate.ts` `isCleanString`). Why: Postgres rejects NUL at INSERT (a
  fail-closed 500 instead of the pinned 400), and a lone surrogate is worse — Node's
  UTF-8 encoder silently mutates it to U+FFFD on the wire, so two distinct keys
  ('a\uD800b', 'a\uD801b') collapse into one stored idempotency key.
- **Adjustment `reason` bound pinned (Phase 8, amends GAP-14):** a non-empty,
  well-formed string of at most 1024 UTF-8 bytes, else 400 (the reason lands verbatim
  in the never-purged queue; 1024 is sane headroom far below the 256 KiB body cap).
- **Body cap pinned (Phase 3):** the `/events` JSON body is capped at 256 KiB → 413 (the
  status is flushed to the client before the socket drops). The webhook raw-body route
  gets its own pinned cap when Phase 4 lands.

**Reads (Phase 5; GAP-13/15/16 pinned).**
- The Ledger service reads `PORT`, `DATABASE_URL` (an `app_ledger` connection string),
  and `JWT_SECRET`; `GET /healthz` stays pure liveness (200 with no DB). Test-only boot
  env `DISABLE_CONSUMER` set ⇒ `src/ledger/main.ts` serves HTTP without spawning the
  consumer worker (GAP-13, load-bearing for the contract tests).
- `GET /balance` → 200 `{ "balance_minor": "<decimal string>" }` — the BigInt-safe
  string sum of the token tenant's `receivable` postings, derived per read, never
  stored, all-time (not period-scoped). 401 missing/invalid token. No tenant parameter.
- `GET /statement?period=YYYY-MM` (strict month 01-12, else 400; absent defaults to the
  current UTC month) → 200
  `{ period, lines: [{ txn_id, kind, metric, quantity, event_date, amount_minor }],
  total_minor }`. Lines come from the transactions header joined to the `receivable`
  leg, scoped by **booked period** (`booked_period_id`, the immutability boundary —
  never by raw event_date, never the queue); `quantity`/`amount_minor`/`total_minor`
  are decimal strings (`metric`/`quantity` null for adjustments); deterministic order
  `(created_at, txn_id)`; **no volatile field** — two reads of the same period are
  byte-identical (GAP-16).

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
- **GAP-9 pinned (Phase 4):** `{source}` is the `X-Key-Id`, so the queue `event_id` is
  `wh:{key_id}:{delivery_id}`. An `X-Key-Id` that resolves to no secret returns **401**
  with a response byte-identical to a bad signature's, and enqueues nothing. Two
  accepted minors from the Phase 4 review: (a) the unknown-key path skips the HMAC
  compute, so the 401 is timing-distinguishable from a bad-signature 401 — a key id
  alone forges nothing; (b) the key rides in by plain concatenation, so an
  operator-minted `key_id` containing `:` could alias another same-tenant key's
  deliveries — key ids are colon-free by operator constraint (seed and helpers comply;
  the frozen schema has no CHECK).
- **GAP-10 pinned (Phase 4):** `X-Signature` is lowercase hex; `X-Timestamp` is unix
  seconds; freshness tolerance is **300 s** either side of server now. Accepted minor:
  the freshness gate parses with JS `Number()`, so non-canonical numeric forms (hex,
  exponent) that the signer chose to sign also pass — only a secret holder can produce
  them.
- **GAP-11 pinned (Phase 4):** body `{event_id, metric, quantity, event_date?, tenant?}`.
  `metric`/`quantity`/`event_date` validate exactly like `POST /events` (`event_date`
  absent defaults to now()); `tenant` is ignored (the secret owner wins); `event_id` is
  bounded 1..200 UTF-8 bytes like an idempotency key (it feeds the same unique index)
  and, since Phase 8, well-formed (the boundary string gate).
  Post-verification validation failures are 400; same delivery id with a different
  payload is 409 at enqueue, the same as `/events`.
- **Webhook body cap pinned (Phase 4):** the raw-body route is capped at 256 KiB → 413,
  the same bound and flush-then-drop behavior as `/events`.

**Roles and grants.**
- `app_owner`: DDL, migrations, seed.
- `app_ingest`: **column-level** `INSERT` on `event_queue` **excluding `kind`** (so it
  defaults to `usage`), plus `SELECT` on `event_queue`; `SELECT` on `tenants`,
  `webhook_secrets`. Nothing on the financial tables, and cannot enqueue an adjustment.
- `app_ledger`: `INSERT, SELECT` on `transactions`, `postings`, `period_closures`;
  `INSERT, SELECT, UPDATE(status)` on `billing_periods` (INSERT for lazy period
  creation in the reroute loop; UPDATE column-limited to `status`; no DELETE, so a period
  can be created and closed but never removed); `INSERT` (all columns, including `kind`),
  `SELECT`, `UPDATE(status, attempts, processed_at)` on `event_queue` (UPDATE
  column-limited so `payload`/`event_id`/`payload_hash` stay immutable to the runtime,
  protecting the reconcile source of truth); `SELECT` on `tenants`, `webhook_secrets`. No
  `UPDATE`/`DELETE`/`TRUNCATE` on the financial tables.
- `app_ingest`'s `INSERT` column list also excludes `status` and `attempts`, so a
  compromised Ingest cannot enqueue a row pre-set to `done`.

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

**Admin routes (Phase 6; GAP-12/14/17 pinned).**
- Order on both routes: authenticate (401 missing/invalid token) → authorize (403 for a
  verified token whose `admin` claim is not `true`) → validate (400) → act. The target
  tenant comes from the body (the pinned admin exception); a `tenant` that is missing,
  non-string, or has no `tenants` row → 400 (the FK violation is mapped, not a 500),
  nothing written. Same 256 KiB JSON body cap → 413 as `/events`.
- **GAP-14:** `amount_minor` must be a JSON number that is a nonzero safe integer with
  `|amount_minor| <= 10^12` — the consumer's own bound, rejected 400 at the boundary
  instead of accepted-then-dead-lettered. `reason` a non-empty well-formed string of
  1..1024 bytes (the bound and well-formedness added in Phase 8 — see the pins above);
  `idempotency_key` 1..200 UTF-8 bytes (the pinned key bound, well-formed since Phase 8).
- **GAP-17:** the route stamps `event_date = now()` at enqueue (mirrors `/events`'
  absent-date default); the payload is `{ amount_minor, reason }` (numbers as JSON
  numbers, pinned above).
- **GAP-12:** `/periods/close` success is **200** `{ closed: true, tenant, period }`;
  re-close and the concurrent-close loser get **409** via the `period_closures` unique
  violation inside the close transaction (get-or-create → `FOR UPDATE` → INSERT closure
  → flip status cache, one `READ COMMITTED` transaction). `period` must be strict
  `YYYY-MM` (month 01-12), else 400.
- The admin credential itself was closed in Phase 3 (claim, not row; README pre-minted
  JWT; `seed/seed.sql` comment) — nothing further to seed in Phase 6.
- **Hybrid tokens pinned (Phase 6 review):** admin is decided solely by the verified
  `admin === true` claim; a `tenant_id` riding in the same token is **ignored** on the
  admin routes (and such a token would also pass the tenant reads). Only the
  `JWT_SECRET` holder can mint one; the seeded admin JWT carries no `tenant_id`. Do not
  build anything that relies on a hybrid token.

**Isolation.** Consumer / adjustments / close — and, since Phase 3, the ingest enqueue
(its duplicate-key conflict path is the same block-then-reread pattern) — run at
explicitly pinned `READ COMMITTED`, never an inherited server default. `POST /reconcile`
runs at `REPEATABLE READ` for a stable snapshot (prevents false positives from in-flight
events).

**Dev-only CORS + the console (Phase 9; gated Phase 11).** The dev CORS layer is
**gated behind `ENABLE_DEV_CORS=1`** (exact-match `=== '1'`), **off by default**, and
set only in `docker-compose.yml` on both services — so "dev-only" is enforced by
mechanism, not label (test/phase-11/cors_gate.test.ts pins off-by-default; the phase-9
suite opts in and pins the enabled contract). When enabled, both services answer
any-path `OPTIONS` with 204 (the short-circuit sits before routing and before any
transaction logic) and attach `access-control-allow-origin: *`,
`allow-methods: GET, POST, OPTIONS`, and `allow-headers: Authorization, Content-Type,
X-Key-Id, X-Timestamp, X-Signature` to every response — errors and the 413 flush path
included, because the browser console must be able to read the 401/403 demos. When
disabled, `OPTIONS` falls through to routing like any other method and no
`access-control-*` header is attached anywhere. A local/case-study convenience, NOT a
production posture (no cookies, bearer-token auth, localhost only); labeled in code,
README, and the page footer. The console itself is a pure static client under `ui/`
(plain HTML/CSS/JS, no build step), served by an nginx compose service on **:8080**;
since Phase 11 every HTML fragment it builds from wire data comes from the pure,
escape-everything builders in `ui/render.js` (XSS-inert, proven by
test/phase-11/ui_render.test.ts). It embeds the README's seeded dev JWTs and the
seeded webhook secret (for in-browser SubtleCrypto signing) — a deliberate, labeled
test convenience. No business logic, no new server endpoint, nothing that can touch an
invariant.

**Infra (Phase 0).** `git init` first. One `migrate` container runs migrations and the
seed as `app_owner`; services depend on it (avoids the two-service migration race).
README.md documents the single run command, seeded credentials (pre-minted JWTs: 2-3
tenants plus 1 admin, no signup), sample curls, the webhook signing recipe, and how to
run tests. Test infra uses a throwaway Postgres compose service (not testcontainers). The
Ingest service carries a test-only `INGEST_CRASH_POINT` env hook mirroring the consumer's
`CRASH_POINT` (e.g. `before-enqueue-commit`), for the crash-before-commit test (GAP-6).
The Ledger service likewise carries a test-only `LEDGER_CRASH_POINT` hook (Phase 8) with
points `adjustment-before-commit` and `close-before-commit`, between the INSERT and the
COMMIT of the two admin transactions. All three hooks are inert unless the env is set
(never set in compose).

## Reconciliation design (REC-1..3)

**GAP-18 pinned (Phase 7):** `POST /reconcile` returns **200** with
`{ ok: boolean, discrepancies: [...] }` — 200 even when flagging (a diagnostic report,
not an error); `ok === true` iff `discrepancies` is empty; each discrepancy carries
`{ type, tenant_id, ... }` with enough (event_id / txn_id, expected vs posted) to
locate it. Auth is the same admin gate as Phase 6 (401/403). The transaction is
`REPEATABLE READ` **READ ONLY**. A header without a queue row is NOT flagged — the
queue's `done` rows drive the re-derivation (they are the independent record); the
global zero-sum and leg-count checks still cover every header. **Engineer-accepted
(2026-06-10) as a documented known gap, closed — not an open TODO:** not reachable from
any external surface (forging it needs ledger-level INSERT, grant-blocked for
`app_ingest`), and fixing it would churn a green suite for no reachable benefit; written
into DESIGN.md's known-gaps section. Do not "fix" the seeds or reconcile for this.

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

### Phase 2 — the consumer (2026-06-10)

**What happened:** TDD: 16 failing tests committed first (balanced-pair
rating, adjustment posting, redelivery dedup, rival-claim SKIP LOCKED, poison
dead-after-5, guarded failure bookkeeping, the three reroute scenarios
including the deterministic mid-reroute close race, real SIGKILL at four
in-transaction boundaries + after-commit redelivery, two-worker 30-event
drain). Then the implementation: `processOne` as one READ COMMITTED
transaction exactly per ARCHITECTURE §3, `consumer-worker.ts` as a spawnable
child process (the SIGKILL harness kills the production artifact), pricebook,
ledger main spawns + respawns the worker. One cross-file fix: Phase 1's
constraint-probe debris (bare headers) now cleans itself up so global
standing invariant checks run over real data. 34 tests green, compose stack
verified end to end.

**Review found (3-lens multi-agent adversarial review — crash boundaries,
concurrency/locking, conformance/test-honesty — every non-NIT finding
adversarially verified by a skeptic against the live DB; all three lenses:
pass-with-fixes):**
1. CONFIRMED: consumer skipped the pinned event_date re-validation — a
   compromised app_ingest could mint a 2999-06 billing period and book real
   postings there (reproduced live); 5-digit years silently misrouted via the
   lexicographic key compare; pre-1000 years burned retries on the period_key
   CHECK. 2. CONFIRMED: bare `BEGIN` inherited the server-default isolation
   while the whole lock protocol depends on READ COMMITTED; at REPEATABLE
   READ the get-or-create throws 40001 storms and INV-7 safety would rest on
   the discardable status-cache write (reproduced live). 3. REFUTED by the
   skeptic (7/7 trials): the claim that connection blips dead-letter
   legitimate charges — the worker dies on the unhandled socket error before
   recordFailure can run; row stays pending; respawn posts exactly once.
   NITs: adjustment magnitude bound missing; header event_date lost
   microseconds in the Date round-trip.

**Solved (TDD, red committed before green):** event_date re-validated in the
consumer against the pinned (now-1y, now+1d) window before any period is
minted — out-of-window is poison (dead), never a misbooked charge;
`BEGIN ISOLATION LEVEL READ COMMITTED` pinned explicitly; adjustment
|amount_minor| bounded by 10^12 like quantity; event_date carried as text
into the header so it mirrors the queue exactly. 37 tests green.

**Deferred to Phase 8 (logged, not hidden):** worker supervision polish
(orphan on parent SIGTERM, unconditional 1s respawn, healthz green without a
live consumer), lock_timeout against a wedged close transaction (liveness
only, no invariant at risk), client-level 'error' listener (connection death
currently surfaces as a crash-respawn, which the skeptic proved
invariant-safe).

**Phase 2 hard checkpoint: PASSED.** Exactly-once + real SIGKILL tests green;
consumer transaction reviewed hostile and surfaced below for the engineer.

### Phases 3-7 — failing test scaffold, TDD red (2026-06-10)

**What:** All Phase 3-7 invariant/API tests were written **red first** — every test was
written and then run to confirm it **fails for the right reason** (route 404 / missing
behavior), **before any of that Phase 3-7 production code exists**. The tests are therefore the
spec the coding agent builds to: each can only turn green on a correct implementation, never
vacuously (a test that passed before the code existed would be testing nothing). Black-box, on
branch `tests/phases-3-7` (test-only). 78 tests, 10 files: **77 red + 1 intentional green**.
The single green is a standing backstop (`app_ingest` cannot enqueue `kind='adjustment'`,
already enforced by the Phase 1 column grant) — kept and clearly labeled because Phase 6's
authorization story rests on it. `*.e2e.test.ts` files stay red until the relevant route
**and** the Phase 2 consumer are both present.

Build/verification order (oldest→newest commit): harness → P3 → P4 → P6 → P5 → P7, each
RED-verified and adversarially reviewed before the next. Re-run any phase's red proof with
`bash scripts/test.sh test/phase-N` (every assertion shows `expected 404 to be <code>`).

**How we built it (reuse this loop — it is fast):**
- **Black-box only.** Spawn the real services as child processes (`test/helpers/
  ingest-server.ts`, `ledger-server.ts` — `node src/<svc>/main.ts`; Node 24 runs `.ts`
  directly) and hit HTTP; assert on status codes + DB state (`event_queue`, `transactions`,
  `postings`, `billing_periods`, `period_closures`). No imports of internal prod modules.
- **Shared harness** under `test/helpers/` (separate from the Phase 0-2 `test/helpers.ts`;
  dedupe at merge): `db.ts` (role pools, fixtures, state queries), `jwt.ts` (hand-rolled
  HS256 mint + `alg:none`/expired/wrong-secret forgers — no lib, so adversarial tokens are
  forgeable), `webhook.ts` (HMAC signing), `http.ts`, `ingest-server.ts`/`ledger-server.ts`/
  `worker.ts` (spawn + drain).
- **Per-phase loop:** write red tests → `bash scripts/test.sh test/phase-N` and confirm each
  fails for the RIGHT reason (route 404, not a typo) → adversarial 3-lens review
  (red-ability, contract fidelity, harness/flakiness) → fold fixes → small test-only commit.
  Built in priority order 4, 6, 3, 5, 7 (4/6 highest value).
- **Unpinned contracts are logged, never invented:** `CONTRACT-GAPS.md` (GAP-1..18). Pin
  these in MEMORY before implementing.

**Boot/run contracts the coding agent must honor (the tests assume these):**
- Ingest & Ledger read `PORT`, `DATABASE_URL` (own role), `JWT_SECRET` (HS256, no default).
- JWT: tenant scope in the `tenant_id` claim; `exp` enforced; admin via an `admin:true`
  claim (GAP-7). Wrong-role-on-route → 401/403.
- Ingest needs test-only `INGEST_CRASH_POINT=before-enqueue-commit` for the crash test (GAP-6).
- Ledger needs test-only `DISABLE_CONSUMER=1` so contract tests see a stable pending row
  (GAP-13) — **load-bearing; must land before the admin/read routes.**
- Webhook: hex HMAC-SHA256 over `{timestamp}.{key_id}.{raw_body}`; unknown key → 401
  (GAP-9/10). Reconcile: 200 with `{ ok, discrepancies }`, 200 even when flagging (GAP-18).

**Coverage:** P3 `/events` (auth incl. alg:none/expired, validation, body.tenant→403,
idempotency 202/409, return-after-commit; e2e charge + retry-once; crash-before-commit). P4
`/webhooks/usage` (bad/missing/stale/tampered/unknown-key→401, timestamp-binding, secret-owner
wins; e2e mutated-id→0 postings, replay charged once). P5 `/balance`==SUM(receivable),
cross-tenant isolation, `/statement` default + closed-reproducible. P6 admin 403, adjustments
202/409 + e2e posts-once/nets-zero/reroute-past-closed, close idle / re-close-409 /
concurrent-one-winner. P7 reconcile flags tamper/delete/symmetric-scale/adjustment-mismatch,
zero false positives under load.

### Phase 3 — ingest tenant API (2026-06-10)

**What happened:** TDD: the 27 Phase 3 tests were already red on main (scaffold commits
`e8bf74f`/`e399766`); RED re-verified (all fail on route 404 / missing crash hook)
before any production code. One green commit (`7034d77`): `POST /events` with
hand-rolled pinned-HS256 JWT verification (shared `src/auth.ts`, strict base64url
decode, exp enforced), the GAP-4 order authenticate→authorize→validate→enqueue,
pinned validation bounds, `api:`-namespaced request idempotency (202 replay / 409
mismatch via payload_hash), a commit-before-202 enqueue transaction at explicitly
pinned READ COMMITTED, and the `INGEST_CRASH_POINT=before-enqueue-commit` hook.
Pre-minted tenant+admin JWTs documented in README (compose `JWT_SECRET`), seed
admin-TODO closed. 64 tests green from a clean DB.

**Review found (3-lens multi-agent pre-commit review, every non-nit finding
adversarially verified live by a skeptic; 0 refuted; fixes folded into `7034d77` and
disclosed in its commit body):**
1. MAJOR: event_date validated with the JS Date parser but stored via the Postgres
   parser — `String(new Date())` input reproduced a 500 against the pinned else-400.
   Fixed: strict ISO-with-explicit-offset gate (only shapes both parsers read
   identically); format pinned. 2. MAJOR: bare `BEGIN` inherited server-default
   isolation, regressing the pinned Phase 2 fix class; 40001→500 reproduced live at
   REPEATABLE READ on concurrent same-key retries. Fixed: explicit READ COMMITTED,
   pinned. 3. minor: unbounded idempotency_key overflowed the btree index row (~2.7KB)
   into a 500 — bounded 1..200 bytes, pinned. 4. minor: the 413 was unreachable
   (req.destroy() raced the response) — now flushes the status, then drops the socket.
   5. minor: stale "seed admin JWT in seed.sql" pin — amended (claim, not row).
   6. nits: README admin-route overclaim rephrased; lenient base64url signature decode
   made strict. GAP-8 pinned: missing `body.tenant` → 400.

**Production-readiness gate (first run of the new `phase-gate` workflow):** clean-DB
suites 64/64; one-command compose cold boot + README-credential smoke proven end to
end (202 / replay-202 / 409 / 403 / 401; consumer posted the balanced pair within
seconds, receivable leg = 100, net zero; rejected requests enqueued nothing).
Readiness checklist flagged one real item — the README test-run paragraph did not
disclose that the intentionally-red Phase 4-7 scaffold makes full `npm test` exit
failing by design — fixed in the gate-fix commit, along with folding the `/events`
256 KiB→413 body cap and the ingest isolation pin into the pinned blocks.

**Accepted (logged, not hidden):** no explicit slowloris timeout on the body read
(bounded by Node 24's default headersTimeout/requestTimeout; one-liner if wanted);
GAP-8's missing-tenant case remains test-unconstrained; this phase's review-fix
behaviors were folded into the green commit without new red tests (review ran
pre-commit) — subsequent phases run the gate post-commit with visible review-fix
commits per the new CLAUDE.md rule.

### Phase 4 — signed webhook (2026-06-10)

**What happened:** TDD: the 12 Phase 4 tests were already red on main (scaffold
commits `36dbc3e`/`6f738d0`); re-verified red (route 404) before any production code.
Pins first (`f41741e`): GAP-9 ({source} = X-Key-Id), GAP-10 (hex sig, unix-seconds
timestamp, 300 s), GAP-11 (body shape, tenant ignored, delivery id 1..200 bytes), and
the 256 KiB raw-body cap. One green commit (`9fa12a4`): `POST /webhooks/usage` on
Ingest — raw bytes read first (the signature covers them), HMAC-SHA256 over
`{timestamp}.{key_id}.{raw_body}` with the algorithm pinned server-side, length-checked
`timingSafeEqual` over the lowercase-hex strings (no lenient hex decode), 300 s
freshness either side, every auth failure an identical 401 with no side effect,
validation only on authenticated bytes, tenant = secret owner, enqueue through the
unchanged Phase 3 transaction. README recipe + honest counts (`ed84fc6`). 76 tests
green from a clean DB. The `/events` handler, the frozen consumer, and migrations are
untouched.

**Gate (ready: true, 0 blocking):** clean-DB suites 76/76; compose cold boot +
README-recipe smoke proven live (valid delivery → 202 → balanced pair for tenant_alpha,
net zero; identical replay → 202 with still one row/one txn; corrupted sig /
stale-but-correctly-signed timestamp / unknown key → byte-identical 401s, nothing
enqueued). 3-lens review + skeptic: one finding REFUTED (pre-auth 256 KiB buffering as
a flaw — the read must precede verification because the signature covers the raw bytes;
bounded by the same cap as `/events`), four confirmed minors, none a forgery vector.

**Solved:** the minors were accepted, not code-churned — the two pins the review proved
overclaimed/loose were amended instead (GAP-9: "does not leak key existence" softened to
byte-identical response, colon-free key_id operator constraint documented; GAP-10:
`Number()` timestamp leniency recorded). Rationale: fix-the-pin beats churning reviewed
code for non-exploitable minors; all three need the real secret or operator action to
reach.

**Accepted (logged, not hidden):** the three minors above; an unauthenticated
oversized request reaches 413 (not 401) and can buffer up to 256 KiB, inherent to
verify-raw-bytes-first; MEMORY status header lag closed at this gate.

### Phase 5 — ledger read APIs (2026-06-10)

**What happened:** TDD: the 9 Phase 5 tests were red on main (scaffold `05b0186`/
`d4f5fbb`); re-verified red (route 404). Pins first (`c58aa55`): GAP-13 (the
`DISABLE_CONSUMER` boot env), GAP-15 (`balance_minor` decimal string), GAP-16 (the
statement shape, strict YYYY-MM, booked-period scoping, deterministic order, no
volatile fields). One green commit (`fa696cb`): `src/ledger/main.ts` rewritten from
health-stub to the real HTTP server — `/balance` derives the all-time receivable sum
per read (never stored, INV-5), `/statement` reads the immutable header joined to the
receivable leg scoped by `booked_period_id`; both 401 without a verified token, tenant
always from the claim. Plain single-statement SELECTs: no caching, no new storage, no
transactions to crash. README curls (`e81e1ac`). 85 tests green from a clean DB.

**Review found (slimmed fan-out per the low-risk-phase rule: orchestrator inline
3-lens pass, gate ran tests/compose/honesty in full):** one confirmed MAJOR — the
ledger compose service lacked `JWT_SECRET`, so every README JWT would have 401'd in
the one-command stack (the routes verify tokens as of this phase). Fixed as visible
review-fix commit `58ea8ac` before the gate.

**Gate (ready: true, zero confirmed findings, zero nits):** clean-DB suites 85/85;
compose smoke proved all seven checks live (derived balance B0→B0+7 after a posted
event; default statement byte-identical to explicit current period and across repeated
reads, the new line present; beta token sees only beta's balance; 401 unauthenticated;
2026-13 → 400; API balance == SUM(postings) by psql cross-check).

**Accepted (logged, not hidden):** `src/healthz.ts` is now dead code (the old ledger
stub was its only importer) — left in place pending engineer say-so on deletion; an
admin token (no `tenant_id`) gets 401 on the tenant read routes (unpinned, no test
constrains it).

### Phase 6 — admin adjustments and period close (2026-06-10)

**What happened:** TDD: the 21 Phase 6 tests were red on main (scaffold `5c3307c`/
`dc1962f`; 1 intentional green — the Phase 1 `kind` column-grant backstop);
re-verified red. Pins first (`abd2d07`): GAP-12 (close success 200, 409 via the
closure unique violation, strict YYYY-MM), GAP-14 (amount a nonzero safe-integer JSON
number, |x| ≤ 10^12, bounded key), GAP-17 (event_date = now() at enqueue), FK→400
mapping, 401-before-403 ordering, 256 KiB cap. One green commit (`e6cb758`):
`/adjustments` validates then **enqueues** `kind='adjustment'` (`adj:{key}`, payload
`{amount_minor, reason}`, hash over both) through the same READ COMMITTED
commit-before-202 transaction shape as ingest — the frozen consumer posts it, no
parallel posting path; `/periods/close` is one transaction: get-or-create →
`FOR UPDATE` → INSERT the append-only closure (the unique violation IS the 409 for
re-close and the concurrent loser) → flip the status cache. Admin = the verified
`admin === true` claim, checked before the body is read. README curls (`262d184`).
106 tests green from a clean DB.

**Gate (ready: true, 0 blocking):** clean-DB suites 106/106; compose smoke proved all
eight checks live (double-202 adjustment charged exactly once, balance −250 once;
same-key/different-payload 409; tenant token 403 / no token 401 with nothing enqueued;
idle close 200 + closure row; re-close 409; two concurrent closes → exactly one 200,
one 409, one closure row; adjustment after closing the current month rerouted to the
next open period — nothing books into a period after its closure; close protocol
verified live with `created_at < closed_at` for every pre-existing row). Full 3-lens
review + skeptic: 3 confirmed minors, none exploitable, none blocking.

**Solved:** the hybrid-token finding was a silent contract surface — pinned now
(admin decided solely by `admin === true`; a `tenant_id` in the same token is ignored;
only the secret holder can mint one).

**Accepted (logged, not hidden):** a NUL byte or unpaired UTF-16 surrogate inside a
validated string field (tenant/reason/key) passes the boundary `typeof` checks and
dies at INSERT as a fail-closed 500 instead of the pinned 400 — transaction rolls
back, zero rows written, admin-only reachability here, and the identical class
pre-exists on `/events`/`/webhooks/usage`; logged as Phase 8 hardening (shared
control-character/surrogate gate on string validators) rather than churning three
reviewed routes mid-build. `reason` is unbounded below the 256 KiB body cap in the
never-purged queue (same class as the bounded key, much smaller exposure; Phase 8).
No SIGKILL hook covers the two new admin transactions yet — structurally identical to
the proven ingest enqueue (single transaction, commit-before-response, unique-key
recovery), and the crash matrix expansion is already PLAN Phase 8 scope.

### Phase 7 — reconciliation (2026-06-10)

**What happened:** TDD: the 9 Phase 7 tests were red on main (scaffold `f217abb`/
`5246ae0`); re-verified red (route 404). Pin first (`044c29d`): GAP-18 — 200 with
`{ ok, discrepancies }` even when flagging, REPEATABLE READ **READ ONLY**, and the
deliberate non-check (a header without a queue row is not flagged). One green commit
(`d50ad44`): `handleReconcile` in `src/ledger/main.ts` — one read-only snapshot
transaction; every `done` queue row LEFT JOINed to its header and receivable leg
(missing header = deleted-pair flag; usage re-rated through the price book **from the
queue payload, never the header**; adjustments compared to the enqueued
`amount_minor`; unratable payloads flagged per-row, never a 500); plus the global
exactly-two-postings / zero-net check over every transaction. README (`fcc8a44`):
`npm test` is now fully green at 115 — the red-scaffold caveat is gone. **The whole
build is green: 115/115 from a clean DB.**

**Gate (ready: true, 0 blocking):** clean-DB suites 115/115; compose smoke proved
REC-1..3 live — persisted-volume baseline reconciled clean; symmetric-scale tamper
(zero-sum preserved) flagged with the exact tenant/event/expected/posted, 200 while
flagging; tamper reverted → clean again; reconcile hammered 4× during a live consumer
drain → zero false positives, then the new charge reconciled clean. Full 3-lens review
+ skeptic: 2 distinct confirmed minors, both accepted.

**Accepted (logged, not hidden):**
1. **The pinned non-check is a real REC-2 narrowing — surfaced for engineer
   sign-off:** a forged *balanced* transaction with NO queue row (requires
   `app_ledger`-level INSERT on transactions+postings — `app_ingest` cannot) passes
   reconcile silently: query 1 walks only `done` queue rows, query 2 only checks
   legs=2/net=0. Pinned with rationale (Phase 5/6 seeds legitimately write queue-less
   headers; flagging would false-positive), and structurally mitigated by the grant
   split. **Engineer decision (2026-06-10): accepted and closed** — documented in
   DESIGN.md's known-gaps section as deliberate judgment (non-reachable externally;
   fixing would churn a green suite for no reachable benefit). Not a Phase 8 item.
2. Reconcile loads every `done` row (payloads included) into one in-memory pass —
   unbounded over the system's life since done rows are never purged. Fine at
   case-study scale (300-row drain reconciles in <1 s); a real deployment would page
   it. Logged as a known cut.

### Phase 8 — hardening (2026-06-10)

**What happened:** PLAN.md's Phases 8-10 were first rewritten to the engineer's final
scope (`d786fa2`): Phase 8 kept minimal — explicit DEL-3 naming, admin crash safety,
two input gaps; reconcile logic and seeds untouched. TDD: 11 red tests committed first
(`f27b0b5`) — the red run itself was diagnostic: a NUL string died as the documented
fail-closed 500, but a lone surrogate was **worse than documented** — Node's UTF-8
encoder silently mutates it to U+FFFD, so two distinct idempotency keys collapse into
one stored key and the request 202s. Green commit (`1378812`): test-only
`LEDGER_CRASH_POINT` SIGKILL hooks between INSERT and COMMIT in both admin
transactions (`adjustment-before-commit`, `close-before-commit`); shared
`src/validate.ts` `isCleanString` (no U+0000, no unpaired surrogates) wired into every
validated free-form string on the four body routes as a 400; adjustment `reason`
bounded at 1024 bytes; `test/phase2_crash.test.ts` describes renamed to explicitly
grader-findable "DEL-3 crash-restart test" / "DEL-3 concurrency test" (renames only).
127/127 green from a clean DB. Frozen files untouched.

**Gate (first run ready: false — all deterministic checks passed; docs-state findings
only):** clean-DB suites 127/127; compose cold boot + README-credential smoke proved
all five checks live (valid event 202 → balance +100; NUL key → field-specific 400
with nothing enqueued; 1025-byte reason → 400; normal adjustment 202 → posted −50;
reconcile ok:true; crash hooks confirmed inert in compose). 3-lens review + skeptic:
1 confirmed MAJOR — MEMORY's pinned contracts contradicted shipped behavior (GAP-14
still said "reason a non-empty string", key pins lacked well-formedness,
LEDGER_CRASH_POINT absent from the env-hook record); 2 confirmed minors — README still
claimed 115 tests / coverage through Phase 7; the Phase 2 log's "deferred to Phase 8"
trio (worker supervision polish, lock_timeout, client-level pg error listener) was
dropped by the rescope with the cut recorded nowhere. 1 nit (informational):
close-before-commit fires before the status UPDATE — same transaction, identical
rollback, satisfies PLAN's stated window.

**Solved (this gate-fix commit, docs-only):** pins amended (boundary string gate +
reason bound pinned as Phase 8 blocks; GAP-11/GAP-14/key-bound/Infra lines updated);
README counts and coverage refreshed to 127 with the DEL-3 test names called out;
Phase 8 log + status refresh.

**Decision recorded — the Phase 2 deferred trio is CUT, not forgotten:** the
engineer's Phase 8 rescope (the new PLAN.md, `d786fa2`) deliberately excludes worker
supervision polish, lock_timeout, and the client-level error listener. No invariant is
at risk: the Phase 2 skeptic proved the crash-respawn path invariant-safe (7/7
trials), and lock_timeout is liveness-only. DESIGN.md's cut list picks this up in
Phase 10's deferred-sections update (noted in PLAN.md Phase 10).

### Phase 9 — UI console (2026-06-10)

**What happened:** TDD: 6 red tests committed first (`41df701`) — CORS preflight 204 +
permissive allow headers on both services, allow-origin on real responses including
errors, and the page-wiring smoke (panels, identity switcher, endpoint calls,
SubtleCrypto). Deliberately light per PLAN.md: the invariants live behind the APIs,
already proven by phases 0-8. Green commit (`75b9d76`): `ui/` — a static, no-build,
no-dependency console styled to ui-design.md's operational console register
(space-blue surfaces, Fragment Mono numerals/badges, tabular right-aligned numbers,
the four fixed status intents, light-theme toggle); identity switcher across the
seeded JWTs; one panel per feature, each showing the exact request and live response
(replay/409 demos on /events, byte-identical webhook replay signed in-browser,
balance readout, statement table, adjustments, close 200-vs-409, rendered reconcile
report); dev-only CORS as an additive header layer on both services; nginx compose
service on :8080; README "Try it in the browser" + 9-step manual checklist. Review
(slimmed inline 3-lens pass per the low-risk-phase rule) caught one real item —
`fmtMinor()` output reaching `innerHTML` unescaped — fixed as visible commit
`a087c95`. Frozen files untouched.

**Gate (first run ready: false — deterministic checks all green; docs-state only):**
clean-DB suites 133/133; compose smoke proved all five checks live (UI 200 with all
seven panels + assets; preflights 204 with the full header set; browser-equivalent
202/200/401-with-allow-origin flow; webhook README recipe end-to-end with
replay-charged-once verified in the DB — one txn, two postings, net zero; crash hooks
inert in both running containers). Zero confirmed code findings. Two docs-only
readiness minors: README counts stale (127 → 133, no phase-9 coverage line) and the
new CORS wire contract unpinned in MEMORY.

**Solved (this gate-fix commit):** README counts/coverage refreshed; dev-only
CORS + console pinned block added; Phase 9 log + status refresh.

### Phase 10 — docs finalization and delivery prep (2026-06-10)

**What happened:** docs-only, no gate (not a code phase; the per-phase gates covered
8 and 9 this session). DESIGN.md: added the engineer-supplied period-rule paragraph
(max(event-month, current-month) as a deliberate, defended simplification); rewrote
the deferred section into "closed in Phase 8" (NUL/surrogate 400s, reason bound, admin
SIGKILL tests) versus what stays (REC-2 orphan non-check, unbounded reconcile scan,
the cut liveness trio now argued in the cut list); refreshed the OOS-1 override note
to describe the real console. Word count ~1.55k ≈ 3 pages. NOTES.md: per-phase
living-log section (one catch per phase, including the Phase 4 finding the skeptic
refuted and the Phase 5 compose-smoke catch), gate mechanization described under "How
I worked", two new had-to-learn items (the U+FFFD encoder collision, SubtleCrypto
secure-context), UI cut-note corrected to built-as-pure-client. README left as
verified by the Phase 9 gate. Final state: full suite green from a clean DB, tree
clean, TDD-visible unsquashed history. Not pushed.

### Phase 11 — console hardening, mobile, design polish + CORS gate (2026-06-10/11)

**What happened:** preceded by a full requirements-compliance audit (REVIEW.md,
commit `5695cf0`): a multi-agent hostile-grader pass over all 42 requirement IDs with
skeptic verification — all 42 met, zero correctness defects; the flagged items
(DEL-4 page headroom, dev-CORS-as-label, doc staleness nits) drove this phase and the
docs pass after it. Then two TDD pairs plus a polish commit. (1) CORS gate: red
`5770f3a` (off-by-default suite, verified failing for the right reason) → green
`d85ecea` — `ENABLE_DEV_CORS === '1'` gates the CORS headers and the OPTIONS
short-circuit in both mains (the only backend change, subtractive; frozen files
untouched), compose sets the flag on both services, README documents it; the phase-9
suite opts in so the enabled contract stays pinned. (2) XSS-inert render layer: red
`c3f2fca` (hostile-payload suite against not-yet-existing ui/render.js) → green
`7a33be2` — all console HTML built from wire data moves into pure escape-everything
builders in `ui/render.js` (escapeHtml now covers single quotes), app.js keeps
wiring/fetch only, plus loading/busy/unreachable/empty states. Disclosed in the green
commit: the red suite's loader had to switch createRequire→node:vm (type:module parses
.js as ESM under require, silently skipping a CJS guard); assertions byte-identical.
(3) Polish `fd9f2e0`, CSS-only: responsive to a real 360px viewport (measured
scrollWidth == 360, no element past the edge), 44px tap targets (measured), 16px field
text on touch, ui-design §4 motion (veil reveal on render, button press/busy, badge
transitions, dot breathe) fully disabled under prefers-reduced-motion; light + dark
verified by screenshot, live request/response verified in-browser via CDP.

**Gate (first run ready: false — every deterministic check green; docs-state only):**
clean-DB suites **150/150** (133 + 17 phase-11); compose smoke proved all eight checks
live (console + assets 200; preflights 204 with the full header set; 401 readable with
allow-origin; event 202 → balance +7; adjustment −250 once; reconcile ok:true; webhook
sign → replay charged exactly once with a DB cross-check → tamper 401; crash hooks
inert; zero-sum standing check clean). Review + skeptic: 0 blockers, 0 majors; the
loader switch judged "a harness fix, not a weakening" (nit). 2 confirmed minors, both
docs: README still counted 133 tests, and the pinned Phase 9 CORS block contradicted
the now-gated implementation (ENABLE_DEV_CORS recorded in no pin).

**Solved (this gate-fix commit, docs-only):** README counts → 150 with a phase-11
coverage line; the CORS pin rewritten as gated (off-by-default, exact-match flag,
compose-only, OPTIONS fall-through) with render.js added to the console pin; the stale
"Phase 8 UI" decision-log line corrected; this Phase 11 log.

**Accepted (logged, not hidden):** the two flag-on tests in cors_gate.test.ts passed
before the gate existed (the then-unconditional behavior satisfied them); they pin the
enabled contract through the change rather than prove the gate — the off-by-default
four are the red proof. REVIEW.md's full flag list (test-coverage nits: webhook/
consumer negative-quantity, storage_gb_hour rate, /statement cross-tenant, reconcile
locator fields) stays surfaced for the engineer, deliberately not silently "fixed".

## Open / pick up next time

JWT claim shape and `JWT_SECRET` handling finalized before Phase 3 (auth hardening,
alg-pinning, `exp`, `alg:none` rejection ship in Phase 3 where auth lands, not Phase 7).
Webhook secret seeding is a Phase 4 concern. Key-reuse-different-payload resolved: 409.
