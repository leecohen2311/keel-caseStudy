import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, queueRows } from '../helpers/db.ts'
import {
  tenantToken,
  expiredTenantToken,
  algNoneToken,
  wrongSecretToken
} from '../helpers/jwt.ts'
import { startIngest, type Service } from '../helpers/ingest-server.ts'
import { postJson } from '../helpers/http.ts'

// Phase 3 — POST /events contract (API-1). Black-box: assert on HTTP status and
// the immediate effect (a row in event_queue), no consumer involved. Every test
// uses a fresh tenant so per-tenant queue assertions are isolated. RED until the
// Ingest API is implemented (today the route 404s). See CONTRACT-GAPS GAP-1..6.

let owner: pg.Pool
let svc: Service
let url: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  svc = await startIngest({ port: 3101 })
  url = `${svc.baseUrl}/events`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

function validBody(tenantId: string, over: Record<string, unknown> = {}) {
  return {
    tenant: tenantId,
    metric: 'api_call',
    quantity: 1,
    idempotency_key: randomUUID(),
    ...over
  }
}

describe('phase 3: POST /events authentication (INV-6, INV-4)', () => {
  test('missing Authorization header -> 401, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t))
    expect(res.status).toBe(401)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('alg:none token is rejected -> 401', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t), { token: algNoneToken(t) })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('expired token is rejected -> 401', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t), { token: expiredTenantToken(t) })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('token signed with the wrong secret is rejected -> 401', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t), { token: wrongSecretToken(t) })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })
})

describe('phase 3: POST /events tenant isolation (INV-4)', () => {
  test('body.tenant different from the token tenant -> 403, nothing enqueued', async () => {
    const a = await newTenant(owner)
    const b = await newTenant(owner)
    // Authenticated as A, but claims to act for B.
    const res = await postJson(url, validBody(b), { token: tenantToken(a) })
    expect(res.status).toBe(403)
    expect(await queueRows(owner, a)).toHaveLength(0)
    expect(await queueRows(owner, b)).toHaveLength(0)
  })
})

describe('phase 3: POST /events validation (API-1, INV-6)', () => {
  // event_date bounds are now-relative and recomputed each run so the
  // out-of-window cases never drift across the boundary as the clock advances
  // (the window is the open interval (now-1y, now+1d); see CONTRACT-GAPS GAP-5).
  const DAY = 24 * 60 * 60_000
  const farPast = new Date(Date.now() - 730 * DAY).toISOString() // ~2 years before now-1y
  const farFuture = new Date(Date.now() + 3 * DAY).toISOString() // ~2 days past the +1d bound
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing metric', { metric: undefined }],
    ['missing quantity', { quantity: undefined }],
    ['missing idempotency_key', { idempotency_key: undefined }],
    ['negative quantity', { quantity: -5 }],
    ['fractional quantity', { quantity: 1.5 }],
    ['zero quantity (below the 1 floor)', { quantity: 0 }],
    ['quantity above 10^12', { quantity: 10 ** 12 + 1 }],
    ['unknown metric not in the price book', { metric: 'not_a_metric' }],
    ['event_date well before now-1y', { event_date: farPast }],
    ['event_date well after now+1d', { event_date: farFuture }]
  ]

  test.each(cases)('%s -> 400, nothing enqueued', async (_label, override) => {
    const t = await newTenant(owner)
    const body = validBody(t, override)
    // `undefined` overrides drop the key entirely (JSON.stringify omits it).
    const res = await postJson(url, body, { token: tenantToken(t) })
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })
})

describe('phase 3: POST /events happy path and durability (API-1, INV-2)', () => {
  test('a valid event -> 202 and a pending usage row lands in event_queue', async () => {
    const t = await newTenant(owner)
    const body = validBody(t, { metric: 'api_call', quantity: 100 })
    const res = await postJson(url, body, { token: tenantToken(t) })
    expect(res.status).toBe(202)

    const rows = await queueRows(owner, t)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.event_id).toBe(`api:${body.idempotency_key}`)
    expect(row.kind).toBe('usage') // app_ingest cannot set kind; defaults to usage
    expect(row.status).toBe('pending')
    expect(row.payload.metric).toBe('api_call')
    expect(Number(row.payload.quantity)).toBe(100)
    expect(row.payload_hash).toBeTruthy()
  })

  test('the 202 is returned only after the queue row has committed', async () => {
    const t = await newTenant(owner)
    const body = validBody(t)
    const res = await postJson(url, body, { token: tenantToken(t) })
    expect(res.status).toBe(202)
    // The response has resolved; a brand-new owner connection must already see
    // the committed row (return-only-after-commit, MEMORY pinned contract).
    const fresh = makePool('owner')
    try {
      const r = await fresh.query(
        `SELECT status FROM event_queue WHERE tenant_id = $1 AND event_id = $2`,
        [t, `api:${body.idempotency_key}`]
      )
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0].status).toBe('pending')
    } finally {
      await fresh.end()
    }
  })

  test('event_date absent defaults to now()', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t), { token: tenantToken(t) })
    expect(res.status).toBe(202)
    const [row] = await queueRows(owner, t)
    const skew = Math.abs(Date.now() - new Date(row.event_date).getTime())
    expect(skew).toBeLessThan(30_000)
  })

  test('a valid in-range event_date is stored on the queue row', async () => {
    const t = await newTenant(owner)
    const when = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
    const res = await postJson(url, validBody(t, { event_date: when }), {
      token: tenantToken(t)
    })
    expect(res.status).toBe(202)
    const [row] = await queueRows(owner, t)
    expect(new Date(row.event_date).getTime()).toBe(new Date(when).getTime())
  })

  test('a valid storage_gb_hour event -> 202 with that metric on the row', async () => {
    // The second pinned price-book metric: an impl that whitelists only api_call
    // would wrongly reject this. (price book: api_call=1, storage_gb_hour=5)
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t, { metric: 'storage_gb_hour', quantity: 4 }), {
      token: tenantToken(t)
    })
    expect(res.status).toBe(202)
    const [row] = await queueRows(owner, t)
    expect(row.payload.metric).toBe('storage_gb_hour')
    expect(Number(row.payload.quantity)).toBe(4)
  })

  test('quantity at the lower bound (1) is accepted -> 202', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t, { quantity: 1 }), { token: tenantToken(t) })
    expect(res.status).toBe(202)
    expect(await queueRows(owner, t)).toHaveLength(1)
  })

  test('quantity at the upper bound (10^12) is accepted -> 202', async () => {
    const t = await newTenant(owner)
    const res = await postJson(url, validBody(t, { quantity: 10 ** 12 }), { token: tenantToken(t) })
    expect(res.status).toBe(202)
    const [row] = await queueRows(owner, t)
    expect(Number(row.payload.quantity)).toBe(10 ** 12)
  })
})

describe('phase 3: POST /events request idempotency (INV-2)', () => {
  test('same idempotency_key + same payload, sent twice -> exactly one queued event', async () => {
    const t = await newTenant(owner)
    const body = validBody(t, { quantity: 3 })
    const token = tenantToken(t)

    const first = await postJson(url, body, { token })
    const second = await postJson(url, body, { token })

    // At-least-once client retry: the duplicate replays the stored response.
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(await queueRows(owner, t)).toHaveLength(1)
  })

  test('same idempotency_key + different payload -> 409, original row unchanged', async () => {
    const t = await newTenant(owner)
    const key = randomUUID()
    const token = tenantToken(t)

    const first = await postJson(url, validBody(t, { quantity: 1, idempotency_key: key }), {
      token
    })
    expect(first.status).toBe(202)

    const conflict = await postJson(url, validBody(t, { quantity: 2, idempotency_key: key }), {
      token
    })
    expect(conflict.status).toBe(409)

    const rows = await queueRows(owner, t)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].payload.quantity)).toBe(1) // the original payload wins
  })
})
