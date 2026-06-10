import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, counts, receivable } from '../helpers/db.ts'
import { adminToken } from '../helpers/jwt.ts'
import { startLedger, type Service } from '../helpers/ledger-server.ts'
import { startWorker, stopWorker, until } from '../helpers/worker.ts'
import { postJson } from '../helpers/http.ts'

// Phase 6 end-to-end: POST /adjustments enqueues a kind='adjustment' event that
// the Phase 2 consumer posts through the SAME dedup + period-lock + reroute path
// as usage (INV-2 exactly-once, INV-1 balanced, INV-7 immutable close). The
// ledger server runs with its internal consumer disabled; an explicit worker
// drains deterministically. Stays red until Phase 2 + the admin routes are merged.

let owner: pg.Pool
let svc: Service
let adjUrl: string
let closeUrl: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  svc = await startLedger({ port: 3122 })
  adjUrl = `${svc.baseUrl}/adjustments`
  closeUrl = `${svc.baseUrl}/periods/close`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

function currentPeriodKey(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function doneCount(tenantId: string): Promise<number> {
  const r = await owner.query(
    `SELECT count(*)::int AS n FROM event_queue WHERE tenant_id = $1 AND status = 'done'`,
    [tenantId]
  )
  return r.rows[0].n
}

async function netZero(tenantId: string): Promise<bigint> {
  const r = await owner.query(
    `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS net FROM postings WHERE tenant_id = $1`,
    [tenantId]
  )
  return BigInt(r.rows[0].net)
}

async function txnPeriodKeys(tenantId: string): Promise<string[]> {
  const r = await owner.query(
    `SELECT bp.period_key FROM transactions t
       JOIN billing_periods bp ON bp.period_id = t.booked_period_id
      WHERE t.tenant_id = $1 ORDER BY t.created_at`,
    [tenantId]
  )
  return r.rows.map((x) => x.period_key as string)
}

describe('phase 6 e2e: adjustments post through the consumer', () => {
  test('a retried adjustment (same key+payload) is posted exactly once', async () => {
    const t = await newTenant(owner)
    const body = {
      tenant: t,
      amount_minor: -250,
      idempotency_key: randomUUID(),
      reason: 'goodwill credit'
    }
    const token = adminToken()
    expect((await postJson(adjUrl, body, { token })).status).toBe(202)
    expect((await postJson(adjUrl, body, { token })).status).toBe(202) // at-least-once retry

    const worker = startWorker()
    try {
      await until(async () => (await doneCount(t)) === 1, 'adjustment posted (done)')
    } finally {
      await stopWorker(worker)
    }

    expect(await counts(owner, t)).toEqual({ txns: 1, postings: 2 })
    expect(await receivable(owner, t)).toBe(-250n) // the explicit signed amount
    expect(await netZero(t)).toBe(0n)
  })

  test('an adjustment nets to zero with exactly two postings', async () => {
    const t = await newTenant(owner)
    const body = {
      tenant: t,
      amount_minor: 400,
      idempotency_key: randomUUID(),
      reason: 'manual debit'
    }
    expect((await postJson(adjUrl, body, { token: adminToken() })).status).toBe(202)

    const worker = startWorker()
    try {
      await until(async () => (await doneCount(t)) === 1, 'adjustment posted (done)')
    } finally {
      await stopWorker(worker)
    }

    expect(await counts(owner, t)).toEqual({ txns: 1, postings: 2 })
    expect(await netZero(t)).toBe(0n)
    expect(await receivable(owner, t)).toBe(400n)
  })

  test('an adjustment cannot land in a closed period; it reroutes forward', async () => {
    const t = await newTenant(owner)
    const current = currentPeriodKey()
    const token = adminToken()

    // Close the current period first.
    const closed = await postJson(closeUrl, { tenant: t, period: current }, { token })
    expect(closed.status).toBeGreaterThanOrEqual(200)
    expect(closed.status).toBeLessThan(300)

    // Now post an adjustment for that tenant; the consumer must reroute it past
    // the closed period (INV-7), exactly as it does for usage.
    const body = { tenant: t, amount_minor: 100, idempotency_key: randomUUID(), reason: 'late credit' }
    expect((await postJson(adjUrl, body, { token })).status).toBe(202)

    const worker = startWorker()
    try {
      await until(async () => (await doneCount(t)) === 1, 'adjustment posted (done)')
    } finally {
      await stopWorker(worker)
    }

    // The adjustment's event_date is stamped now() at enqueue (CONTRACT-GAPS GAP-17),
    // so it targets the (now-closed) current period and must reroute forward. Assert
    // the robust invariant — it never books into the closed period and lands in an OPEN
    // one — rather than an exact next month, which a UTC month-boundary roll could spoof.
    const periods = await txnPeriodKeys(t)
    expect(periods).toHaveLength(1)
    expect(periods[0]).not.toBe(current) // never the closed period
    const landedClosed = await owner.query(
      `SELECT EXISTS(
         SELECT 1 FROM transactions tx
           JOIN period_closures pc
             ON pc.period_id = tx.booked_period_id AND pc.tenant_id = tx.tenant_id
          WHERE tx.tenant_id = $1
       ) AS closed`,
      [t]
    )
    expect(landedClosed.rows[0].closed).toBe(false) // booked into an OPEN period
  })
})
