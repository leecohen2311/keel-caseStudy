# REQUIREMENTS.md — Case Study Requirements

Extracted from the official brief ("Distributed Usage Metering and Billing Ledger",
Argonav, June 2026 PDF). This is the grading contract. Every requirement carries an ID
so PLAN.md phases and tests can reference them. Nothing here is interpretation; where
the brief leaves a choice, that is noted as a choice.

**Framing from the brief:** Role is Head of Engineering. 24 hours from receipt. Scope
is intentionally larger than the time allows — they expect deliberate triage, not
completeness. "A narrow, crash-safe, exactly-once core with an honest list of what you
deferred beats a feature-complete system that corrupts under load." Correctness and
security are weighted far above feature count. The submission will undergo adversarial
correctness, concurrency, and fault-injection testing. How you work (heavy AI-agent
use) is evaluated alongside what you ship.

---

## 1. System shape

| ID | Requirement |
|----|-------------|
| SYS-1 | A usage metering and billing system for a **multi-tenant SaaS** product. |
| SYS-2 | Split into **two independently running services** (Ingest, Ledger). |
| SYS-3 | Services communicate over an **at-least-once message channel**. Channel is your choice: table-backed queue, Redis, NATS, or Kafka. |
| SYS-4 | The channel **must redeliver on failure**, and you should assume it will. |
| SYS-5 | **Ingest**: accepts usage events from tenants and from an external usage provider via webhook, then publishes them onto the channel. |
| SYS-6 | **Ledger**: consumes events, rates them, and writes balanced double-entry postings; serves balances and statements. |
| SYS-7 | Single node per service. "Distributed" means across the two services and the channel, not across machines. |

## 2. API surface

The brief: "Endpoints are small on purpose. Depth is the point."

### Ingest service

| ID | Endpoint | Requirement |
|----|----------|-------------|
| API-1 | `POST /events` | Tenant-authenticated usage event. Documented payload: `{tenant, metric, quantity, idempotency_key}`. |
| API-2 | `POST /webhooks/usage` | Usage from external provider, HMAC-signed. Verify signatures, reject tampered or replayed deliveries, tolerate retries. |

### Ledger service

| ID | Endpoint | Requirement |
|----|----------|-------------|
| API-3 | `GET /balance` | Tenant-scoped read. |
| API-4 | `GET /statement` | Tenant-scoped read. |
| API-5 | `POST /adjustments` | Credit or manual adjustment. **Admin only.** |
| API-6 | `POST /periods/close` | Finalize a billing period **for a tenant**. **Safe under concurrent invocation.** |

### Seeding and rating

| ID | Requirement |
|----|-------------|
| API-7 | Pre-seed **two or three tenants plus one admin credential**; no need to build signup. |
| API-8 | Define a **simple price book** for rating. |

## 3. Invariants

"These invariants must hold under concurrency, retries, and crashes."

| ID | Invariant | Requirement |
|----|-----------|-------------|
| INV-1 | Zero sum | Every transaction's postings net to zero; the ledger is append-only and never edited in place. |
| INV-2 | Exactly once | Because the channel is at-least-once, the same usage event — redelivered by the queue, retried by a client, or replayed by the webhook caller — must produce its charge **exactly once**. Define and defend your dedup boundary. |
| INV-3 | Crash safety | If either service is killed at any point mid-processing and restarted, every invariant still holds. No lost events, no double posts, no partially applied transactions, no orphaned state. **They will test this by killing processes mid-run.** |
| INV-4 | Tenant isolation | No tenant can read or affect another's data, ever. |
| INV-5 | No drift | Any derived balance equals the sum of its underlying postings. Money is exact **integer minor units**; no floating point. |
| INV-6 | Authorization | Privileged actions require **elevated** authorization, not merely a valid tenant token. |
| INV-7 | Immutable close | A closed period cannot be re-closed or mutated; concurrent close attempts resolve to a single close. |
| INV-8 | Webhook integrity | The webhook boundary rejects forged, tampered, and replayed deliveries. |

## 4. Reconciliation (its own required section in the brief)

| ID | Requirement |
|----|-------------|
| REC-1 | A **background process or a `POST /reconcile` admin endpoint** that independently re-derives each tenant's balance from the postings and flags any drift between expected and recorded state. |
| REC-2 | It must **detect real corruption**. **They will inject corruption and watch whether it catches it.** |
| REC-3 | It must **not raise false positives during normal concurrent operation**. |

## 5. Deliverables (all REQUIRED)

| ID | Deliverable | Requirement |
|----|-------------|-------------|
| DEL-1 | Git repository | **Full history preserved. Do not squash. They will read the commit history.** |
| DEL-2 | Docker compose | Both services runnable with **one documented command**. |
| DEL-3 | Automated tests | Tests for the invariants, including **at least one crash-restart test and one concurrency test**. |
| DEL-4 | DESIGN.md | **Three pages or fewer**, covering: (a) architecture and why; (b) how each invariant survives concurrency, retries, and crash; (c) the exactly-once dedup design and its boundary; (d) threat model for the webhook; (e) an explicit "what I cut and why under the time limit" section. |
| DEL-5 | NOTES.md | Short: (a) how you worked; (b) what you delegated to agents; (c) **where you had to learn something new**; (d) where the agents led you wrong and you caught it. |

## 6. Out of scope — DO NOT BUILD

| ID | Excluded |
|----|----------|
| OOS-1 | **Any UI.** |
| OOS-2 | Real payment processor integration. |
| OOS-3 | SSO or signup. |
| OOS-4 | Autoscaling or HA. |
| OOS-5 | Multi-region, cloud deploy. |

## 7. Evaluation criteria (verbatim themes)

| ID | Criterion |
|----|-----------|
| EVAL-1 | Deliberate triage over completeness; argue your cuts. |
| EVAL-2 | Correctness and security weighted far above feature count. |
| EVAL-3 | Adversarial correctness, concurrency, and fault-injection testing will be run against the submission. |
| EVAL-4 | An honest note in DESIGN.md about a known gap is worth more than a hidden one. |
| EVAL-5 | How you build (agent workflow, what you delegated, what you caught) is part of the evaluation (see DEL-5). |
| EVAL-6 | Any stack you are fluent in. |
