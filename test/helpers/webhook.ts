// Webhook signing helper (Phase 4). Implements the pinned wire contract so the
// tests can produce valid AND adversarial deliveries:
//   headers: X-Key-Id, X-Timestamp, X-Signature
//   string-to-sign = `{timestamp}.{key_id}.{raw_body}`, HMAC-SHA256
//   the delivery id lives INSIDE the signed body (the `event_id` field)
//   tenant = owner of the secret found by X-Key-Id (never the body)
// Signature encoding (hex) and timestamp format (unix seconds) are assumed —
// see CONTRACT-GAPS GAP-10. The body shape is assumed — see GAP-11.
import { createHmac, randomUUID } from 'node:crypto'

export interface SignedDelivery {
  rawBody: string
  headers: Record<string, string>
  deliveryId: string
  keyId: string
  body: Record<string, unknown>
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// Sign an exact raw body under a key's secret. timestamp defaults to now (fresh).
export function signWebhook(opts: {
  keyId: string
  secret: string
  rawBody: string
  timestamp?: string
}): { headers: Record<string, string> } {
  const timestamp = opts.timestamp ?? String(nowSec())
  const stringToSign = `${timestamp}.${opts.keyId}.${opts.rawBody}`
  const signature = createHmac('sha256', opts.secret).update(stringToSign).digest('hex')
  return {
    headers: {
      'content-type': 'application/json',
      'X-Key-Id': opts.keyId,
      'X-Timestamp': timestamp,
      'X-Signature': signature
    }
  }
}

// Build a usage delivery (raw body + signed headers) for a given key/secret.
// `deliveryId` is the body `event_id`; `bodyTenant` (ignored by the server) lets
// tests prove the secret owner wins over the body.
export function makeUsageDelivery(opts: {
  keyId: string
  secret: string
  deliveryId?: string
  metric?: string
  quantity?: number
  eventDate?: string
  bodyTenant?: string
  timestamp?: string
}): SignedDelivery {
  const deliveryId = opts.deliveryId ?? randomUUID()
  const body: Record<string, unknown> = {
    event_id: deliveryId,
    metric: opts.metric ?? 'api_call',
    quantity: opts.quantity ?? 1
  }
  if (opts.eventDate) body.event_date = opts.eventDate
  if (opts.bodyTenant) body.tenant = opts.bodyTenant
  const rawBody = JSON.stringify(body)
  const { headers } = signWebhook({
    keyId: opts.keyId,
    secret: opts.secret,
    rawBody,
    timestamp: opts.timestamp
  })
  return { rawBody, headers, deliveryId, keyId: opts.keyId, body }
}
