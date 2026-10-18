// R3 Lane 4 integration tests run each scenario on the in-memory event store AND on real PostgreSQL (when DATABASE_URL is
// set), with a COLD RESTART (a fresh API over the same durable store) — the pattern of
// tests/integration/a-recall-runs-its-whole-lifecycle-on-postgresql.test.ts, shared here so each file states only its story.

import { beforeAll, afterAll, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from './api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

export interface Backing { readonly name: string; readonly harness: () => ApiHarness; readonly restart: (h: ApiHarness) => ApiHarness }
export type Res = { status: number; body: unknown };

/** Call once at the top of a test file: the backings to `describe.each` over. */
export function r3OpsBackings(): Backing[] {
  const DATABASE_URL = process.env['DATABASE_URL'];
  let pool: Pool | undefined;
  beforeAll(async () => {
    if (DATABASE_URL === undefined) return;
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool?.end(); });
  const backings: Backing[] = [{ name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) }];
  if (DATABASE_URL !== undefined) {
    const make = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
    backings.push({ name: 'real PostgreSQL', harness: make, restart: () => make() });
  }
  return backings;
}

/** A small client for one tenant over a (restartable) harness. */
export function tenantClient(get: () => ApiHarness, tenantId: string) {
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
    get().request({ method, path, userId, tenantId, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  const code = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
  return { req, ok, code };
}
