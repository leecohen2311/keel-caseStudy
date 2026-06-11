import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { verifyJwt, tenantOf } from '../auth.ts'
import { periodKeyOf } from './consumer.ts'
import { rate } from './pricebook.ts'

// Ledger API: tenant-scoped reads (Phase 5), admin actions (Phase 6), and
// reconcile (Phase 7), plus the consumer worker. Balances are DERIVED on every
// read — SUM over the postings — never stored, so no drift can exist (INV-5).
// Tenant scope is always the verified token claim, never a request parameter
// (INV-4). Connects as app_ledger.

const PORT = Number(process.env.PORT ?? 3002)
const DATABASE_URL = process.env.DATABASE_URL
const JWT_SECRET = process.env.JWT_SECRET // no default/fallback, pinned

// healthz is pure liveness (Phase 0 contract), so missing env degrades the
// API routes to 500 rather than failing the boot.
if (!DATABASE_URL) console.error('ledger: DATABASE_URL is not set; API routes will fail')
if (!JWT_SECRET) console.error('ledger: JWT_SECRET is not set (no default); API routes will fail')

const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 5 }) : null

const MAX_BODY_BYTES = 256 * 1024 // same pinned cap as /events
const MAX_AMOUNT = 1_000_000_000_000 // 10^12 — the consumer's own bound (GAP-14)
const MAX_IDEMPOTENCY_KEY_BYTES = 200 // pinned key bound, same as /events

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // Stop consuming but do NOT destroy the socket here: the 413 still
        // has to be written. The error path closes the connection after the
        // response flushes.
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        reject(new HttpError(413, 'request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Strict YYYY-MM with a real month — the same shape billing_periods enforces.
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Tenant scope from the verified token claim (INV-4); null on any failure.
function authTenant(req: IncomingMessage): string | null {
  if (!JWT_SECRET) return null
  const auth = req.headers.authorization
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
  const claims = token ? verifyJwt(token, JWT_SECRET) : null
  return claims ? tenantOf(claims) : null
}

// Admin is a DISTINCT check (INV-6): the verified token must carry
// admin === true. A validly signed tenant token is 'forbidden' (403), an
// unverifiable or missing token 'unauthenticated' (401).
function authAdmin(req: IncomingMessage): 'unauthenticated' | 'forbidden' | 'admin' {
  if (!JWT_SECRET) return 'unauthenticated'
  const auth = req.headers.authorization
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
  const claims = token ? verifyJwt(token, JWT_SECRET) : null
  if (!claims) return 'unauthenticated'
  return claims.admin === true ? 'admin' : 'forbidden'
}

async function handleBalance(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }
  const tenant = authTenant(req)
  if (!tenant) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  // Derived on read, all-time, BigInt-safe: SUM(bigint) is numeric in
  // Postgres and rides to JSON as a decimal string (GAP-15) — a JS number
  // would lose precision past 2^53.
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS bal
       FROM postings WHERE tenant_id = $1 AND account = 'receivable'`,
    [tenant]
  )
  sendJson(res, 200, { balance_minor: r.rows[0].bal })
}

async function handleStatement(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  if (!pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }
  const tenant = authTenant(req)
  if (!tenant) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  const period = url.searchParams.get('period') ?? periodKeyOf(new Date())
  if (!PERIOD_RE.test(period)) {
    sendJson(res, 400, { error: 'period must be YYYY-MM' })
    return
  }
  // Lines come from the immutable transactions header joined to the
  // receivable leg, scoped by BOOKED period — the boundary the close protocol
  // makes immutable — never by raw event_date and never the mutable queue.
  // Deterministic order and no volatile field, so two reads of the same
  // period are byte-identical (GAP-16) and a closed period is reproducible.
  const r = await pool.query(
    `SELECT t.txn_id, t.kind, t.metric, t.quantity::text AS quantity,
            t.event_date::text AS event_date, p.amount_minor::text AS amount_minor
       FROM transactions t
       JOIN postings p ON p.txn_id = t.txn_id AND p.account = 'receivable'
       JOIN billing_periods bp ON bp.period_id = t.booked_period_id
      WHERE t.tenant_id = $1 AND bp.period_key = $2
      ORDER BY t.created_at, t.txn_id`,
    [tenant, period]
  )
  let total = 0n
  for (const row of r.rows) total += BigInt(row.amount_minor)
  sendJson(res, 200, { period, lines: r.rows, total_minor: total.toString() })
}

type EnqueueOutcome = 'created' | 'replay' | 'conflict'

// One explicit transaction mirroring the ingest enqueue: the 202 happens only
// after COMMIT, and the conflict path is the same block-then-reread pattern,
// pinned at READ COMMITTED. app_ledger holds the kind column grant, so only
// this route — never a compromised Ingest — can enqueue an adjustment.
async function enqueueAdjustment(
  db: pg.Pool,
  row: {
    tenantId: string
    eventId: string
    payload: Record<string, unknown>
    payloadHash: string
    eventDate: string
  }
): Promise<EnqueueOutcome> {
  const client = await db.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const inserted = await client.query(
      `INSERT INTO event_queue (tenant_id, event_id, kind, payload, payload_hash, event_date)
       VALUES ($1, $2, 'adjustment', $3, $4, $5)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING queue_id`,
      [row.tenantId, row.eventId, JSON.stringify(row.payload), row.payloadHash, row.eventDate]
    )
    if (inserted.rowCount === 1) {
      await client.query('COMMIT')
      return 'created'
    }
    const existing = await client.query(
      `SELECT payload_hash FROM event_queue WHERE tenant_id = $1 AND event_id = $2`,
      [row.tenantId, row.eventId]
    )
    await client.query('COMMIT')
    if (existing.rowCount === 0) throw new Error('idempotency conflict with no stored row')
    return existing.rows[0].payload_hash === row.payloadHash ? 'replay' : 'conflict'
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// POST /adjustments (admin): validate, then ENQUEUE a kind='adjustment'
// event (202). The existing consumer posts it through the identical dedup,
// period-lock, and crash-safe path as usage — no parallel posting path
// exists (INV-1/2/3/7 for free).
async function handleAdjustments(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }
  const who = authAdmin(req)
  if (who !== 'admin') {
    sendJson(res, who === 'unauthenticated' ? 401 : 403, { error: 'admin required' })
    return
  }

  const raw = await readBody(req, MAX_BODY_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const body = parsed as Record<string, unknown>

  // The admin exception (pinned): the target tenant comes from the body.
  const tenant = body.tenant
  if (typeof tenant !== 'string' || tenant.length === 0) {
    sendJson(res, 400, { error: 'tenant is required' })
    return
  }
  const amount = body.amount_minor
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > MAX_AMOUNT
  ) {
    sendJson(res, 400, { error: 'amount_minor must be a nonzero integer with |x| <= 10^12' })
    return
  }
  const reason = body.reason
  if (typeof reason !== 'string' || reason.length === 0) {
    sendJson(res, 400, { error: 'reason is required' })
    return
  }
  const key = body.idempotency_key
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    Buffer.byteLength(key, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    sendJson(res, 400, { error: 'idempotency_key must be a string of 1..200 bytes' })
    return
  }

  // adj:-namespaced key (INV-2); event_date stamped now() at enqueue
  // (GAP-17); amount rides as a JSON number (pinned: exact below 2^53).
  const eventId = `adj:${key}`
  const payloadHash = createHash('sha256')
    .update(JSON.stringify([amount, reason]))
    .digest('hex')

  let outcome: EnqueueOutcome
  try {
    outcome = await enqueueAdjustment(pool, {
      tenantId: tenant,
      eventId,
      payload: { amount_minor: amount, reason },
      payloadHash,
      eventDate: new Date().toISOString()
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23503') {
      sendJson(res, 400, { error: 'unknown tenant' })
      return
    }
    throw err
  }
  if (outcome === 'conflict') {
    sendJson(res, 409, { error: 'idempotency_key reused with a different payload' })
    return
  }
  sendJson(res, 202, { accepted: true, event_id: eventId })
}

// POST /periods/close (admin): get-or-create the period row, FOR UPDATE it,
// insert the append-only closure (UNIQUE(tenant_id, period_id) makes one
// winner), flip the status cache — one READ COMMITTED transaction. The
// FOR UPDATE serializes against the consumer's FOR SHARE, so no event can
// post into the period mid-close (INV-7).
async function handleClose(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }
  const who = authAdmin(req)
  if (who !== 'admin') {
    sendJson(res, who === 'unauthenticated' ? 401 : 403, { error: 'admin required' })
    return
  }

  const raw = await readBody(req, MAX_BODY_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const body = parsed as Record<string, unknown>

  const tenant = body.tenant
  if (typeof tenant !== 'string' || tenant.length === 0) {
    sendJson(res, 400, { error: 'tenant is required' })
    return
  }
  const period = body.period
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
    sendJson(res, 400, { error: 'period must be YYYY-MM' })
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    // Get-or-create first: an idle, never-touched period has no row to lock.
    await client.query(
      `INSERT INTO billing_periods (tenant_id, period_key)
       VALUES ($1, $2) ON CONFLICT (tenant_id, period_key) DO NOTHING`,
      [tenant, period]
    )
    const p = await client.query(
      `SELECT period_id FROM billing_periods
        WHERE tenant_id = $1 AND period_key = $2 FOR UPDATE`,
      [tenant, period]
    )
    const periodId = p.rows[0].period_id
    // No ON CONFLICT: the unique violation IS the already-closed signal, for
    // both a re-close and the loser of a concurrent race.
    await client.query(
      `INSERT INTO period_closures (tenant_id, period_id) VALUES ($1, $2)`,
      [tenant, periodId]
    )
    await client.query(
      `UPDATE billing_periods SET status = 'closed'
        WHERE period_id = $1 AND tenant_id = $2`,
      [periodId, tenant]
    )
    await client.query('COMMIT')
    sendJson(res, 200, { closed: true, tenant, period })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    const code = (err as { code?: string }).code
    if (code === '23505') {
      sendJson(res, 409, { error: 'period is already closed' })
      return
    }
    if (code === '23503') {
      sendJson(res, 400, { error: 'unknown tenant' })
      return
    }
    throw err
  } finally {
    client.release()
  }
}

interface Discrepancy {
  type: string
  tenant_id: string
  event_id?: string
  txn_id?: string
  expected?: string
  posted?: string
  detail?: string
}

// POST /reconcile (admin): independently re-derive state from the queue's
// `done` rows — the record the runtime roles cannot mutate — and flag drift
// (REC-1..3). One REPEATABLE READ READ ONLY transaction: a stable snapshot,
// so an in-flight event (whose done-flag, header, and postings commit
// atomically) is either fully visible or not at all — never a false positive
// under concurrent load. Re-rating uses the QUEUE payload, never the header,
// so a symmetric tamper that fools zero-sum still shows up.
async function handleReconcile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }
  const who = authAdmin(req)
  if (who !== 'admin') {
    sendJson(res, who === 'unauthenticated' ? 401 : 403, { error: 'admin required' })
    return
  }
  await readBody(req, MAX_BODY_BYTES) // drain; the report takes no input

  const discrepancies: Discrepancy[] = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

    // 1+2. Every done queue row, joined to its header and receivable leg.
    //      Usage re-rates through the price book; an adjustment's expected
    //      amount is the enqueued amount_minor itself. A missing header is a
    //      deleted pair; a posted amount differing from the re-derivation is
    //      a tamper (including the symmetric scale that nets to zero).
    const rows = await client.query(
      `SELECT q.tenant_id, q.event_id, q.kind, q.payload,
              t.txn_id, p.amount_minor::text AS posted
         FROM event_queue q
         LEFT JOIN transactions t
           ON t.tenant_id = q.tenant_id AND t.originating_event_id = q.event_id
         LEFT JOIN postings p
           ON p.txn_id = t.txn_id AND p.account = 'receivable'
        WHERE q.status = 'done'`
    )
    for (const row of rows.rows) {
      if (row.txn_id === null) {
        discrepancies.push({
          type: 'done_row_without_transaction',
          tenant_id: row.tenant_id,
          event_id: row.event_id
        })
        continue
      }
      if (row.posted === null) {
        discrepancies.push({
          type: 'transaction_without_receivable_posting',
          tenant_id: row.tenant_id,
          event_id: row.event_id,
          txn_id: row.txn_id
        })
        continue
      }
      let expected: bigint
      try {
        const payload = (row.payload ?? {}) as Record<string, unknown>
        expected =
          row.kind === 'adjustment'
            ? BigInt(payload.amount_minor as number)
            : rate(payload.metric as string, BigInt(payload.quantity as number))
      } catch (err) {
        discrepancies.push({
          type: 'unratable_queue_payload',
          tenant_id: row.tenant_id,
          event_id: row.event_id,
          detail: String(err)
        })
        continue
      }
      if (BigInt(row.posted) !== expected) {
        discrepancies.push({
          type: row.kind === 'adjustment' ? 'adjustment_amount_mismatch' : 'usage_amount_mismatch',
          tenant_id: row.tenant_id,
          event_id: row.event_id,
          txn_id: row.txn_id,
          expected: expected.toString(),
          posted: row.posted
        })
      }
    }

    // 3. Global structural checks over EVERY transaction (queue-backed or
    //    not): exactly two postings and a zero net. UNIQUE(txn_id, account)
    //    plus the two-value account CHECK makes two legs one-per-account;
    //    the composite FK already makes orphan postings impossible.
    const unbalanced = await client.query(
      `SELECT t.txn_id, t.tenant_id,
              COUNT(p.posting_id)::int AS legs,
              COALESCE(SUM(p.amount_minor), 0)::text AS net
         FROM transactions t
         LEFT JOIN postings p ON p.txn_id = t.txn_id
        GROUP BY t.txn_id, t.tenant_id
       HAVING COUNT(p.posting_id) <> 2 OR COALESCE(SUM(p.amount_minor), 0) <> 0`
    )
    for (const row of unbalanced.rows) {
      discrepancies.push({
        type: 'unbalanced_transaction',
        tenant_id: row.tenant_id,
        txn_id: row.txn_id,
        detail: `legs=${row.legs} net=${row.net}`
      })
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  sendJson(res, 200, { ok: discrepancies.length === 0, discrepancies })
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, service: 'ledger' })
    return
  }
  if (req.method === 'GET' && url.pathname === '/balance') {
    await handleBalance(req, res)
    return
  }
  if (req.method === 'GET' && url.pathname === '/statement') {
    await handleStatement(req, res, url)
    return
  }
  if (req.method === 'POST' && url.pathname === '/adjustments') {
    await handleAdjustments(req, res)
    return
  }
  if (req.method === 'POST' && url.pathname === '/periods/close') {
    await handleClose(req, res)
    return
  }
  if (req.method === 'POST' && url.pathname === '/reconcile') {
    await handleReconcile(req, res)
    return
  }
  sendJson(res, 404, { error: 'not found' })
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    if (err instanceof HttpError) {
      // Flush the status to the client first, then drop the socket (the 413
      // path may still have an unconsumed request body streaming in).
      if (!res.headersSent) {
        res.writeHead(err.status, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ error: err.message }), () => req.destroy())
      }
      return
    }
    console.error('ledger: unhandled error', err)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
  })
})

server.listen(PORT, () => console.log(`ledger listening on :${PORT}`))

// The consumer runs as a spawnable child process from day one so the SIGKILL
// crash harness exercises the exact artifact production runs. DISABLE_CONSUMER
// is a test-only boot env (GAP-13): contract tests need an enqueued row to
// stay pending for inspection, so they serve HTTP without the worker.
if (process.env.DATABASE_URL && !process.env.DISABLE_CONSUMER) {
  const workerPath = fileURLToPath(new URL('./consumer-worker.ts', import.meta.url))
  const spawnWorker = () => {
    const worker = fork(workerPath)
    worker.on('exit', (code, signal) => {
      console.error(
        `consumer worker exited (code=${code}, signal=${signal}); respawning in 1s`
      )
      setTimeout(spawnWorker, 1000)
    })
  }
  spawnWorker()
}
