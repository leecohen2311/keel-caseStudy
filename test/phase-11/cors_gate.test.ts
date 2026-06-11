import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { startIngest } from '../helpers/ingest-server.ts'
import { startLedger } from '../helpers/ledger-server.ts'
import type { Service } from '../helpers/ledger-server.ts'

// Phase 11 — the dev-CORS gate. Phase 9 shipped the permissive CORS layer
// unconditionally with a "dev-only" label; this suite makes the label
// mechanical: both services attach Access-Control-* headers and answer
// OPTIONS preflights ONLY when ENABLE_DEV_CORS=1 (docker-compose.yml sets it
// for the browser console), and are CORS-silent by default — so the
// permissive headers cannot ship anywhere by accident. The full enabled-mode
// contract (preflight header set, error readability) stays pinned by
// test/phase-9/ui_smoke.test.ts, which now opts in explicitly.

let ingestOff: Service
let ledgerOff: Service
let ingestOn: Service
let ledgerOn: Service

beforeAll(async () => {
  ;[ingestOff, ledgerOff, ingestOn, ledgerOn] = await Promise.all([
    startIngest({ port: 3171 }),
    startLedger({ port: 3172 }),
    startIngest({ port: 3173, extraEnv: { ENABLE_DEV_CORS: '1' } }),
    startLedger({ port: 3174, extraEnv: { ENABLE_DEV_CORS: '1' } })
  ])
})

afterAll(async () => {
  await Promise.all([ingestOff.stop(), ledgerOff.stop(), ingestOn.stop(), ledgerOn.stop()])
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

describe('phase 11: dev CORS is OFF by default (no env flag)', () => {
  test('ingest: OPTIONS /events is not a 204 preflight and carries no allow-origin', async () => {
    const res = await preflight(`${ingestOff.baseUrl}/events`, 'POST')
    expect(res.status).not.toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-headers')).toBeNull()
  })

  test('ingest: a real (401) response carries no allow-origin', async () => {
    const res = await fetch(`${ingestOff.baseUrl}/events`, {
      method: 'POST',
      headers: { origin: 'http://localhost:8080', 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('ledger: OPTIONS /balance is not a 204 preflight and carries no allow-origin', async () => {
    const res = await preflight(`${ledgerOff.baseUrl}/balance`, 'GET')
    expect(res.status).not.toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('ledger: a real (401) response carries no allow-origin', async () => {
    const res = await fetch(`${ledgerOff.baseUrl}/balance`, {
      headers: { origin: 'http://localhost:8080' }
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('phase 11: ENABLE_DEV_CORS=1 turns the dev layer on (the compose path)', () => {
  test('ingest: preflight 204 with the permissive header set', async () => {
    const res = await preflight(`${ingestOn.baseUrl}/events`, 'POST')
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('ledger: a 401 stays readable by the browser console (allow-origin present)', async () => {
    const res = await fetch(`${ledgerOn.baseUrl}/balance`, {
      headers: { origin: 'http://localhost:8080' }
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
