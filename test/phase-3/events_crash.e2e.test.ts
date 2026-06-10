import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, queueRows } from '../helpers/db.ts'
import { tenantToken } from '../helpers/jwt.ts'
import { startIngest } from '../helpers/ingest-server.ts'
import { postJson } from '../helpers/http.ts'

// Phase 3 crash safety on the Ingest side (INV-3): a process killed after it
// builds the queue row but before COMMIT must leave nothing behind, and a client
// retry with the same key must enqueue exactly one event.
//
// This needs a test-only Ingest crash hook (INGEST_CRASH_POINT), the analogue of
// the consumer's CRASH_POINT — see CONTRACT-GAPS GAP-6. Stays red until both the
// Ingest API and that hook exist.

let owner: pg.Pool

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
})

afterAll(async () => {
  await owner.end()
})

describe('phase 3 e2e: crash before the enqueue commit (GAP-6)', () => {
  test('a kill before COMMIT enqueues nothing; the client retry enqueues exactly one', async () => {
    const t = await newTenant(owner)
    const body = {
      tenant: t,
      metric: 'api_call',
      quantity: 4,
      idempotency_key: randomUUID()
    }
    const token = tenantToken(t)

    // Doomed Ingest: SIGKILLs itself after building the row, before COMMIT.
    const doomed = await startIngest({
      port: 3104,
      extraEnv: { INGEST_CRASH_POINT: 'before-enqueue-commit' }
    })
    try {
      // The process dies mid-request, so the connection resets — fetch may throw.
      await postJson(`${doomed.baseUrl}/events`, body, { token }).catch(() => undefined)
    } finally {
      await doomed.stop().catch(() => undefined)
    }

    // The transaction never committed: nothing landed.
    expect(await queueRows(owner, t)).toHaveLength(0)

    // A fresh Ingest; the client retries the same idempotency key.
    const fresh = await startIngest({ port: 3105 })
    try {
      const retry = await postJson(`${fresh.baseUrl}/events`, body, { token })
      expect(retry.status).toBe(202)
    } finally {
      await fresh.stop()
    }
    expect(await queueRows(owner, t)).toHaveLength(1)
  })
})
