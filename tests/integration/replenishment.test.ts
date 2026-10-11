import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

// Replenishment suggestions (M09-FR-02, API-04) end to end through the real API. A proposal is FOR ONE STORE and runs on
// HEAD OFFICE'S facts for it (FUL-11, round 6): on-hand from the stock ledger at the store and every place under it,
// on-order from the issued purchase orders still owed to it plus the transfers on the van to it, and sold from the ledger's
// `sold` movements there. A request may carry only planning parameters — a typed `onHand`/`onOrder`/`reserved` is refused
// by name — and the store's effective range ALWAYS decides what may be proposed. Every proposal is ADVISORY ONLY (hard
// rule #5): it can never become a purchase order by itself. In memory and, with DATABASE_URL, on real PostgreSQL.

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Proposal { productId: string; position: number; reorderPoint: number; suggestedQty: number; reason: string; advisoryOnly: boolean; shelfLifeCap?: number; shelfLifeCapped?: boolean }
interface Reply { status: number; body: unknown }
const proposals = (res: { body: unknown }): Proposal[] => (res.body as { proposals: Proposal[] }).proposals;
const cost = { minor: 2_000, currency: 'INR' };
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const YESTERDAY = isoDay(Date.now() - 86_400_000);

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

/** Two stores (S-A with a back store under it, S-B), a central warehouse, an owner, a manager for S-A only, a cashier. */
async function shop(h: ApiHarness) {
  const t = randomUUID();
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Readonly<Record<string, string>>, key?: string): Promise<Reply> =>
    h.request({ method, path, userId, tenantId: t, ...(userId === 'u-mgr-a' ? { branchId: 'S-A' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${n += 1}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  await h.provisionRole(t, 'u-mgr-a', 'store_manager', ['S-A']);
  await h.provisionRole(t, 'u-cash', 'cashier');
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    ['WH', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' }],
    ['S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }],
    ['S-A-BACK', { kind: 'warehouse', name: 'Store A back store', parentId: 'S-A', companyId: 'C1' }],
    ['S-B', { kind: 'branch', name: 'Store B', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
  const receive = async (locationId: string, productId: string, qty: number) => expect((await call('POST', '/v1/inventory/movements', 'u-owner', {
    movementId: `rx-${locationId}-${productId}-${qty}`, productId, locationId, kind: 'received', quantityMinor: qty, unitCostMinor: 1_000, uom: 'each',
    occurredAt: `${YESTERDAY}T06:00:00.000Z`, enteredBy: 'u-owner',
  })).status).toBe(202);
  const sell = async (saleId: string, locationId: string, productId: string, qty: number) => expect((await call('POST', '/v1/sales', 'u-owner', {
    saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId, cashierId: 'u-owner',
    tradingDay: YESTERDAY, committedAt: `${YESTERDAY}T09:00:00Z`, totalMinor: qty * 100, currency: 'INR', packVersion: 1,
    lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
    tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
  })).status).toBeLessThan(300);
  const propose = (userId: string, items: unknown, query?: Readonly<Record<string, string>>, key?: string) =>
    call('POST', '/v1/replenishment/propose', userId, { items }, query, key);
  return { t, call, receive, sell, propose };
}

describe.each(backings)('FUL-11 replenishment runs on head office\'s facts for one store — on $name', ({ harness }) => {
  it('needs a store (asked for, or the only branch held); refuses one outside the caller\'s branches, a typed stock figure, and a cashier', async () => {
    const h = harness();
    const s = await shop(h);
    const item = { productId: 'P1', maxLevel: 100, reorderPoint: 10 };

    // The owner covers every branch: which store must be said.
    const none = await s.propose('u-owner', [item]);
    expect(none.status).toBe(400);
    expect(codeOf(none)).toBe('store_required');
    // A manager for S-A alone gets S-A without asking; S-B is refused by name.
    const mine = await s.propose('u-mgr-a', [item]);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ storeId: 'S-A', factsFrom: 'head_office_stock_ledger' });
    const theirs = await s.propose('u-mgr-a', [item], { storeId: 'S-B' });
    expect(theirs.status).toBe(403);
    expect(codeOf(theirs)).toBe('outside_your_branch_scope');

    // A request may not say what is on hand, on order or reserved — head office says.
    for (const typed of [{ onHand: 0 }, { onOrder: 0 }, { reserved: 5 }, { onHand: 'lots' }]) {
      const r = await s.propose('u-owner', [{ ...item, ...typed }], { storeId: 'S-A' });
      expect(r.status).toBe(400);
      expect(codeOf(r)).toBe('replenishment_carries_caller_stock');
    }
    expect((await s.propose('u-cash', [item], { storeId: 'S-A' })).status).toBe(403);
    expect(codeOf(await s.propose('u-owner', 'not-a-list', { storeId: 'S-A' }))).toBe('not_readable_as_replenishment');
    expect(codeOf(await s.propose('u-owner', [{ productId: 'P1' }], { storeId: 'S-A' }))).toBe('not_readable_as_an_item'); // no maxLevel
    expect(codeOf(await s.propose('u-owner', [{ productId: 'P1', maxLevel: 0, reorderPoint: 5 }], { storeId: 'S-A' }))).toBe('invalid_replenishment_parameter');
  }, 120_000);

  it('on-hand is the store\'s own (and its back store\'s), on-order is the open purchase orders plus the van; a receipt moves stock from one to the other, never counted twice', async () => {
    const h = harness();
    const s = await shop(h);
    await approvedSuppliers(h, s.t, 'sup-1');
    expect((await s.call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
    await s.receive('S-A-BACK', 'p1', 5);   // S-A's back store: counts for S-A
    await s.receive('S-B', 'p1', 300);      // another store: never S-A's
    await s.receive('WH', 'p1', 200);

    const item = { productId: 'p1', maxLevel: 100, reorderPoint: 50 };
    const first = await s.propose('u-mgr', [item], { storeId: 'S-A' });
    expect(proposals(first)[0]).toMatchObject({ productId: 'p1', position: 5, suggestedQty: 95, advisoryOnly: true });
    expect((first.body as { stockFacts: unknown[] }).stockFacts).toEqual([{ productId: 'p1', onHand: 5, onOrder: 0, inTransit: 0 }]);

    // An issued order for 10 to S-A: on order, so only 85 more is proposed.
    expect((await s.call('POST', '/v1/purchase/orders/po-a', 'u-mgr', { supplierId: 'sup-1', deliverToLocationId: 'S-A', lines: [{ productId: 'p1', orderedQty: 10, unitCost: cost }] })).status).toBe(201);
    expect((await s.propose('u-mgr', [item], { storeId: 'S-A' })).body).toMatchObject({ proposals: [{ position: 5, suggestedQty: 95 }] }); // a proposed (unapproved) order is not on order
    expect((await s.call('POST', '/v1/purchase/orders/po-a/approval', 'u-owner', { reason: 'ok' })).status).toBe(200);
    expect(proposals(await s.propose('u-mgr', [item], { storeId: 'S-A' }))[0]).toMatchObject({ position: 15, suggestedQty: 85 });

    // 6 of it arrive at the back store: on-hand 11, still owed 4 — the same position, nothing counted twice.
    expect((await s.call('POST', '/v1/inventory/goods-receipt/grn-1', 'u-mgr', {
      warehouseId: 'S-A-BACK', receivedOnDate: YESTERDAY, currency: 'INR', poId: 'po-a',
      lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: 6, uom: 'ea', unitCost: cost, condition: 'good' }],
    })).status).toBe(201);
    const afterGrn = await s.propose('u-mgr', [item], { storeId: 'S-A' });
    expect(proposals(afterGrn)[0]).toMatchObject({ position: 15, suggestedQty: 85 });
    expect((afterGrn.body as { stockFacts: unknown[] }).stockFacts).toEqual([{ productId: 'p1', onHand: 11, onOrder: 4, inTransit: 0 }]);

    // 30 on the van from the warehouse to S-A: in transit, so 30 less is proposed.
    expect((await s.call('POST', '/v1/warehouse/transfers/tr-1', 'u-owner', { fromLocationId: 'WH', toLocationId: 'S-A', lines: [{ productId: 'p1', batchId: null, quantityMinor: 30, uom: 'each', unitCost: { minor: 1_000, currency: 'INR' } }] })).status).toBe(201);
    expect((await s.call('POST', '/v1/warehouse/transfers/tr-1/dispatch', 'u-mgr', {})).status).toBe(200);
    const vanned = await s.propose('u-mgr', [item], { storeId: 'S-A' }, 'rp-van');
    expect(proposals(vanned)[0]).toMatchObject({ position: 45, suggestedQty: 55 });
    expect((vanned.body as { stockFacts: unknown[] }).stockFacts).toEqual([{ productId: 'p1', onHand: 11, onOrder: 4, inTransit: 30 }]);

    // The same request again (same key) is the same answer.
    const replay = await s.propose('u-mgr', [item], { storeId: 'S-A' }, 'rp-van');
    expect(replay.body).toEqual(vanned.body);
    // S-B's view of p1 is S-B's 300 — above the reorder point, nothing proposed.
    expect(proposals(await s.propose('u-owner', [item], { storeId: 'S-B' }))).toEqual([]);
  }, 120_000);

  it('demand is what the store\'s own ledger recorded selling — another store\'s sales are not its demand; the range always applies', async () => {
    const h = harness();
    const s = await shop(h);
    await s.sell('sa-1', 'S-A', 'FRESH', 280);  // S-A: 280 over 28 days → 10/day
    await s.sell('sb-1', 'S-B', 'FRESH', 840);  // S-B: never S-A's demand
    const item = { productId: 'FRESH', maxLevel: 100, leadTimeDays: 3, safetyStock: 4, remainingShelfLifeDays: 5 };
    const res = await s.propose('u-mgr-a', [item]);
    const fresh = proposals(res)[0]!;
    expect(fresh.reorderPoint).toBe(34);   // 4 + 10 × 3 — the store's own demand
    expect(fresh.shelfLifeCap).toBe(50);   // 10 × 5
    expect(fresh.position).toBe(-280);     // the ledger: sold 280 with none received — a visible negative, never hidden
    expect((res.body as { demandWindow?: { days: number } }).demandWindow?.days).toBe(28);

    // The range: once S-A records one, a delisted item is never proposed — with or without ?storeId=.
    expect((await s.call('POST', '/v1/merchandising/assortment/S-A/FRESH/list', 'u-owner', { effectiveFrom: '2026-01-01' })).status).toBe(201);
    expect((await s.call('POST', '/v1/merchandising/assortment/S-A/OLD/drop', 'u-owner', { reason: 'poor_sales', effectiveFrom: '2026-01-01' })).status).toBe(201);
    const ranged = await s.propose('u-mgr-a', [item, { productId: 'OLD', maxLevel: 50, reorderPoint: 10 }, { productId: 'NEW', maxLevel: 50, reorderPoint: 10 }]);
    expect(proposals(ranged).map((p) => p.productId)).toEqual(['FRESH']);
    expect((ranged.body as { outOfRange: unknown[] }).outOfRange).toEqual([{ productId: 'OLD', status: 'delisted' }, { productId: 'NEW', status: 'not_ranged' }]);
  }, 120_000);
});

describe('replenishment engine behaviour through the route (M09-FR-02)', () => {
  it('rounds up to the pack and raises to the supplier minimum, suppresses a blocked item, computes the reorder point from demand × lead + safety', async () => {
    const s = await shop(apiHarness());
    await s.receive('S-A', 'P4', 10);
    const out = proposals(await s.propose('u-owner', [
      { productId: 'P1', maxLevel: 100, reorderPoint: 50, orderMultiple: 12 },   // 100 → 108
      { productId: 'P2', maxLevel: 5, reorderPoint: 10, minOrderQty: 20 },        // 5 → raised to 20
      { productId: 'P3', maxLevel: 100, reorderPoint: 50, blocked: true },        // suppressed
      { productId: 'P4', maxLevel: 100, avgDailyDemand: 5, leadTimeDays: 3, safetyStock: 4 },  // ROP 19, on hand 10 → 90
    ], { storeId: 'S-A' }));
    expect(out.find((p) => p.productId === 'P1')?.suggestedQty).toBe(108);
    expect(out.find((p) => p.productId === 'P2')?.suggestedQty).toBe(20);
    expect(out.find((p) => p.productId === 'P3')).toBeUndefined();
    expect(out.find((p) => p.productId === 'P4')).toMatchObject({ reorderPoint: 19, suggestedQty: 90 });
  });

  it('bounds a perishable order by remaining shelf life, and surfaces an over-order as an exception (D-3)', async () => {
    const s = await shop(apiHarness());
    await s.receive('S-A', 'HELD', 15);
    const out = proposals(await s.propose('u-owner', [
      { productId: 'FRESH', maxLevel: 100, reorderPoint: 50, avgDailyDemand: 10, remainingShelfLifeDays: 3 },  // 30 sellable
      { productId: 'HELD', maxLevel: 100, reorderPoint: 50, avgDailyDemand: 5, remainingShelfLifeDays: 2 },    // 10 sellable < 15 held
    ], { storeId: 'S-A' }));
    expect(out.find((p) => p.productId === 'FRESH')).toMatchObject({ suggestedQty: 30, shelfLifeCap: 30, shelfLifeCapped: true });
    expect(out.find((p) => p.productId === 'HELD')).toMatchObject({ suggestedQty: 0, reason: 'held_shelf_life', shelfLifeCapped: true });
  });

  it('a supplied avgDailyDemand (a planning parameter) still wins; a custom window divides differently; a bad one is refused', async () => {
    const s = await shop(apiHarness());
    await s.sell('d-1', 'S-A', 'FRESH', 70);
    const supplied = proposals(await s.propose('u-owner', [{ productId: 'FRESH', maxLevel: 100, reorderPoint: 50, avgDailyDemand: 2, remainingShelfLifeDays: 5 }], { storeId: 'S-A' }));
    expect(supplied[0]!.shelfLifeCap).toBe(10);
    const week = proposals(await s.propose('u-owner', [{ productId: 'FRESH', maxLevel: 100, reorderPoint: 50, remainingShelfLifeDays: 5 }], { storeId: 'S-A', demandWindowDays: '7' }));
    expect(week[0]!.shelfLifeCap).toBe(50); // 70 over 7 days = 10/day
    expect(codeOf(await s.propose('u-owner', [{ productId: 'FRESH', maxLevel: 10, reorderPoint: 5 }], { storeId: 'S-A', demandWindowDays: '0' }))).toBe('bad_demand_window');
  });
});
