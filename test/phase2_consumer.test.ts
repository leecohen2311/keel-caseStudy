import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, enqueueUsage, sweepPending } from './helpers.ts'
import {
  processOne,
  recordFailure,
  periodKeyOf,
  nextPeriodKey
} from '../src/ledger/consumer.ts'

// Phase 2 functional tests for the consumer transaction. Discipline: every
// test drains what it enqueues (processOne claims the oldest pending row,
// so a leftover would poison the next test's claim).

let owner: pg.Pool
let ingest: pg.Pool
let ledger: pg.Pool
const currentKey = periodKeyOf(new Date())

beforeAll(async () => {
  owner = makePool('owner')
  ingest = makePool('ingest')
  ledger = makePool('ledger')
  await sweepPending(owner)
})

afterAll(async () => {
  await owner.end()
  await ingest.end()
  await ledger.end()
})

async function getOrCreatePeriod(tenantId: string, key: string): Promise<string> {
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

async function closePeriod(tenantId: string, key: string): Promise<string> {
  const periodId = await getOrCreatePeriod(tenantId, key)
  await ledger.query(
    'INSERT INTO period_closures (tenant_id, period_id) VALUES ($1, $2)',
    [tenantId, periodId]
  )
  return periodId
}

async function tenantTxns(tenantId: string) {
  const r = await owner.query(
    `SELECT t.txn_id, t.kind, t.metric, t.quantity, t.originating_event_id,
            p.period_key
       FROM transactions t JOIN billing_periods p ON p.period_id = t.booked_period_id
      WHERE t.tenant_id = $1 ORDER BY t.created_at`,
    [tenantId]
  )
  return r.rows
}

async function tenantPostings(tenantId: string) {
  const r = await owner.query(
    `SELECT txn_id, account, amount_minor FROM postings
      WHERE tenant_id = $1 ORDER BY posting_id`,
    [tenantId]
  )
  return r.rows
}

async function queueRow(queueId: string) {
  const r = await owner.query(
    'SELECT status, attempts, processed_at FROM event_queue WHERE queue_id = $1',
    [queueId]
  )
  return r.rows[0]
}

describe('phase 2: the consumer transaction', () => {
  test('rates a usage event into a balanced pair booked in the current period', async () => {
    const tenantId = await newTenant(owner)
    const { queueId, eventId } = await enqueueUsage(ingest, tenantId, {
      metric: 'api_call',
      quantity: 100
    })

    expect(await processOne(ledger)).toBe('posted')

    const txns = await tenantTxns(tenantId)
    expect(txns).toHaveLength(1)
    expect(txns[0]).toMatchObject({
      kind: 'usage',
      metric: 'api_call',
      originating_event_id: eventId,
      period_key: currentKey
    })
    expect(BigInt(txns[0].quantity)).toBe(100n)

    const postings = await tenantPostings(tenantId)
    expect(postings).toHaveLength(2)
    const byAccount = Object.fromEntries(
      postings.map((p) => [p.account, BigInt(p.amount_minor)])
    )
    expect(byAccount).toEqual({ receivable: 100n, revenue: -100n })

    const q = await queueRow(queueId)
    expect(q.status).toBe('done')
    expect(q.processed_at).not.toBeNull()
  })

  test('adjustment event posts its explicit signed amount, still balanced', async () => {
    const tenantId = await newTenant(owner)
    // Enqueued as app_ledger, the only role that can set kind (Phase 6 path).
    await ledger.query(
      `INSERT INTO event_queue (tenant_id, event_id, kind, payload, payload_hash, event_date)
       VALUES ($1, $2, 'adjustment', $3, 'test-hash', now())`,
      [tenantId, `adj:${randomUUID()}`, JSON.stringify({ amount_minor: -250, reason: 'goodwill credit' })]
    )

    expect(await processOne(ledger)).toBe('posted')

    const postings = await tenantPostings(tenantId)
    const byAccount = Object.fromEntries(
      postings.map((p) => [p.account, BigInt(p.amount_minor)])
    )
    expect(byAccount).toEqual({ receivable: -250n, revenue: 250n })
  })

  test('redelivered event charges exactly once', async () => {
    const tenantId = await newTenant(owner)
    const { queueId } = await enqueueUsage(ingest, tenantId, { quantity: 9 })

    expect(await processOne(ledger)).toBe('posted')
    // The channel is at-least-once: force a redelivery of the same event.
    await owner.query(`UPDATE event_queue SET status = 'pending' WHERE queue_id = $1`, [
      queueId
    ])
    expect(await processOne(ledger)).toBe('duplicate')

    expect(await tenantTxns(tenantId)).toHaveLength(1)
    expect(await tenantPostings(tenantId)).toHaveLength(2)
    expect((await queueRow(queueId)).status).toBe('done')
  })

  test('a claimed row is invisible to a second worker', async () => {
    const tenantId = await newTenant(owner)
    await enqueueUsage(ingest, tenantId, { quantity: 3 })

    const rival = await ledger.connect()
    try {
      await rival.query('BEGIN')
      const claimed = await rival.query(
        `SELECT queue_id FROM event_queue WHERE status = 'pending'
         ORDER BY queue_id FOR UPDATE SKIP LOCKED LIMIT 1`
      )
      expect(claimed.rowCount).toBe(1)
      // Our worker sees nothing while the rival holds the claim...
      expect(await processOne(ledger)).toBe('empty')
      await rival.query('ROLLBACK')
    } finally {
      rival.release()
    }
    // ...and the row comes straight back after the rival dies.
    expect(await processOne(ledger)).toBe('posted')
    expect(await tenantTxns(tenantId)).toHaveLength(1)
  })

  test('poison event goes dead after 5 attempts and writes nothing', async () => {
    const tenantId = await newTenant(owner)
    const { queueId } = await enqueueUsage(ingest, tenantId, {
      metric: 'not_in_price_book',
      quantity: 5
    })

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await processOne(ledger)).toBe('retried')
      expect((await queueRow(queueId)).attempts).toBe(attempt)
    }
    expect(await processOne(ledger)).toBe('dead')

    const q = await queueRow(queueId)
    expect(q.status).toBe('dead')
    expect(q.attempts).toBe(5)
    expect(await tenantTxns(tenantId)).toHaveLength(0)
    expect(await tenantPostings(tenantId)).toHaveLength(0)
    expect(await processOne(ledger)).toBe('empty')
  })

  test('failure bookkeeping cannot touch a completed row', async () => {
    const tenantId = await newTenant(owner)
    const { queueId } = await enqueueUsage(ingest, tenantId, { quantity: 2 })
    expect(await processOne(ledger)).toBe('posted')

    // A crashed worker's stale failure report arrives after another worker
    // already posted the row: the status='pending' guard must make it a no-op.
    await recordFailure(ledger, queueId)
    const q = await queueRow(queueId)
    expect(q.status).toBe('done')
    expect(q.attempts).toBe(0)
  })

  test('event dated in a closed past month books into the current month', async () => {
    const tenantId = await newTenant(owner)
    await closePeriod(tenantId, '2026-05')
    await enqueueUsage(ingest, tenantId, {
      quantity: 4,
      eventDate: '2026-05-15T12:00:00Z'
    })

    expect(await processOne(ledger)).toBe('posted')
    const txns = await tenantTxns(tenantId)
    expect(txns[0].period_key).toBe(currentKey)
  })

  test('closing the current month pushes new events to the next month', async () => {
    const tenantId = await newTenant(owner)
    await closePeriod(tenantId, currentKey)
    await enqueueUsage(ingest, tenantId, { quantity: 6 })

    expect(await processOne(ledger)).toBe('posted')
    const txns = await tenantTxns(tenantId)
    expect(txns[0].period_key).toBe(nextPeriodKey(currentKey))
  })

  test('a close committing mid-reroute cannot trap the event in a closed period', async () => {
    const tenantId = await newTenant(owner)
    await closePeriod(tenantId, currentKey)
    const julKey = nextPeriodKey(currentKey)
    const julId = await getOrCreatePeriod(tenantId, julKey)
    await enqueueUsage(ingest, tenantId, { quantity: 8 })

    // A concurrent close holds FOR UPDATE on the reroute target (next month)
    // before the consumer starts; the consumer's FOR SHARE must wait, then
    // re-check the closure under its lock and advance again.
    const closer = await ledger.connect()
    try {
      await closer.query('BEGIN')
      await closer.query(
        'SELECT period_id FROM billing_periods WHERE period_id = $1 FOR UPDATE',
        [julId]
      )
      const consumerRun = processOne(ledger)
      await new Promise((r) => setTimeout(r, 200))
      await closer.query(
        'INSERT INTO period_closures (tenant_id, period_id) VALUES ($1, $2)',
        [tenantId, julId]
      )
      await closer.query('COMMIT')
      expect(await consumerRun).toBe('posted')
    } finally {
      closer.release()
    }

    const txns = await tenantTxns(tenantId)
    expect(txns[0].period_key).toBe(nextPeriodKey(julKey))
  })

  test('event_date outside the pinned window is poison, not a misbooked charge', async () => {
    const tenantId = await newTenant(owner)
    // A compromised ingest can write any event_date; the consumer must
    // re-validate against the pinned (now - 1y, now + 1d) window.
    const { queueId: futureId } = await enqueueUsage(ingest, tenantId, {
      quantity: 5,
      eventDate: '2036-06-15T00:00:00Z'
    })
    const { queueId: staleId } = await enqueueUsage(ingest, tenantId, {
      quantity: 5,
      eventDate: '2024-01-01T00:00:00Z'
    })
    for (let i = 0; i < 10; i++) await processOne(ledger)

    expect((await queueRow(futureId)).status).toBe('dead')
    expect((await queueRow(staleId)).status).toBe('dead')
    expect(await tenantTxns(tenantId)).toHaveLength(0)
    // ...and no far-future billing period was ever minted.
    const periods = await owner.query(
      'SELECT period_key FROM billing_periods WHERE tenant_id = $1',
      [tenantId]
    )
    expect(periods.rows).toEqual([])
  })

  test('adjustment beyond the magnitude bound never posts', async () => {
    const tenantId = await newTenant(owner)
    const r = await ledger.query(
      `INSERT INTO event_queue (tenant_id, event_id, kind, payload, payload_hash, event_date)
       VALUES ($1, $2, 'adjustment', $3, 'test-hash', now()) RETURNING queue_id`,
      [tenantId, `adj:${randomUUID()}`, JSON.stringify({ amount_minor: 2_000_000_000_000 })]
    )
    for (let i = 0; i < 5; i++) await processOne(ledger)
    expect((await queueRow(r.rows[0].queue_id)).status).toBe('dead')
    expect(await tenantPostings(tenantId)).toHaveLength(0)
  })

  test('header event_date mirrors the queue exactly, microseconds intact', async () => {
    const tenantId = await newTenant(owner)
    await enqueueUsage(ingest, tenantId, {
      quantity: 1,
      eventDate: '2026-06-01T10:20:30.123456Z'
    })
    expect(await processOne(ledger)).toBe('posted')
    const r = await owner.query(
      `SELECT (t.event_date = q.event_date) AS exact
         FROM transactions t
         JOIN event_queue q
           ON q.tenant_id = t.tenant_id AND q.event_id = t.originating_event_id
        WHERE t.tenant_id = $1`,
      [tenantId]
    )
    expect(r.rows).toEqual([{ exact: true }])
  })

  test('standing zero-sum invariant: no transaction nets nonzero, none is empty', async () => {
    const unbalanced = await owner.query(
      `SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(amount_minor) <> 0`
    )
    expect(unbalanced.rows).toEqual([])
    const headerless = await owner.query(
      `SELECT t.txn_id FROM transactions t
        LEFT JOIN postings p ON p.txn_id = t.txn_id
       GROUP BY t.txn_id HAVING count(p.posting_id) <> 2`
    )
    expect(headerless.rows).toEqual([])
  })
})
