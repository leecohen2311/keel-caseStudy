import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool } from './helpers.ts'

// Phase 1: the invariants must be structural — enforced by the database
// against the runtime roles — before any business logic exists.

let owner: pg.Pool
let ingest: pg.Pool
let ledger: pg.Pool
let tenantId: string

beforeAll(async () => {
  owner = makePool('owner')
  ingest = makePool('ingest')
  ledger = makePool('ledger')
  tenantId = `t_${randomUUID().slice(0, 8)}`
  await owner.query('INSERT INTO tenants (tenant_id, name) VALUES ($1, $2)', [
    tenantId,
    'Phase 1 tenant'
  ])
})

afterAll(async () => {
  // This file deliberately writes constraint-probe debris (bare headers with
  // no postings, dangling closures). Remove it as owner so the global
  // standing invariant checks in later phases run over real data only.
  for (const table of [
    'postings',
    'transactions',
    'period_closures',
    'billing_periods',
    'event_queue',
    'tenants'
  ]) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId])
  }
  await owner.end()
  await ingest.end()
  await ledger.end()
})

// All as app_ledger, exactly as the Phase 2 consumer will work.
async function createPeriod(key = '2026-06'): Promise<string> {
  await ledger.query(
    `INSERT INTO billing_periods (tenant_id, period_key)
     VALUES ($1, $2) ON CONFLICT (tenant_id, period_key) DO NOTHING`,
    [tenantId, key]
  )
  const r = await ledger.query(
    'SELECT period_id FROM billing_periods WHERE tenant_id = $1 AND period_key = $2',
    [tenantId, key]
  )
  return r.rows[0].period_id
}

async function createTxn(periodId: string): Promise<string> {
  const r = await ledger.query(
    `INSERT INTO transactions
       (tenant_id, originating_event_id, booked_period_id, kind, metric, quantity, event_date)
     VALUES ($1, $2, $3, 'usage', 'api_call', 10, now())
     RETURNING txn_id`,
    [tenantId, `api:${randomUUID()}`, periodId]
  )
  return r.rows[0].txn_id
}

async function createBalancedPair(txnId: string): Promise<void> {
  await ledger.query(
    `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
     VALUES ($1, $2, 'receivable', 10), ($1, $2, 'revenue', -10)`,
    [txnId, tenantId]
  )
}

describe('phase 1: schema and grant invariants', () => {
  test('money is integer: no float/numeric column anywhere, amounts are bigint', async () => {
    const floats = await owner.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('real', 'double precision', 'numeric', 'money')`
    )
    expect(floats.rows).toEqual([])

    const amounts = await owner.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('amount_minor', 'quantity')`
    )
    expect(amounts.rows.length).toBeGreaterThanOrEqual(2)
    for (const row of amounts.rows) expect(row.data_type).toBe('bigint')
  })

  test('append-only: app_ledger cannot UPDATE or DELETE financial rows', async () => {
    const periodId = await createPeriod()
    const txnId = await createTxn(periodId)
    await createBalancedPair(txnId)

    await expect(
      ledger.query('UPDATE postings SET amount_minor = 999 WHERE txn_id = $1', [txnId])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query('DELETE FROM postings WHERE txn_id = $1', [txnId])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query('UPDATE transactions SET quantity = 999 WHERE txn_id = $1', [txnId])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query('DELETE FROM transactions WHERE txn_id = $1', [txnId])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query('UPDATE period_closures SET closed_at = now()')
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query('DELETE FROM period_closures')
    ).rejects.toMatchObject({ code: '42501' })
  })

  test('app_ingest has no grants on the financial tables', async () => {
    for (const sql of [
      'SELECT * FROM transactions LIMIT 1',
      'SELECT * FROM postings LIMIT 1',
      'SELECT * FROM billing_periods LIMIT 1',
      'SELECT * FROM period_closures LIMIT 1',
      `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
       VALUES (gen_random_uuid(), 'tenant_alpha', 'receivable', 1)`
    ]) {
      await expect(ingest.query(sql)).rejects.toMatchObject({ code: '42501' })
    }
  })

  test('app_ingest cannot set kind: column denied, defaults to usage', async () => {
    const eventId = `api:${randomUUID()}`
    await expect(
      ingest.query(
        `INSERT INTO event_queue (tenant_id, event_id, kind, payload, payload_hash, event_date)
         VALUES ($1, $2, 'adjustment', '{}', 'h', now())`,
        [tenantId, eventId]
      )
    ).rejects.toMatchObject({ code: '42501' })

    await ingest.query(
      `INSERT INTO event_queue (tenant_id, event_id, payload, payload_hash, event_date)
       VALUES ($1, $2, '{}', 'h', now())`,
      [tenantId, eventId]
    )
    const r = await ingest.query(
      'SELECT kind, status, attempts FROM event_queue WHERE tenant_id = $1 AND event_id = $2',
      [tenantId, eventId]
    )
    expect(r.rows[0]).toMatchObject({ kind: 'usage', status: 'pending', attempts: 0 })
  })

  test('app_ingest cannot mutate the queue at all', async () => {
    await expect(
      ingest.query(`UPDATE event_queue SET status = 'done' WHERE tenant_id = $1`, [tenantId])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ingest.query('DELETE FROM event_queue WHERE tenant_id = $1', [tenantId])
    ).rejects.toMatchObject({ code: '42501' })
  })

  test('queue request-idempotency: duplicate (tenant_id, event_id) rejected', async () => {
    const eventId = `api:${randomUUID()}`
    const insert = `INSERT INTO event_queue (tenant_id, event_id, payload, payload_hash, event_date)
                    VALUES ($1, $2, '{}', 'h', now())`
    await ingest.query(insert, [tenantId, eventId])
    await expect(ingest.query(insert, [tenantId, eventId])).rejects.toMatchObject({
      code: '23505'
    })
  })

  test('a third posting on a transaction is structurally impossible', async () => {
    const periodId = await createPeriod()
    const txnId = await createTxn(periodId)
    await createBalancedPair(txnId)

    // Same account again: unique violation.
    await expect(
      ledger.query(
        `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
         VALUES ($1, $2, 'receivable', 5)`,
        [txnId, tenantId]
      )
    ).rejects.toMatchObject({ code: '23505' })
    // Invented account: CHECK violation.
    await expect(
      ledger.query(
        `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
         VALUES ($1, $2, 'slush_fund', 5)`,
        [txnId, tenantId]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  test('zero-amount posting rejected', async () => {
    const periodId = await createPeriod()
    const txnId = await createTxn(periodId)
    await expect(
      ledger.query(
        `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
         VALUES ($1, $2, 'receivable', 0)`,
        [txnId, tenantId]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  test('money dedup boundary: duplicate (tenant_id, originating_event_id) rejected', async () => {
    const periodId = await createPeriod()
    const eventId = `api:${randomUUID()}`
    const insert = `INSERT INTO transactions
        (tenant_id, originating_event_id, booked_period_id, kind, event_date)
      VALUES ($1, $2, $3, 'usage', now())`
    await ledger.query(insert, [tenantId, eventId, periodId])
    await expect(ledger.query(insert, [tenantId, eventId, periodId])).rejects.toMatchObject({
      code: '23505'
    })
  })

  test('tenant binding: posting under the wrong tenant is an FK violation', async () => {
    const periodId = await createPeriod()
    const txnId = await createTxn(periodId)
    await expect(
      ledger.query(
        `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
         VALUES ($1, 'tenant_alpha', 'receivable', 5)`,
        [txnId]
      )
    ).rejects.toMatchObject({ code: '23503' })
  })

  test('app_ledger billing_periods UPDATE is column-limited to status', async () => {
    const periodId = await createPeriod()
    await expect(
      ledger.query(`UPDATE billing_periods SET period_key = '1999-01' WHERE period_id = $1`, [
        periodId
      ])
    ).rejects.toMatchObject({ code: '42501' })
    const r = await ledger.query(
      `UPDATE billing_periods SET status = 'closed' WHERE period_id = $1`,
      [periodId]
    )
    expect(r.rowCount).toBe(1)
    await ledger.query(`UPDATE billing_periods SET status = 'open' WHERE period_id = $1`, [
      periodId
    ])
  })

  test('app_ledger can take the row locks the consumer depends on', async () => {
    // Both locks need an UPDATE privilege in Postgres, so these only work
    // because of the column-limited UPDATE grants — load-bearing, not vacuous.
    const periodId = await createPeriod()
    const client = await ledger.connect()
    try {
      await client.query('BEGIN')
      const period = await client.query(
        'SELECT period_id FROM billing_periods WHERE period_id = $1 FOR SHARE',
        [periodId]
      )
      expect(period.rowCount).toBe(1)
      // The consumer's claim lease on the queue.
      await client.query(
        `SELECT queue_id FROM event_queue WHERE status = 'pending'
         ORDER BY queue_id FOR UPDATE SKIP LOCKED LIMIT 1`
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  test('immutable close foundation: duplicate period_closures rejected', async () => {
    const periodId = await createPeriod('2026-01')
    const insert = `INSERT INTO period_closures (tenant_id, period_id) VALUES ($1, $2)`
    await ledger.query(insert, [tenantId, periodId])
    await expect(ledger.query(insert, [tenantId, periodId])).rejects.toMatchObject({
      code: '23505'
    })
  })

  test('queue is tamper-proof to app_ledger: payload immutable, no purge', async () => {
    // Ledger may enqueue adjustments (Phase 6 path) ...
    const eventId = `adj:${randomUUID()}`
    await ledger.query(
      `INSERT INTO event_queue (tenant_id, event_id, kind, payload, payload_hash, event_date)
       VALUES ($1, $2, 'adjustment', '{"amount_minor": -100}', 'h', now())`,
      [tenantId, eventId]
    )
    // ... and flip processing bookkeeping ...
    await ledger.query(
      `UPDATE event_queue SET status = 'done', processed_at = now()
       WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, eventId]
    )
    // ... but the reconcile source of truth is immutable to it:
    await expect(
      ledger.query(`UPDATE event_queue SET payload = '{}' WHERE tenant_id = $1`, [tenantId])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query(`UPDATE event_queue SET event_id = 'forged' WHERE tenant_id = $1`, [
        tenantId
      ])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      ledger.query('DELETE FROM event_queue WHERE tenant_id = $1', [tenantId])
    ).rejects.toMatchObject({ code: '42501' })
  })
})
