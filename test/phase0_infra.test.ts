import { describe, test, expect } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { connStr, makePool } from './helpers.ts'

const execFileP = promisify(execFile)

describe('phase 0: scaffold and infra', () => {
  test('migrations apply cleanly and are recorded', async () => {
    const owner = makePool('owner')
    try {
      const migrations = await owner.query(
        'SELECT filename FROM schema_migrations ORDER BY filename'
      )
      expect(migrations.rows.length).toBeGreaterThanOrEqual(1)

      const tenants = await owner.query('SELECT tenant_id FROM tenants')
      expect(tenants.rows.length).toBeGreaterThanOrEqual(2)

      const secrets = await owner.query('SELECT key_id FROM webhook_secrets')
      expect(secrets.rows.length).toBeGreaterThanOrEqual(1)
    } finally {
      await owner.end()
    }
  })

  test('migration runner is idempotent: re-run applies nothing and exits 0', async () => {
    const owner = makePool('owner')
    try {
      const before = await owner.query(
        'SELECT count(*)::int AS n FROM schema_migrations'
      )
      await execFileP('node', ['scripts/migrate.ts'], {
        env: { ...process.env, DATABASE_URL: connStr('owner') }
      })
      const after = await owner.query(
        'SELECT count(*)::int AS n FROM schema_migrations'
      )
      expect(after.rows[0].n).toBe(before.rows[0].n)
    } finally {
      await owner.end()
    }
  })

  test('runtime roles cannot CREATE tables or DROP existing ones', async () => {
    for (const role of ['ingest', 'ledger'] as const) {
      const pool = makePool(role)
      try {
        await expect(
          pool.query('CREATE TABLE hax (x int)')
        ).rejects.toMatchObject({ code: '42501' })
        await expect(pool.query('DROP TABLE tenants')).rejects.toMatchObject({
          code: '42501'
        })
      } finally {
        await pool.end()
      }
    }
  })

  test('GET /healthz returns 200 on both service entrypoints', async () => {
    await checkHealth('src/ingest/main.ts', 3101, 'ingest')
    await checkHealth('src/ledger/main.ts', 3102, 'ledger')
  })
})

async function checkHealth(entry: string, port: number, service: string) {
  const child = spawn('node', [entry], {
    // DATABASE_URL deliberately empty: healthz is pure liveness and must not
    // depend on the database.
    env: { ...process.env, PORT: String(port), DATABASE_URL: '' },
    stdio: 'ignore'
  })
  try {
    const deadline = Date.now() + 8000
    let lastError: unknown = new Error('service never came up')
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, service })
        return
      } catch (e) {
        lastError = e
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw lastError
  } finally {
    child.kill('SIGKILL')
  }
}
