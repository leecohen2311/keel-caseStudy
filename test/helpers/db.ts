// DB access for the Phase 3-7 test harness. Kept separate from the Phase 0-2
// test/helpers.ts (a different agent owns that one); the two are deduped at
// merge. Connection details mirror docker-compose.test.yml exactly so both
// harnesses hit the same throwaway Postgres.
import pg from 'pg'
import { randomUUID } from 'node:crypto'

const HOST = process.env.PGHOST_TEST ?? 'localhost'
const PORT = Number(process.env.PGPORT_TEST ?? 5433)

export type Role = 'owner' | 'ingest' | 'ledger'

const PASSWORDS: Record<Role, string> = {
  owner: 'owner_pw_dev',
  ingest: 'ingest_pw_dev',
  ledger: 'ledger_pw_dev'
}

export function connStr(role: Role): string {
  return `postgres://app_${role}:${PASSWORDS[role]}@${HOST}:${PORT}/billing`
}

export function makePool(role: Role): pg.Pool {
  return new pg.Pool({ connectionString: connStr(role), max: 5 })
}

// Seeded fixtures (seed/seed.sql, applied by runMigrations in global setup).
export const SEEDED = {
  tenantAlpha: 'tenant_alpha',
  tenantBeta: 'tenant_beta',
  webhook: {
    keyId: 'whk_alpha_meterco',
    tenantId: 'tenant_alpha',
    secret: 'whsec_dev_alpha_meterco_1'
  }
} as const

// A fresh isolated tenant so one test's rows never collide with another's.
export async function newTenant(owner: pg.Pool, label = 'phase3-7 tenant'): Promise<string> {
  const id = `t_${randomUUID().slice(0, 8)}`
  await owner.query('INSERT INTO tenants (tenant_id, name) VALUES ($1, $2)', [id, label])
  return id
}

// A fresh webhook secret owned by a fresh (or given) tenant, so each webhook
// test is isolated from the shared seeded secret and from other tests' charges.
export async function newWebhookSecret(
  owner: pg.Pool,
  opts: { tenantId?: string } = {}
): Promise<{ keyId: string; secret: string; tenantId: string }> {
  const tenantId = opts.tenantId ?? (await newTenant(owner, 'webhook source tenant'))
  const keyId = `whk_${randomUUID().slice(0, 8)}`
  const secret = `whsec_${randomUUID()}`
  await owner.query(
    'INSERT INTO webhook_secrets (key_id, tenant_id, secret) VALUES ($1, $2, $3)',
    [keyId, tenantId, secret]
  )
  return { keyId, secret, tenantId }
}

// Park stray pending rows so a spawned consumer in an e2e test cannot claim
// another file's leftovers. 'dead', not 'done': reconcile must never mistake an
// unprocessed test row for a posted event.
export async function sweepPending(owner: pg.Pool): Promise<void> {
  await owner.query(`UPDATE event_queue SET status = 'dead' WHERE status = 'pending'`)
}

// event_queue rows a tenant owns, oldest first.
export async function queueRows(owner: pg.Pool, tenantId: string) {
  const r = await owner.query(
    `SELECT queue_id, event_id, kind, status, attempts, payload, payload_hash, event_date
       FROM event_queue WHERE tenant_id = $1 ORDER BY queue_id`,
    [tenantId]
  )
  return r.rows
}

export async function counts(owner: pg.Pool, tenantId: string) {
  const r = await owner.query(
    `SELECT
       (SELECT count(*)::int FROM transactions WHERE tenant_id = $1) AS txns,
       (SELECT count(*)::int FROM postings     WHERE tenant_id = $1) AS postings`,
    [tenantId]
  )
  return r.rows[0] as { txns: number; postings: number }
}

// Receivable-account sum, as BigInt, for a tenant (the derived balance, INV-5).
export async function receivable(owner: pg.Pool, tenantId: string): Promise<bigint> {
  const r = await owner.query(
    `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE account = 'receivable'), 0)::bigint AS bal
       FROM postings WHERE tenant_id = $1`,
    [tenantId]
  )
  return BigInt(r.rows[0].bal)
}
