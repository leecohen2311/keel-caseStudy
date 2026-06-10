import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending } from '../helpers/db.ts'
import { adminToken, tenantToken } from '../helpers/jwt.ts'
import { startLedger, type Service } from '../helpers/ledger-server.ts'
import { postJson } from '../helpers/http.ts'

// Phase 7 — POST /reconcile (admin) independently re-derives state from the
// queue's `done` rows and flags injected corruption (REC-1..3). The queue is an
// INDEPENDENT record of the postings, so a symmetric tamper that still nets to
// zero is caught by re-rating, not just by the zero-sum check. Tests seed a
// CONSISTENT ledger (a `done` queue row plus its matching header + balanced
// pair), then inject corruption as app_owner and expect a flag — and expect a
// clean ledger to reconcile silently. Response shape assumed (CONTRACT-GAPS
// GAP-18): 200 with { ok: boolean, discrepancies: [...] }. RED until the route
// exists (today: 404).

let owner: pg.Pool
let svc: Service
let url: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  svc = await startLedger({ port: 3171 })
  url = `${svc.baseUrl}/reconcile`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

function currentPeriodKey(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function periodId(tenantId: string, periodKey: string): Promise<string> {
  await owner.query(
    `INSERT INTO billing_periods (tenant_id, period_key) VALUES ($1, $2)
     ON CONFLICT (tenant_id, period_key) DO NOTHING`,
    [tenantId, periodKey]
  )
  const r = await owner.query(
    'SELECT period_id FROM billing_periods WHERE tenant_id = $1 AND period_key = $2',
    [tenantId, periodKey]
  )
  return r.rows[0].period_id
}

// A CONSISTENT usage record: a `done` queue row {api_call, q} (rate 1 => amount q)
// plus the matching header (originating_event_id = the queue event_id) and a
// balanced pair. Reconcile re-rates the queue row and must match the posting.
async function seedConsistentUsage(
  tenantId: string,
  q: number,
  periodKey = currentPeriodKey()
): Promise<{ txnId: string; eventId: string }> {
  const p = await periodId(tenantId, periodKey)
  const eventId = `api:recon-${randomUUID()}`
  await owner.query(
    `INSERT INTO event_queue
       (tenant_id, event_id, kind, payload, payload_hash, event_date, status, processed_at)
     VALUES ($1, $2, 'usage', $3, 'h', now(), 'done', now())`,
    [tenantId, eventId, JSON.stringify({ metric: 'api_call', quantity: q })]
  )
  const txn = (
    await owner.query(
      `INSERT INTO transactions
         (tenant_id, originating_event_id, booked_period_id, kind, metric, quantity, event_date)
       VALUES ($1, $2, $3, 'usage', 'api_call', $4, now()) RETURNING txn_id`,
      [tenantId, eventId, p, q]
    )
  ).rows[0].txn_id
  await owner.query(
    `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
     VALUES ($1, $2, 'receivable', $3), ($1, $2, 'revenue', $4)`,
    [txn, tenantId, q, -q]
  )
  return { txnId: txn, eventId }
}

// A CONSISTENT adjustment record: a `done` queue row {amount_minor: A} plus the
// matching header and balanced pair. Reconcile compares the posted amount to the
// enqueued amount_minor.
async function seedConsistentAdjustment(
  tenantId: string,
  amountMinor: number,
  periodKey = currentPeriodKey()
): Promise<{ txnId: string; eventId: string }> {
  const p = await periodId(tenantId, periodKey)
  const eventId = `adj:recon-${randomUUID()}`
  await owner.query(
    `INSERT INTO event_queue
       (tenant_id, event_id, kind, payload, payload_hash, event_date, status, processed_at)
     VALUES ($1, $2, 'adjustment', $3, 'h', now(), 'done', now())`,
    [tenantId, eventId, JSON.stringify({ amount_minor: amountMinor, reason: 'seed adj' })]
  )
  const txn = (
    await owner.query(
      `INSERT INTO transactions
         (tenant_id, originating_event_id, booked_period_id, kind, event_date)
       VALUES ($1, $2, $3, 'adjustment', now()) RETURNING txn_id`,
      [tenantId, eventId, p]
    )
  ).rows[0].txn_id
  await owner.query(
    `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
     VALUES ($1, $2, 'receivable', $3), ($1, $2, 'revenue', $4)`,
    [txn, tenantId, amountMinor, -amountMinor]
  )
  return { txnId: txn, eventId }
}

// Reconcile re-derives EVERY tenant globally, so a corruption test must not leak
// its injected damage into later tests' (or other files') reconcile calls.
async function wipeTenant(tenantId: string): Promise<void> {
  await owner.query('DELETE FROM postings WHERE tenant_id = $1', [tenantId])
  await owner.query('DELETE FROM transactions WHERE tenant_id = $1', [tenantId])
  await owner.query('DELETE FROM event_queue WHERE tenant_id = $1', [tenantId])
}

function reconcile() {
  return postJson(url, {}, { token: adminToken() })
}

describe('phase 7: /reconcile authorization (INV-6)', () => {
  test('a tenant token -> 403', async () => {
    const t = await newTenant(owner)
    expect((await postJson(url, {}, { token: tenantToken(t) })).status).toBe(403)
  })

  test('no token -> 401', async () => {
    expect((await postJson(url, {})).status).toBe(401)
  })
})

describe('phase 7: /reconcile detects injected corruption (REC-2)', () => {
  test('a clean, consistent ledger reconciles with no discrepancies (REC-3 baseline)', async () => {
    const t = await newTenant(owner)
    await seedConsistentUsage(t, 100)
    await seedConsistentUsage(t, 250)
    await seedConsistentAdjustment(t, -75)

    const res = await reconcile()
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  test('a tampered posting is flagged', async () => {
    const t = await newTenant(owner)
    const { txnId } = await seedConsistentUsage(t, 100)
    // Inflate one leg: now posted (101) != re-rated (100), and zero-sum breaks too.
    await owner.query(
      `UPDATE postings SET amount_minor = 101 WHERE txn_id = $1 AND account = 'receivable'`,
      [txnId]
    )

    const res = await reconcile()
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(false)
    await wipeTenant(t) // global reconcile: don't leak this corruption to other tests
  })

  test('a deleted balanced pair is flagged (a done row with no header)', async () => {
    const t = await newTenant(owner)
    const { txnId } = await seedConsistentUsage(t, 100)
    // Remove the whole transaction; the `done` queue row is now orphaned.
    await owner.query('DELETE FROM postings WHERE txn_id = $1', [txnId])
    await owner.query('DELETE FROM transactions WHERE txn_id = $1', [txnId])

    const res = await reconcile()
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(false)
    await wipeTenant(t) // global reconcile: don't leak this corruption to other tests
  })

  test('a symmetric scaling of both legs is flagged (zero-sum still holds)', async () => {
    const t = await newTenant(owner)
    const { txnId } = await seedConsistentUsage(t, 100)
    // Double both legs: nets to zero (fools zero-sum), but posted 200 != re-rated 100.
    await owner.query(
      `UPDATE postings SET amount_minor = amount_minor * 2 WHERE txn_id = $1`,
      [txnId]
    )
    // Sanity: the tamper is invisible to a pure zero-sum check.
    const net = await owner.query(
      'SELECT COALESCE(SUM(amount_minor),0)::bigint AS n FROM postings WHERE txn_id = $1',
      [txnId]
    )
    expect(BigInt(net.rows[0].n)).toBe(0n)

    const res = await reconcile()
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(false)
    await wipeTenant(t) // global reconcile: don't leak this corruption to other tests
  })

  test('an adjustment whose posted amount != enqueued amount_minor is flagged', async () => {
    const t = await newTenant(owner)
    const { txnId } = await seedConsistentAdjustment(t, 300)
    // Symmetric scale: zero-sum holds, but posted 600 != enqueued amount_minor 300.
    await owner.query(
      `UPDATE postings SET amount_minor = amount_minor * 2 WHERE txn_id = $1`,
      [txnId]
    )

    const res = await reconcile()
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(false)
    await wipeTenant(t) // global reconcile: don't leak this corruption to other tests
  })
})
