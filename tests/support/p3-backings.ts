// OB-288 P3: the two backings a procure-to-pay test runs on — the in-memory event store, and (with DATABASE_URL) real
// PostgreSQL over the same migrations production runs — each able to build a SECOND head-office instance over the same
// store, which is the cold restart: everything recorded must read back the same from a fresh process.

import { beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from './api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

export interface RestartableBacking {
  readonly name: string;
  /** A head office; given an earlier one, a fresh instance over the SAME store (a cold restart). */
  readonly harness: (sameStoreAs?: ApiHarness) => ApiHarness;
}

export function useRestartableBackings(): readonly RestartableBacking[] {
  const DATABASE_URL = process.env['DATABASE_URL'];
  let pool: Pool | undefined;
  beforeAll(async () => {
    if (DATABASE_URL === undefined) return;
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool?.end(); });
  const out: RestartableBacking[] = [{ name: 'the in-memory event store', harness: (same) => apiHarness(same === undefined ? {} : { store: same.store }) }];
  if (DATABASE_URL !== undefined) {
    // A fresh SqlEventStore and idempotency store on every call: nothing is carried in memory across the "restart".
    out.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
  }
  return out;
}

/** Today and a day `n` days away, as YYYY-MM-DD on the server's clock (validity windows are judged on it). */
export const dayFromToday = (n: number): string => shopDateIn(new Date(Date.now() + n * 86_400_000).toISOString()); // R1c: the shop's days
