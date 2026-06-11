// Argonav ledger console — pure HTML builders (Phase 11).
// Every fragment the console inserts into the page is built here, and every
// wire value — API responses, echoed errors, user input — passes through
// escapeHtml before it can reach markup. The functions are pure
// (data in, string out) so test/phase-11/ui_render.test.ts can feed them
// hostile payloads and prove the output inert. Classic browser script, no
// build step: in the page these land on the global scope, and the test
// runner evaluates this file in a vm context the same way.

'use strict'

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]))
}

// Group an integer minor-unit string for display: '-12500' -> '−12,500'.
// Display-only; anything that is not a plain integer string passes through
// untouched (the renderer escapes it like every other wire value), and the
// API's exact string is always visible in the response block.
function fmtMinor(s) {
  const str = String(s)
  if (!/^-?\d+$/.test(str)) return str
  const neg = str.startsWith('-')
  const grouped = str.replace(/^-/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '−' : '') + grouped
}

function truncToken(v) {
  return v.length > 28 ? `${v.slice(0, 16)}…${v.slice(-8)}` : v
}

function badgeClass(status) {
  if (status >= 200 && status < 300) return 'badge--ok'
  if (status >= 500 || status === 0) return 'badge--danger'
  return 'badge--warn' // 4xx: amber — an expected, demonstrable rejection
}

// The in-flight state shown while a request runs.
function loadingHtml() {
  return '<div class="result__loading"><span class="result__pulse"></span>contacting service…</div>'
}

// The request/response block: exact request, status badge, timing, body.
function resultHtml({ reqText, status, ms, when, bodyText }) {
  const badge = status === 0 ? '✕ UNREACHABLE' : '● ' + status
  return `
    <div class="result__req">${escapeHtml(reqText)}</div>
    <div class="result__status">
      <span class="badge ${badgeClass(status)}">${escapeHtml(badge)}</span>
      <span class="result__time">${escapeHtml(`${ms} ms · ${when}`)}</span>
    </div>
    <pre class="result__body">${escapeHtml(bodyText)}</pre>`
}

// The statement table. `body` is the parsed GET /statement response.
function statementTableHtml(body) {
  const rows = body.lines.map((l) => `
    <tr>
      <td class="id" title="${escapeHtml(l.txn_id)}">${escapeHtml(String(l.txn_id))}</td>
      <td>${escapeHtml(l.kind)}</td>
      <td>${l.metric === null ? '—' : escapeHtml(l.metric)}</td>
      <td class="num">${l.quantity === null ? '—' : escapeHtml(fmtMinor(l.quantity))}</td>
      <td class="id">${escapeHtml(String(l.event_date))}</td>
      <td class="num">${escapeHtml(fmtMinor(l.amount_minor))}</td>
    </tr>`).join('')
  return `
    <table>
      <thead><tr>
        <th>txn</th><th>kind</th><th>metric</th><th class="num">qty</th>
        <th>event date</th><th class="num">amount</th>
      </tr></thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="6" class="id statement__empty">no lines in this period</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="5">TOTAL · ${escapeHtml(body.period)}</td>
        <td class="num">${escapeHtml(fmtMinor(body.total_minor))}</td>
      </tr></tfoot>
    </table>`
}

// The reconcile report. `body` is the parsed POST /reconcile response.
function reconReportHtml(body) {
  if (body.ok) {
    return `<div class="recon__clear">● ALL CLEAR — every tenant re-derived
      from the queue's done rows; 0 discrepancies</div>`
  }
  const rows = body.discrepancies.map((d) => `
    <tr class="flagged">
      <td><span class="badge badge--danger">▲ ${escapeHtml(d.type)}</span></td>
      <td class="id">${escapeHtml(d.tenant_id ?? '—')}</td>
      <td class="id">${escapeHtml(d.event_id ?? d.txn_id ?? '—')}</td>
      <td class="num">${d.expected !== undefined ? escapeHtml(fmtMinor(d.expected)) : '—'}</td>
      <td class="num">${d.posted !== undefined ? escapeHtml(fmtMinor(d.posted)) : '—'}</td>
      <td class="id">${escapeHtml(d.detail ?? '')}</td>
    </tr>`).join('')
  return `
    <table>
      <thead><tr>
        <th>type</th><th>tenant</th><th>event / txn</th>
        <th class="num">expected</th><th class="num">posted</th><th>detail</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
}
