import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import pg from 'pg'
import { verifyJwt, tenantOf } from '../auth.ts'
import { isCleanString } from '../validate.ts'
import { PRICE_BOOK } from '../ledger/pricebook.ts'

// Ingest: authenticate -> authorize -> validate -> enqueue, in that pinned
// order (GAP-4); a rejected request (400/401/403/409) writes no event_queue
// row, and the 202 is sent only after the queue row's transaction has
// committed. Connects as app_ingest: the column-level INSERT grant means
// `kind` always defaults to 'usage' and nothing financial is reachable even
// if this service is compromised.

const PORT = Number(process.env.PORT ?? 3001)
const DATABASE_URL = process.env.DATABASE_URL
const JWT_SECRET = process.env.JWT_SECRET // no default/fallback, pinned

// healthz is pure liveness (Phase 0 contract), so missing env degrades the
// API routes to 500 rather than failing the boot.
if (!DATABASE_URL) console.error('ingest: DATABASE_URL is not set; POST /events will fail')
if (!JWT_SECRET) console.error('ingest: JWT_SECRET is not set (no default); POST /events will fail')

const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 5 }) : null

const MAX_QUANTITY = 1_000_000_000_000 // 10^12, pinned validation bound
const MAX_BODY_BYTES = 256 * 1024
// event_id feeds UNIQUE(tenant_id, event_id); an unbounded key can overflow
// the btree index-row cap (~2.7KB) and turn a client error into a 500.
const MAX_IDEMPOTENCY_KEY_BYTES = 200

// Strict event_date shape: full timestamp with an explicit Z or ±HH:MM
// offset. Every string this accepts is parsed to the same instant by both
// JS Date and Postgres timestamptz; the divergent shapes (JS toString
// format, date-only, timezone-less, colon-less offset) are rejected up
// front so the pinned else-400 can never degrade into an INSERT-time 500.
const EVENT_DATE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

// Test-only crash injection, mirroring the consumer's CRASH_POINT: a real,
// uncatchable SIGKILL at a named boundary. Inert unless INGEST_CRASH_POINT
// is set (never in prod). See CONTRACT-GAPS GAP-6.
function crashIfRequested(point: string): void {
  if (process.env.INGEST_CRASH_POINT === point) process.kill(process.pid, 'SIGKILL')
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Dev-only CORS (Phase 9, gated Phase 11): the browser console under ui/ is
// a pure client on its own origin, so every response — including errors,
// which the console must be able to read to demo a 401/403 — carries
// permissive CORS headers, and OPTIONS preflights are answered 204. Enabled
// ONLY by ENABLE_DEV_CORS=1 (docker-compose.yml sets it for the console);
// off by default, so "dev-only" is enforced by mechanism, not by label. An
// additive header layer with no route logic.
const DEV_CORS_ENABLED = process.env.ENABLE_DEV_CORS === '1'
const CORS_HEADERS: Record<string, string> = DEV_CORS_ENABLED
  ? {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers':
        'Authorization, Content-Type, X-Key-Id, X-Timestamp, X-Signature'
    }
  : {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS_HEADERS })
  res.end(JSON.stringify(body))
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

// Pinned validation window, identical to the consumer's re-validation:
// event_date must fall in the open interval (now - 1y, now + 1d).
function eventDateInWindow(t: number): boolean {
  const now = Date.now()
  const yearMs = 365 * 24 * 60 * 60 * 1000
  const dayMs = 24 * 60 * 60 * 1000
  return Number.isFinite(t) && t > now - yearMs && t < now + dayMs
}

type EnqueueOutcome = 'created' | 'replay' | 'conflict'

// One explicit transaction so the 202 provably happens-after the COMMIT, and
// so the crash hook has a real built-but-uncommitted window to die in. A
// SIGKILL between INSERT and COMMIT drops the connection and rolls back:
// nothing enqueued, the client retry starts fresh (INV-3).
async function enqueue(
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
    // Pinned explicitly, mirroring the consumer: the conflict path below is
    // a block-then-reread pattern that depends on READ COMMITTED, so don't
    // inherit a changeable server default.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const inserted = await client.query(
      `INSERT INTO event_queue (tenant_id, event_id, payload, payload_hash, event_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING queue_id`,
      [row.tenantId, row.eventId, JSON.stringify(row.payload), row.payloadHash, row.eventDate]
    )
    crashIfRequested('before-enqueue-commit')
    if (inserted.rowCount === 1) {
      await client.query('COMMIT')
      return 'created'
    }
    // Conflict: the key already has a committed row (a concurrent uncommitted
    // insert blocks the ON CONFLICT arbitration until it resolves, so READ
    // COMMITTED sees it here). Queue rows are never deleted, so it exists.
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

async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!JWT_SECRET || !pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }

  // 1. Authenticate (401): Bearer token, HS256 pinned, exp enforced. Tenant
  //    scope is the verified tenant_id claim.
  const auth = req.headers.authorization
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
  const claims = token ? verifyJwt(token, JWT_SECRET) : null
  const tokenTenant = claims ? tenantOf(claims) : null
  if (!tokenTenant) {
    sendJson(res, 401, { error: 'unauthorized' })
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

  // 2. Authorize (403): the token is authoritative; a body.tenant naming
  //    anyone else is a cross-tenant write attempt (INV-4).
  if (typeof body.tenant === 'string' && body.tenant !== tokenTenant) {
    sendJson(res, 403, { error: 'body.tenant does not match the authenticated tenant' })
    return
  }

  // 3. Validate (400). GAP-8 pinned: tenant is a documented payload field, so
  //    a missing/non-string body.tenant is a missing required field, not a
  //    silent default to the token tenant.
  if (typeof body.tenant !== 'string' || !isCleanString(body.tenant)) {
    sendJson(res, 400, { error: 'tenant is required' })
    return
  }
  const metric = body.metric
  if (typeof metric !== 'string' || !Object.hasOwn(PRICE_BOOK, metric)) {
    sendJson(res, 400, { error: 'metric must be in the price book' })
    return
  }
  const quantity = body.quantity
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    sendJson(res, 400, { error: 'quantity must be an integer in [1, 10^12]' })
    return
  }
  const key = body.idempotency_key
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    !isCleanString(key) ||
    Buffer.byteLength(key, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    sendJson(res, 400, { error: 'idempotency_key must be a well-formed string of 1..200 bytes' })
    return
  }
  let eventDate: string
  if (body.event_date === undefined) {
    eventDate = new Date().toISOString()
  } else {
    if (
      typeof body.event_date !== 'string' ||
      !EVENT_DATE_RE.test(body.event_date) ||
      !eventDateInWindow(new Date(body.event_date).getTime())
    ) {
      sendJson(res, 400, { error: 'event_date must parse and fall in (now-1y, now+1d)' })
      return
    }
    eventDate = body.event_date // raw string through to timestamptz, no precision loss
  }

  // 4. Enqueue. The dedup key is namespaced at construction (api:) so it can
  //    never collide with a webhook delivery id or an adjustment key (INV-2).
  //    quantity rides as a JSON number (pinned: exact below 2^53). The hash
  //    covers the request's literal fields — the raw event_date or null, never
  //    the defaulted now(), so an identical retry hashes identically.
  const eventId = `api:${key}`
  const rawEventDate = typeof body.event_date === 'string' ? body.event_date : null
  const payloadHash = createHash('sha256')
    .update(JSON.stringify([metric, quantity, rawEventDate]))
    .digest('hex')

  const outcome = await enqueue(pool, {
    tenantId: tokenTenant,
    eventId,
    payload: { metric, quantity },
    payloadHash,
    eventDate
  })
  if (outcome === 'conflict') {
    sendJson(res, 409, { error: 'idempotency_key reused with a different payload' })
    return
  }
  // 'created' and 'replay' return the same response: an at-least-once client
  // retry replays the stored outcome (GAP-3: status is the contract).
  sendJson(res, 202, { accepted: true, event_id: eventId })
}

// Webhook freshness window, pinned (GAP-10): unix-seconds timestamp within
// 300s either side of server now. The timestamp is bound into the
// string-to-sign, so a captured delivery cannot be re-stamped fresh.
const WEBHOOK_FRESHNESS_SECONDS = 300

function headerString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!pool) {
    sendJson(res, 500, { error: 'service misconfigured' })
    return
  }

  // The signature covers the exact raw bytes, so read them before anything
  // parses or transforms the body (INV-8). Same 256 KiB cap as /events
  // (pinned), flushed as a 413 by the shared error path.
  const raw = await readBody(req, MAX_BODY_BYTES)

  // 1. Authenticate (401 for every failure mode — missing/empty headers,
  //    unknown key, bad signature, stale timestamp — indistinguishable, so
  //    the boundary leaks neither key existence nor which check failed).
  const keyId = headerString(req.headers['x-key-id'])
  const timestamp = headerString(req.headers['x-timestamp'])
  const signature = headerString(req.headers['x-signature'])
  if (!keyId || !timestamp || !signature) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  // Tenant identity is the owner of the verifying secret, never the body.
  const found = await pool.query(
    'SELECT tenant_id, secret FROM webhook_secrets WHERE key_id = $1',
    [keyId]
  )
  if (found.rowCount === 0) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  const { tenant_id: secretTenant, secret } = found.rows[0] as {
    tenant_id: string
    secret: string
  }

  // HMAC-SHA256 over `{timestamp}.{key_id}.{raw_body}` — the algorithm is
  // pinned HERE, server-side, never read from a header. Both sides are
  // lowercase-hex strings compared as bytes: a length check first
  // (timingSafeEqual throws on mismatch), and no lenient hex decode for a
  // forged signature to be malleable through.
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${keyId}.`).update(raw).digest('hex')
  )
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WEBHOOK_FRESHNESS_SECONDS) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  // 2. Only now parse and validate (400): the bytes are authentic. The body
  //    shape is pinned (GAP-11) and rates exactly like /events; body.tenant
  //    is deliberately ignored — the secret owner wins (INV-4).
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

  // The delivery id lives INSIDE the signed body; it feeds the same unique
  // index as an idempotency key, so it carries the same 1..200 byte bound.
  const deliveryId = body.event_id
  if (
    typeof deliveryId !== 'string' ||
    deliveryId.length === 0 ||
    !isCleanString(deliveryId) ||
    Buffer.byteLength(deliveryId, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    sendJson(res, 400, { error: 'event_id must be a well-formed string of 1..200 bytes' })
    return
  }
  const metric = body.metric
  if (typeof metric !== 'string' || !Object.hasOwn(PRICE_BOOK, metric)) {
    sendJson(res, 400, { error: 'metric must be in the price book' })
    return
  }
  const quantity = body.quantity
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    sendJson(res, 400, { error: 'quantity must be an integer in [1, 10^12]' })
    return
  }
  let eventDate: string
  if (body.event_date === undefined) {
    eventDate = new Date().toISOString()
  } else {
    if (
      typeof body.event_date !== 'string' ||
      !EVENT_DATE_RE.test(body.event_date) ||
      !eventDateInWindow(new Date(body.event_date).getTime())
    ) {
      sendJson(res, 400, { error: 'event_date must parse and fall in (now-1y, now+1d)' })
      return
    }
    eventDate = body.event_date
  }

  // 3. Enqueue exactly like /events. Dedup key wh:{key_id}:{delivery_id}
  //    (GAP-9): namespaced so it can never collide with an api: idempotency
  //    key, with the source segment binding it to the verifying secret. The
  //    consumer dedups at the ledger and posts; nothing is posted here.
  const eventId = `wh:${keyId}:${deliveryId}`
  const rawEventDate = typeof body.event_date === 'string' ? body.event_date : null
  const payloadHash = createHash('sha256')
    .update(JSON.stringify([metric, quantity, rawEventDate]))
    .digest('hex')

  const outcome = await enqueue(pool, {
    tenantId: secretTenant,
    eventId,
    payload: { metric, quantity },
    payloadHash,
    eventDate
  })
  if (outcome === 'conflict') {
    sendJson(res, 409, { error: 'delivery id reused with a different payload' })
    return
  }
  // 'created' and 'replay' both 202: an at-least-once provider retry is
  // deduped to the single stored row and charged exactly once at the ledger.
  sendJson(res, 202, { accepted: true, event_id: eventId })
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS' && DEV_CORS_ENABLED) {
    // Dev-only CORS preflight (Phase 9); see CORS_HEADERS above. With the
    // gate off, OPTIONS falls through to routing like any other method.
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { ok: true, service: 'ingest' })
    return
  }
  if (req.method === 'POST' && req.url === '/events') {
    await handleEvents(req, res)
    return
  }
  if (req.method === 'POST' && req.url === '/webhooks/usage') {
    await handleWebhook(req, res)
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
        res.writeHead(err.status, {
          'content-type': 'application/json',
          connection: 'close',
          ...CORS_HEADERS
        })
        res.end(JSON.stringify({ error: err.message }), () => req.destroy())
      }
      return
    }
    console.error('ingest: unhandled error', err)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
  })
})

server.listen(PORT, () => console.log(`ingest listening on :${PORT}`))
