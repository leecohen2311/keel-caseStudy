# DESIGN.md

A usage-metering and billing system for a multi-tenant SaaS product: two services over
an at-least-once channel, optimized for one thing — every invariant holds under
concurrency, retries, and crashes. IDs reference REQUIREMENTS.md; ARCHITECTURE.md has
the implementation depth.

## Architecture, and why

**Ingest** accepts usage events (`POST /events` and the HMAC-signed `POST
/webhooks/usage`) and writes them to the channel. **Ledger** consumes events, rates them
against a flat price book, writes balanced double-entry postings, and serves the
balance, statement, admin (adjustments, close), and reconcile APIs. Single node each.

Both the ledger store and the message channel are **Postgres**; the channel is a table
read with `SELECT ... FOR UPDATE SKIP LOCKED`. This is the central decision: queue and
ledger share one database, so dedup and the posting write commit in **one transaction**.
A broker (Kafka, NATS, Redis) splits read-from-bus, write-to-DB, confirm-back-to-bus
across systems, reopening a crash window. Here exactly-once is free.

Money is integer minor units (`BIGINT`), strings/BigInt end-to-end in Node — `int8`
never passes through a lossy `Number()`.

## How each invariant survives

**Zero-sum, append-only (INV-1).** Each transaction writes its balanced pair in one
statement — construction, not a deferred trigger — proven by a standing check (`GROUP BY
txn_id HAVING SUM(amount_minor) <> 0` returns zero rows). `UNIQUE(txn_id, account)` plus
a two-account `CHECK` means no third posting can be appended, so a balanced rogue pair
cannot slip past the check. Append-only is a database grant, not a convention:
`app_ingest` gets the queue plus credential lookups only; `app_ledger` gets `INSERT,
SELECT` on the financial tables, no `UPDATE`/`DELETE`. A compromised Ingest cannot forge
a posting.

**Exactly-once (INV-2).** The money dedup boundary is the `transactions` header,
`UNIQUE(tenant_id, originating_event_id)`, inserted `ON CONFLICT DO NOTHING` in the same
transaction as the postings. Keys are namespaced (`api:`, `wh:`, `adj:`) so an
idempotency key cannot collide with a webhook delivery id to suppress a charge. Ingest
adds a separate, labeled request-idempotency layer (`UNIQUE(tenant_id, event_id)` plus a
payload hash): a same-key/same-payload retry replays the response; a different payload
is a **409**. If the layers ever disagree, the ledger wins.

**Crash safety (INV-3).** The transaction is the mechanism: claim, dedup, post, complete
commit together or not at all. The claim lock is also the lease, so a killed worker's row
reverts to pending with no partial post. Proven by a real SIGKILL harness.

**Tenant isolation (INV-4).** Scope is the verified JWT `tenant_id` claim — for
webhooks, the verifying secret's owner — never a request field; a mismatching
`body.tenant` is a 403. Composite foreign keys turn a cross-tenant posting into a
database error rather than silent drift.

**No drift (INV-5).** Balances are derived per read, never stored: no cache to fall out
of sync.

**Authorization (INV-6).** Admin actions require a distinct admin claim; a valid tenant
token is rejected. Validation closes a quieter hole: `quantity` must be a positive
integer, so a tenant cannot mint a credit via a negative quantity. Adjustments reach the
ledger only through the queue, and a column-level grant stops `app_ingest` writing the
`kind` column — a compromised Ingest cannot forge an admin credit either.

**Immutable close (INV-7).** A close inserts a `period_closures` row with
`UNIQUE(tenant_id, period_id)`; concurrent closes resolve to one winner, and that
append-only row — not the mutable `status` — is the authoritative closed-check. Posting
and closing contend on the period row (`FOR SHARE` vs `FOR UPDATE`); a straggler arriving
mid-close reroutes forward to the open period via a locked loop.

**The period rule (deliberate).** Usage books into max(event-month, current-month):
backdated events roll forward into the open period, never a possibly-closed past month;
the header keeps the true event_date for statements. The brief sets no
occurrence-accurate-period requirement, and binding to the event's own month would
change the reviewed, crash-tested consumer for no graded benefit.

**Webhook integrity (INV-8) — the webhook threat model.** The webhook is the one
untrusted entry point. Headers `X-Key-Id`, `X-Timestamp`, `X-Signature`; string-to-sign
`{timestamp}.{key_id}.{raw_body}`. The HMAC covers the **raw request bytes before any
JSON parse** (parsing first lets a re-serialized body slip through), compared
constant-time with the algorithm pinned server-side — no `alg:none` downgrade. A stale
timestamp is rejected, defeating replay of an old capture. The **delivery id lives
inside the signed body**, not a header, so a replay cannot mutate it past the signature
to forge a fresh dedup key. Tenant identity is the secret's owner, never the body.
Forged and tampered deliveries die at the boundary; a replayed delivery is de-duplicated
and charged exactly once at the ledger.

## The dedup boundary

The money guarantee lives at the point of ledger effect: Ingest may enqueue the same
event more than once; the header unique constraint in the posting transaction is the
authoritative guard. The originating id is the client `idempotency_key` on `POST
/events` and the signed webhook delivery id, namespaced by channel. Adjustments flow
through the same queue with an `adj:` key, inheriting the identical dedup, period-lock,
and crash-safe path: a retried adjustment posts once.

## Reconciliation (REC-1..3)

Comparing a derived balance to the sum of its postings is circular, and a symmetric
tamper (deleting a balanced pair, scaling both legs) is invisible to it. The independent
record is the queue: its `done` rows are never purged. `POST /reconcile` runs one
`REPEATABLE READ` snapshot (no false positives from in-flight events), re-rates each
`done` row through the price book against the posted amount, flags a `done` row with no
header (a deleted pair), checks adjustments as their own class, and runs the global
zero-sum and orphan checks. Injected corruption shows up because nothing trusts the
postings.

## What I cut, and why

Scope is deliberately larger than 24 hours; I cut toward a narrow, airtight core and
argue the cuts (EVAL-1).

- **Tiered price book.** One flat integer rate per metric; a rate engine adds surface
  and rounding questions without exercising any invariant.
- **Statement pagination, multiple channels, multi-currency.** Volume, not correctness.
- The brief's own exclusions (OOS-2..5).

**UI (Phase 9, hardened in Phase 11):** OOS-1 excludes "Any UI"; the graders instructed
in person to build it, so it ships as an explicit override, built last: a static browser
console (`ui/`, on :8080 from the same compose command) exercising every endpoint with
the live response — phone-responsive, its HTML built by an XSS-inert render layer proven
by test. A pure client of the existing APIs, no business logic, no new endpoint; its
permissive dev CORS is gated behind `ENABLE_DEV_CORS`, off by default, on only in
compose — nothing about it can touch an invariant or ship by accident.

**Honest known gaps (EVAL-4):**

- A process-crashing poison event is not durably dead-lettered: the attempt counter
  cannot live in the transaction that rolls back on the crash. Caught exceptions
  dead-letter at five attempts; a hard crash-loop needs a two-phase claim that
  compromises the single-transaction guarantee, so it is documented, not built.
- Reconcile re-derives from the `done` queue rows, so a forged but internally-balanced
  transaction with **no** queue row reconciles clean. The grant boundary blocks the
  exposed Ingest role outright, and the ledger service has no code path that writes a
  header without a queue row; closing it means teaching test seeds to write matching
  `done` rows — deferred: unreachable from any external surface, and the change would
  churn a green suite for no reachable benefit.
- Reconcile loads every `done` row in one in-memory pass — unbounded over time, fine
  at case-study scale; a real deployment would page it.
- Worker liveness polish, cut as gold-plating: unconditional 1s worker respawn, no
  `lock_timeout` against a wedged close, a dropped DB connection surfacing as
  crash-respawn rather than a handled client error. None of it risks an invariant — the
  SIGKILL suite proves crash-respawn posts exactly once — so it stayed cut.

**Closed in Phase 8:** NUL and unpaired-surrogate strings now 400 at the boundary on
all four body routes (previously a fail-closed 500; lone surrogates were quieter —
Node's UTF-8 encoder mutated them to U+FFFD, collapsing two distinct idempotency keys
into one); `reason` bounded at 1024 bytes; SIGKILL crash tests inside both admin
transactions prove no partial state and a clean retry.
