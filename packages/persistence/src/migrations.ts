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
/** One key for the migration lock, so two processes starting on a new release apply each migration once. */
const MIGRATION_LOCK_KEY = 4_207_011;

export async function runMigrations(
  client: SqlClient,
  migrations: readonly Migration[],
): Promise<MigrationOutcome> {
  // Where the client offers a transaction (PostgreSQL), the whole run holds a transaction-scoped advisory lock: a second
  // process starting at the same moment waits, then finds everything applied — instead of both creating the same table
  // (found at round-6 integration: test files sharing a fresh database raced on a new migration). Without a transaction
  // (an embedded engine, a fake), it runs as before.
  if (client.transaction !== undefined) {
    return client.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      return applyPending(tx, migrations);
    });
  }
  return applyPending(client, migrations);
}

async function applyPending(client: SqlClient, migrations: readonly Migration[]): Promise<MigrationOutcome> {
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
