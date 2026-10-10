import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { ADJUSTMENT_REASON_CODES } from '../../packages/adjustment/src/adjustment';

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

// ── the other stock families, family by family ──────────────────────────────────────────────────────────────
// each manager signs in at their own branch; the owner at none in particular
const signedInAt = (userId: string): { branchId?: string } => (userId === MGR1 ? { branchId: 'br-1' } : userId === MGR2 ? { branchId: 'br-2' } : {});
const post = (h: ApiHarness, userId: string, path: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path, userId, tenantId: A, ...signedInAt(userId), idempotencyKey: key, body });
const get = (h: ApiHarness, userId: string, path: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path, userId, tenantId: A, ...signedInAt(userId), query });
const LINE = { productId: 'P1', batchId: null, quantityMinor: 10, uom: 'each', unitCost: { minor: 2_000, currency: 'INR' } };

describe('every stock family keeps to the caller\'s branches (PA-01-r1 sweep)', () => {
  it('bins and bin movements: br-2\'s bin cannot be read, re-homed or emptied by the br-1 manager; br-1\'s own bin works', async () => {
    const h = await twoBranches(apiHarness(), A);
    expect((await post(h, OWNER, '/v1/warehouse/bins/B2', { storeId: 'br-2', capacityMinor: 1000, pickable: true }, 'b2')).status).toBe(201);
    expect((await post(h, OWNER, '/v1/warehouse/movements/c-own', { kind: 'put_away', storeId: 'br-2', productId: 'P1', quantityMinor: 10, uom: 'each', toBinId: 'B2' }, 'c-own')).status).toBe(201);
    expect(codeOf(await get(h, MGR1, '/v1/warehouse/bins/B2'))).toBe('outside_your_branch_scope');
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/bins/B2', { storeId: 'br-1', capacityMinor: 1, pickable: true }, 'b2-rehome'))).toBe('outside_your_branch_scope');
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/movements/c-steal', { kind: 'pick', storeId: 'br-1', productId: 'P1', quantityMinor: 10, uom: 'each', fromBinId: 'B2' }, 'c-steal'))).toBe('outside_your_branch_scope');
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/movements/c-there', { kind: 'put_away', storeId: 'br-2', productId: 'P1', quantityMinor: 1, uom: 'each', toBinId: 'B2' }, 'c-there'))).toBe('outside_your_branch_scope');
    expect((await post(h, MGR1, '/v1/warehouse/bins/B1', { storeId: 'br-1', capacityMinor: 100, pickable: true }, 'b1')).status).toBe(201);
    expect((await get(h, MGR2, '/v1/warehouse/bins/B2')).status).toBe(200);
    const held = (await get(h, OWNER, '/v1/warehouse/bins/B2')).body as { occupancyMinor: number };
    expect(held.occupancyMinor).toBe(10); // nothing left br-2's bin
  });

  it('transfers: proposing, dispatching, receiving or reading a br-2 → br-2 transfer is refused to the br-1 manager', async () => {
    const h = await twoBranches(apiHarness(), A);
    expect((await post(h, OWNER, '/v1/warehouse/transfers/T2', { fromLocationId: 'br-2', toLocationId: 'bs-2', lines: [LINE] }, 't2')).status).toBe(201);
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/transfers/T3', { fromLocationId: 'br-2', toLocationId: 'bs-2', lines: [LINE] }, 't3'))).toBe('outside_your_branch_scope');
    expect(codeOf(await get(h, MGR1, '/v1/warehouse/transfers/T2'))).toBe('outside_your_branch_scope');
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/transfers/T2/dispatch', {}, 't2-d'))).toBe('outside_your_branch_scope');
    expect((await get(h, MGR2, '/v1/warehouse/transfers/T2')).status).toBe(200);
    expect((await post(h, MGR2, '/v1/warehouse/transfers/T2/dispatch', {}, 't2-d2')).status).toBe(200); // br-2's own manager
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/transfers/T2/receive', { counted: [{ productId: 'P1', quantityMinor: 10 }] }, 't2-r'))).toBe('outside_your_branch_scope');
    // a request INTO my branch from br-2 may be proposed (it asks), but only br-2 can dispatch it
    expect((await post(h, MGR1, '/v1/warehouse/transfers/T4', { fromLocationId: 'br-2', toLocationId: 'br-1', lines: [LINE] }, 't4')).status).toBe(201);
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/transfers/T4/dispatch', {}, 't4-d'))).toBe('outside_your_branch_scope');
  });

  it('write-offs, counts, receipts, indents and near-expiry: br-2 is refused by name or left out', async () => {
    const h = await twoBranches(apiHarness(), A);
    const loss = { productId: 'P1', locationId: 'br-2', qty: 1, uom: 'each', lossType: 'damage', reasonCode: 'broken' };
    expect(codeOf(await post(h, MGR1, '/v1/inventory/write-off/W1', loss, 'w1'))).toBe('outside_your_branch_scope');
    expect(codeOf(await get(h, MGR1, '/v1/inventory/write-off-value', { productId: 'P1', locationId: 'br-2', qty: '1' }))).toBe('outside_your_branch_scope');
    expect(codeOf(await get(h, MGR1, '/v1/inventory/write-offs', { branchId: 'br-2' }))).toBe('scope_not_held');
    expect(codeOf(await post(h, MGR1, '/v1/inventory/counts/K1', { productId: 'P1', locationId: 'br-2', uom: 'each', countedMinor: 0, reasonCode: 'cycle' }, 'k1'))).toBe('outside_your_branch_scope');
    expect(codeOf(await get(h, MGR1, '/v1/inventory/counts', { productId: 'P1', locationId: 'bs-2' }))).toBe('outside_your_branch_scope');
    const grn = { warehouseId: 'br-2', receivedOnDate: '2026-08-18', currency: 'INR', lines: [{ lineId: 'L1', productId: 'P1', orderedMinor: 5, countedMinor: 5, uom: 'each', unitCost: { minor: 2_000, currency: 'INR' }, condition: 'good' }] };
    expect(codeOf(await post(h, MGR1, '/v1/inventory/goods-receipt/G1', grn, 'g1'))).toBe('outside_your_branch_scope');
    expect(codeOf(await get(h, MGR1, '/v1/inventory/goods-receipt', { branchId: 'br-2' }))).toBe('scope_not_held');
    // an indent between br-2's back store and its floor is br-2's
    expect((await post(h, OWNER, '/v1/floor/indents/I2', { fromLocationId: 'bs-2', toLocationId: 'br-2', lines: [{ productId: 'P1', quantityMinor: 5, uom: 'each' }] }, 'i2')).status).toBeLessThan(300);
    expect(codeOf(await get(h, MGR1, '/v1/floor/indents/I2'))).toBe('outside_your_branch_scope');
    expect(codeOf(await post(h, MGR1, '/v1/floor/indents/I2/approval', {}, 'i2-a'))).toBe('outside_your_branch_scope');
    expect(((await get(h, MGR1, '/v1/floor/indents')).body as { count: number }).count).toBe(0);
    expect(((await get(h, MGR2, '/v1/floor/indents')).body as { count: number }).count).toBe(1);
    // a batch close to its date at br-2 is br-2's to mark down — not on the br-1 manager's list
    expect((await move(h, A, OWNER, undefined, { movementId: 'rb', productId: 'P2', locationId: 'br-2', kind: 'received', quantityMinor: 3, batchId: 'B-1', expiry: '2026-08-09' })).status).toBe(202);
    const near = (u: string) => get(h, u, '/v1/inventory/near-expiry', { asOf: '2026-08-07', withinDays: '7' });
    expect(((await near(MGR1)).body as { count: number }).count).toBe(0);
    expect(((await near(MGR2)).body as { count: number }).count).toBe(1);
    expect(((await near(OWNER)).body as { count: number }).count).toBe(1);
  });
});

describe('the routes added in the coordinated programme keep to the caller\'s branches (PA-01-r1 × Batch 2)', () => {
  it('a br-2 shortfall, a br-2 supplier return and a br-2 production run are refused to the br-1 manager by name', async () => {
    const h = await twoBranches(apiHarness(), A);
    const resolution = { reasonCode: ADJUSTMENT_REASON_CODES[0], note: 'searched the back store', lines: [] };
    // an indent between br-2's back store and floor: its shortfall is br-2's to resolve
    expect((await post(h, OWNER, '/v1/floor/indents/I2', { fromLocationId: 'bs-2', toLocationId: 'br-2', lines: [{ productId: 'P1', quantityMinor: 5, uom: 'each' }] }, 'i2')).status).toBeLessThan(300);
    expect(codeOf(await post(h, MGR1, '/v1/floor/indents/I2/issues/X1/shortfall/resolution', resolution, 'i2-res'))).toBe('outside_your_branch_scope');
    // a br-2 → br-2 transfer's shortfall
    expect((await post(h, OWNER, '/v1/warehouse/transfers/T2', { fromLocationId: 'br-2', toLocationId: 'bs-2', lines: [LINE] }, 't2')).status).toBe(201);
    expect(codeOf(await post(h, MGR1, '/v1/warehouse/transfers/T2/shortfall/resolution', resolution, 't2-res'))).toBe('outside_your_branch_scope');
    // a br-2 receipt's line going back to the supplier
    const grn = { warehouseId: 'br-2', receivedOnDate: '2026-08-18', currency: 'INR', lines: [{ lineId: 'L1', productId: 'P1', orderedMinor: 5, countedMinor: 5, uom: 'each', unitCost: { minor: 2_000, currency: 'INR' }, condition: 'good' }] };
    expect((await post(h, OWNER, '/v1/inventory/goods-receipt/G2', grn, 'g2')).status).toBeLessThan(300);
    expect(codeOf(await post(h, MGR1, '/v1/inventory/goods-receipt/G2/lines/L1/returned', { reason: 'collected by the supplier' }, 'g2-ret'))).toBe('outside_your_branch_scope');
    // a production run at br-2, and br-2's run list
    const run = { recipeId: 'R1', batches: 1, actualOutputMinor: 1, outputBatchId: 'OB-1', locationId: 'br-2' };
    const committed = await post(h, MGR1, '/v1/production/runs/RUN-2', run, 'run-2');
    expect([403]).toContain(committed.status);
    expect(['outside_your_branch_scope', 'forbidden']).toContain(codeOf(committed));
    const listed = await get(h, MGR1, '/v1/production/runs', { locationId: 'br-2' });
    expect(listed.status).toBe(403);
  });
});

describe('waste, scrap and packaging keep to the caller\'s branches (PA-01-r1 sweep, the families named in Wave 2b-ii)', () => {
  it('br-2\'s waste, scrap and packaging cannot be recorded or read by the br-1 manager; coverage of br-2 cannot be dropped', async () => {
    const h = await twoBranches(apiHarness(), A);
    const waste = (branchId: string) => ({ branchId, departmentId: 'grocery', productId: 'P1', source: 'damage', at: AT, valueMinor: 1_000, disposal: 'landfill' });
    expect(codeOf(await post(h, MGR1, '/v1/waste/records/W2', waste('br-2'), 'w2'))).toBe('outside_your_branch_scope');
    expect((await post(h, MGR1, '/v1/waste/records/W1', waste('br-1'), 'w1')).status).toBeLessThan(300);
    const window = { from: '2026-08-01', to: '2026-08-31' };
    expect(codeOf(await get(h, MGR1, '/v1/waste/report', { branchId: 'br-2', ...window }))).toBe('outside_your_branch_scope');
    expect((await get(h, MGR1, '/v1/waste/report', { branchId: 'br-1', ...window })).status).toBe(200);
    expect(codeOf(await get(h, MGR1, '/v1/waste/compare', { branchId: 'br-2', from1: '2026-07-01', to1: '2026-07-31', from2: '2026-08-01', to2: '2026-08-31' }))).toBe('outside_your_branch_scope');
    // coverage is one list for the shop: the owner sets both branches; the br-1 manager may not drop br-2's row
    const both = { expected: [{ branchId: 'br-1', departmentId: 'grocery' }, { branchId: 'br-2', departmentId: 'grocery' }] };
    expect((await post(h, OWNER, '/v1/waste/coverage', both, 'cov-owner')).status).toBeLessThan(300);
    expect(codeOf(await post(h, MGR1, '/v1/waste/coverage', { expected: [{ branchId: 'br-1', departmentId: 'grocery' }] }, 'cov-drop'))).toBe('outside_your_branch_scope');
    expect(codeOf(await post(h, MGR1, '/v1/waste/coverage', { expected: [...both.expected, { branchId: 'br-2', departmentId: 'bakery' }] }, 'cov-add'))).toBe('outside_your_branch_scope');
    expect((await post(h, MGR1, '/v1/waste/coverage', { expected: [...both.expected, { branchId: 'br-1', departmentId: 'bakery' }] }, 'cov-mine')).status).toBeLessThan(300);
    // scrap: br-2's review is refused by name
    expect(codeOf(await get(h, MGR1, '/v1/scrap/review', { branchId: 'br-2', ...window }))).toBe('outside_your_branch_scope');
    // packaging: a movement or a position at br-2 is refused by name
    expect((await post(h, OWNER, '/v1/packaging/items/BAG', { name: 'Carry bag', kind: 'carry_bag', returnable: false }, 'bag')).status).toBeLessThan(300);
    expect(codeOf(await post(h, MGR1, '/v1/packaging/items/BAG/movements/m2', { branchId: 'br-2', kind: 'received', qty: 100, at: AT }, 'pm2'))).toBe('outside_your_branch_scope');
    expect((await post(h, MGR1, '/v1/packaging/items/BAG/movements/m1', { branchId: 'br-1', kind: 'received', qty: 100, at: AT }, 'pm1')).status).toBeLessThan(300);
    expect(codeOf(await get(h, MGR1, '/v1/packaging/items/BAG/position', { branchId: 'br-2' }))).toBe('outside_your_branch_scope');
    expect((await get(h, OWNER, '/v1/packaging/items/BAG/position', { branchId: 'br-2' })).status).toBe(200);
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
