import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **Stock is read and moved inside the caller's branches (PA-01-r1 · audit PA-01 · M01-FR-01 · M02-FR-02 · M08 ·
 * M25-FR-01 · SEC-02 · P-08).** Wave 2b-ii put the server's scope on every request, but the inventory routes did not
 * read it: a manager granted only br-1 could read br-2's on-hand, value and ageing, and append a movement at br-2.
 * A stock location belongs to the branch the org hierarchy puts it under (a branch is its own location — the store
 * computer sends its store id; a warehouse or department belongs to the branch above it). Reads with no branch named
 * narrow to the caller's branches; a branch named that is not held is refused by name; a movement at a location
 * outside the caller's branches is refused by name, and nothing is appended. The owner ('all') still sees and moves
 * everything. Driven as the branch-limited manager (never an owner simulating one), on memory and on real PostgreSQL.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'u-owner'; const MGR1 = 'u-mgr-br1'; const MGR2 = 'u-mgr-br2';
const AT = '2026-08-07T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Row { productId: string; locationId: string; onHandMinor: number }

const node = (h: ApiHarness, t: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: OWNER, tenantId: t, idempotencyKey: `org-${id}`, body });
const move = (h: ApiHarness, t: string, userId: string, branchId: string | undefined, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }),
    idempotencyKey: `mv-${String(m['movementId'])}-${userId}`, body: { uom: 'each', occurredAt: AT, enteredBy: userId, ...m } });
const read = (h: ApiHarness, t: string, path: string, userId: string, branchId: string | undefined, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path, userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), query });
const locationsIn = (rows: readonly Row[]): string[] => [...new Set(rows.map((r) => r.locationId))].sort();

async function twoBranches(h: ApiHarness, t: string): Promise<ApiHarness> {
  await h.seedOwner(t, OWNER);
  await h.provisionRole(t, MGR1, 'store_manager', ['br-1']); // a manager of ONE branch — the audit's subject
  await h.provisionRole(t, MGR2, 'store_manager', ['br-2']);
  expect((await node(h, t, 'C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node(h, t, 'br-1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node(h, t, 'br-2', { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  // a back store that sits under br-2: its stock is br-2's
  expect((await node(h, t, 'bs-2', { kind: 'warehouse', name: 'Store 2 back store', parentId: 'br-2', companyId: 'C1' })).status).toBe(201);
  for (const [id, loc, qty, cost] of [['r1', 'br-1', 100, 1000], ['r2', 'br-2', 250, 2000], ['r3', 'bs-2', 40, 2000]] as const) {
    expect((await move(h, t, OWNER, undefined, { movementId: id, productId: 'P1', locationId: loc, kind: 'received', quantityMinor: qty, unitCostMinor: cost })).status).toBe(202);
  }
  return h;
}

async function theLeakIsClosed(h: ApiHarness, t: string): Promise<void> {
  // READ — no branch named: exactly the branch held, never the other one
  const mine = await read(h, t, '/v1/inventory/availability', MGR1, 'br-1');
  expect(mine.status).toBe(200);
  expect(locationsIn((mine.body as { rows: Row[] }).rows)).toEqual(['br-1']);
  // READ — the other branch named: refused by name, not answered
  const peek = await read(h, t, '/v1/inventory/availability', MGR1, 'br-1', { branchId: 'br-2' });
  expect(peek.status).toBe(403);
  expect(codeOf(peek)).toBe('scope_not_held');
  // the same for every stock read keyed by location
  for (const path of ['/v1/inventory/valuation', '/v1/inventory/exceptions', '/v1/inventory/ageing', '/v1/inventory/performance']) {
    expect(codeOf(await read(h, t, path, MGR1, 'br-1', { branchId: 'br-2' })), path).toBe('scope_not_held');
  }
  const value = (await read(h, t, '/v1/inventory/valuation', MGR1, 'br-1')).body as { rows: Row[]; totalValueMinor: number };
  expect(locationsIn(value.rows)).toEqual(['br-1']);
  expect(value.totalValueMinor).toBe(100 * 1000);
  const aged = (await read(h, t, '/v1/inventory/ageing', MGR1, 'br-1')).body as { total?: { minor?: number }; totalValueMinor?: number };
  expect(JSON.stringify(aged)).not.toContain('250000'); // br-2's value never appears in br-1's ageing
  // br-2's own manager sees br-2 and its back store (the hierarchy puts bs-2 under br-2)
  expect(locationsIn(((await read(h, t, '/v1/inventory/availability', MGR2, 'br-2')).body as { rows: Row[] }).rows)).toEqual(['br-2', 'bs-2']);
  // the owner sees every location, asked or not
  expect(locationsIn(((await read(h, t, '/v1/inventory/availability', OWNER, undefined)).body as { rows: Row[] }).rows)).toEqual(['br-1', 'br-2', 'bs-2']);
  expect(locationsIn(((await read(h, t, '/v1/inventory/availability', OWNER, undefined, { branchId: 'br-2' })).body as { rows: Row[] }).rows)).toEqual(['br-2', 'bs-2']);

  // WRITE — a movement at br-2, or at br-2's back store, is refused by name and nothing moves
  for (const [id, loc] of [['x1', 'br-2'], ['x2', 'bs-2'], ['x3', 'somewhere-else']] as const) {
    const w = await move(h, t, MGR1, 'br-1', { movementId: id, productId: 'P1', locationId: loc, kind: 'received', quantityMinor: 5 });
    expect(w.status, loc).toBe(403);
    expect(codeOf(w)).toBe('outside_your_branch_scope');
  }
  // inside my own branch: fine
  expect((await move(h, t, MGR1, 'br-1', { movementId: 'ok1', productId: 'P1', locationId: 'br-1', kind: 'received', quantityMinor: 5 })).status).toBe(202);
  const truth = (await read(h, t, '/v1/inventory/availability', OWNER, undefined)).body as { rows: Row[] };
  expect(truth.rows.find((r) => r.locationId === 'br-2')!.onHandMinor).toBe(250);
  expect(truth.rows.find((r) => r.locationId === 'bs-2')!.onHandMinor).toBe(40);
  expect(truth.rows.find((r) => r.locationId === 'br-1')!.onHandMinor).toBe(105);
  expect(truth.rows.some((r) => r.locationId === 'somewhere-else')).toBe(false);
}

describe('stock is read and moved inside the caller\'s branches (PA-01-r1)', () => {
  it('a br-1 manager reads only br-1 stock, is refused br-2 by name, cannot move stock at br-2 — and a restart agrees', async () => {
    const h = await twoBranches(apiHarness(), A);
    await theLeakIsClosed(h, A);
    const restarted = apiHarness({ store: h.store });
    expect(locationsIn(((await read(restarted, A, '/v1/inventory/availability', MGR1, 'br-1')).body as { rows: Row[] }).rows)).toEqual(['br-1']);
    expect((await move(restarted, A, MGR1, 'br-1', { movementId: 'again', productId: 'P1', locationId: 'br-2', kind: 'received', quantityMinor: 1 })).status).toBe(403);
  });
});

// ── on real PostgreSQL ────────────────────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `e${Date.now().toString(16).slice(-7)}-eeee-4eee-8eee-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('stock branch scope on real PostgreSQL (PA-01-r1)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('the br-1 manager reads br-1 stock only and cannot move br-2 stock — and a second instance agrees', async () => {
    const h = await twoBranches(harness(), PG_TENANT);
    await theLeakIsClosed(h, PG_TENANT);
    const other = harness();
    expect(codeOf(await read(other, PG_TENANT, '/v1/inventory/availability', MGR1, 'br-1', { branchId: 'br-2' }))).toBe('scope_not_held');
  });
});
