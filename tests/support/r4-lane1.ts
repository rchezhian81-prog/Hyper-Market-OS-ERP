// R4 Lane 1 test support — the two backings every lane-1 integration test runs on (the in-memory event store and REAL
// PostgreSQL over the same migrations production runs), each with a COLD RESTART (a fresh API over the same durable
// store), and small helpers for the pay and EPR journeys. Synthetic data only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { apiHarness, type ApiHarness } from './api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

export const DATABASE_URL = process.env['DATABASE_URL'];

export interface Backing { readonly name: string; readonly harness: () => ApiHarness; readonly restart: (h: ApiHarness) => ApiHarness }

let pool: Pool | undefined;

/** Open the pool and run the migrations (call in beforeAll); a no-op without DATABASE_URL. */
export async function openDatabase(): Promise<void> {
  if (DATABASE_URL === undefined || pool !== undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
}

export async function closeDatabase(): Promise<void> { await pool?.end(); pool = undefined; }

/** The backings: memory always; PostgreSQL when DATABASE_URL is set. */
export function backings(): Backing[] {
  const out: Backing[] = [{ name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) }];
  if (DATABASE_URL !== undefined) {
    const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
    out.push({ name: 'real PostgreSQL', harness: pg, restart: () => pg() });
  }
  return out;
}

export type Res = { status: number; body: unknown };
export const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
export const whatOf = (r: Res): string | undefined => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened;

/** A caller bound to one tenant; `h` may be swapped for a restarted harness. */
export function caller(get: () => ApiHarness, tenantId: string) {
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
    get().request({ method, path, userId, tenantId, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  return { req, ok };
}

/** A synthetic staff member in the directory. */
export async function addStaff(
  c: ReturnType<typeof caller>, employeeId: string,
  opts: { roles?: readonly string[]; hourlyRateMinor?: number; active?: boolean; branchId?: string } = {},
): Promise<void> {
  await c.ok(c.req('POST', `/v1/hr/workforce/employees/${employeeId}`, {
    name: `Staff ${employeeId}`, branchId: opts.branchId ?? 'br-1', roles: opts.roles ?? ['cashier'], active: opts.active ?? true,
    ...(opts.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: opts.hourlyRateMinor }),
  }), `staff ${employeeId}`);
}

/** Fill one payroll legal figure on the CA's (synthetic) confirmation. */
export async function confirmFigure(c: ReturnType<typeof caller>, key: string, value: number): Promise<void> {
  await c.ok(c.req('POST', `/v1/hr/payroll/legal-settings/${key}`, { value, source: 'TEST FIGURE — synthetic, not a legal rate', confirmation: 'CA (test) ref T-1' }), `figure ${key}`);
}

/**
 * SYNTHETIC test figures for EPF / ESI — chosen so the arithmetic is easy to check. They are NOT the legal rates and are
 * never shipped: production starts with every figure "not confirmed" (OB-208).
 */
export const TEST_CONTRIBUTION_FIGURES: Readonly<Record<string, number>> = Object.freeze({
  pfEmployeeRateBps: 1000, pfEmployerRateBps: 1100, pfWageCeilingMinor: 1_000_000, pfHeadcountThreshold: 3,
  esiEmployeeRateBps: 100, esiEmployerRateBps: 300, esiGrossCeilingMinor: 2_000_000, esiHeadcountThreshold: 2,
});
