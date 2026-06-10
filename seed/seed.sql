-- Idempotent seed (API-7): two tenants and one webhook secret per source.
-- Dev-only credentials; the pre-minted JWTs ship with auth in Phase 3.
INSERT INTO tenants (tenant_id, name) VALUES
  ('tenant_alpha', 'Alpha Corp'),
  ('tenant_beta',  'Beta Industries')
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO webhook_secrets (key_id, tenant_id, secret) VALUES
  ('whk_alpha_meterco', 'tenant_alpha', 'whsec_dev_alpha_meterco_1')
ON CONFLICT (key_id) DO NOTHING;
