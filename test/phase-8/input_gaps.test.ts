import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, newWebhookSecret, sweepPending, queueRows } from '../helpers/db.ts'
import { adminToken, tenantToken } from '../helpers/jwt.ts'
import { startIngest } from '../helpers/ingest-server.ts'
import { startLedger } from '../helpers/ledger-server.ts'
import { signWebhook } from '../helpers/webhook.ts'
import { postJson, postRaw } from '../helpers/http.ts'
import type { Service } from '../helpers/ledger-server.ts'

// Phase 8 — the two cheap input gaps deferred from Phase 6 (logged in
// DESIGN.md, accepted then, closed now):
//
// 1. A NUL byte or an unpaired UTF-16 surrogate inside a validated string
//    field passed the boundary typeof checks and died at INSERT — NUL as a
//    fail-closed 500 (Postgres rejects \u0000 in text and jsonb), a lone
//    surrogate worse: Node's UTF-8 encoder silently mutates it to U+FFFD, so
//    'a\uD800b' and 'a\uD801b' became the SAME stored idempotency key. Both
//    are now a 400 at the boundary, on every body route.
// 2. The adjustment `reason` was unbounded below the 256 KiB body cap and
//    landed verbatim in the never-purged queue. Now bounded at 1024 bytes.

const NUL = 'bad\u0000key'
const LONE_SURROGATE = 'bad\uD800key'

let owner: pg.Pool
let ingestSvc: Service
let ledgerSvc: Service

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  ingestSvc = await startIngest({ port: 3151 })
  ledgerSvc = await startLedger({ port: 3152 })
})

afterAll(async () => {
  await ingestSvc.stop()
  await ledgerSvc.stop()
  await owner.end()
})

function validEvent(tenantId: string, over: Record<string, unknown> = {}) {
  return {
    tenant: tenantId,
    metric: 'api_call',
    quantity: 3,
    idempotency_key: randomUUID(),
    ...over
  }
}

describe('phase 8: POST /events rejects NUL / unpaired surrogates with 400', () => {
  test('idempotency_key containing a NUL byte: 400, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(
      `${ingestSvc.baseUrl}/events`,
      validEvent(t, { idempotency_key: NUL }),
      { token: tenantToken(t) }
    )
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('idempotency_key containing an unpaired surrogate: 400, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(
      `${ingestSvc.baseUrl}/events`,
      validEvent(t, { idempotency_key: LONE_SURROGATE }),
      { token: tenantToken(t) }
    )
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })
})

describe('phase 8: POST /webhooks/usage rejects NUL / unpaired surrogates with 400', () => {
  // The delivery id lives inside the signed body, so these are correctly
  // signed deliveries — they pass HMAC verification and must die at the
  // post-verification validation step, not as an INSERT-time 500.
  async function signedDelivery(eventId: string) {
    const { keyId, secret, tenantId } = await newWebhookSecret(owner)
    const rawBody = JSON.stringify({ event_id: eventId, metric: 'api_call', quantity: 2 })
    const { headers } = signWebhook({ keyId, secret, rawBody })
    return { rawBody, headers, tenantId }
  }

  test('signed event_id containing a NUL byte: 400, nothing enqueued', async () => {
    const { rawBody, headers, tenantId } = await signedDelivery(NUL)
    const res = await postRaw(`${ingestSvc.baseUrl}/webhooks/usage`, rawBody, { headers })
    expect(res.status).toBe(400)
    expect(await queueRows(owner, tenantId)).toHaveLength(0)
  })

  test('signed event_id containing an unpaired surrogate: 400, nothing enqueued', async () => {
    const { rawBody, headers, tenantId } = await signedDelivery(LONE_SURROGATE)
    const res = await postRaw(`${ingestSvc.baseUrl}/webhooks/usage`, rawBody, { headers })
    expect(res.status).toBe(400)
    expect(await queueRows(owner, tenantId)).toHaveLength(0)
  })
})

describe('phase 8: POST /adjustments rejects NUL / unpaired surrogates with 400', () => {
  function validAdj(tenantId: string, over: Record<string, unknown> = {}) {
    return {
      tenant: tenantId,
      amount_minor: -100,
      idempotency_key: randomUUID(),
      reason: 'phase-8 input gap test',
      ...over
    }
  }

  test('tenant containing a NUL byte: 400', async () => {
    const res = await postJson(
      `${ledgerSvc.baseUrl}/adjustments`,
      validAdj(NUL),
      { token: adminToken() }
    )
    expect(res.status).toBe(400)
  })

  test('reason containing a NUL byte: 400, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(
      `${ledgerSvc.baseUrl}/adjustments`,
      validAdj(t, { reason: NUL }),
      { token: adminToken() }
    )
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('idempotency_key containing an unpaired surrogate: 400, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(
      `${ledgerSvc.baseUrl}/adjustments`,
      validAdj(t, { idempotency_key: LONE_SURROGATE }),
      { token: adminToken() }
    )
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })
})

describe('phase 8: adjustment reason bounded at 1024 bytes', () => {
  test('a 1025-byte reason: 400, nothing enqueued', async () => {
    const t = await newTenant(owner)
    const res = await postJson(
      `${ledgerSvc.baseUrl}/adjustments`,
      {
        tenant: t,
        amount_minor: -100,
        idempotency_key: randomUUID(),
        reason: 'r'.repeat(1025)
      },
      { token: adminToken() }
    )
    expect(res.status).toBe(400)
    expect(await queueRows(owner, t)).toHaveLength(0)
  })

  test('boundary control: a reason of exactly 1024 bytes is accepted (202)', async () => {
    const t = await newTenant(owner)
    const res = await postJson(
      `${ledgerSvc.baseUrl}/adjustments`,
      {
        tenant: t,
        amount_minor: -100,
        idempotency_key: randomUUID(),
        reason: 'r'.repeat(1024)
      },
      { token: adminToken() }
    )
    expect(res.status).toBe(202)
    expect(await queueRows(owner, t)).toHaveLength(1)
  })
})

describe('phase 8: POST /periods/close rejects NUL with 400', () => {
  test('tenant containing a NUL byte: 400', async () => {
    const res = await postJson(
      `${ledgerSvc.baseUrl}/periods/close`,
      { tenant: NUL, period: '2026-02' },
      { token: adminToken() }
    )
    expect(res.status).toBe(400)
  })
})
