import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Numbered SQL migrations, each applied in its own transaction and recorded
// in schema_migrations. The seed is idempotent and re-applied on every run.
export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  const applied: string[] = []
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    )
    // One migrator at a time; harmless for the single migrate container,
    // protects local test runs racing it.
    await client.query('SELECT pg_advisory_lock(727001)')

    const done = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename
      )
    )
    const files = readdirSync(join(root, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      if (done.has(file)) continue
      const sql = readFileSync(join(root, 'migrations', file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        )
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      }
      applied.push(file)
    }

    await client.query(readFileSync(join(root, 'seed', 'seed.sql'), 'utf8'))
  } finally {
    await client.end()
  }
  return applied
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  runMigrations(url)
    .then((applied) => {
      console.log(`migrations ok (${applied.length} newly applied)`)
      process.exit(0)
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
