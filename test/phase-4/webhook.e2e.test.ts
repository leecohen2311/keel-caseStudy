import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type pg from 'pg'
import { makePool, sweepPending, newWebhookSecret, counts, receivable, queueRows } from '../helpers/db.ts'
import { makeUsageDelivery } from '../helpers/webhook.ts'
import { startIngest, type Service } from '../helpers/ingest-server.ts'
import { startWorker, stopWorker, until } from '../helpers/worker.ts'
import { postRaw } from '../helpers/http.ts'

// Phase 4 end-to-end: signed webhook -> queue -> Phase 2 consumer -> balanced
// posting (INV-8 + INV-2). Replays are de-duplicated and charged exactly once;
// a delivery whose signed id is mutated is rejected and charges nothing.
// Stays red until both Phase 2 and the webhook route are merged.

let owner: pg.Pool
let svc: Service
let url: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  svc = await startIngest({ port: 3112 })
  url = `${svc.baseUrl}/webhooks/usage`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

async function pendingCount(tenantId: string): Promise<number> {
  const r = await owner.query(
    `SELECT count(*)::int AS n FROM event_queue WHERE tenant_id = $1 AND status = 'pending'`,
    [tenantId]
  )
  return r.rows[0].n
}

describe('phase 4 e2e: signed webhook becomes a balanced charge', () => {
  test('a valid signed delivery flows to one balanced posting for the secret owner', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret, metric: 'api_call', quantity: 5 })
    expect((await postRaw(url, d.rawBody, { headers: d.headers })).status).toBe(202)

    const worker = startWorker()
    try {
      await until(async () => (await pendingCount(sec.tenantId)) === 0, 'delivery drained')
    } finally {
      await stopWorker(worker)
    }

    expect(await counts(owner, sec.tenantId)).toEqual({ txns: 1, postings: 2 })
    expect(await receivable(owner, sec.tenantId)).toBe(5n) // api_call rate 1 x 5
  })

  test('a mutated delivery-id replay produces 0 new postings', async () => {
    const sec = await newWebhookSecret(owner)
    const legit = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret, quantity: 5 })
    expect((await postRaw(url, legit.rawBody, { headers: legit.headers })).status).toBe(202)

    // Same captured signature, but the delivery id inside the body is changed.
    // Because the id is signed, the signature no longer matches -> rejected.
    const mutated = JSON.stringify({ ...legit.body, event_id: `mutated-${legit.deliveryId}` })
    expect((await postRaw(url, mutated, { headers: legit.headers })).status).toBe(401)

    const worker = startWorker()
    try {
      await until(async () => (await pendingCount(sec.tenantId)) === 0, 'legit delivery drained')
    } finally {
      await stopWorker(worker)
    }

    // Only the one legitimate delivery was ever enqueued and charged.
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(1)
    expect(await counts(owner, sec.tenantId)).toEqual({ txns: 1, postings: 2 })
    expect(await receivable(owner, sec.tenantId)).toBe(5n)
  })

  test('a replayed delivery within the freshness window is charged exactly once', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret, quantity: 9 })

    // At-least-once provider: the identical, still-fresh delivery arrives twice.
    expect((await postRaw(url, d.rawBody, { headers: d.headers })).status).toBe(202)
    expect((await postRaw(url, d.rawBody, { headers: d.headers })).status).toBe(202)

    // Deduped at ingest to a single queue row (UNIQUE(tenant_id, event_id)).
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(1)

    const worker = startWorker()
    try {
      await until(async () => (await pendingCount(sec.tenantId)) === 0, 'delivery drained')
    } finally {
      await stopWorker(worker)
    }

    expect(await counts(owner, sec.tenantId)).toEqual({ txns: 1, postings: 2 })
    expect(await receivable(owner, sec.tenantId)).toBe(9n)
  })
})
