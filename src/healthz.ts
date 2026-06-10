import { createServer, type Server } from 'node:http'

// Pure liveness: no database dependency.
export function startHealthServer(service: string, port: number): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  server.listen(port, () => console.log(`${service} listening on :${port}`))
  return server
}
