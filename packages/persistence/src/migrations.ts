// Migration runner — applies ordered forward-only SQL migrations against any
// `SqlClient` (so it runs on PostgreSQL in the cloud or an embedded engine at the
// edge, and is testable without a live database). It records applied migrations in a
// `schema_migrations` table and skips ones already applied, so it is idempotent — a
// re-run applies nothing new. The database is only ever changed through a migration
// (see `db/migrations/`). This is the tested library; `scripts/migrate.mjs` is the
// runnable CLI that wires it to a real `pg.Pool` from `DATABASE_URL`.

import type { SqlClient } from './sql-client';

export interface Migration {
  /** File name, e.g. "0001_event_ledger.sql" — also the applied-record key. */
  readonly name: string;
  readonly sql: string;
}

export interface MigrationOutcome {
  /** Migrations applied on this run, in order. */
  readonly applied: string[];
  /** Migrations skipped because they were already applied. */
  readonly skipped: string[];
}

const ENSURE_TABLE =
  'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())';
const SELECT_APPLIED = 'SELECT name FROM schema_migrations';
const RECORD_APPLIED = 'INSERT INTO schema_migrations (name) VALUES ($1)';

/**
 * Apply pending migrations in the given order. Ensures the tracking table exists,
 * reads what's already applied, then runs each new migration's SQL and records it.
 * Idempotent: already-applied migrations are skipped.
 */
export async function runMigrations(
  client: SqlClient,
  migrations: readonly Migration[],
): Promise<MigrationOutcome> {
  await client.query(ENSURE_TABLE);
  const rows = await client.query<{ name: string }>(SELECT_APPLIED);
  const alreadyApplied = new Set(rows.map((r) => String(r.name)));

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }
    await client.query(migration.sql); // the migration's DDL (may be multi-statement)
    await client.query(RECORD_APPLIED, [migration.name]);
    applied.push(migration.name);
  }
  return { applied, skipped };
}
