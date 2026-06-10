import pg from 'pg'

// The throwaway test Postgres from docker-compose.test.yml.
const HOST = process.env.PGHOST_TEST ?? 'localhost'
const PORT = Number(process.env.PGPORT_TEST ?? 5433)

export type Role = 'owner' | 'ingest' | 'ledger'

const PASSWORDS: Record<Role, string> = {
  owner: 'owner_pw_dev',
  ingest: 'ingest_pw_dev',
  ledger: 'ledger_pw_dev'
}

export function connStr(role: Role): string {
  return `postgres://app_${role}:${PASSWORDS[role]}@${HOST}:${PORT}/billing`
}

export function makePool(role: Role): pg.Pool {
  return new pg.Pool({ connectionString: connStr(role), max: 5 })
}
