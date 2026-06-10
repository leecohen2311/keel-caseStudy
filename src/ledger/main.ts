import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { verifyJwt, tenantOf } from '../auth.ts'
import { periodKeyOf } from './consumer.ts'

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
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
  sendJson(res, 404, { error: 'not found' })
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
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
