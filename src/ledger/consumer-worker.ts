import pg from 'pg'
import { processOne } from './consumer.ts'

// Standalone consumer worker. Spawned as a child process by the ledger
// service (and directly by the SIGKILL test harness) so killing it is a real
// process death: connections drop, locks release, transactions roll back.

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('consumer-worker: DATABASE_URL is required')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
const pollMs = Number(process.env.POLL_MS ?? 250)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`consumer-worker started (pid ${process.pid})`)
for (;;) {
  try {
    const result = await processOne(pool)
    if (result === 'empty') await sleep(pollMs)
  } catch (err) {
    // e.g. database briefly unreachable; back off and keep draining
    console.error('consumer-worker error:', err)
    await sleep(pollMs * 4)
  }
}
