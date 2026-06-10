import pg from 'pg'
import { randomUUID } from 'node:crypto'

// The throwaway test Postgres from docker-compose.test.yml.
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

export async function newTenant(owner: pg.Pool, label = 'test tenant'): Promise<string> {
  const id = `t_${randomUUID().slice(0, 8)}`
  await owner.query('INSERT INTO tenants (tenant_id, name) VALUES ($1, $2)', [id, label])
  return id
}

// Enqueue exactly as the Phase 3 ingest API will: as app_ingest, kind
// defaulted by the column grant.
export async function enqueueUsage(
  ingest: pg.Pool,
  tenantId: string,
  opts: { metric?: string; quantity?: number; eventDate?: string; eventId?: string } = {}
): Promise<{ queueId: string; eventId: string }> {
  const eventId = opts.eventId ?? `api:${randomUUID()}`
  const payload = { metric: opts.metric ?? 'api_call', quantity: opts.quantity ?? 1 }
  const r = await ingest.query(
    `INSERT INTO event_queue (tenant_id, event_id, payload, payload_hash, event_date)
     VALUES ($1, $2, $3, 'test-hash', COALESCE($4::timestamptz, now()))
     RETURNING queue_id`,
    [tenantId, eventId, JSON.stringify(payload), opts.eventDate ?? null]
  )
  return { queueId: r.rows[0].queue_id, eventId }
}

// Park stray pending rows left by earlier test files so ORDER BY queue_id
// claims stay deterministic. 'dead', not 'done': reconcile must never
// mistake an unprocessed test row for a posted event.
export async function sweepPending(owner: pg.Pool): Promise<void> {
  await owner.query(`UPDATE event_queue SET status = 'dead' WHERE status = 'pending'`)
}
