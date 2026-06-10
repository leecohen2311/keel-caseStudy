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
`migrate` container), then starts both services:

- Ingest: http://localhost:3001 (`GET /healthz`)
- Ledger: http://localhost:3002 (`GET /healthz`)

If a first boot was ever interrupted mid-initialization, reset with
`docker compose down -v` and rerun.

## Run the tests

```bash
npm install
npm test    # full suite — includes the intentionally-red TDD scaffold (see below)

# implemented phases only (all green, 64 tests):
bash scripts/test.sh test/phase0_infra.test.ts test/phase1_schema.test.ts \
  test/phase2_consumer.test.ts test/phase2_crash.test.ts test/phase-3
```

`npm test` brings up a throwaway Postgres (port 5433, tmpfs), applies
migrations + seed, and runs the whole vitest suite. The repo is built
test-first: the suites for not-yet-built phases (webhook, reads, admin
adjustments/close, reconcile — `test/phase-4..7`) are committed red on purpose
and stay red until their phase ships, so the full run currently exits failing
**by design**. The implemented-phases command above is the green gate: infra
checks, schema/grant invariants (append-only, dedup boundary, tenant binding),
the consumer's crash-injection tests — a real child-process worker SIGKILLed
at four in-transaction boundaries — plus redelivery, poison/dead-letter,
closed-period reroute, two-worker concurrency, and the Phase 3 tenant API
(JWT hardening, validation, request idempotency, ingest crash hook).

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
Phases 5-7 reject plain tenant tokens. All expire 2036-01-01.

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
consumer rates and posts it within ~250ms (`GET /balance` and the webhook
recipe ship with their phases).

## Price book

Flat, integer minor units: `api_call` = 1, `storage_gb_hour` = 5.
`amount = rate[metric] * quantity`, all arithmetic in BigInt.
