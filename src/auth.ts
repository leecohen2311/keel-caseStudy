import { createHmac, timingSafeEqual } from 'node:crypto'

// HS256 JWT verification, hand-rolled on node:crypto (no jwt dependency).
// The algorithm is pinned HERE, server-side: verification always recomputes
// HMAC-SHA256 and never reads `alg` from the token header, so alg:none and
// algorithm-confusion tokens fail the signature check like any other forgery
// (ARCHITECTURE §6, MEMORY "Auth (JWT)"). Shared: Ingest uses it now, the
// Ledger admin/read routes use it in Phases 5-6.

export type Claims = Record<string, unknown>

export function verifyJwt(token: string, secret: string): Claims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  const given = Buffer.from(signature, 'base64url')
  // Strict decode: Buffer.from is lenient (skips invalid chars), so require
  // the segment to be canonical base64url — closes signature malleability.
  if (given.toString('base64url') !== signature) return null
  // Length check first: timingSafeEqual throws on mismatched lengths, and an
  // alg:none token arrives with an empty signature segment.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null

  // exp is required and enforced (numeric seconds since epoch, pinned claim
  // shape { tenant_id, iat, exp }).
  const exp = (claims as Claims).exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (Math.floor(Date.now() / 1000) >= exp) return null

  return claims as Claims
}

// Tenant scope comes from the verified claim, never a request field (INV-4).
export function tenantOf(claims: Claims): string | null {
  const t = claims.tenant_id
  return typeof t === 'string' && t.length > 0 ? t : null
}
