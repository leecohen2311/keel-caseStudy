import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending } from '../helpers/db.ts'
import { adminToken } from '../helpers/jwt.ts'
import { startLedger, type Service } from '../helpers/ledger-server.ts'
import { startWorker, stopWorker, until } from '../helpers/worker.ts'
import { postJson } from '../helpers/http.ts'

// Phase 7 end-to-end (REC-3): reconcile must NOT raise false positives during
// normal concurrent operation. We enqueue a batch of usage events, drain them
// with a real worker, and hammer POST /reconcile throughout. Because reconcile
// runs at REPEATABLE READ and only re-derives from `done` rows (which commit
// atomically with their postings), an in-flight pending/mid-transaction event is
// never mistaken for drift. Stays red until Phase 2 + the reconcile route are
// merged.

let owner: pg.Pool
let ingest: pg.Pool
let svc: Service
let url: string

beforeAll(async () => {
  owner = makePool('owner')
  ingest = makePool('ingest')
  await sweepPending(owner)
  svc = await startLedger({ port: 3172 })
  url = `${svc.baseUrl}/reconcile`
})

afterAll(async () => {
  await svc.stop()
  await owner.end()
  await ingest.end()
})

async function enqueuePending(tenantId: string, quantity: number): Promise<void> {
  await ingest.query(
    `INSERT INTO event_queue (tenant_id, event_id, payload, payload_hash, event_date)
     VALUES ($1, $2, $3, 'h', now())`,
    [tenantId, `api:recon-${randomUUID()}`, JSON.stringify({ metric: 'api_call', quantity })]
  )
}

async function pendingCount(tenantId: string): Promise<number> {
  const r = await owner.query(
    `SELECT count(*)::int AS n FROM event_queue WHERE tenant_id = $1 AND status = 'pending'`,
    [tenantId]
  )
  return r.rows[0].n
}

function reconcile() {
  return postJson(url, {}, { token: adminToken() })
}

describe('phase 7 e2e: reconcile under concurrent consumer load (REC-3)', () => {
  test('reports no false positives while events are being drained', async () => {
    const t = await newTenant(owner)
    // A big batch so the worker cannot drain it within the reconcile-hammer
    // window — this guarantees reconcile genuinely overlaps in-flight events
    // rather than racing an already-empty queue.
    for (let i = 1; i <= 300; i++) await enqueuePending(t, i)

    let maxPendingDuringReconcile = 0
    const worker = startWorker()
    try {
      // Hammer reconcile while the queue still has pending/in-flight events. Each
      // call must come back clean: a half-applied event is never visible.
      for (let i = 0; i < 8; i++) {
        maxPendingDuringReconcile = Math.max(maxPendingDuringReconcile, await pendingCount(t))
        const res = await reconcile()
        expect(res.status).toBe(200)
        expect((res.body as { ok: boolean }).ok).toBe(true)
        await new Promise((r) => setTimeout(r, 40))
      }
      await until(async () => (await pendingCount(t)) === 0, 'all events drained', 30_000)
    } finally {
      await stopWorker(worker)
    }

    // Fail loudly if the batch drained before any reconcile saw in-flight events,
    // which would make the ok:true assertions above pass vacuously.
    expect(maxPendingDuringReconcile).toBeGreaterThan(0)

    // And clean once everything has settled.
    const final = await reconcile()
    expect(final.status).toBe(200)
    expect((final.body as { ok: boolean }).ok).toBe(true)
  })
})
