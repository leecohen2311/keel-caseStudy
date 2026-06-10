import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, sweepPending, queueRows, newTenant, newWebhookSecret } from '../helpers/db.ts'
import { makeUsageDelivery } from '../helpers/webhook.ts'
import { startIngest, type Service } from '../helpers/ingest-server.ts'
import { postRaw } from '../helpers/http.ts'

// Phase 4 — POST /webhooks/usage HMAC boundary (INV-8, API-2). Black-box: assert
// HTTP status and the immediate effect (a queue row attributed to the SECRET
// OWNER). Forged/tampered/stale/missing-signature deliveries are rejected at the
// boundary with no side effect. RED until the webhook route exists (today: 404).

let owner: pg.Pool
let svc: Service
let url: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  svc = await startIngest({ port: 3111 })
  url = `${svc.baseUrl}/webhooks/usage`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

const STALE_SECONDS = 10 * 60 // 10 min, beyond the ~5 min freshness window

describe('phase 4: webhook signature rejection (INV-8)', () => {
  test('a bad signature -> 401, nothing enqueued', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret })
    const res = await postRaw(url, d.rawBody, {
      headers: { ...d.headers, 'X-Signature': 'deadbeef'.repeat(8) }
    })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(0)
  })

  test('a missing signature header -> 401', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret })
    const headers = { ...d.headers }
    delete headers['X-Signature']
    const res = await postRaw(url, d.rawBody, { headers })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(0)
  })

  test('an empty signature -> 401', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret })
    const res = await postRaw(url, d.rawBody, { headers: { ...d.headers, 'X-Signature': '' } })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(0)
  })

  test('a stale timestamp -> 401 (signature valid, but outside the window)', async () => {
    const sec = await newWebhookSecret(owner)
    const stale = String(Math.floor(Date.now() / 1000) - STALE_SECONDS)
    // Correctly signed FOR the stale timestamp, so this isolates staleness from a
    // signature failure (the string-to-sign includes the timestamp).
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret, timestamp: stale })
    const res = await postRaw(url, d.rawBody, { headers: d.headers })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(0)
  })

  test('a tampered body fails the signature -> 401', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret, quantity: 1 })
    // Change the bytes after signing; the signature no longer matches.
    const tampered = JSON.stringify({ ...d.body, quantity: 999 })
    const res = await postRaw(url, tampered, { headers: d.headers })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(0)
  })

  test('an unknown X-Key-Id -> 401, nothing enqueued', async () => {
    // A forged delivery naming a secret that does not exist. The boundary must
    // reject it like a bad signature (401) and not leak key existence (GAP-9).
    const before = await owner.query(`SELECT count(*)::int AS n FROM event_queue`)
    const d = makeUsageDelivery({ keyId: `whk_${randomUUID().slice(0, 8)}`, secret: 'whsec_nope' })
    const res = await postRaw(url, d.rawBody, { headers: d.headers })
    expect(res.status).toBe(401)
    const after = await owner.query(`SELECT count(*)::int AS n FROM event_queue`)
    expect(after.rows[0].n).toBe(before.rows[0].n) // global: nothing enqueued
  })

  test('mutating X-Timestamp after signing breaks the signature -> 401', async () => {
    // The timestamp is bound into the string-to-sign, so re-stamping a captured
    // delivery to make it look fresh must fail verification.
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({ keyId: sec.keyId, secret: sec.secret })
    const restamped = String(Number(d.headers['X-Timestamp']) + 30)
    const res = await postRaw(url, d.rawBody, { headers: { ...d.headers, 'X-Timestamp': restamped } })
    expect(res.status).toBe(401)
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(0)
  })
})

describe('phase 4: webhook acceptance and tenant attribution (INV-8, INV-4)', () => {
  test('a valid signed delivery -> 202 and a pending usage row for the secret owner', async () => {
    const sec = await newWebhookSecret(owner)
    const d = makeUsageDelivery({
      keyId: sec.keyId,
      secret: sec.secret,
      metric: 'api_call',
      quantity: 50
    })
    const res = await postRaw(url, d.rawBody, { headers: d.headers })
    expect(res.status).toBe(202)

    const rows = await queueRows(owner, sec.tenantId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.tenant_id).toBe(sec.tenantId) // attributed to the secret owner
    expect(row.kind).toBe('usage')
    expect(row.status).toBe('pending')
    // The delivery id is the dedup-relevant tail of a wh:-namespaced key. The
    // `{source}` segment is not pinned (CONTRACT-GAPS GAP-9), so assert the
    // namespace prefix and the delivery-id suffix rather than the exact middle.
    expect(row.event_id.startsWith('wh:')).toBe(true)
    expect(row.event_id.endsWith(`:${d.deliveryId}`)).toBe(true)
    expect(row.payload.metric).toBe('api_call')
    expect(Number(row.payload.quantity)).toBe(50)
  })

  test('the body tenant is ignored; the secret owner wins', async () => {
    const sec = await newWebhookSecret(owner)
    const impostor = await newTenant(owner, 'impostor tenant')
    const d = makeUsageDelivery({
      keyId: sec.keyId,
      secret: sec.secret,
      quantity: 3,
      bodyTenant: impostor // the body claims a different tenant
    })
    const res = await postRaw(url, d.rawBody, { headers: d.headers })
    expect(res.status).toBe(202)

    // Attributed to the secret owner, NOT the body's tenant.
    expect(await queueRows(owner, sec.tenantId)).toHaveLength(1)
    expect(await queueRows(owner, impostor)).toHaveLength(0)
  })
})
