#!/usr/bin/env node
// Runnable migration CLI. Applies the ordered SQL migrations in `db/migrations/`
// against the PostgreSQL database named by DATABASE_URL, tracking applied
// migrations in a `schema_migrations` table so it is idempotent (a re-run applies
// nothing new). This mirrors the tested library `runMigrations` in
// `packages/persistence/src/migrations.ts` — kept in sync — and is the deployment
// entrypoint that wires it to a real `pg.Pool`.
//
// Usage:  set DATABASE_URL to your PostgreSQL connection string, then run
//         `pnpm db:migrate`. It reads only from the environment — no credentials
//         are ever stored in the repo (hard rule #4).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'db', 'migrations');

/** Load db/migrations/*.sql in lexical (numeric-prefix) order. */
function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/** Apply pending migrations. Mirrors packages/persistence/src/migrations.ts. */
async function runMigrations(pool, migrations) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((r) => r.name));

  let appliedCount = 0;
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.name)) {
      console.log(`  skip   ${migration.name}`);
      continue;
    }
    console.log(`  apply  ${migration.name}`);
    await pool.query(migration.sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    appliedCount += 1;
  }
  return appliedCount;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — cannot run migrations.');
    process.exit(1);
  }

  // Load node-postgres at runtime so the rest of the repo never depends on it.
  const pg = await import('pg');
  const { Pool } = pg.default ?? pg;
  const pool = new Pool({ connectionString: url });

  try {
    const migrations = loadMigrations();
    const applied = await runMigrations(pool, migrations);
    console.log(`Done — ${migrations.length} migration(s) checked, ${applied} applied.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
