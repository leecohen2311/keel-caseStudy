# DESIGN.md

A usage-metering and billing system for a multi-tenant SaaS product. Two services over
an at-least-once channel. The whole design optimizes for one thing: every invariant
holds under concurrency, retries, and crashes. Requirement IDs reference REQUIREMENTS.md;
ARCHITECTURE.md has the implementation depth.

## Architecture, and why

**Ingest** accepts usage events (`POST /events` and the HMAC-signed `POST
/webhooks/usage`) and writes them to the channel. **Ledger** consumes events, rates them
against a flat price book, writes balanced double-entry postings, and serves `GET
/balance`, `GET /statement`, the admin `POST /adjustments` and `POST /periods/close`, and
`POST /reconcile`. Single node per service.

Both the ledger store and the message channel are **Postgres**. The channel is a table
read with `SELECT ... FOR UPDATE SKIP LOCKED`. This is the central decision: because the
queue and the ledger are the same database, deduplication and the posting write commit in
**one transaction**. A broker (Kafka, NATS, Redis) would split read-from-bus,
write-to-DB, confirm-back-to-bus across systems and reopen a crash window between them.
Here exactly-once is free.

Money is integer minor units (`BIGINT`), carried as strings/BigInt in Node so `int8`
never passes through a lossy `Number()`.

## How each invariant survives

**Zero-sum (INV-1).** Each transaction writes its balanced pair in one statement.
Enforced by construction, not a deferred trigger, and proven by a standing check (`GROUP
BY txn_id HAVING SUM(amount_minor) <> 0` returns zero rows). `UNIQUE(txn_id, account)`
plus a two-account `CHECK` means no third posting can be appended to an existing
transaction, so a balanced rogue pair cannot slip past the check.

**Append-only.** Enforced by database grant. Two runtime roles: `app_ingest` (queue plus
credential lookups only) and `app_ledger` (`INSERT, SELECT` on the financial tables, no
`UPDATE`/`DELETE`). A compromised Ingest cannot forge a posting.

**Exactly-once (INV-2).** The money dedup boundary is the `transactions` header,
`UNIQUE(tenant_id, originating_event_id)`, inserted `ON CONFLICT DO NOTHING` in the same
transaction as the postings. Keys are namespaced (`api:`, `wh:`, `adj:`) so an
idempotency key cannot collide with a webhook delivery id to suppress a charge. Ingest
adds a separate, labeled request-idempotency layer (`UNIQUE(tenant_id, event_id)` plus a
payload hash) that returns the original response on a same-key/same-payload retry and
**409 on a same-key/different-payload** request. If the two layers ever disagree, the
ledger is authoritative.

**Crash safety (INV-3).** The transaction is the mechanism: claim, dedup, post, complete
commit together or not at all. The `FOR UPDATE SKIP LOCKED` claim is also the lease, so a
killed worker reverts its row to pending with no partial post. Proven with a real SIGKILL
harness from Phase 2.

**Tenant isolation (INV-4).** Scope is the verified JWT `tenant_id` claim, or for
webhooks the owner of the verifying secret, never a request field; a mismatching
`body.tenant` is a 403. Composite foreign keys make a cross-tenant posting a database
error rather than silent drift.

**No drift (INV-5).** Balances are derived, never stored, so there is no cache to fall
out of sync.

**Authorization (INV-6).** Admin actions require a distinct admin check; a valid tenant
token is rejected. Input validation closes a quieter authorization hole: `quantity` must
be a positive integer, so a tenant cannot mint a credit (an admin-only action) by sending
a negative quantity. Adjustments reach the ledger only through the queue, and a
column-level grant prevents `app_ingest` from writing the `kind` column, so a compromised
Ingest cannot forge an admin credit either.

**Immutable close (INV-7).** A close inserts a `period_closures` row with
`UNIQUE(tenant_id, period_id)`; concurrent closes resolve to one winner. The authoritative
closed-check is the existence of that append-only row, not the mutable `status`. Posting
and closing contend on the period row (`FOR SHARE` vs `FOR UPDATE`), and a straggler that
arrives during or after a close reroutes forward to the current open period via a locked
loop instead of mutating the closed one.

**Webhook integrity (INV-8).** See the threat model below.

## The dedup boundary

The money guarantee lives at the point of ledger effect. Ingest may enqueue the same
event more than once and that is fine; the authoritative guard is the header unique
constraint in the posting transaction. The originating id is the client `idempotency_key`
on `POST /events` and the signed delivery id on the webhook, each namespaced by channel.
Adjustments flow through the same queue with an `adj:` key, so they inherit the identical
dedup, period-lock, and crash-safe path, and a retried adjustment posts once.

## Webhook threat model

The webhook is the one untrusted entry point, so verification is strict and ordered.
Headers are `X-Key-Id`, `X-Timestamp`, `X-Signature`; the string-to-sign is
`{timestamp}.{key_id}.{raw_body}`. The HMAC is computed over the **raw request bytes
before any JSON parse** (parsing first would let a re-serialized or normalized body slip
through), with a constant-time compare and a pinned algorithm so a caller cannot downgrade
to `alg:none`. A stale timestamp is rejected, which defeats replay of an old capture. The
**delivery id lives inside the signed body**, not a header, so a replay cannot mutate it
past the signature to forge a fresh dedup key. Tenant identity is the owner of the
verifying secret, never the body. Forged and tampered deliveries are rejected at the
boundary; a replayed delivery is de-duplicated and charged exactly once at the ledger.

## Reconciliation (REC-1..3)

Because balances are derived, comparing a balance to the sum of its postings is circular,
and a symmetric tamper (deleting a balanced pair, scaling both legs) is invisible to it.
The independent record is the queue: its `done` rows are never purged. `POST /reconcile`
runs one `REPEATABLE READ` transaction (the snapshot is what prevents false positives
from in-flight events) and per tenant re-rates each `done` queue row through the price
book, compares it to the posted amount, flags a `done` row with no header (a deleted
pair), checks adjustments as their own class, and runs the global zero-sum and orphan
checks. Corruption injected by a grader against the postings shows up because the check
does not trust the postings.

## What I cut, and why

Scope is intentionally larger than 24 hours, so I cut toward a narrow, airtight core, and
argue the cuts (EVAL-1).

- **Tiered price book.** One flat integer rate per metric. A rate engine adds surface and
  rounding questions without exercising any invariant.
- **Statement pagination, multiple channels, multi-currency.** Volume and presentation,
  not correctness.
- The brief's own exclusions: real payment processor, SSO/signup, autoscaling/HA,
  multi-region (OOS-2..5).

**UI (Phase 9):** the brief lists OOS-1 "Any UI" as out of scope; the graders instructed
in person to build it, so it is included as an explicit override, built last and read-only,
touching no invariant.

**Honest known gaps (EVAL-4):**

- A process-crashing poison event is not durably dead-lettered, because the attempt
  counter cannot live in the transaction that rolls back on the crash. Caught exceptions
  dead-letter at five attempts. Covering a hard crash-loop would need a two-phase claim
  that compromises the single-transaction guarantee the rest of the system rests on, so I
  documented it instead of building it.
- Reconcile compares postings against the independent `done` queue rows, so a forged but
  internally-balanced transaction with **no** queue row reconciles clean. This requires
  ledger-level INSERT, which the exposed Ingest role is grant-blocked from; it is not
  reachable from any external surface. Closing it would mean teaching test seeds to write
  matching `done` rows so reconcile could flag orphan transactions — deferred
  deliberately, as the grant boundary makes the gap non-reachable and the change would
  churn a green suite for no reachable benefit.

**Deferred to Phase 8 (planned hardening, not forgotten):**

- NUL or unpaired-surrogate strings pass the boundary validators and die at INSERT as a
  fail-closed 500 instead of a 400, across the body routes (pre-existing class since
  Phase 3; fail-closed: the transaction rolls back and rejects — it never corrupts).
- The adjustment `reason` field is unbounded below the 256 KiB body cap and lands
  verbatim in the never-purged queue.
- Reconcile loads every `done` row in one in-memory pass — unbounded over the system's
  life, fine at single-node case-study scale.
- No SIGKILL hook yet on the two new admin transactions (adjustment post, period close);
  both run on the same single-transaction, commit-before-response spine as the
  crash-tested usage path and inherit that guarantee — the explicit crash test lands with
  Phase 8's expanded kill matrix.
