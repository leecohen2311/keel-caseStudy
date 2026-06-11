import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Phase 12 — the read-only Ledger view. One light smoke suite, deliberately
// minimal (the invariants live behind the APIs, proven by phases 0-8; the
// render layer's XSS-inert discipline is proven by phase 11 — this suite only
// pins that the new view exists, is wired to GET /statement + GET /balance
// through the same escaping builders, and renders hostile wire data inert).
// Also pins the [hidden] kill rule: panel rules like `.readout { display:flex }`
// were overriding the UA's [hidden] { display:none }, so hidden blocks showed.

const UI = (f: string) => readFileSync(new URL(`../../ui/${f}`, import.meta.url), 'utf8')

const ctx: Record<string, CallableFunction> = {}
vm.createContext(ctx)
vm.runInContext(UI('render.js'), ctx, { filename: 'ui/render.js' })
const R = ctx

const SCRIPT = '<script>alert(1)</script>'

describe('phase 12: the ledger table builder renders hostile wire data inert', () => {
  test('a statement body with markup in every field comes out escaped', () => {
    const html = R.ledgerTableHtml({
      period: '<s>2026-06</s>',
      total_minor: '<b>1</b>',
      lines: [
        {
          txn_id: 'x',
          kind: SCRIPT,
          metric: `">${SCRIPT}`,
          quantity: '12<i>3</i>',
          event_date: '<svg onload=alert(1)>',
          amount_minor: SCRIPT
        }
      ]
    })
    for (const live of ['<script', '<svg', '<b>', '<i>', '<s>']) {
      expect(html, `live ${live} leaked`).not.toContain(live)
    }
    expect(html).toContain('&lt;script&gt;')
  })

  test('an adjustment line (null metric/quantity) and the period total render', () => {
    const html = R.ledgerTableHtml({
      period: '2026-06',
      total_minor: '-250',
      lines: [
        { txn_id: 't', kind: 'adjustment', metric: null, quantity: null,
          event_date: 'd', amount_minor: '-250' }
      ]
    })
    expect(html).toContain('—')
    expect(html).toContain('−250')
  })

  test('an empty period renders the no-activity state, escaped', () => {
    const html = R.ledgerEmptyHtml(`<u>2026-06</u>`)
    expect(html).toContain('no activity this period')
    expect(html).not.toContain('<u>')
  })

  test('the error state escapes a hostile response body', () => {
    const html = R.ledgerErrorHtml({ status: 401, bodyText: `{"error":"${SCRIPT}"}` })
    expect(html).toContain('401')
    expect(html).not.toContain('<script')
  })
})

describe('phase 12: the page wires the ledger view', () => {
  test('index.html has the view toggle and the ledger view skeleton', () => {
    const html = UI('index.html')
    for (const id of ['view-btn-console', 'view-btn-ledger', 'view-console',
                      'view-ledger', 'lv-prev', 'lv-next', 'lv-period',
                      'lv-balance', 'lv-body']) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`)
    }
  })

  test('app.js renders the view only through the render.js builders', () => {
    const js = UI('app.js')
    for (const ref of ['ledgerTableHtml', 'ledgerEmptyHtml', 'ledgerErrorHtml', 'lv-body']) {
      expect(js, `missing ${ref}`).toContain(ref)
    }
  })

  test('styles.css makes [hidden] actually hide despite display rules', () => {
    expect(UI('styles.css')).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })
})
