-- Phase 1: two-role grants. Append-only is a database guarantee, not a code
-- convention: neither runtime role can UPDATE or DELETE financial rows.

-- app_ingest: enqueue usage events and look up credentials. Nothing
-- financial. The column list excludes kind (defaults to 'usage'), so a
-- compromised Ingest cannot forge an admin adjustment.
GRANT SELECT ON tenants, webhook_secrets TO app_ingest;
GRANT SELECT ON event_queue TO app_ingest;
GRANT INSERT (tenant_id, event_id, payload, payload_hash, event_date)
  ON event_queue TO app_ingest;
GRANT USAGE ON SEQUENCE event_queue_queue_id_seq TO app_ingest;

-- app_ledger: append-only financial writes. INSERT on billing_periods is
-- required by the consumer's get-or-create reroute loop (deviation from the
-- pinned grant list, logged in MEMORY.md). Queue UPDATE is column-limited to
-- processing bookkeeping so the reconcile source of truth (payload,
-- event_id, payload_hash) is immutable to the runtime; no DELETE anywhere,
-- so 'done' rows cannot be purged.
GRANT SELECT ON tenants, webhook_secrets TO app_ledger;
GRANT INSERT, SELECT ON transactions, postings, period_closures TO app_ledger;
GRANT SELECT, INSERT ON billing_periods TO app_ledger;
GRANT UPDATE (status) ON billing_periods TO app_ledger;
GRANT SELECT, INSERT ON event_queue TO app_ledger;
GRANT UPDATE (status, attempts, processed_at) ON event_queue TO app_ledger;
GRANT USAGE ON SEQUENCE event_queue_queue_id_seq, billing_periods_period_id_seq,
  postings_posting_id_seq TO app_ledger;
