import { connStr } from './helpers.ts'

// Apply migrations and seed once before the suite. If the runner does not
// exist yet (TDD red phase) every test fails here, which is the point.
export default async function globalSetup(): Promise<void> {
  const { runMigrations } = await import('../scripts/migrate.ts')
  await runMigrations(connStr('owner'))
}
