// Argonav ledger console — a pure client of the existing APIs (Phase 9,
// hardened Phase 11). Plain browser JS, no build step, no dependencies.
// Every action shows the exact request sent and the live response; nothing
// here can touch an invariant — the servers enforce everything. All HTML
// built from wire data comes from the pure builders in render.js (loaded
// before this file), where every value is escaped — see
// test/phase-11/ui_render.test.ts for the XSS-inert proof.

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

// ---- generic request runner -------------------------------------------

// Disable the pressed button while its request is in flight so a double
// click cannot fire twice (the APIs are idempotent anyway — this is purely
// feedback).
async function withBusy(btn, fn) {
  btn.disabled = true
  btn.classList.add('btn--busy')
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.classList.remove('btn--busy')
  }
}

// Perform the call and render { request, status badge, response } into the
// panel's result block, with a visible loading state while in flight and
// clean states for network failure and non-JSON responses. Returns
// { status, body } (body null unless valid JSON).
async function run(resultId, { method, url, headers = {}, body = null }) {
  const el = $(resultId)
  el.hidden = false
  el.innerHTML = loadingHtml()

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
  let pretty = text === '' ? '(empty response body)' : text
  try {
    parsed = JSON.parse(text)
    pretty = JSON.stringify(parsed, null, 2)
  } catch { /* not JSON: show the raw text */ }

  el.innerHTML = resultHtml({ reqText, status, ms, when: new Date().toISOString(), bodyText: pretty })
  return { status, body: parsed }
}

const jsonHeaders = (who) => ({
  authorization: `Bearer ${tokenFor(who)}`,
  'content-type': 'application/json'
})

const newKey = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 13)}`

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

// ---- 01 · submit usage --------------------------------------------------

$('ev-newkey').onclick = () => { $('ev-key').value = newKey('ui') }
$('ev-key').value = newKey('ui')

$('ev-send').onclick = () => withBusy($('ev-send'), () => {
  const who = identity()
  const body = {
    tenant: who, // the token is authoritative; a mismatch is the 403 demo
    metric: $('ev-metric').value,
    quantity: Number($('ev-quantity').value),
    idempotency_key: $('ev-key').value
  }
  if ($('ev-date').value.trim()) body.event_date = $('ev-date').value.trim()
  return run('result-events', {
    method: 'POST',
    url: `${cfg().ingest}/events`,
    headers: jsonHeaders(who),
    body: JSON.stringify(body)
  })
})

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

$('wh-send').onclick = () => withBusy($('wh-send'), async () => {
  const { keyId, secret } = cfg().webhook
  const rawBody = JSON.stringify({
    event_id: $('wh-eventid').value,
    metric: $('wh-metric').value,
    quantity: Number($('wh-quantity').value)
  })
  const timestamp = $('wh-ts').value.trim() || String(Math.floor(Date.now() / 1000))
  const signature = await hmacHex(secret, `${timestamp}.${keyId}.${rawBody}`)
  lastDelivery = { rawBody, timestamp, signature }
  return sendWebhook(lastDelivery)
})

// Byte-identical replay: same body, same timestamp, same signature. The
// server accepts it (202) but the ledger charges exactly once.
$('wh-replay').onclick = () => {
  if (lastDelivery) withBusy($('wh-replay'), () => sendWebhook(lastDelivery))
}

// ---- 03 · balance ---------------------------------------------------------

$('bal-fetch').onclick = () => withBusy($('bal-fetch'), async () => {
  const who = identity()
  const r = await run('result-balance', {
    method: 'GET',
    url: `${cfg().ledger}/balance`,
    headers: { authorization: `Bearer ${tokenFor(who)}` }
  })
  const ok = r.status === 200 && r.body && typeof r.body.balance_minor === 'string'
  $('balance-readout').hidden = !ok
  if (ok) $('balance-value').textContent = fmtMinor(r.body.balance_minor)
})

// ---- 04 · statement --------------------------------------------------------

$('st-period').value = currentMonth()

$('st-fetch').onclick = () => withBusy($('st-fetch'), async () => {
  const who = identity()
  const period = $('st-period').value || currentMonth()
  const r = await run('result-statement', {
    method: 'GET',
    url: `${cfg().ledger}/statement?period=${encodeURIComponent(period)}`,
    headers: { authorization: `Bearer ${tokenFor(who)}` }
  })
  const tbl = $('statement-table')
  if (!(r.status === 200 && r.body && Array.isArray(r.body.lines))) {
    tbl.hidden = true // the result block above shows the error state
    return
  }
  tbl.innerHTML = statementTableHtml(r.body)
  tbl.hidden = false
})

// ---- 05 · adjustment ---------------------------------------------------------

$('adj-newkey').onclick = () => { $('adj-key').value = newKey('adj-ui') }
$('adj-key').value = newKey('adj-ui')

$('adj-send').onclick = () => withBusy($('adj-send'), () => {
  const who = identity() // as a tenant this is the 403 demo
  return run('result-adjustments', {
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
})

// ---- 06 · close period ---------------------------------------------------------

$('cl-period').value = currentMonth()

$('cl-send').onclick = () => withBusy($('cl-send'), () => {
  const who = identity()
  return run('result-close', {
    method: 'POST',
    url: `${cfg().ledger}/periods/close`,
    headers: jsonHeaders(who),
    body: JSON.stringify({ tenant: $('cl-tenant').value, period: $('cl-period').value })
  })
})

// ---- 07 · reconcile ---------------------------------------------------------

$('rec-run').onclick = () => withBusy($('rec-run'), async () => {
  const who = identity()
  const r = await run('result-reconcile', {
    method: 'POST',
    url: `${cfg().ledger}/reconcile`,
    headers: jsonHeaders(who),
    body: '{}'
  })
  const report = $('recon-report')
  if (!(r.status === 200 && r.body && Array.isArray(r.body.discrepancies))) {
    report.hidden = true // the result block above shows the error state
    return
  }
  report.innerHTML = reconReportHtml(r.body)
  report.hidden = false
})

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
