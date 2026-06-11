import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { makePool, newTenant, sweepPending, queueRows } from '../helpers/db.ts'
import { adminToken } from '../helpers/jwt.ts'
import { startLedger } from '../helpers/ledger-server.ts'
import { postJson } from '../helpers/http.ts'

// Phase 8 — crash safety for the two admin transactions (INV-3), the deferred
// Phase 6 gap. The ledger service honors a test-only LEDGER_CRASH_POINT env
// hook, the analogue of the consumer's CRASH_POINT and ingest's
// INGEST_CRASH_POINT: a real self-SIGKILL between the INSERT and the COMMIT.
// Killed there, the transaction never commits — no enqueued adjustment, no
// closure row, no flipped status — and a retry against a fresh process
// succeeds exactly once.

let owner: pg.Pool

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
})

afterAll(async () => {
  await owner.end()
})

async function closures(tenantId: string) {
  const r = await owner.query(
    `SELECT c.closure_id, bp.period_key, bp.status
       FROM period_closures c
       JOIN billing_periods bp ON bp.period_id = c.period_id
      WHERE c.tenant_id = $1`,
    [tenantId]
  )
  return r.rows
}

describe('phase 8: admin transactions under real SIGKILL (LEDGER_CRASH_POINT)', () => {
  test('kill between the adjustment INSERT and COMMIT: nothing enqueued; the retry enqueues exactly one', async () => {
    const t = await newTenant(owner)
    const body = {
      tenant: t,
      amount_minor: -250,
      idempotency_key: randomUUID(),
      reason: 'crash-test credit'
    }
    const token = adminToken()

    const doomed = await startLedger({
      port: 3141,
      extraEnv: { LEDGER_CRASH_POINT: 'adjustment-before-commit' }
    })
    try {
      // The process dies mid-request, so the connection resets — fetch may throw.
      await postJson(`${doomed.baseUrl}/adjustments`, body, { token }).catch(() => undefined)
      // Load-bearing: the kill must be a real self-SIGKILL at the crash point.
      // Keeps the test red until LEDGER_CRASH_POINT genuinely fires, rather than
      // passing vacuously while the hook is still missing.
      const death = await Promise.race([
        doomed.exited,
        new Promise<{ signal: string | null }>((r) => setTimeout(() => r({ signal: null }), 8000))
      ])
      expect(death.signal).toBe('SIGKILL')
    } finally {
      await doomed.stop().catch(() => undefined)
    }

    // The transaction never committed: no queue row, nothing for the consumer.
    expect(await queueRows(owner, t)).toHaveLength(0)

    // A fresh Ledger; the admin retries the same idempotency key.
    const fresh = await startLedger({ port: 3142 })
    try {
      const retry = await postJson(`${fresh.baseUrl}/adjustments`, body, { token })
      expect(retry.status).toBe(202)
    } finally {
      await fresh.stop()
    }
    const rows = await queueRows(owner, t)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('adjustment')
  })

  test('kill between the closure INSERT and COMMIT: no committed closure; the retry closes exactly once', async () => {
    const t = await newTenant(owner)
    const body = { tenant: t, period: '2026-03' }
    const token = adminToken()

    const doomed = await startLedger({
      port: 3141,
      extraEnv: { LEDGER_CRASH_POINT: 'close-before-commit' }
    })
    try {
      await postJson(`${doomed.baseUrl}/periods/close`, body, { token }).catch(() => undefined)
      const death = await Promise.race([
        doomed.exited,
        new Promise<{ signal: string | null }>((r) => setTimeout(() => r({ signal: null }), 8000))
      ])
      expect(death.signal).toBe('SIGKILL')
    } finally {
      await doomed.stop().catch(() => undefined)
    }

    // The closure INSERT rolled back with the transaction: the period is not
    // closed, and no half-state (closure without status flip) exists either.
    expect(await closures(t)).toHaveLength(0)
    const period = await owner.query(
      `SELECT status FROM billing_periods WHERE tenant_id = $1 AND period_key = $2`,
      [t, body.period]
    )
    if (period.rowCount === 1) expect(period.rows[0].status).not.toBe('closed')

    // A fresh Ledger; the admin retries the close.
    const fresh = await startLedger({ port: 3142 })
    try {
      const retry = await postJson(`${fresh.baseUrl}/periods/close`, body, { token })
      expect(retry.status).toBe(200)
    } finally {
      await fresh.stop()
    }
    const closed = await closures(t)
    expect(closed).toHaveLength(1)
    expect(closed[0].period_key).toBe(body.period)
    expect(closed[0].status).toBe('closed')
  })
})
