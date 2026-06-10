import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, queueRows } from '../helpers/db.ts'
import { adminToken, tenantToken } from '../helpers/jwt.ts'
import { startLedger, type Service } from '../helpers/ledger-server.ts'
import { postJson } from '../helpers/http.ts'

// Phase 6 — admin routes on the Ledger service: POST /adjustments and
// POST /periods/close (INV-6 authorization, INV-7 immutable close). Black-box:
// HTTP status + immediate effect (a pending adjustment queue row; a
// period_closures row). The internal consumer is disabled (startLedger default)
// so the enqueued adjustment stays pending for inspection. RED until the routes
// exist (today: 404).

let owner: pg.Pool
let ingest: pg.Pool
let svc: Service
let adjUrl: string
let closeUrl: string

const PERIOD = '2026-04' // a neutral month; each test uses a fresh tenant

beforeAll(async () => {
  owner = makePool('owner')
  ingest = makePool('ingest')
  await sweepPending(owner)
  svc = await startLedger({ port: 3121 })
  adjUrl = `${svc.baseUrl}/adjustments`
  closeUrl = `${svc.baseUrl}/periods/close`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
  await ingest.end()
})

function validAdj(tenantId: string, over: Record<string, unknown> = {}) {
  return {
    tenant: tenantId,
    amount_minor: -250,
    idempotency_key: randomUUID(),
    reason: 'goodwill credit',
    ...over
  }
}

function validClose(tenantId: string, over: Record<string, unknown> = {}) {
  return { tenant: tenantId, period: PERIOD, ...over }
}

async function closures(tenantId: string) {
  const r = await owner.query(
    `SELECT pc.period_id, bp.period_key, bp.status
       FROM period_closures pc JOIN billing_periods bp ON bp.period_id = pc.period_id
      WHERE pc.tenant_id = $1`,
    [tenantId]
  )
  return r.rows
}

describe('phase 6: admin authorization (INV-6)', () => {
  test('a tenant token on /adjustments -> 403, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(adjUrl, validAdj(t), { token: tenantToken(t) })
    expect(res.status).toBe(403)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('a tenant token on /periods/close -> 403, nothing closed', async () => {
    const t = await newTenant(owner)
    const res = await postJson(closeUrl, validClose(t), { token: tenantToken(t) })
    expect(res.status).toBe(403)
    expect(await closures(t)).toHaveLength(0)
  })

  test('no token on /adjustments -> 401', async () => {
    const t = await newTenant(owner)
    expect((await postJson(adjUrl, validAdj(t))).status).toBe(401)
  })

  test('no token on /periods/close -> 401', async () => {
    const t = await newTenant(owner)
    expect((await postJson(closeUrl, validClose(t))).status).toBe(401)
  })
})

describe('phase 6: /adjustments validation (INV-6)', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['missing amount_minor', { amount_minor: undefined }],
    ['zero amount_minor', { amount_minor: 0 }],
    ['fractional amount_minor', { amount_minor: 1.5 }],
    ['missing reason', { reason: undefined }],
    ['missing idempotency_key', { idempotency_key: undefined }]
  ]
  test.each(bad)('%s -> 400, nothing enqueued', async (_label, over) => {
    const t = await newTenant(owner)
    const res = await postJson(adjUrl, validAdj(t, over), { token: adminToken() })
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })
})

describe('phase 6: /adjustments enqueue + idempotency (INV-2, INV-6)', () => {
  test('a valid adjustment -> 202 and a pending adjustment row for the target tenant', async () => {
    const t = await newTenant(owner)
    const body = validAdj(t, { amount_minor: -250 })
    const res = await postJson(adjUrl, body, { token: adminToken() })
    expect(res.status).toBe(202)

    const rows = await queueRows(owner, t)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.tenant_id).toBe(t)
    expect(row.kind).toBe('adjustment')
    expect(row.status).toBe('pending')
    expect(row.event_id).toBe(`adj:${body.idempotency_key}`)
    expect(Number(row.payload.amount_minor)).toBe(-250)
    expect(row.payload.reason).toBe('goodwill credit')
  })

  test('same idempotency_key + same payload twice -> 202, exactly one queued event', async () => {
    const t = await newTenant(owner)
    const body = validAdj(t)
    const token = adminToken()
    expect((await postJson(adjUrl, body, { token })).status).toBe(202)
    expect((await postJson(adjUrl, body, { token })).status).toBe(202)
    expect(await queueRows(owner, t)).toHaveLength(1)
  })

  test('same idempotency_key + different payload -> 409, original unchanged', async () => {
    const t = await newTenant(owner)
    const key = randomUUID()
    const token = adminToken()
    expect((await postJson(adjUrl, validAdj(t, { amount_minor: -250, idempotency_key: key }), { token })).status).toBe(202)
    const conflict = await postJson(adjUrl, validAdj(t, { amount_minor: -999, idempotency_key: key }), { token })
    expect(conflict.status).toBe(409)
    const rows = await queueRows(owner, t)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].payload.amount_minor)).toBe(-250)
  })
})

describe('phase 6: authorization backstop (standing — enforced by the Phase 1 grant)', () => {
  // NOTE: this guards a property already enforced (and tested) in Phase 1
  // (app_ingest's column-level INSERT excludes `kind`), so it is GREEN on arrival
  // rather than a TDD-red test. Kept here because Phase 6's authorization story
  // depends on it: a compromised Ingest must not be able to forge an admin credit.
  test('app_ingest cannot enqueue kind=adjustment (column grant denied)', async () => {
    const t = await newTenant(owner)
    await expect(
      ingest.query(
        `INSERT INTO event_queue (tenant_id, event_id, kind, payload, payload_hash, event_date)
         VALUES ($1, $2, 'adjustment', $3, 'h', now())`,
        [t, `adj:${randomUUID()}`, JSON.stringify({ amount_minor: -100, reason: 'forged' })]
      )
    ).rejects.toMatchObject({ code: '42501' }) // insufficient_privilege, not a brittle text match
    expect(await queueRows(owner, t)).toHaveLength(0)
  })
})

describe('phase 6: /periods/close immutability and concurrency (INV-7)', () => {
  test('missing tenant -> 400', async () => {
    const t = await newTenant(owner)
    expect((await postJson(closeUrl, validClose(t, { tenant: undefined }), { token: adminToken() })).status).toBe(400)
  })

  test('missing period -> 400', async () => {
    const t = await newTenant(owner)
    expect((await postJson(closeUrl, validClose(t, { period: undefined }), { token: adminToken() })).status).toBe(400)
  })

  test('closing an idle never-touched period succeeds and records a closure', async () => {
    const t = await newTenant(owner) // no billing_periods row exists yet
    const res = await postJson(closeUrl, validClose(t), { token: adminToken() })
    // Success code is not pinned (CONTRACT-GAPS GAP-12); assert 2xx + the state.
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    const c = await closures(t)
    expect(c).toHaveLength(1)
    expect(c[0].period_key).toBe(PERIOD)
    expect(c[0].status).toBe('closed') // the status cache flipped
  })

  test('re-closing a closed period -> 409, still one closure', async () => {
    const t = await newTenant(owner)
    const token = adminToken()
    const first = await postJson(closeUrl, validClose(t), { token })
    expect(first.status).toBeGreaterThanOrEqual(200)
    expect(first.status).toBeLessThan(300)
    const second = await postJson(closeUrl, validClose(t), { token })
    expect(second.status).toBe(409)
    expect(await closures(t)).toHaveLength(1)
  })

  test('two concurrent closes resolve to exactly one winner', async () => {
    const t = await newTenant(owner)
    const token = adminToken()
    const body = validClose(t)
    const results = await Promise.all([
      postJson(closeUrl, body, { token }),
      postJson(closeUrl, body, { token })
    ])
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s >= 200 && s < 300)).toHaveLength(1) // one winner
    expect(statuses.filter((s) => s === 409)).toHaveLength(1) // one loser
    expect(await closures(t)).toHaveLength(1) // exactly one closure row
  })
})
