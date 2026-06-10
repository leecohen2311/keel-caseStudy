# ARCHITECTURE.md

The deep technical reference. DESIGN.md makes the argument; this document is the
mechanism: components, schema, transaction boundaries, and a line-by-line crash analysis.
REQUIREMENTS.md is the grading contract; MEMORY.md holds the pinned contracts the coding
agent must not improvise.

## 1. Components

Two services and one database.

**Ingest** is a stateless HTTP service. It authenticates the caller, validates the
event, enforces request idempotency, and writes one row to the queue table. It does no
rating. It connects as `app_ingest`, which has no grants on the financial tables, so a
compromised Ingest cannot forge a posting.

**Ledger** owns all financial logic. It runs a consumer worker that drains the queue,
rates events, and writes postings, and it serves the read, admin, and reconcile APIs. It
connects as `app_ledger`. The worker runs as a spawnable child process so the SIGKILL
crash harness is real from Phase 2.

**Postgres** is both the ledger store and the message channel. Because the queue lives
in the same database as the ledger, the claim, the dedup, and the posting write are one
transaction. There is no distributed commit and no second system to keep consistent.

```
  tenant client ──JWT, /events────────────▶  ┌─────────┐  app_ingest
  external provider ──HMAC, /webhooks/usage─▶ │ Ingest  │──INSERT──▶ event_queue
                                              └─────────┘  (UNIQUE tenant,event_id)
                                                                        │ FOR UPDATE
  tenant/admin ──JWT──▶ /balance /statement   ┌─────────┐  app_ledger   │ SKIP LOCKED
                        /adjustments /close ──▶│ Ledger  │◀── consumer ──┘
                        /reconcile             └─────────┘  one tx:
                                                   claim → reroute-lock → dedup → post → done
                                              transactions, postings,
                                              billing_periods, period_closures
```

## 2. Data model

Money is `BIGINT` minor units throughout; no float column exists. In Node, `pg` returns
`int8` as a string and `Number()` loses precision past 2^53, so amounts stay string /
`BigInt` end-to-end and all arithmetic is in `BigInt`. The runtime services connect as
restricted roles; a separate owner role runs migrations and the seed.

```sql
tenants(tenant_id PK, name, created_at)
webhook_secrets(key_id PK, tenant_id FK, secret, algo, created_at)   -- per source

event_queue(
  queue_id     BIGSERIAL PK,
  tenant_id    FK NOT NULL,
  event_id     TEXT NOT NULL,        -- namespaced: api:{k} | wh:{src}:{id} | adj:{k}
  kind         TEXT NOT NULL DEFAULT 'usage',  -- 'usage' | 'adjustment'; app_ingest cannot set this
  payload      JSONB NOT NULL,
  payload_hash TEXT NOT NULL,        -- for 409 on key reuse
  event_date   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL,        -- 'pending' | 'done' | 'dead'
  attempts     INT NOT NULL DEFAULT 0,
  created_at, processed_at,
  UNIQUE(tenant_id, event_id)        -- ingest request-idempotency (NOT the money guarantee)
)                                     -- 'done' rows are never purged (reconcile source)

transactions(                         -- header; append-only to runtime roles
  txn_id               UUID PK,
  tenant_id            FK NOT NULL,
  originating_event_id TEXT NOT NULL,
  booked_period_id     FK NOT NULL,
  kind                 TEXT NOT NULL, -- 'usage' | 'adjustment'
  metric               TEXT,          -- traceability for statements
  quantity             BIGINT,
  event_date           TIMESTAMPTZ NOT NULL,
  created_at,
  UNIQUE(tenant_id, originating_event_id),   -- THE money dedup boundary
  UNIQUE(txn_id, tenant_id),                 -- target for composite FK
  FOREIGN KEY (booked_period_id, tenant_id)
      REFERENCES billing_periods(period_id, tenant_id)
)
postings(
  posting_id   BIGSERIAL PK,
  txn_id       UUID NOT NULL,
  tenant_id    FK NOT NULL,
  account      TEXT NOT NULL CHECK (account IN ('receivable','revenue')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
  created_at,
  UNIQUE(txn_id, account),                   -- exactly one posting per account
  FOREIGN KEY (txn_id, tenant_id)
      REFERENCES transactions(txn_id, tenant_id)   -- no cross-tenant posting
)

billing_periods(
  period_id  PK, tenant_id FK NOT NULL,
  period_key TEXT NOT NULL,            -- 'YYYY-MM'
  status     TEXT NOT NULL,            -- 'open' | 'closed' (cache; closures table is truth)
  UNIQUE(tenant_id, period_key),
  UNIQUE(period_id, tenant_id)         -- target for composite FK
)
period_closures(                       -- append-only, cannot be un-closed
  tenant_id FK, period_id FK, closed_at,
  UNIQUE(tenant_id, period_id)         -- concurrent closes resolve to one winner
)
```

`UNIQUE(txn_id, account)` plus exactly-two-postings means no one can append a third
posting to an existing (possibly closed-period) transaction; a balanced rogue pair can
no longer slip past the zero-sum check. The composite FKs make a wrong-variable bug that
files tenant A's posting under tenant B a foreign-key violation rather than silent
cross-tenant drift.

### Roles and grants

```
app_owner  : full DDL, runs migrations and seed.
app_ingest : INSERT (all columns EXCEPT kind), SELECT on event_queue;  -- kind defaults to 'usage'
             SELECT on tenants, webhook_secrets. Cannot enqueue an adjustment.
app_ledger : INSERT, SELECT on transactions, postings, period_closures;
             SELECT, UPDATE(status) on billing_periods;     -- column-limited
             INSERT (incl. kind), SELECT, UPDATE on event_queue;
             SELECT on tenants, webhook_secrets.
             No UPDATE/DELETE/TRUNCATE on the financial tables.
```

Append-only is a database guarantee, not a comment. Two runtime roles, not one, so the
"a compromised service cannot rewrite history" claim is true as written: Ingest can only
enqueue, and the column-level grant on `kind` means it can only enqueue `usage` events,
never forge an admin adjustment.

### Chart of accounts

Two accounts per tenant. A usage transaction posts `debit receivable` and
`credit revenue` for the rated amount, which nets to zero. Balance is the sum over the
receivable account. An admin adjustment is the same shape: a new balanced transaction,
never an edit.

## 3. The consumer loop

One `READ COMMITTED` transaction. The block-then-reread-then-reroute protocol depends on
`READ COMMITTED`; at `REPEATABLE READ` the same pattern throws serialization errors.

```
BEGIN  (READ COMMITTED)

1.  SELECT ... FROM event_queue WHERE status='pending'
      ORDER BY queue_id FOR UPDATE SKIP LOCKED LIMIT 1;     -- claim; lock is the lease
    -- no row: COMMIT, sleep, retry

2.  -- resolve the booked period: locked reroute loop
    target_month := max(month_of(event_date), current_utc_month)
    loop:
      p := get_or_create_period(tenant, target_month)        -- ON CONFLICT DO NOTHING
      SELECT 1 FROM billing_periods WHERE period_id=p FOR SHARE;   -- lock
      if EXISTS(SELECT 1 FROM period_closures WHERE period_id=p):  -- authoritative
          target_month := target_month + 1 month; continue
      else: break                                            -- p is open under our lock

3.  INSERT INTO transactions (txn_id, tenant_id, originating_event_id,
                              booked_period_id, kind, metric, quantity, event_date)
         VALUES (..., p, kind, ...)          -- kind is 'usage' or 'adjustment'
    ON CONFLICT (tenant_id, originating_event_id) DO NOTHING
    RETURNING txn_id;

4.  IF no row returned:                  -- duplicate, already posted
        UPDATE event_queue SET status='done', processed_at=now() WHERE queue_id=$q;
        COMMIT; return;

5.  validate(payload)                    -- queue payloads are data, not trust
    amount := (kind = 'adjustment') ? payload.amount_minor   -- explicit, signed
                                     : rate(metric, quantity) -- BigInt, no rounding
    INSERT INTO postings (txn_id, tenant_id, account, amount_minor) VALUES
        ($txn, $tenant, 'receivable',  amount),
        ($txn, $tenant, 'revenue',    -amount);

6.  UPDATE event_queue SET status='done', processed_at=now() WHERE queue_id=$q;

COMMIT
```

Caught transient exception: `ROLLBACK`, then a **separate** transaction does the
bookkeeping the rolled-back one cannot, guarded so it can never clobber a row another
worker has since completed:

```sql
UPDATE event_queue
   SET attempts = attempts + 1,
       status   = CASE WHEN attempts + 1 >= 5 THEN 'dead' ELSE 'pending' END
 WHERE queue_id = $q AND status = 'pending';   -- guard
```

Serialization errors are retryable and do not count toward the dead-letter threshold.

### Why the details are what they are

- **The period is resolved and locked before the header insert** because the header
  records `booked_period_id` and the runtime role cannot patch it later.
- **The reroute is a locked loop, not a plain assignment.** An earlier version locked
  only the event-date period and then rerouted to an unlocked "current open" period,
  which reopened the exact check-then-act race the close protocol exists to kill: a
  concurrent close could close the reroute target between the read and the post. The
  loop only ever inserts while holding `FOR SHARE` on a period verified open (no closure
  row) under that lock.
- **Closure existence, not `status`, is authoritative.** `status` is runtime-mutable, so
  a single bug could flip closed to open; a `period_closures` row is append-only and
  cannot be removed.
- **The dedup header goes in before the postings** so a conflict is detected without
  poisoning the transaction (a unique violation aborts the whole Postgres transaction,
  which is why the earlier "insert posting then swallow the violation" sketch was wrong).
- **Keys are namespaced** (`api:`, `wh:`, `adj:`) so an idempotency key cannot collide
  with a webhook delivery id and suppress a legitimate charge.

## 4. Transaction boundaries and crash analysis

There is exactly one commit per event. Graders kill processes mid-flight; here is the
recovered state at each point.

| Kill point | State after recovery |
|------------|----------------------|
| Ingest dies after the queue row commits, before it returns | Client got no response and retries with the same key; `UNIQUE(tenant_id, event_id)` returns the stored response. One queued event. |
| Ingest dies before the queue row commits | No row, no response. Client retries and enqueues fresh. No loss. |
| Consumer dies after claim, before COMMIT | Transaction rolls back; the `FOR UPDATE` lock drops on connection close; the row returns to `pending`. No partial postings. Reprocessed cleanly. |
| Consumer dies after COMMIT | Header, postings, and `status='done'` committed together. A redelivery conflicts on the header and writes nothing. |
| Two workers, same `event_id` (two queue rows is impossible due to ingest UNIQUE; same row is SKIP-LOCKED) | One worker posts; the other path conflicts on the header and posts nothing. |
| Close commits between a consumer's period read and its post | Cannot happen. The consumer holds `FOR SHARE`; the close needs `FOR UPDATE` and serializes. The consumer re-checks the closure row under its lock and reroutes if needed. |
| Admin adjustment | Enqueued like any event (retry dedups on the queue), then posted by the consumer in the standard single transaction. No separate path. |
| Close dies mid-transaction | Rolls back; no `period_closures` row, period stays open; a retry resolves to one winner. |
| Two concurrent closes | Both insert into `period_closures`; `UNIQUE(tenant_id, period_id)` lets one win, the other gets the conflict. |

## 5. Period model

Each event carries `event_date` (defaulted to `now()` at ingest if absent, else validated
into `(now-1y, now+1d)`). The consumer binds the transaction to the period covering
`max(event month, current month)` if open, otherwise advances forward month by month via
the locked reroute loop, creating the target open if needed. The loop terminates at the
first not-yet-closed future month, so closing the current month pushes new same-month
events forward rather than losing them or looping.

A close is an explicit admin action that get-or-creates the period row first (an idle
period has no row to lock otherwise), takes `FOR UPDATE`, inserts the closure, and flips
the status cache. Because postings are append-only and a closed period rejects new
postings, the sum over a closed period never changes, so its statement is reproducible.
The header stores `metric`, `quantity`, and `event_date`, so statements show when usage
occurred without joining the mutable queue.

## 6. Auth and the webhook boundary

JWT, HS256, single shared secret via env with no default fallback. Rules:

1. Tenant scope is the verified `tenant_id` claim, never a request parameter. The brief's
   `POST /events` body carries `tenant`; the token is authoritative and a mismatch
   returns 403.
2. Admin is a distinct check on `/adjustments`, `/periods/close`, and `/reconcile`. A
   validly signed tenant token is rejected there.
3. The algorithm is pinned and `exp` is verified; `alg:none` and algorithm-confusion are
   rejected. (Auth hardening ships in Phase 3 with the API, not late.)

The webhook is the one untrusted entry point. Wire contract: headers `X-Key-Id`,
`X-Timestamp`, `X-Signature`; string-to-sign `{timestamp}.{key_id}.{raw_body}`;
HMAC-SHA256 with the secret for `key_id`, algorithm pinned server-side. Verification is
over the **raw bytes before any JSON parse**, with a constant-time compare, a
stale-timestamp rejection (~5 min), and a missing-signature rejection. The **delivery id
is a field inside the signed body**, so a replay cannot mutate it past the signature; the
dedup key is `wh:{source}:{event_id}`. Tenant identity is the owner of the verifying
secret, never the body. Forged or tampered deliveries are rejected at the boundary;
replayed deliveries are de-duplicated and charged exactly once at the ledger. A request
body size limit applies to the raw-body route.

Accepted risk, documented: a leaked JWT or webhook secret makes the corresponding tokens
or signatures forgeable. Acceptable for a single-node case study with no key-management
story.

## 7. Reconciliation (REC-1..3)

The earlier no-drift "check" was circular: balance is defined as the sum of postings, so
comparing balance to the sum of postings proves nothing, and a symmetric tamper (delete a
balanced pair, scale both legs) is invisible. The fix is an independent record. The
queue's `done` rows are that record, which is why they are never purged.

`POST /reconcile` (admin) runs one `REPEATABLE READ` transaction (a stable snapshot, so
in-flight `pending` events are not mistaken for drift). Per tenant it:

- re-rates each `done` queue row through the price book and compares to the posted usage
  amount for that `originating_event_id`;
- flags a `done` row with no transaction header (a deleted pair);
- checks each `done` adjustment row against its posting (posted amount equals the
  enqueued `amount_minor`, header present, exactly two postings one per account, nets to
  zero); because adjustments now flow through the queue, they have an independent record
  too, where a synchronous post would have left nothing to reconcile against;
- runs the global zero-sum (`GROUP BY txn_id HAVING SUM(amount_minor) <> 0`) and
  orphan-posting checks (the composite FK already prevents orphans).

Tests: connect as `app_owner`, tamper a posting or delete a pair, expect a flag; run
reconcile under concurrent consumer load, expect zero flags. Combined with the SIGKILL
matrix in PLAN.md Phase 8, this is the evidence the invariants hold, not just the claim.
