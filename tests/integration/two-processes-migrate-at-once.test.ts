import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * Two processes starting on a new release must not both apply the same migration (found at round-6 integration: test
 * files sharing a fresh database raced on a new table and one failed with a duplicate type). The run holds a
 * transaction-scoped advisory lock: the second waits, then finds everything applied. Real PostgreSQL; a fresh
 * scratch database per run; skips without DATABASE_URL.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const urlFor = (db: string): string => { const u = new URL(DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };
const MIGRATIONS = readdirSync(join(__dirname, '../../db/migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((name) => ({ name, sql: readFileSync(join(__dirname, '../../db/migrations', name), 'utf8') }));

describe.skipIf(!DATABASE_URL)('two processes migrate a fresh database at once (real PostgreSQL)', () => {
  const DB = `mig_race_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Pool;
  const pools: Pool[] = [];
  beforeAll(async () => {
    admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    admin.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    await admin.query(`CREATE DATABASE ${DB}`);
  });
  afterAll(async () => {
    for (const p of pools) await p.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  it('four runs at the same moment all succeed, and every migration is applied exactly once', async () => {
    const runs = Array.from({ length: 4 }, () => {
      const pool = new Pool({ connectionString: urlFor(DB), max: 2, options: '-c app.tenant_id=*' });
      pool.on('error', () => { /* the scratch database is dropped with FORCE at the end */ });
      pools.push(pool);
      return runMigrations(pgPoolClient(pool), MIGRATIONS);
    });
    const outcomes = await Promise.all(runs);
    const appliedCounts = outcomes.map((o) => o.applied.length).sort((a, b) => b - a);
    expect(appliedCounts).toEqual([MIGRATIONS.length, 0, 0, 0]);
    const rows = await pools[0]!.query('SELECT name, count(*)::int AS n FROM schema_migrations GROUP BY name');
    expect(rows.rows).toHaveLength(MIGRATIONS.length);
    expect(rows.rows.every((r: { n: number }) => r.n === 1)).toBe(true);
  }, 120_000);
});
