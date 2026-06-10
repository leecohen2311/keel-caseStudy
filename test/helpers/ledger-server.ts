// Spawn the real Ledger service (serves /balance, /statement, /adjustments,
// /periods/close, /reconcile). Mirrors ingest-server.ts. By default the internal
// consumer worker is disabled (DISABLE_CONSUMER=1) so contract tests can observe
// a stable pending queue row; e2e tests run an explicit worker for determinism.
// DISABLE_CONSUMER is a test-only boot env — see CONTRACT-GAPS GAP-13.
import { spawn, type ChildProcess } from 'node:child_process'
import { connStr } from './db.ts'
import { TEST_JWT_SECRET } from './jwt.ts'

export interface Service {
  baseUrl: string
  stop: () => Promise<void>
  exited: Promise<{ code: number | null; signal: string | null }>
}

function waitExit(child: ChildProcess): Promise<void> {
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
  throw new Error(`ledger service did not become healthy at ${baseUrl}`)
}

export async function startLedger(
  opts: { port?: number; runConsumer?: boolean; extraEnv?: Record<string, string> } = {}
): Promise<Service> {
  const port = opts.port ?? 3122
  const env: Record<string, string> = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: connStr('ledger'),
    JWT_SECRET: TEST_JWT_SECRET,
    ...(opts.extraEnv ?? {})
  }
  // Disable the in-process consumer unless a test explicitly wants it; e2e tests
  // drive their own worker so draining is deterministic.
  if (!opts.runConsumer) env.DISABLE_CONSUMER = '1'

  const child = spawn(process.execPath, ['src/ledger/main.ts'], {
    env,
    stdio: ['ignore', 'ignore', 'inherit']
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
    } else {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }
  })
  await waitHealthy(baseUrl)
  return {
    baseUrl,
    exited,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await waitExit(child)
    }
  }
}
