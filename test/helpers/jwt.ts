// Hand-rolled HS256 JWT minting for the test harness. Deliberately NOT a
// library: the adversarial tests need to forge tokens a well-behaved library
// refuses to produce (alg:none, an exp in the past, a signature under the wrong
// secret). The server is expected to verify HS256 with the JWT_SECRET env var,
// reject alg:none / algorithm confusion, and enforce exp (ARCHITECTURE.md §6,
// MEMORY.md). See CONTRACT-GAPS.md GAP-1: the secret env var name and full
// claim shape are assumed here and must be pinned.
import { createHmac } from 'node:crypto'

// The secret the spawned ingest/ledger servers are started with (helpers spawn
// them with JWT_SECRET=TEST_JWT_SECRET), so tokens minted here verify.
export const TEST_JWT_SECRET = 'test_jwt_secret_dev'

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export interface SignOpts {
  secret?: string
  header?: Record<string, unknown>
}

// Low-level: sign an arbitrary payload (and optionally a tampered header).
export function sign(payload: Record<string, unknown>, opts: SignOpts = {}): string {
  const header = opts.header ?? { alg: 'HS256', typ: 'JWT' }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const sig = createHmac('sha256', opts.secret ?? TEST_JWT_SECRET)
    .update(signingInput)
    .digest('base64url')
  return `${signingInput}.${sig}`
}

// A valid tenant token: tenant scope in the `tenant_id` claim (pinned), exp +1h.
export function tenantToken(
  tenantId: string,
  opts: { exp?: number; secret?: string } = {}
): string {
  const iat = nowSec()
  return sign(
    { tenant_id: tenantId, iat, exp: opts.exp ?? iat + 3600 },
    { secret: opts.secret }
  )
}

// An admin token. Admin is "a distinct check, not merely a valid tenant token"
// (INV-6). The exact admin claim is NOT pinned — see CONTRACT-GAPS.md GAP-7.
// Assumed shape: an `admin: true` claim. Used by Phase 6/7 tests.
export function adminToken(opts: { tenantId?: string; exp?: number; secret?: string } = {}): string {
  const iat = nowSec()
  const payload: Record<string, unknown> = { admin: true, iat, exp: opts.exp ?? iat + 3600 }
  if (opts.tenantId) payload.tenant_id = opts.tenantId
  return sign(payload, { secret: opts.secret })
}

// --- forged / malformed tokens for the adversarial auth tests ---

// exp in the past; otherwise a well-formed, correctly-signed tenant token.
export function expiredTenantToken(tenantId: string): string {
  return tenantToken(tenantId, { exp: nowSec() - 60 })
}

// alg:none — header claims no signature, signature segment empty. Must be
// rejected (the algorithm is pinned server-side, never read from the header).
export function algNoneToken(tenantId: string): string {
  const iat = nowSec()
  const header = { alg: 'none', typ: 'JWT' }
  const payload = { tenant_id: tenantId, iat, exp: iat + 3600 }
  return `${b64url(header)}.${b64url(payload)}.`
}

// Correct algorithm, wrong key: a signature the server's secret cannot verify.
export function wrongSecretToken(tenantId: string): string {
  return tenantToken(tenantId, { secret: 'not_the_real_secret' })
}
