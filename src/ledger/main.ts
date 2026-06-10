import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startHealthServer } from '../healthz.ts'

startHealthServer('ledger', Number(process.env.PORT ?? 3002))

// The consumer runs as a spawnable child process from day one so the SIGKILL
// crash harness exercises the exact artifact production runs.
if (process.env.DATABASE_URL) {
  const workerPath = fileURLToPath(new URL('./consumer-worker.ts', import.meta.url))
  const spawnWorker = () => {
    const worker = fork(workerPath)
    worker.on('exit', (code, signal) => {
      console.error(
        `consumer worker exited (code=${code}, signal=${signal}); respawning in 1s`
      )
      setTimeout(spawnWorker, 1000)
    })
  }
  spawnWorker()
}
