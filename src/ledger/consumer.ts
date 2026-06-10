import type pg from 'pg'
import { rate } from './pricebook.ts'

// The heart of the system: one READ COMMITTED transaction per event.
// Claim -> locked reroute loop -> dedup header -> balanced pair -> done.
// Kill the process on any line and either nothing happened (transaction
// rolls back, claim lock dies with the connection, the row returns to
// pending) or everything happened (single commit). See ARCHITECTURE.md §3-4.

export type ProcessResult = 'empty' | 'posted' | 'duplicate' | 'retried' | 'dead'

const MAX_ATTEMPTS = 5
const MAX_QUANTITY = 1_000_000_000_000 // 10^12, pinned validation bound

export function periodKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function nextPeriodKey(key: string): string {
  const [year, month] = key.split('-').map(Number)
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`
}

// Test-only crash injection: a real, uncatchable SIGKILL at a named boundary
// inside the transaction. Inert unless CRASH_POINT is set (never in prod).
function crashIfRequested(point: string): void {
  if (process.env.CRASH_POINT === point) process.kill(process.pid, 'SIGKILL')
}

export async function processOne(pool: pg.Pool): Promise<ProcessResult> {
  const client = await pool.connect()
  let queueId: string | undefined
  try {
    // Pinned explicitly: the reroute loop's block-reread pattern depends on
    // READ COMMITTED, so don't inherit a changeable server default.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')

    // 1. Claim. The row lock is the lease: it cannot outlive the process.
    // event_date also rides along as text so the header insert is exact
    // (a JS Date round-trip would truncate microseconds).
    const claimed = await client.query(
      `SELECT queue_id, tenant_id, event_id, kind, payload, event_date,
              event_date::text AS event_date_text
         FROM event_queue WHERE status = 'pending'
        ORDER BY queue_id FOR UPDATE SKIP LOCKED LIMIT 1`
    )
    if (claimed.rowCount === 0) {
      await client.query('COMMIT')
      return 'empty'
    }
    const row = claimed.rows[0]
    queueId = row.queue_id
    crashIfRequested('after-claim')

    // 2. Queue payloads are data, not trust: re-validate the date window
    // before it can mint a billing period, then resolve the booked period
    // under a lock that a concurrent close cannot cross (close takes
    // FOR UPDATE; we hold FOR SHARE).
    validateEventDate(row.event_date)
    const periodId = await resolveOpenPeriod(client, row.tenant_id, row.event_date)

    // 3. The money dedup boundary (INV-2), before the postings so a
    // duplicate is detected without poisoning the transaction.
    const header = await client.query(
      `INSERT INTO transactions
         (tenant_id, originating_event_id, booked_period_id, kind, metric, quantity, event_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, originating_event_id) DO NOTHING
       RETURNING txn_id`,
      [
        row.tenant_id,
        row.event_id,
        periodId,
        row.kind,
        row.payload?.metric ?? null,
        row.payload?.quantity ?? null,
        row.event_date_text
      ]
    )

    // 4. Already charged by an earlier delivery: just retire the queue row.
    if (header.rowCount === 0) {
      await client.query(
        `UPDATE event_queue SET status = 'done', processed_at = now() WHERE queue_id = $1`,
        [queueId]
      )
      await client.query('COMMIT')
      return 'duplicate'
    }
    crashIfRequested('after-header')

    // 5. Queue payloads are data, not trust: re-validate, then write the
    // balanced pair in ONE statement (INV-1 by construction).
    const amount = computeAmount(row.kind, row.payload)
    await client.query(
      `INSERT INTO postings (txn_id, tenant_id, account, amount_minor)
       VALUES ($1, $2, 'receivable', $3), ($1, $2, 'revenue', $4)`,
      [header.rows[0].txn_id, row.tenant_id, amount.toString(), (-amount).toString()]
    )
    crashIfRequested('after-postings')

    // 6. Retire the claim in the same transaction.
    await client.query(
      `UPDATE event_queue SET status = 'done', processed_at = now() WHERE queue_id = $1`,
      [queueId]
    )
    crashIfRequested('after-markdone')

    await client.query('COMMIT')
    crashIfRequested('after-commit')
    return 'posted'
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (queueId === undefined) throw err // claim itself failed; nothing to bookkeep
    if (isSerializationError(err)) return 'retried' // retryable, never counts toward dead
    return recordFailure(pool, queueId)
  } finally {
    client.release()
  }
}

// The locked reroute loop (pinned in MEMORY.md). Only ever returns a period
// verified open (no closure row) while we hold FOR SHARE on it; a concurrent
// close serializes against that lock, so the re-check after the lock is
// authoritative. Terminates at the first never-closed future month.
async function resolveOpenPeriod(
  client: pg.PoolClient,
  tenantId: string,
  eventDate: Date
): Promise<string> {
  const eventKey = periodKeyOf(eventDate)
  const currentKey = periodKeyOf(new Date())
  // YYYY-MM compares chronologically as a string.
  let key = eventKey > currentKey ? eventKey : currentKey
  for (;;) {
    await client.query(
      `INSERT INTO billing_periods (tenant_id, period_key)
       VALUES ($1, $2) ON CONFLICT (tenant_id, period_key) DO NOTHING`,
      [tenantId, key]
    )
    const period = await client.query(
      `SELECT period_id FROM billing_periods
        WHERE tenant_id = $1 AND period_key = $2 FOR SHARE`,
      [tenantId, key]
    )
    const periodId = period.rows[0].period_id
    const closed = await client.query(
      'SELECT 1 FROM period_closures WHERE tenant_id = $1 AND period_id = $2',
      [tenantId, periodId]
    )
    if (closed.rowCount === 0) return periodId
    key = nextPeriodKey(key)
  }
}

// Pinned validation window: event_date in (now - 1y, now + 1d). Outside it,
// the event is poison (dead after MAX_ATTEMPTS), never a misbooked charge in
// an arbitrary period.
function validateEventDate(eventDate: Date): void {
  const t = eventDate.getTime()
  const now = Date.now()
  const yearMs = 365 * 24 * 60 * 60 * 1000
  const dayMs = 24 * 60 * 60 * 1000
  if (!Number.isFinite(t) || t <= now - yearMs || t >= now + dayMs) {
    throw new Error(`event_date outside (now-1y, now+1d): ${eventDate.toISOString()}`)
  }
}

function computeAmount(kind: string, payload: unknown): bigint {
  const p = (payload ?? {}) as Record<string, unknown>
  if (kind === 'adjustment') {
    const amount = p.amount_minor
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount === 0 ||
      Math.abs(amount) > MAX_QUANTITY
    ) {
      throw new Error(`invalid adjustment amount_minor: ${String(amount)}`)
    }
    return BigInt(amount)
  }
  const { metric, quantity } = p
  if (
    typeof quantity !== 'number' ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    throw new Error(`invalid quantity: ${String(quantity)}`)
  }
  if (typeof metric !== 'string') throw new Error('missing metric')
  return rate(metric, BigInt(quantity))
}

// Failure bookkeeping the rolled-back transaction cannot do, in its own
// transaction. The status='pending' guard means a stale report can never
// touch a row another worker has since completed.
export async function recordFailure(
  pool: pg.Pool,
  queueId: string
): Promise<'retried' | 'dead'> {
  const r = await pool.query(
    `UPDATE event_queue
        SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= $2 THEN 'dead' ELSE 'pending' END
      WHERE queue_id = $1 AND status = 'pending'
      RETURNING status`,
    [queueId, MAX_ATTEMPTS]
  )
  return r.rows[0]?.status === 'dead' ? 'dead' : 'retried'
}

function isSerializationError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === '40001' || code === '40P01'
}
