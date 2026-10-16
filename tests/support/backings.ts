// The two backings an integration test runs on: the in-memory event store, and — when DATABASE_URL is set — real
// PostgreSQL over the same migrations production runs. Each test file calls `useBackings()` at module level.

import { beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from './api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

export interface Backing { readonly name: string; readonly harness: () => ApiHarness }

export function useBackings(): readonly Backing[] {
  const DATABASE_URL = process.env['DATABASE_URL'];
  let pool: Pool | undefined;
  beforeAll(async () => {
    if (DATABASE_URL === undefined) return;
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool?.end(); });
  const out: Backing[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
  if (DATABASE_URL !== undefined) {
    out.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
  }
  return out;
}
