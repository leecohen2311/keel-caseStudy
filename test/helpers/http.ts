// Thin HTTP client over global fetch (Node 24). Black-box: tests assert on the
// status code and parsed body only, never on internal handlers.

export interface HttpResponse {
  status: number
  body: unknown
  text: string
}

export interface ReqOpts {
  token?: string
  headers?: Record<string, string>
}

function withAuth(opts: ReqOpts): Record<string, string> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  return headers
}

async function parse(res: Response): Promise<HttpResponse> {
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { status: res.status, body, text }
}

export async function postJson(
  url: string,
  json: unknown,
  opts: ReqOpts = {}
): Promise<HttpResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...withAuth(opts) },
    body: JSON.stringify(json)
  })
  return parse(res)
}

// Send a body verbatim (no JSON.stringify, no forced content-type). Needed by
// the webhook tests, which must sign and transmit exact raw bytes.
export async function postRaw(
  url: string,
  rawBody: string,
  opts: ReqOpts = {}
): Promise<HttpResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...withAuth(opts) },
    body: rawBody
  })
  return parse(res)
}

export async function getJson(url: string, opts: ReqOpts = {}): Promise<HttpResponse> {
  const res = await fetch(url, { method: 'GET', headers: withAuth(opts) })
  return parse(res)
}
