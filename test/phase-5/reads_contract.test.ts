import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, receivable } from '../helpers/db.ts'
import { tenantToken } from '../helpers/jwt.ts'
import { startLedger, type Service } from '../helpers/ledger-server.ts'
import { getJson } from '../helpers/http.ts'

// Phase 5 — Ledger read APIs: GET /balance, GET /statement (INV-5 no drift,
// INV-4 tenant isolation). Balance is DERIVED (SUM over the receivable account),
// never stored. Reads are scoped to the token tenant; there is no tenant request
// parameter. Tests seed balanced postings directly as app_owner, then assert the
// API re-derives them. Response body shapes are unpinned (CONTRACT-GAPS GAP-15,
// GAP-16); balance assertions read `balance_minor`, statement tests are
// shape-agnostic (stable across reads, default == explicit current period).
// RED until the read routes exist (today: 404).

let owner: pg.Pool
let svc: Service
let balanceUrl: string
let statementUrl: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  svc = await startLedger({ port: 3131 })
  balanceUrl = `${svc.baseUrl}/balance`
  statementUrl = `${svc.baseUrl}/statement`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

function currentPeriodKey(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// Seed one balanced usage transaction (debit receivable / credit revenue) for a
// tenant in a given period, as app_owner — the read API must re-derive this.
async function seedUsage(tenantId: string, amountMinor: number, periodKey: string): Promise<void> {
  await owner.query(
    `INSERT INTO billing_periods (tenant_id, period_key) VALUES ($1, $2)
     ON CONFLICT (tenant_id, period_key) DO NOTHING`,
    [tenantId, periodKey]
  )
  const p = (
    await owner.query(
      'SELECT period_id FROM billing_periods WHERE tenant_id = $1 AND period_key = $2',
      [tenantId, periodKey]
    )
  ).rows[0].period_id
  const txn = (
    await owner.query(
      `INSERT INTO transactions
         (tenant_id, originating_event_id, booked_period_id, kind, metric, quantity, event_date)
       VALUES ($1, $2, $3, 'usage', 'api_call', $4, now()) RETURNING txn_id`,
      [tenantId, `seed:${randomUUID()}`, p, amountMinor]
    )
  ).rows[0].txn_id
  await owner.query(
    `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
     VALUES ($1, $2, 'receivable', $3), ($1, $2, 'revenue', $4)`,
    [txn, tenantId, amountMinor, -amountMinor]
  )
}

async function closePeriodDirect(tenantId: string, periodKey: string): Promise<void> {
  await owner.query(
    `INSERT INTO billing_periods (tenant_id, period_key, status) VALUES ($1, $2, 'closed')
     ON CONFLICT (tenant_id, period_key) DO UPDATE SET status = 'closed'`,
    [tenantId, periodKey]
  )
  const p = (
    await owner.query(
      'SELECT period_id FROM billing_periods WHERE tenant_id = $1 AND period_key = $2',
      [tenantId, periodKey]
    )
  ).rows[0].period_id
  await owner.query(
    `INSERT INTO period_closures (tenant_id, period_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, period_id) DO NOTHING`,
    [tenantId, p]
  )
}

describe('phase 5: GET /balance (INV-5, INV-4)', () => {
  test('requires auth -> 401', async () => {
    expect((await getJson(balanceUrl)).status).toBe(401)
  })

  test('balance equals SUM(postings) over the receivable account', async () => {
    const t = await newTenant(owner)
    const period = currentPeriodKey()
    await seedUsage(t, 100, period)
    await seedUsage(t, 250, period)
    await seedUsage(t, 30, period)

    const res = await getJson(balanceUrl, { token: tenantToken(t) })
    expect(res.status).toBe(200)
    const expected = await receivable(owner, t) // 380
    expect(expected).toBe(380n)
    expect(BigInt((res.body as { balance_minor: string }).balance_minor)).toBe(expected)
  })

  test('cross-tenant isolation: balance reflects only the token tenant', async () => {
    const a = await newTenant(owner)
    const b = await newTenant(owner)
    const period = currentPeriodKey()
    await seedUsage(a, 70, period)
    await seedUsage(b, 999, period) // b's postings must never leak into a's balance

    const res = await getJson(balanceUrl, { token: tenantToken(a) })
    expect(res.status).toBe(200)
    expect(BigInt((res.body as { balance_minor: string }).balance_minor)).toBe(70n)
    expect(await receivable(owner, b)).toBe(999n) // sanity: b really does have its own
  })
})

describe('phase 5: GET /statement (INV-4)', () => {
  test('defaults to the current period when no period is given', async () => {
    const t = await newTenant(owner)
    const period = currentPeriodKey()
    await seedUsage(t, 120, period)

    const def = await getJson(statementUrl, { token: tenantToken(t) })
    const explicit = await getJson(`${statementUrl}?period=${period}`, { token: tenantToken(t) })
    expect(def.status).toBe(200)
    expect(explicit.status).toBe(200)
    // The default period IS the current period: identical bodies.
    expect(def.body).toEqual(explicit.body)
  })

  test('a closed-period statement is reproducible', async () => {
    const t = await newTenant(owner)
    const past = '2026-02'
    await seedUsage(t, 500, past)
    await closePeriodDirect(t, past) // immutable after close -> sum can never change

    const first = await getJson(`${statementUrl}?period=${past}`, { token: tenantToken(t) })
    expect(first.status).toBe(200)
    expect(first.body).toBeTruthy()

    // The tenant keeps accruing usage in a LATER period; the closed period's
    // statement must not drift (period-scoped + immutable after close).
    await seedUsage(t, 777, currentPeriodKey())

    const second = await getJson(`${statementUrl}?period=${past}`, { token: tenantToken(t) })
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body) // reproducible despite new activity elsewhere
  })
})
