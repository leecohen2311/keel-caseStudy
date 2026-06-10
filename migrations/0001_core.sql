-- Phase 0 core: tenants and webhook secrets, enough for the seed (API-7).
-- The financial schema and role grants land in Phase 1.
CREATE TABLE tenants (
  tenant_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_secrets (
  key_id     TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  secret     TEXT NOT NULL,
  algo       TEXT NOT NULL DEFAULT 'hmac-sha256',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
