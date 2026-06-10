# NOTES.md

How I built this, what I handed off, and where I caught the AI before it put a
correctness bug in the repo.

## How I worked

I ran this as two AI roles plus me. One AI acted as my engineering co-architect and
reviewer: it pressure-tested designs against the eight invariants, sketched the
consumer loop and schema, and reviewed plans adversarially. A separate coding agent
wrote the production code. I sat between them. Nothing reached the repo before I had
checked the transaction boundaries and the test list myself.

This file is a living log: it grows as each phase lands, so the history shows the work
happening rather than a retrospective written after the fact. The discipline is
test-first (TDD). For every invariant, the proving test is written and failing before
the code that satisfies it; the invariant tests are the spec and the agent codes to
them. The build order puts the airtight core (table-backed queue, dedup, balanced
double-entry) before any API, and no phase is called done while an invariant is
knowingly broken.

## What I delegated versus what I owned

I delegated implementation: route handlers, the migration runner, the HMAC,
the test scaffolding. I owned the things where correctness lives: the database schema
and its constraints, the exact transaction boundaries in the consumer, the choice of
dedup key, and the role grants. When the agent or the co-architect proposed something
in those areas, I treated it as a suggestion to verify, not an instruction to follow.

## Where the AI was wrong and I caught it

This is the part that matters. The AI moved fast and was usually right, but it was
confidently wrong in a few places that would have corrupted the ledger. I caught
these in design review, before any code was written.

**Append-only was a comment, not a guarantee.** The consumer design labeled the
postings table "append-only" and left it at that. Nothing actually stopped an `UPDATE`
or `DELETE`. A comment does not survive a grader killing processes and injecting
corruption. I moved the enforcement into the database: the runtime role gets `INSERT`
and `SELECT` on the financial tables and nothing else, while a separate owner role
holds DDL and runs migrations. History is now physically unrewritable by the service,
not just by convention.

**The consumer would post into a closed period.** The loop wrote postings against a
period id without checking the period was still open, so a late event could land in a
finalized month and quietly break immutable-close. I required an open-period check
inside the same transaction. Then I pushed further, because the obvious check has a
race: read "open," a concurrent close commits, you post anyway. The fix is a row lock.
The consumer takes `FOR SHARE` on the period row and a close takes `FOR UPDATE`, so the
two serialize. A straggler that arrives mid-close blocks, sees the period is now
closed, and reroutes to the current open period as a late charge instead of corrupting
the closed one.

**The retry counter never counted.** The loop read an `attempts` column but never
incremented it. A poison event would reclaim itself and fail forever, wedging the
whole queue. I set a max-attempts with a dead-letter status, incremented on caught
transient failures in a separate transaction (it cannot live in the one that just
rolled back). I also made us write the limit down honestly: this counts caught
exceptions, not a process-crashing event. The crash-loop case is a documented gap, not
a hidden one.

**Awkward SQL where a one-liner does the job.** For zero-sum, the design floated a
deferred constraint trigger that checks each transaction's postings net to zero at
commit time. It is the most exotic SQL in the project and the easiest place for the
coding agent to write something subtly wrong, then have it pass a happy-path test. I
rejected it in favor of enforcement by construction: always insert the balanced pair
in one statement, and prove it on demand with a single query
(`GROUP BY txn_id HAVING SUM(amount_minor) <> 0` must return zero rows). Simpler to
explain, and the check is the proof. Less clever, more defensible.

The review cut both ways, to be fair. The co-architect's first consumer sketch was
also broken in a way I had it fix: it tried to insert the posting first and then
"swallow" the unique-constraint violation, which does not work in Postgres because a
constraint violation poisons the entire transaction. The corrected version inserts the
transaction header with `ON CONFLICT (tenant_id, originating_event_id) DO NOTHING` and
branches on whether a row came back. The same pass tightened the dedup key to be
per-tenant (a global key lets one tenant's idempotency key suppress another tenant's
event) and fixed the webhook to take its tenant identity from the verifying secret
rather than trusting a field in the request body.

A second adversarial pass, run against the brief, caught more before any code. The
reroute path I had pinned reopened the very close-race the protocol exists to kill: it
locked the event-date period but rerouted to an unlocked one. Adjustments bypassed the
dedup boundary entirely, since a NULL originating id dedups nothing, so a retried
adjustment double-posts. The shared dedup namespace was a charge-suppression vector: a
tenant who guesses a webhook delivery id can pre-post it as an idempotency key and
launder the real charge down to nothing. The same pass found the API surface had drifted
off the brief's documented endpoints, and that the no-drift check was circular and could
never catch a symmetric tamper, which is what forced a real reconciliation endpoint. All
fixed in the design before the baseline commit.

## Decision log

Each call here had a real alternative I rejected.

- **Postgres as both ledger store and message channel**, table-backed queue with
  `SELECT ... FOR UPDATE SKIP LOCKED`. Rejected Kafka/NATS: they cost the free
  exactly-once guarantee that comes from dedup and posting sharing one transaction,
  and buy nothing this system rewards. The broker flow is read from the bus, write to
  the DB, confirm back to the bus, which leaves a gap between processes where a crash
  double-charges or loses the event.
- **Dedup at the point of ledger effect**, on a `transactions` header with
  `UNIQUE(tenant_id, originating_event_id)`. Rejected dedup at ingest: it double-charges
  on queue redelivery, because the queue is at-least-once by design.
- **Zero-sum by construction plus an invariant query.** Rejected the deferred
  constraint trigger (see above).
- **Append-only by database grant.** Rejected enforcement by code convention.
- **Closed-period guard by row lock** (`FOR SHARE` / `FOR UPDATE`). Rejected the
  bare status check (it has a check-then-act race) and a trigger alone (it cannot see
  an uncommitted concurrent close).
- **Late events book to the current open period.** Rejected reopening or mutating the
  closed period, which would break immutable-close.
- **JWT (HS256) with tenant scope from the verified claim, admin as a distinct check.**
  Rejected pulling tenant scope from request parameters, and rejected treating "valid
  token" as "authorized for admin."
- **One flat integer rate per event type.** Rejected a rich tiered price book as
  gold-plating.
- **Adjustments flow through the queue, not a synchronous post.** One idempotency
  mechanism and uniform crash-safety. Reviewing this surfaced an authorization hole, a
  compromised Ingest could enqueue a forged adjustment, which I closed with a
  column-level INSERT grant so Ingest cannot write the `kind` column. Rejected the
  synchronous post: a second 409 path, and it left adjustments with no independent record
  for reconcile.

## What I had to learn

A few things I had to learn or verify rather than already know, since the brief weights
honest process.

- A unique-constraint violation aborts the entire Postgres transaction, so you cannot
  insert-then-catch inside one transaction; the dedup has to be `ON CONFLICT DO NOTHING`
  with a branch on the result. This reshaped the consumer loop.
- `FOR UPDATE SKIP LOCKED` doubles as a lease: a killed worker's lock drops on connection
  close and the row reverts to pending, so the table-queue needs no separate
  visibility-timeout machinery.
- `pg` returns `BIGINT` as a JavaScript string and `Number()` silently loses precision
  past 2^53, so money has to stay string/BigInt end-to-end. A footgun I would have hit at
  runtime.
- The block-reread-reroute pattern is only correct at `READ COMMITTED`; `REPEATABLE READ`
  turns the same lock contention into serialization errors. Reconcile deliberately uses
  `REPEATABLE READ` for the opposite reason: a stable snapshot that avoids false
  positives.

## What I cut, and the honest gaps

Cut as out of scope and argued in DESIGN.md: tiered price book, statement pagination,
multiple channels, multi-currency, plus the brief's own exclusions (payment processor,
SSO/signup, HA, multi-region). The UI is built only because the graders asked for it in
person, overriding the brief's OOS-1; it is last and cut first.

Known gap I am not hiding: a process-crashing poison event is not durably dead-lettered,
because the attempt counter cannot live in the transaction that rolls back on the crash.
Caught exceptions dead-letter at five attempts; a hard crash-loop would need a two-phase
claim that I chose not to build, because it muddies the single-transaction story
everything else depends on. I would rather state that plainly than pretend the
dead-letter path covers it.
