# NOTES.md

How I built this, what I handed off, and where I caught the AI before a correctness bug
reached the repo.

## How I worked

I ran this as two AI roles plus me. One AI was my co-architect and reviewer: it
pressure-tested designs against the eight invariants, sketched the consumer loop and
schema, and reviewed plans adversarially. A separate coding agent wrote the production
code. I sat between them. Nothing reached the repo before I had checked the transaction
boundaries and the test list myself.

TDD: The work is test-first. For every invariant, the proving test is written and failing
before the code that satisfies it. The invariant tests are the spec and the agent codes
to them. The build order puts the airtight core (table-backed queue, dedup, balanced
double-entry) before any API, and no phase is done while an invariant is knowingly
broken.

From Phase 3 on I ran a gate after each implementation commit: the full suite from a
clean database, a cold boot of the one-command compose stack smoke-tested with the
README credentials, a three-lens adversarial review of the phase diff (contract,
security, crash and transaction boundaries) where a skeptic agent tries to refute every
finding, and a docs-honesty check. Fixes land as their own commits and the gate re-runs
until green. The point was to catch defects while the diff was one phase wide and cheap
to fix, which it did repeatedly.

## What I delegated versus what I owned

I delegated implementation: route handlers, the migration runner, the HMAC, the test
scaffolding. I owned where correctness lives: the schema and its constraints, the exact
transaction boundaries in the consumer, the dedup key, and the role grants. Anything the
AI proposed in those areas I treated as a suggestion to verify, not an instruction to
follow.

## Where the AI was wrong and I caught it

The AI moved fast and was usually right, but it was confidently wrong in a few places
that would have corrupted the ledger. I caught these in design review, before any code
was written.

**Append-only was a comment, not a guarantee.** The design labeled the postings table
"append-only" and left it there. Nothing actually stopped an UPDATE or DELETE, and a
comment does not survive a grader injecting corruption. I moved enforcement into the
database: the runtime role gets INSERT and SELECT on the financial tables and nothing
else, while a separate owner role holds DDL and migrations. History is now physically
unrewritable by the service.

**The consumer would post into a closed period.** The loop wrote postings against a
period id without checking the period was still open, so a late event could land in a
finalized month and break immutable-close. I required an open-period check inside the
same transaction. Then I pushed further, because the obvious check has a race: read
"open," a concurrent close commits, you post anyway. The fix is a row lock. The consumer
takes FOR SHARE on the period row and a close takes FOR UPDATE, so the two serialize. A
straggler that arrives mid-close blocks, sees the period is now closed, and reroutes to
the current open period as a late charge instead of corrupting the closed one.

**The retry counter never counted.** The loop read an attempts column but never
incremented it, so a poison event would reclaim itself and fail forever, wedging the
queue. I set a max-attempts with a dead-letter status, incremented on caught transient
failures in a separate transaction (it cannot live in the one that just rolled back). I
also made us write the limit down honestly: this counts caught exceptions, not a
process-crashing event. The crash-loop case is a documented gap, not a hidden one.

**Awkward SQL where a one-liner does the job.** For zero-sum the design floated a
deferred constraint trigger checking each transaction nets to zero at commit. It is the
most exotic SQL in the project and the easiest place for the coding agent to write
something subtly wrong that still passes a happy-path test. I rejected it for
enforcement by construction: always insert the balanced pair in one statement, and prove
it on demand with one query (GROUP BY txn_id HAVING SUM(amount_minor) <> 0 must return
zero rows). Less clever, more defensible.

The catches kept coming during the build, not just at design time. One per phase from
the gates:

- **Phase 3 (tenant API).** Two majors caught live before shipping: event_date was
  validated with the JavaScript date parser but stored through the Postgres parser, so
  an input the two accepted differently turned a pinned 400 into a 500; and a bare BEGIN
  inherited the server default isolation level, silently regressing the Phase 2 locking
  fix. Both reproduced against the live database, then fixed.
- **Phase 4 (webhook).** The reviewer flagged pre-auth buffering of the raw body; the
  skeptic refuted it, since the signature covers the raw bytes so the read must precede
  verification. The agents arguing saved me from fixing correct code. Real findings were
  pin-level and we amended the pins instead of churning code.
- **Phase 5 (reads).** The compose smoke, not the suite, caught that the ledger
  container was missing JWT_SECRET, which would have 401'd every credential in the
  one-command demo. Tests green, product broken: exactly why a boot-and-poke gate
  exists.
- **Phase 8 (hardening).** A NUL byte died as the documented fail-closed 500, but an
  unpaired surrogate was quietly worse: Node's UTF-8 encoder rewrites it to U+FFFD on the
  wire, so two distinct idempotency keys collapsed into one stored key and the request
  202'd. The boundary now rejects both with a 400.
- **Phase 9 (console).** The review caught formatted numeric strings reaching innerHTML
  unescaped in the statement and reconcile tables. Server-generated by contract, but the
  console should not trust any wire value into markup.
- **Phase 11 (console hardening).** Running the red XSS suite caught its own harness:
  the loader required ui/render.js via CommonJS, but the package's type:module makes
  Node parse it as ESM, silently skipping the export guard — the suite could never have
  gone green against any implementation. Switched to evaluating the script in a vm
  context, the way a browser actually runs it; assertions untouched. The same phase
  turned "dev-only CORS" from a label into a mechanism (ENABLE_DEV_CORS, off by
  default, on only in compose) and made the console phone-usable.

The review cut both ways. The co-architect's first consumer sketch tried to insert the
posting first and swallow the unique-constraint violation, which does not work in
Postgres because a violation poisons the whole transaction. The corrected version
inserts the header with ON CONFLICT (tenant_id, originating_event_id) DO NOTHING and
branches on whether a row came back. The same pass made the dedup key per-tenant (a
global key lets one tenant's idempotency key suppress another's event) and took the
webhook's tenant identity from the verifying secret rather than a body field.

A second pass against the brief caught more before any code. My reroute path reopened the
close-race it exists to kill: it locked the event-date period but rerouted to an unlocked
one. Adjustments bypassed dedup entirely, since a NULL originating id dedups nothing, so
a retried adjustment double-posts. The shared dedup namespace was a charge-suppression
vector: a tenant who guesses a webhook delivery id can pre-post it as an idempotency key
and launder the real charge to nothing. The same pass found the API had drifted off the
brief's documented endpoints, and that the no-drift check was circular and could never
catch a symmetric tamper, which forced a real reconciliation endpoint. All fixed in
design before the baseline commit.

## Decision log

Each call had a real alternative I rejected.

- **Postgres as both ledger store and channel**, table-backed queue with SELECT ... FOR
  UPDATE SKIP LOCKED. Rejected Kafka/NATS: they cost the free exactly-once that comes
  from dedup and posting sharing one transaction. The broker flow (read the bus, write
  the DB, confirm back) leaves a gap between processes where a crash double-charges or
  loses the event.
- **Dedup at the point of ledger effect**, UNIQUE(tenant_id, originating_event_id) on the
  header. Rejected dedup at ingest: it double-charges on the at-least-once queue's
  redelivery.
- **Zero-sum by construction plus an invariant query.** Rejected the deferred trigger.
- **Append-only by database grant.** Rejected code convention.
- **Closed-period guard by row lock** (FOR SHARE / FOR UPDATE). Rejected the bare status
  check (check-then-act race) and a trigger alone (it cannot see an uncommitted
  concurrent close).
- **Late events book to the current open period.** Rejected reopening or mutating the
  closed period.
- **JWT (HS256), tenant scope from the verified claim, admin as a distinct check.**
  Rejected pulling scope from request parameters, and rejected treating "valid token" as
  "authorized for admin."
- **One flat integer rate per event type.** Rejected a tiered price book as gold-plating.
- **Adjustments flow through the queue, not a synchronous post.** One idempotency
  mechanism, uniform crash-safety. Reviewing this surfaced an auth hole, a compromised
  Ingest could enqueue a forged adjustment, which I closed with a column-level INSERT
  grant so Ingest cannot write the kind column. Rejected the synchronous post: a second
  409 path, and it left adjustments with no independent record for reconcile.

## What I had to learn

- A unique-constraint violation aborts the whole Postgres transaction, so you cannot
  insert-then-catch in one transaction. The dedup has to be ON CONFLICT DO NOTHING with a
  branch on the result. This reshaped the consumer loop.
- FOR UPDATE SKIP LOCKED doubles as a lease: a killed worker's lock drops on connection
  close and the row reverts to pending, so the table-queue needs no separate
  visibility-timeout machinery.
- pg returns BIGINT as a JavaScript string and Number() loses precision past 2^53, so
  money stays string/BigInt end-to-end. A footgun I would have hit at runtime.
- Block-reread-reroute is only correct at READ COMMITTED; REPEATABLE READ turns the same
  lock contention into serialization errors. Reconcile uses REPEATABLE READ for the
  opposite reason: a stable snapshot that avoids false positives.
- An unpaired UTF-16 surrogate survives every typeof check and is then silently rewritten
  to U+FFFD by Node on the way to Postgres, so two distinct idempotency keys can become
  one. I only learned this from the Phase 8 failing-test run, which is the argument for
  running the red tests instead of assuming what they say.

## What I cut, and the honest gaps

Cut as out of scope and argued in DESIGN.md: tiered price book, statement pagination,
multiple channels, multi-currency, worker liveness polish (supervision, lock_timeout, a
handled pg error path, all liveness-only; the SIGKILL suite proves the crash-respawn
path safe), plus the brief's own exclusions (payment processor, SSO/signup, HA,
multi-region). The UI was built last, and only because the graders asked for it in
person, overriding the brief's OOS-1. It stayed a pure client of the existing APIs: a
static console that exercises every endpoint and shows the live response, with nothing
that can touch an invariant.

Known gap I am not hiding: a process-crashing poison event is not durably dead-lettered,
because the attempt counter cannot live in the transaction that rolls back on the crash.
Caught exceptions dead-letter at five attempts; a hard crash-loop would need a two-phase
claim that I chose not to build, because it muddies the single-transaction story
everything else depends on. I would rather state that plainly than pretend the
dead-letter path covers it.