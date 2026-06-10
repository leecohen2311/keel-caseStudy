// Spawn the real Ledger consumer worker for end-to-end tests (the same child
// process the SIGKILL harness uses). e2e tests enqueue via the HTTP API, run a
// worker to drain, then assert on postings. These tests stay red until both the
// Phase 2 consumer and the relevant phase's API are merged.
import { spawn, type ChildProcess } from 'node:child_process'
import { connStr } from './db.ts'

export function startWorker(extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['src/ledger/consumer-worker.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: connStr('ledger'),
      POLL_MS: '25',
      ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

export function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
}

export async function stopWorker(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM')
  await waitExit(child)
}

// Poll until `probe` is true or we time out (used to wait for the worker to
// drain). Throws with a labelled message so a hung drain is diagnosable.
export async function until(
  probe: () => Promise<boolean>,
  what: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for: ${what}`)
}
