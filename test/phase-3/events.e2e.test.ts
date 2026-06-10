import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, counts, receivable } from '../helpers/db.ts'
import { tenantToken } from '../helpers/jwt.ts'
import { startIngest, type Service } from '../helpers/ingest-server.ts'
import { startWorker, stopWorker, until } from '../helpers/worker.ts'
import { postJson } from '../helpers/http.ts'

// Phase 3 end-to-end: the real Ingest API -> queue -> the Phase 2 consumer ->
// balanced postings. Proves the full submit path and exactly-once under a
// client retry (INV-2). Stays red until both Phase 2 (merged) and the Phase 3
// Ingest API are in place. Drives the consumer as a real child process.

let owner: pg.Pool
let svc: Service
let url: string

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner) // park other files' pending rows so our worker only drains ours
  svc = await startIngest({ port: 3102 })
  url = `${svc.baseUrl}/events`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
})

async function doneCount(tenantId: string): Promise<number> {
  const r = await owner.query(
    `SELECT count(*)::int AS n FROM event_queue WHERE tenant_id = $1 AND status = 'done'`,
    [tenantId]
  )
  return r.rows[0].n
}

describe('phase 3 e2e: submitted usage becomes a balanced charge', () => {
  test('a valid POST /events flows through to one balanced posting', async () => {
    const t = await newTenant(owner)
    const body = {
      tenant: t,
      metric: 'api_call',
      quantity: 100,
      idempotency_key: randomUUID()
    }
    const res = await postJson(url, body, { token: tenantToken(t) })
    expect(res.status).toBe(202)

    const worker = startWorker()
    try {
      await until(async () => (await doneCount(t)) === 1, 'event drained to done')
    } finally {
      await stopWorker(worker)
    }

    expect(await counts(owner, t)).toEqual({ txns: 1, postings: 2 })
    expect(await receivable(owner, t)).toBe(100n) // api_call rate 1 x 100
  })

  test('a client retry (same key+payload) is charged exactly once end-to-end', async () => {
    const t = await newTenant(owner)
    const body = {
      tenant: t,
      metric: 'api_call',
      quantity: 7,
      idempotency_key: randomUUID()
    }
    const token = tenantToken(t)

    // At-least-once client: the same request lands three times.
    for (let i = 0; i < 3; i++) {
      const res = await postJson(url, body, { token })
      expect(res.status).toBe(202)
    }

    const worker = startWorker()
    try {
      await until(async () => (await doneCount(t)) >= 1, 'event drained to done')
      // Give a second tick in case the dedup left more than one queue row to settle.
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      await stopWorker(worker)
    }

    // Ingest dedups the retry to a single queue row; the ledger's
    // UNIQUE(tenant_id, originating_event_id) is the backstop. Either way: one charge.
    expect(await counts(owner, t)).toEqual({ txns: 1, postings: 2 })
    expect(await receivable(owner, t)).toBe(7n)
  })
})
