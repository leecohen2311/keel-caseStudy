// Spawn the real Ingest service as a child process and talk to it over HTTP
// (black-box). Mirrors the Phase 2 worker-spawn pattern (process.execPath runs
// .ts directly under Node 24). The service is started with the env it is
// expected to read — PORT, DATABASE_URL (app_ingest), JWT_SECRET. The
// DATABASE_URL + PORT contract is already established (Phase 0/2); JWT_SECRET is
// new — see CONTRACT-GAPS.md GAP-2.
import { spawn, type ChildProcess } from 'node:child_process'
import { connStr } from './db.ts'
import { TEST_JWT_SECRET } from './jwt.ts'

export interface Service {
  baseUrl: string
  stop: () => Promise<void>
}

function waitExit(child: ChildProcess): Promise<void> {
  // Exit-safe: if the child already died (e.g. a crash-point SIGKILL fired
  // mid-request), 'exit' will never fire again — resolve immediately.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

async function waitHealthy(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`)
      if (res.status === 200) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`ingest service did not become healthy at ${baseUrl}`)
}

export async function startIngest(opts: { port?: number; extraEnv?: Record<string, string> } = {}): Promise<Service> {
  const port = opts.port ?? 3101
  const child = spawn(process.execPath, ['src/ingest/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: connStr('ingest'),
      JWT_SECRET: TEST_JWT_SECRET,
      ...(opts.extraEnv ?? {})
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })
  const baseUrl = `http://127.0.0.1:${port}`
  await waitHealthy(baseUrl)
  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await waitExit(child)
    }
  }
}
