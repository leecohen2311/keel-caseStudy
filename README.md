# Usage Metering & Billing Ledger — Case Study

Two services over an at-least-once channel: **Ingest** accepts usage events and
enqueues them; **Ledger** consumes, rates, and writes balanced double-entry
postings. Postgres is both the ledger store and the message channel, so dedup
and posting commit in one transaction. Full design: DESIGN.md (argument),
ARCHITECTURE.md (mechanism), PLAN.md (build order), REQUIREMENTS.md (grading
contract).

## Run it

```bash
docker compose up --build
```

That single command starts Postgres, applies migrations and seed (one-shot
`migrate` container), then starts both services and the browser console:

- Ingest: http://localhost:3001 (`GET /healthz`)
- Ledger: http://localhost:3002 (`GET /healthz`)
- Console (UI): http://localhost:8080

If a first boot was ever interrupted mid-initialization, reset with
`docker compose down -v` and rerun.

## Run the tests

```bash
npm install
npm test    # full suite, all green (133 tests)
```

`npm test` brings up a throwaway Postgres (port 5433, tmpfs), applies
migrations + seed, and runs the whole vitest suite — 133 tests, all green:
infra checks, schema/grant invariants (append-only, dedup boundary, tenant
binding), the consumer's crash-injection tests — a real child-process worker
SIGKILLed at four in-transaction boundaries — plus redelivery,
poison/dead-letter, closed-period reroute, two-worker concurrency, the
Phase 3 tenant API (JWT hardening, validation, request idempotency, ingest
crash hook), the Phase 4 signed webhook (forged/tampered/stale/replayed
deliveries), the Phase 5 reads (derived balance, tenant isolation,
reproducible statements), the Phase 6 admin actions (authorization,
adjustment exactly-once, one-winner concurrent close), and the Phase 7
reconciliation (tamper/deletion/symmetric-scale detection, zero false
positives under concurrent load), and the Phase 8 hardening (SIGKILL
crash hooks inside the admin transactions, NUL/unpaired-surrogate
rejection at the boundary, bounded adjustment reason), plus the Phase 9
console smoke (dev-only CORS preflight on both services, page wiring). The DEL-3
required tests are explicitly named: the "DEL-3 crash-restart test" and
"DEL-3 concurrency test" describes in `test/phase2_crash.test.ts`. The
repo was built test-first: every phase's suite was committed red before
its implementation (the commit history shows the red/green pairs).

Requires Docker and Node >= 24.

## Seeded data (dev-only credentials)

| What | Value |
|------|-------|
| Tenants | `tenant_alpha` (Alpha Corp), `tenant_beta` (Beta Industries) |
| Webhook key | `whk_alpha_meterco` / secret `whsec_dev_alpha_meterco_1` (owner: `tenant_alpha`) |
| DB roles | `app_owner` (migrations/seed), `app_ingest`, `app_ledger` — least-privilege runtime roles |
| JWT secret | `dev_jwt_secret_1` (compose env `JWT_SECRET`; HS256, pinned server-side) |

### Pre-minted JWTs (dev-only, signed with the compose `JWT_SECRET`)

Tenant scope is the verified `tenant_id` claim — never a request field. Admin
is the `admin: true` claim (no `tenant_id`); the admin routes that ship in
Phases 6-7 reject plain tenant tokens. All expire 2036-01-01.

```
# tenant_alpha
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRfaWQiOiJ0ZW5hbnRfYWxwaGEiLCJpYXQiOjE3ODExMzEzMzIsImV4cCI6MjA4Mjc1ODQwMH0.8SQyVU7HbmNa-5dRQdFYwrChit5pyy-f9kqiMETAMIY

# tenant_beta
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRfaWQiOiJ0ZW5hbnRfYmV0YSIsImlhdCI6MTc4MTEzMTMzMiwiZXhwIjoyMDgyNzU4NDAwfQ.2mCsUzJ7dkRC0cG3kaGyjnUSRrWepaqMjXYKUG2Xm6Y

# admin (admin: true, no tenant_id)
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZG1pbiI6dHJ1ZSwiaWF0IjoxNzgxMTMxMzMyLCJleHAiOjIwODI3NTg0MDB9.FZ6OTAE3EjyXl-EPy-lB52EL356UVZ0eW3haUeKaj-8
```

To mint your own (e.g. after changing the secret):

```bash
node -e "
const { createHmac } = require('node:crypto');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const iat = Math.floor(Date.now() / 1000);
const input = b64({alg:'HS256',typ:'JWT'}) + '.' + b64({tenant_id:'tenant_alpha',iat,exp:iat+86400});
console.log(input + '.' + createHmac('sha256', 'dev_jwt_secret_1').update(input).digest('base64url'));
"
```

### Submit a usage event

```bash
curl -i http://localhost:3001/events \
  -H "Authorization: Bearer <tenant_alpha JWT>" \
  -H "Content-Type: application/json" \
  -d '{"tenant":"tenant_alpha","metric":"api_call","quantity":100,"idempotency_key":"demo-1"}'
```

`202` once the queue row is durably committed; the same key + same payload
replays the 202, the same key + a different payload returns `409`. The ledger
consumer rates and posts it within ~250ms.

### Read the balance and statement

```bash
curl -s http://localhost:3002/balance \
  -H "Authorization: Bearer <tenant_alpha JWT>"
# {"balance_minor":"100"} — derived per read: SUM over the receivable postings

curl -s "http://localhost:3002/statement?period=2026-06" \
  -H "Authorization: Bearer <tenant_alpha JWT>"
# {"period":"2026-06","lines":[{txn_id, kind, metric, quantity, event_date,
#  amount_minor}...],"total_minor":"100"} — ?period defaults to the current
#  UTC month; amounts are BigInt-safe decimal strings
```

### Admin actions (require the admin JWT; tenant tokens get 403)

```bash
# Credit 250 minor units to tenant_alpha (enqueued, posted by the consumer)
curl -i http://localhost:3002/adjustments \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{"tenant":"tenant_alpha","amount_minor":-250,"idempotency_key":"adj-demo-1","reason":"goodwill credit"}'
# 202; same key + same payload replays the 202, different payload -> 409

# Close a billing period (concurrent-safe: exactly one winner)
curl -i http://localhost:3002/periods/close \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{"tenant":"tenant_alpha","period":"2026-05"}'
# 200 {"closed":true,...}; closing again -> 409. New events targeting a
# closed month reroute forward to the next open period — never lost,
# never booked into the closed month.

# Reconcile: independently re-derive state from the queue's done rows and
# flag drift (tampered/deleted/scaled postings); 200 even when flagging.
curl -s http://localhost:3002/reconcile \
  -H "Authorization: Bearer <admin JWT>" -d '{}'
# {"ok":true,"discrepancies":[]}
```

### Submit usage via the signed webhook

Headers `X-Key-Id`, `X-Timestamp` (unix seconds), `X-Signature` —
HMAC-SHA256 hex over `{timestamp}.{key_id}.{raw_body}`, algorithm pinned
server-side. The delivery id (`event_id`) lives inside the signed body; the
tenant is the owner of the verifying secret, never the body. Stale
timestamps (±5 min), forged or tampered deliveries are rejected with 401;
an identical replayed delivery is accepted (202) but charged exactly once.

```bash
BODY='{"event_id":"dlv-demo-1","metric":"api_call","quantity":5}'
TS=$(date +%s)
SIG=$(node -e "
const { createHmac } = require('node:crypto');
console.log(createHmac('sha256', 'whsec_dev_alpha_meterco_1')
  .update(process.argv[1] + '.whk_alpha_meterco.' + process.argv[2])
  .digest('hex'));
" "$TS" "$BODY")

curl -i http://localhost:3001/webhooks/usage \
  -H "X-Key-Id: whk_alpha_meterco" -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG" -d "$BODY"
```

## Try it in the browser

`docker compose up --build` also serves a console at **http://localhost:8080**
(static page under `ui/`, no build step). It is a pure client of the two
APIs — every panel shows the exact request and the live response, with the
seeded credentials prefilled. Dev conveniences, clearly not a production
posture: permissive CORS on both services — **gated behind
`ENABLE_DEV_CORS=1`, off by default, set only in `docker-compose.yml`** so
the browser console works there and the permissive headers cannot ship
anywhere by accident — and the seeded webhook secret in the page so the
browser can sign deliveries with SubtleCrypto.

Manual test checklist (one pass exercises every feature):

1. **Identity.** The `ACTING AS` switcher in the top bar selects which seeded
   JWT (from this README) every panel uses: `tenant_alpha`, `tenant_beta`, or
   `admin`.
2. **Submit usage (01).** As `tenant_alpha`, Send → `202`. Send again with the
   same key → `202` (replay, charged once — check Balance). Change the
   quantity but keep the key → `409`.
3. **Signed webhook (02).** Sign & send → `202` (the page computes the
   HMAC-SHA256 over `{timestamp}.{key_id}.{raw_body}` in-browser). "Replay
   last delivery" resends the identical bytes → `202`, but Balance/Statement
   show exactly one charge. Edit the timestamp to something stale (>5 min
   old) → `401`.
4. **Balance (03).** As `tenant_alpha`, Fetch → the derived sum. Switch to
   `tenant_beta` → that tenant's own balance (isolation). As `admin` → `401`
   (the admin token carries no `tenant_id`; reads are tenant-scoped).
5. **Statement (04).** Pick the current month → the lines you just created,
   with the total. Fetch twice — byte-identical (reproducible reads).
6. **Adjustment (05).** As `tenant_alpha` → `403` (admin only). As `admin`,
   Send a `-250` credit → `202`; Balance drops by 250 once, even if you Send
   the same key again.
7. **Close period (06).** As `admin`, close a past month (e.g. last month) →
   `200`. Close it again → `409` (immutable close). New usage for a closed
   month rolls forward to the open period — visible in Statement.
8. **Reconcile (07).** As `admin` → green "ALL CLEAR". (Drift is flagged with
   tenant/event/expected/posted rows; injecting it needs DB access — see the
   phase-7 tests.)
9. **Authorization, negative.** As `tenant_beta`, try Close period → `403`.
   Remove/garble a token in the config panel → `401`.

## Price book

Flat, integer minor units: `api_call` = 1, `storage_gb_hour` = 5.
`amount = rate[metric] * quantity`, all arithmetic in BigInt.
