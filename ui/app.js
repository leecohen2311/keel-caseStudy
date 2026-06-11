// Argonav ledger console — a pure client of the existing APIs (Phase 9).
// Plain browser JS, no build step, no dependencies. Every action shows the
// exact request sent and the live response; nothing here can touch an
// invariant — the servers enforce everything.

'use strict'

const $ = (id) => document.getElementById(id)

// ---- config / identity ------------------------------------------------

function cfg() {
  return {
    ingest: $('cfg-ingest').value.replace(/\/$/, ''),
    ledger: $('cfg-ledger').value.replace(/\/$/, ''),
    tokens: {
      tenant_alpha: $('cfg-token-tenant_alpha').value.trim(),
      tenant_beta: $('cfg-token-tenant_beta').value.trim(),
      admin: $('cfg-token-admin').value.trim()
    },
    webhook: { keyId: $('cfg-wh-key').value.trim(), secret: $('cfg-wh-secret').value.trim() }
  }
}

const identity = () => $('identity').value
const tokenFor = (who) => cfg().tokens[who]

// ---- generic request runner + result rendering -------------------------

function badgeClass(status) {
  if (status >= 200 && status < 300) return 'badge--ok'
  if (status >= 500 || status === 0) return 'badge--danger'
  return 'badge--warn' // 4xx: amber — an expected, demonstrable rejection
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function truncToken(v) {
  return v.length > 28 ? `${v.slice(0, 16)}…${v.slice(-8)}` : v
}

// Perform the call and render { request, status badge, response } into the
// panel's result block. Returns the parsed body (or null).
async function run(resultId, { method, url, headers = {}, body = null }) {
  const el = $(resultId)
  el.hidden = false

  const shownHeaders = Object.entries(headers)
    .map(([k, v]) => `${k}: ${k.toLowerCase() === 'authorization' ? 'Bearer ' + truncToken(v.slice(7)) : v}`)
    .join('\n')
  const reqText = `${method} ${url}` + (shownHeaders ? `\n${shownHeaders}` : '') + (body ? `\n\n${body}` : '')

  let status = 0
  let text = ''
  const started = performance.now()
  try {
    const res = await fetch(url, { method, headers, body })
    status = res.status
    text = await res.text()
  } catch (err) {
    text = `network error: ${err.message}\n\nIs the stack up? docker compose up --build`
  }
  const ms = Math.round(performance.now() - started)

  let parsed = null
  let pretty = text
  try {
    parsed = JSON.parse(text)
    pretty = JSON.stringify(parsed, null, 2)
  } catch { /* leave raw */ }

  el.innerHTML = `
    <div class="result__req">${escapeHtml(reqText)}</div>
    <div class="result__status">
      <span class="badge ${badgeClass(status)}">${status === 0 ? '✕ UNREACHABLE' : '● ' + status}</span>
      <span class="result__time">${ms} ms · ${new Date().toISOString()}</span>
    </div>
    <pre class="result__body">${escapeHtml(pretty)}</pre>`
  return { status, body: parsed }
}

const jsonHeaders = (who) => ({
  authorization: `Bearer ${tokenFor(who)}`,
  'content-type': 'application/json'
})

// ---- helpers ------------------------------------------------------------

const newKey = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 13)}`

// Group an integer minor-unit string for display: '-12500' -> '−12,500'.
// Display-only; the API's exact string is always in the response block.
function fmtMinor(s) {
  const neg = String(s).startsWith('-')
  const digits = String(s).replace(/^-/, '')
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '−' : '') + grouped
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

// ---- 01 · submit usage --------------------------------------------------

$('ev-newkey').onclick = () => { $('ev-key').value = newKey('ui') }
$('ev-key').value = newKey('ui')

$('ev-send').onclick = () => {
  const who = identity()
  const body = {
    tenant: who, // the token is authoritative; a mismatch is the 403 demo
    metric: $('ev-metric').value,
    quantity: Number($('ev-quantity').value),
    idempotency_key: $('ev-key').value
  }
  if ($('ev-date').value.trim()) body.event_date = $('ev-date').value.trim()
  run('result-events', {
    method: 'POST',
    url: `${cfg().ingest}/events`,
    headers: jsonHeaders(who),
    body: JSON.stringify(body)
  })
}

// ---- 02 · signed webhook --------------------------------------------------

$('wh-newid').onclick = () => { $('wh-eventid').value = newKey('dlv') }
$('wh-eventid').value = newKey('dlv')

// HMAC-SHA256 hex via SubtleCrypto over `{timestamp}.{key_id}.{raw_body}` —
// the exact server-side string-to-sign. In-browser signing is a local test
// convenience: it requires the seeded dev secret pasted in the config panel.
async function hmacHex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

let lastDelivery = null

async function sendWebhook(delivery) {
  const { keyId } = cfg().webhook
  const r = await run('result-webhook', {
    method: 'POST',
    url: `${cfg().ingest}/webhooks/usage`,
    headers: {
      'content-type': 'application/json',
      'x-key-id': keyId,
      'x-timestamp': delivery.timestamp,
      'x-signature': delivery.signature
    },
    body: delivery.rawBody
  })
  $('wh-replay').disabled = false
  return r
}

$('wh-send').onclick = async () => {
  const { keyId, secret } = cfg().webhook
  const rawBody = JSON.stringify({
    event_id: $('wh-eventid').value,
    metric: $('wh-metric').value,
    quantity: Number($('wh-quantity').value)
  })
  const timestamp = $('wh-ts').value.trim() || String(Math.floor(Date.now() / 1000))
  const signature = await hmacHex(secret, `${timestamp}.${keyId}.${rawBody}`)
  lastDelivery = { rawBody, timestamp, signature }
  sendWebhook(lastDelivery)
}

// Byte-identical replay: same body, same timestamp, same signature. The
// server accepts it (202) but the ledger charges exactly once.
$('wh-replay').onclick = () => { if (lastDelivery) sendWebhook(lastDelivery) }

// ---- 03 · balance ---------------------------------------------------------

$('bal-fetch').onclick = async () => {
  const who = identity()
  const r = await run('result-balance', {
    method: 'GET',
    url: `${cfg().ledger}/balance`,
    headers: { authorization: `Bearer ${tokenFor(who)}` }
  })
  const ok = r.status === 200 && r.body && typeof r.body.balance_minor === 'string'
  $('balance-readout').hidden = !ok
  if (ok) $('balance-value').textContent = fmtMinor(r.body.balance_minor)
}

// ---- 04 · statement --------------------------------------------------------

$('st-period').value = currentMonth()

$('st-fetch').onclick = async () => {
  const who = identity()
  const period = $('st-period').value || currentMonth()
  const r = await run('result-statement', {
    method: 'GET',
    url: `${cfg().ledger}/statement?period=${encodeURIComponent(period)}`,
    headers: { authorization: `Bearer ${tokenFor(who)}` }
  })
  const tbl = $('statement-table')
  if (!(r.status === 200 && r.body && Array.isArray(r.body.lines))) {
    tbl.hidden = true
    return
  }
  const rows = r.body.lines.map((l) => `
    <tr>
      <td class="id" title="${escapeHtml(l.txn_id)}">${escapeHtml(String(l.txn_id))}</td>
      <td>${escapeHtml(l.kind)}</td>
      <td>${l.metric === null ? '—' : escapeHtml(l.metric)}</td>
      <td class="num">${l.quantity === null ? '—' : escapeHtml(fmtMinor(l.quantity))}</td>
      <td class="id">${escapeHtml(String(l.event_date))}</td>
      <td class="num">${escapeHtml(fmtMinor(l.amount_minor))}</td>
    </tr>`).join('')
  tbl.innerHTML = `
    <table>
      <thead><tr>
        <th>txn</th><th>kind</th><th>metric</th><th class="num">qty</th>
        <th>event date</th><th class="num">amount</th>
      </tr></thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="6" class="id">no lines in this period</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="5">TOTAL · ${escapeHtml(r.body.period)}</td>
        <td class="num">${escapeHtml(fmtMinor(r.body.total_minor))}</td>
      </tr></tfoot>
    </table>`
  tbl.hidden = false
}

// ---- 05 · adjustment ---------------------------------------------------------

$('adj-newkey').onclick = () => { $('adj-key').value = newKey('adj-ui') }
$('adj-key').value = newKey('adj-ui')

$('adj-send').onclick = () => {
  const who = identity() // as a tenant this is the 403 demo
  run('result-adjustments', {
    method: 'POST',
    url: `${cfg().ledger}/adjustments`,
    headers: jsonHeaders(who),
    body: JSON.stringify({
      tenant: $('adj-tenant').value,
      amount_minor: Number($('adj-amount').value),
      reason: $('adj-reason').value,
      idempotency_key: $('adj-key').value
    })
  })
}

// ---- 06 · close period ---------------------------------------------------------

$('cl-period').value = currentMonth()

$('cl-send').onclick = () => {
  const who = identity()
  run('result-close', {
    method: 'POST',
    url: `${cfg().ledger}/periods/close`,
    headers: jsonHeaders(who),
    body: JSON.stringify({ tenant: $('cl-tenant').value, period: $('cl-period').value })
  })
}

// ---- 07 · reconcile ---------------------------------------------------------

$('rec-run').onclick = async () => {
  const who = identity()
  const r = await run('result-reconcile', {
    method: 'POST',
    url: `${cfg().ledger}/reconcile`,
    headers: jsonHeaders(who),
    body: '{}'
  })
  const report = $('recon-report')
  if (!(r.status === 200 && r.body && Array.isArray(r.body.discrepancies))) {
    report.hidden = true
    return
  }
  if (r.body.ok) {
    report.innerHTML = `<div class="recon__clear">● ALL CLEAR — every tenant re-derived
      from the queue's done rows; 0 discrepancies</div>`
  } else {
    const rows = r.body.discrepancies.map((d) => `
      <tr class="flagged">
        <td><span class="badge badge--danger">▲ ${escapeHtml(d.type)}</span></td>
        <td class="id">${escapeHtml(d.tenant_id ?? '—')}</td>
        <td class="id">${escapeHtml(d.event_id ?? d.txn_id ?? '—')}</td>
        <td class="num">${d.expected !== undefined ? escapeHtml(fmtMinor(d.expected)) : '—'}</td>
        <td class="num">${d.posted !== undefined ? escapeHtml(fmtMinor(d.posted)) : '—'}</td>
        <td class="id">${escapeHtml(d.detail ?? '')}</td>
      </tr>`).join('')
    report.innerHTML = `
      <table>
        <thead><tr>
          <th>type</th><th>tenant</th><th>event / txn</th>
          <th class="num">expected</th><th class="num">posted</th><th>detail</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
  report.hidden = false
}

// ---- theme + url display ---------------------------------------------------------

$('theme-toggle').onclick = () => {
  const html = document.documentElement
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark'
}

function refreshUrls() {
  const c = cfg()
  $('svc-urls').textContent =
    `INGEST ${c.ingest.replace(/^https?:\/\//, '')} · LEDGER ${c.ledger.replace(/^https?:\/\//, '')}`
}
$('cfg-ingest').addEventListener('input', refreshUrls)
$('cfg-ledger').addEventListener('input', refreshUrls)
refreshUrls()
