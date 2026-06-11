import { describe, test, expect } from 'vitest'
import { createRequire } from 'node:module'

// Phase 11 — the console's render layer must be XSS-inert. Every HTML
// fragment the console builds from wire data goes through the pure builders
// in ui/render.js (a classic browser script with a CommonJS guard so this
// suite can require it — still no build step). These tests feed API
// responses whose every field carries hostile markup and assert the output
// is inert: server values must never reach the page as live HTML, no matter
// what an endpoint (or a tampered response) returns.

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../../ui/render.js')

const SCRIPT = '<script>alert(1)</script>'
const IMG = '<img src=x onerror=alert(1)>'

describe('phase 11: escapeHtml', () => {
  test('neutralizes angle brackets, ampersands, and both quote styles', () => {
    expect(R.escapeHtml(SCRIPT)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(R.escapeHtml(`"'&`)).not.toMatch(/["']/)
    expect(R.escapeHtml(`"'&`)).toContain('&amp;')
  })
})

describe('phase 11: statement table renders hostile wire data inert', () => {
  const hostileBody = {
    period: '<s>2026-06</s>',
    total_minor: '<b>1</b>',
    lines: [
      {
        txn_id: IMG,
        kind: SCRIPT,
        metric: `">${SCRIPT}`,
        quantity: '12<i>3</i>',
        event_date: '<svg onload=alert(1)>',
        amount_minor: SCRIPT
      }
    ]
  }

  test('no tag from any field survives into the markup', () => {
    const html = R.statementTableHtml(hostileBody)
    for (const live of ['<script', '<img', '<svg', '<b>', '<i>', '<s>']) {
      expect(html, `live ${live} leaked`).not.toContain(live)
    }
    expect(html).toContain('&lt;script&gt;')
  })

  test('a null metric/quantity line (an adjustment) renders the em-dash, inert', () => {
    const html = R.statementTableHtml({
      period: '2026-06',
      total_minor: '-250',
      lines: [
        {
          txn_id: 't',
          kind: 'adjustment',
          metric: null,
          quantity: null,
          event_date: 'd',
          amount_minor: '-250'
        }
      ]
    })
    expect(html).toContain('—')
    expect(html).toContain('−250')
  })

  test('an empty statement renders the empty state, not a blank panel', () => {
    const html = R.statementTableHtml({ period: '2026-06', total_minor: '0', lines: [] })
    expect(html).toContain('no lines in this period')
  })
})

describe('phase 11: reconcile report renders hostile wire data inert', () => {
  test('hostile discrepancy fields are escaped everywhere they land', () => {
    const html = R.reconReportHtml({
      ok: false,
      discrepancies: [
        {
          type: SCRIPT,
          tenant_id: IMG,
          event_id: `">${SCRIPT}`,
          expected: '10<b>0</b>',
          posted: SCRIPT,
          detail: '<svg onload=alert(1)>'
        }
      ]
    })
    for (const live of ['<script', '<img', '<svg', '<b>']) {
      expect(html, `live ${live} leaked`).not.toContain(live)
    }
    expect(html).toContain('&lt;script&gt;')
  })

  test('ok:true renders the all-clear state', () => {
    expect(R.reconReportHtml({ ok: true, discrepancies: [] })).toContain('ALL CLEAR')
  })
})

describe('phase 11: the request/response result block is inert', () => {
  test('hostile request text and response body are escaped', () => {
    const html = R.resultHtml({
      reqText: `POST /events\nx-evil: ${SCRIPT}`,
      status: 400,
      ms: 12,
      when: '2026-06-10T00:00:00.000Z',
      bodyText: `{"error":"${SCRIPT}"}`
    })
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('● 400')
  })

  test('a network failure (status 0) renders the unreachable state', () => {
    const html = R.resultHtml({
      reqText: 'GET /balance',
      status: 0,
      ms: 3,
      when: 'now',
      bodyText: `network error: ${SCRIPT}`
    })
    expect(html).toContain('UNREACHABLE')
    expect(html).not.toContain('<script')
  })

  test('the loading state exists and is static markup', () => {
    expect(R.loadingHtml()).toContain('result__loading')
  })
})

describe('phase 11: display helpers stay display-only and safe', () => {
  test('fmtMinor groups integer strings and passes non-numeric input through untouched', () => {
    expect(R.fmtMinor('-12500')).toBe('−12,500')
    expect(R.fmtMinor('1234567')).toBe('1,234,567')
    expect(R.fmtMinor(SCRIPT)).toBe(SCRIPT) // escaping is the renderer's job
  })

  test('badgeClass maps 2xx ok / 4xx warn / 5xx+network danger', () => {
    expect(R.badgeClass(202)).toBe('badge--ok')
    expect(R.badgeClass(409)).toBe('badge--warn')
    expect(R.badgeClass(500)).toBe('badge--danger')
    expect(R.badgeClass(0)).toBe('badge--danger')
  })
})
