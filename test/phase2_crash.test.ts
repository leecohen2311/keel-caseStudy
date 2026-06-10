import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import type pg from 'pg'
import { connStr, makePool, newTenant, enqueueUsage, sweepPending } from './helpers.ts'

// Phase 2 crash harness: the consumer worker is a real child process and the
// kills are real SIGKILLs delivered mid-transaction (INV-3). The worker
// honors CRASH_POINT (test-only env) by SIGKILLing itself at a named
// boundary inside the consumer transaction.

let owner: pg.Pool
let ingest: pg.Pool

beforeAll(async () => {
  owner = makePool('owner')
  ingest = makePool('ingest')
  await sweepPending(owner)
})

afterAll(async () => {
  await owner.end()
  await ingest.end()
})

function spawnWorker(extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['src/ledger/consumer-worker.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: connStr('ledger'),
      POLL_MS: '25',
      ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
}

async function until(probe: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

async function counts(tenantId: string) {
  const r = await owner.query(
    `SELECT
       (SELECT count(*)::int FROM transactions WHERE tenant_id = $1) AS txns,
       (SELECT count(*)::int FROM postings WHERE tenant_id = $1) AS postings`,
    [tenantId]
  )
  return r.rows[0] as { txns: number; postings: number }
}

describe('phase 2: crash safety under real SIGKILL', () => {
  const boundaries = ['after-claim', 'after-header', 'after-postings', 'after-markdone']

  test.each(boundaries)(
    'SIGKILL %s: no partial state, event recovers and posts exactly once',
    async (point) => {
      const tenantId = await newTenant(owner)
      const { queueId } = await enqueueUsage(ingest, tenantId, { quantity: 7 })

      const doomed = spawnWorker({ CRASH_POINT: point })
      const death = await waitExit(doomed)
      expect(death.signal).toBe('SIGKILL')

      // Everything was inside one uncommitted transaction: nothing landed.
      expect(await counts(tenantId)).toEqual({ txns: 0, postings: 0 })
      const q = await owner.query(
        'SELECT status, attempts FROM event_queue WHERE queue_id = $1',
        [queueId]
      )
      expect(q.rows[0]).toEqual({ status: 'pending', attempts: 0 })

      // A clean worker recovers the row (the dead worker's lock died with
      // its connection) and posts exactly once.
      const clean = spawnWorker()
      try {
        await until(async () => {
          const r = await owner.query(
            'SELECT status FROM event_queue WHERE queue_id = $1',
            [queueId]
          )
          return r.rows[0].status === 'done'
        }, `queue row ${queueId} done after recovery from ${point}`)
      } finally {
        clean.kill('SIGTERM')
        await waitExit(clean)
      }

      expect(await counts(tenantId)).toEqual({ txns: 1, postings: 2 })
      const sum = await owner.query(
        'SELECT COALESCE(SUM(amount_minor), 0)::bigint AS net, ' +
          "COALESCE(SUM(amount_minor) FILTER (WHERE account = 'receivable'), 0)::bigint AS receivable " +
          'FROM postings WHERE tenant_id = $1',
        [tenantId]
      )
      expect(BigInt(sum.rows[0].net)).toBe(0n)
      expect(BigInt(sum.rows[0].receivable)).toBe(7n) // api_call rate 1 x 7
    }
  )

  test('SIGKILL after commit: the redelivery writes nothing new', async () => {
    const tenantId = await newTenant(owner)
    const { queueId } = await enqueueUsage(ingest, tenantId, { quantity: 11 })

    const doomed = spawnWorker({ CRASH_POINT: 'after-commit' })
    const death = await waitExit(doomed)
    expect(death.signal).toBe('SIGKILL')

    // The commit beat the kill: fully posted.
    expect(await counts(tenantId)).toEqual({ txns: 1, postings: 2 })

    // The channel redelivers (at-least-once); dedup must hold.
    await owner.query(`UPDATE event_queue SET status = 'pending' WHERE queue_id = $1`, [
      queueId
    ])
    const clean = spawnWorker()
    try {
      await until(async () => {
        const r = await owner.query(
          'SELECT status FROM event_queue WHERE queue_id = $1',
          [queueId]
        )
        return r.rows[0].status === 'done'
      }, 'redelivered row re-marked done')
    } finally {
      clean.kill('SIGTERM')
      await waitExit(clean)
    }
    expect(await counts(tenantId)).toEqual({ txns: 1, postings: 2 })
  })

  test('two concurrent workers drain 30 events: each charged exactly once', async () => {
    const tenantId = await newTenant(owner)
    const events = 30
    for (let i = 1; i <= events; i++) {
      await enqueueUsage(ingest, tenantId, { quantity: i })
    }

    const workers = [spawnWorker(), spawnWorker()]
    try {
      await until(async () => {
        const r = await owner.query(
          `SELECT count(*)::int AS n FROM event_queue
            WHERE tenant_id = $1 AND status = 'done'`,
          [tenantId]
        )
        return r.rows[0].n === events
      }, `all ${events} events done`, 25_000)
    } finally {
      for (const w of workers) w.kill('SIGTERM')
      await Promise.all(workers.map(waitExit))
    }

    expect(await counts(tenantId)).toEqual({ txns: events, postings: events * 2 })

    const sums = await owner.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS net,
              COALESCE(SUM(amount_minor) FILTER (WHERE account = 'receivable'), 0)::bigint AS receivable
         FROM postings WHERE tenant_id = $1`,
      [tenantId]
    )
    expect(BigInt(sums.rows[0].net)).toBe(0n)
    // sum(1..30) at api_call rate 1
    expect(BigInt(sums.rows[0].receivable)).toBe(465n)

    const unbalanced = await owner.query(
      `SELECT txn_id FROM postings WHERE tenant_id = $1
        GROUP BY txn_id HAVING SUM(amount_minor) <> 0`,
      [tenantId]
    )
    expect(unbalanced.rows).toEqual([])
  })
})
