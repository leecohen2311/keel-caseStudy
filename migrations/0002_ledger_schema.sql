-- Phase 1: the full hardened financial schema. Every invariant that can be
-- structural is structural (constraints), per the pinned contracts in
-- MEMORY.md. Grants land in 0003.

-- The message channel. UNIQUE(tenant_id, event_id) is ingest
-- request-idempotency — NOT the money guarantee (that lives on
-- transactions). 'done' rows are never purged: they are the independent
-- record reconciliation re-derives state from.
CREATE TABLE event_queue (
  queue_id     BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  event_id     TEXT NOT NULL,  -- namespaced: api:{k} | wh:{src}:{id} | adj:{k}
  kind         TEXT NOT NULL DEFAULT 'usage' CHECK (kind IN ('usage', 'adjustment')),
  payload      JSONB NOT NULL,
  payload_hash TEXT NOT NULL,  -- same key + different payload => 409 at ingest
  event_date   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dead')),
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX event_queue_pending_idx ON event_queue (queue_id) WHERE status = 'pending';

CREATE TABLE billing_periods (
  period_id  BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  period_key TEXT NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- status is a cache; the authoritative closed-check is a period_closures row.
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_key),
  UNIQUE (period_id, tenant_id)   -- composite-FK target
);

-- Append-only: a closure can never be removed, so "closed" cannot be undone.
-- UNIQUE resolves concurrent closes to exactly one winner (INV-7).
CREATE TABLE period_closures (
  tenant_id TEXT NOT NULL,
  period_id BIGINT NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_id),
  FOREIGN KEY (period_id, tenant_id) REFERENCES billing_periods(period_id, tenant_id)
);

-- Transaction header. UNIQUE(tenant_id, originating_event_id) is THE money
-- dedup boundary (INV-2): inserted ON CONFLICT DO NOTHING in the same DB
-- transaction as the postings. metric/quantity/event_date live here so
-- statements never join the runtime-mutable queue.
CREATE TABLE transactions (
  txn_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            TEXT NOT NULL REFERENCES tenants(tenant_id),
  originating_event_id TEXT NOT NULL,
  booked_period_id     BIGINT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('usage', 'adjustment')),
  metric               TEXT,
  quantity             BIGINT,
  event_date           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, originating_event_id),
  UNIQUE (txn_id, tenant_id),     -- composite-FK target
  FOREIGN KEY (booked_period_id, tenant_id) REFERENCES billing_periods(period_id, tenant_id)
);

-- Exactly one posting per account per transaction: with two legal accounts,
-- a third posting (rogue balanced pair included) is structurally impossible
-- (INV-1). The composite FK makes a cross-tenant posting an FK violation,
-- not silent drift (INV-4). Money is BIGINT minor units (INV-5).
CREATE TABLE postings (
  posting_id   BIGSERIAL PRIMARY KEY,
  txn_id       UUID NOT NULL,
  tenant_id    TEXT NOT NULL,
  account      TEXT NOT NULL CHECK (account IN ('receivable', 'revenue')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (txn_id, account),
  FOREIGN KEY (txn_id, tenant_id) REFERENCES transactions(txn_id, tenant_id)
);
