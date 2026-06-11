import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { makePool, newTenant, sweepPending } from '../helpers/db.ts'
import { tenantToken } from '../helpers/jwt.ts'
import { startIngest } from '../helpers/ingest-server.ts'
import { startLedger } from '../helpers/ledger-server.ts'
import type { Service } from '../helpers/ledger-server.ts'

// Phase 9 — the browser console. Two thin layers under test, deliberately
// light (UI tests are low-value by design; the invariants live behind the
// APIs, which the phase 0-8 suites already prove):
//
// 1. CORS (real server behavior): the UI is a pure browser client on its own
//    origin, so both services need dev-only permissive CORS — an OPTIONS
//    preflight and Access-Control-Allow-* on every response, including error
//    responses (the browser cannot read a 401/403 demo without them).
//    Since Phase 11 the layer is gated behind ENABLE_DEV_CORS=1 (the compose
//    stack sets it); this suite opts in and pins the enabled-mode contract,
//    while test/phase-11/cors_gate.test.ts pins the off-by-default behavior.
// 2. Page wiring (static smoke): the front end exists, has one panel per
//    feature, an identity switcher, and calls every endpoint plus
//    SubtleCrypto for the in-browser webhook signature.

const UI_DIR = fileURLToPath(new URL('../../ui/', import.meta.url))

let owner: pg.Pool
let ingestSvc: Service
let ledgerSvc: Service

beforeAll(async () => {
  owner = makePool('owner')
  await sweepPending(owner)
  ingestSvc = await startIngest({ port: 3161, extraEnv: { ENABLE_DEV_CORS: '1' } })
  ledgerSvc = await startLedger({ port: 3162, extraEnv: { ENABLE_DEV_CORS: '1' } })
})

afterAll(async () => {
  await ingestSvc.stop()
  await ledgerSvc.stop()
  await owner.end()
})

function preflight(url: string, method: string) {
  return fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:8080',
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization, content-type'
    }
  })
}

describe('phase 9: dev-only CORS on the ingest service', () => {
  test('OPTIONS /events preflight: 204 with permissive allow headers', async () => {
    const res = await preflight(`${ingestSvc.baseUrl}/events`, 'POST')
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const h of ['authorization', 'content-type', 'x-key-id', 'x-timestamp', 'x-signature']) {
      expect(allowed).toContain(h)
    }
  })

  test('error responses carry allow-origin too (the browser must read the 401 demo)', async () => {
    const res = await fetch(`${ingestSvc.baseUrl}/events`, {
      method: 'POST',
      headers: { origin: 'http://localhost:8080', 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('phase 9: dev-only CORS on the ledger service', () => {
  test('OPTIONS /balance preflight: 204 with permissive allow headers', async () => {
    const res = await preflight(`${ledgerSvc.baseUrl}/balance`, 'GET')
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
  })

  test('a normal authenticated read carries allow-origin', async () => {
    const t = await newTenant(owner)
    const res = await fetch(`${ledgerSvc.baseUrl}/balance`, {
      headers: {
        origin: 'http://localhost:8080',
        authorization: `Bearer ${tenantToken(t)}`
      }
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('phase 9: the console page exists and wires every feature', () => {
  test('index.html has the identity switcher and one panel per feature', async () => {
    const html = await readFile(`${UI_DIR}index.html`, 'utf8')
    expect(html).toContain('id="identity"')
    for (const panel of [
      'panel-events',
      'panel-webhook',
      'panel-balance',
      'panel-statement',
      'panel-adjustments',
      'panel-close',
      'panel-reconcile'
    ]) {
      expect(html, `missing ${panel}`).toContain(`id="${panel}"`)
    }
    expect(html).toContain('app.js')
  })

  test('app.js calls every endpoint and signs webhooks with SubtleCrypto', async () => {
    const js = await readFile(`${UI_DIR}app.js`, 'utf8')
    for (const path of [
      '/events',
      '/webhooks/usage',
      '/balance',
      '/statement',
      '/adjustments',
      '/periods/close',
      '/reconcile'
    ]) {
      expect(js, `missing call to ${path}`).toContain(path)
    }
    expect(js).toContain('crypto.subtle')
  })
})
