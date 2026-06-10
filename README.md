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
npm test
```

`npm test` brings up a throwaway Postgres (port 5433, tmpfs), applies
migrations + seed, and runs the vitest suite: infra checks, schema/grant
invariants (append-only, dedup boundary, tenant binding), and the consumer's
crash-injection tests — a real child-process worker SIGKILLed at four
in-transaction boundaries — plus redelivery, poison/dead-letter, closed-period
reroute, and two-worker concurrency tests. The suite grows with each phase
(APIs, webhook, close, reconcile still to come).

Requires Docker and Node >= 24.

## Seeded data (dev-only credentials)

| What | Value |
|------|-------|
| Tenants | `tenant_alpha` (Alpha Corp), `tenant_beta` (Beta Industries) |
| Webhook key | `whk_alpha_meterco` / secret `whsec_dev_alpha_meterco_1` (owner: `tenant_alpha`) |
| DB roles | `app_owner` (migrations/seed), `app_ingest`, `app_ledger` — least-privilege runtime roles |

Pre-minted tenant/admin JWTs and sample curls ship with the API phases
(Phase 3+), and will be documented here.

## Price book

Flat, integer minor units: `api_call` = 1, `storage_gb_hour` = 5.
`amount = rate[metric] * quantity`, all arithmetic in BigInt.
