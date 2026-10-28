import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **M07-FR-01/02 · hard rule #10 (round 6 re-audit) — a direct goods receipt is booked at the cost the ISSUED order agreed,
 * never at the cost the receiver typed.**
 *
 * Before, `POST /v1/inventory/goods-receipt/:grnId` took each line's `unitCost` from the request and booked it as the stock
 * movement's cost, never compared with the order (the handheld path already used the order's cost). A receiver could make a
 * delivery look worth ₹0.10 or ₹10,000. Now, on a receipt against an issued order, every line is booked at the order line's
 * cost; a typed cost that differs is NOT booked — it is kept on the receipt as a valued cost discrepancy and the receipt is
 * flagged `cost_differs_from_order`, and the receipts list counts it. A receipt with no order is unchanged (owner question).
 * In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: (store?: ApiHarness['store']) => ApiHarness }[] = [{ name: 'the in-memory event store', harness: (store) => apiHarness(store === undefined ? {} : { store }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const AT = '2026-10-09T06:00:00.000Z';
const cost = (minor: number) => ({ minor, currency: 'INR' });

interface CostDiscrepancy { lineId: string; productId: string; quantityMinor: number; orderUnitCost: { minor: number }; typedUnitCost: { minor: number }; valueMinor: number; differenceMinor: number; currency: string; detail: string }
interface Grn {
  governanceFlags: string[]; costDiscrepancies?: CostDiscrepancy[];
  captured: { lines: { unitCost: { minor: number } }[]; discrepancies: { kind: string; quantityMinor: number; value: { minor: number } }[] };
}
const grnOf = (res: { body: unknown }): Grn => (res.body as { grn: Grn }).grn;

function lab(h: ApiHarness, t: string) {
  const req = (method: 'POST' | 'GET', path: string, userId: string, idempotencyKey?: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  return {
    req,
    /** The cast, the product master (p1 untracked), and an ISSUED order of 10 × p1 at ₹50.00. */
    seed: async (poId: string) => {
      await h.seedOwner(t, 'u-owner');
      await approvedSuppliers(h, t, 'sup-1');
      await deliveryPlaces(h, t, 'wh1');
      await h.provisionRole(t, 'u-mgr', 'store_manager');
      await h.provisionRole(t, 'u-po-buyer', 'store_manager');
      await h.provisionRole(t, 'u-cash', 'cashier');
      await h.store.append(t, STREAM.catalogue, makeEvent({
        id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
        payload: { snapshot: { tenantId: t, version: 1, builtAt: AT, scope: { tenantId: t, storeId: 'store-1' }, barcodes: [],
          products: [{ productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: false, handling: 'ambient' }] } },
      }));
      expect((await req('POST', '/v1/inventory/receipt-policy', 'u-owner', 'k-policy', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
      expect((await req('POST', `/v1/purchase/orders/${poId}`, 'u-po-buyer', `po-${poId}`, { supplierId: 'sup-1', deliverToLocationId: 'wh1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: cost(5_000) }] })).status).toBe(201);
      expect((await req('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', `po-${poId}-ok`, { reason: 'within budget' })).status).toBe(200);
    },
    receive: (grnId: string, poId: string | undefined, counted: number, typedMinor: number, userId = 'u-mgr') => req('POST', `/v1/inventory/goods-receipt/${grnId}`, userId, `k-${grnId}`, {
      warehouseId: 'wh1', receivedOnDate: '2026-10-09', currency: 'INR', ...(poId === undefined ? {} : { poId }),
      lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: counted, uom: 'each', unitCost: cost(typedMinor), condition: 'good' }],
    }),
    stockValue: async (): Promise<number> => ((await req('GET', '/v1/inventory/valuation', 'u-owner')).body as { rows: { productId: string; locationId: string; value: { minor: number } }[] })
      .rows.filter((r) => r.productId === 'p1' && r.locationId === 'wh1').reduce((s, r) => s + r.value.minor, 0),
  };
}

describe.each(backings)('a direct goods receipt is booked at the issued order\'s cost — on $name', ({ harness }) => {
  it('a typed cost below the order\'s is not booked: the stock carries the order\'s cost, the difference is a valued, flagged cost discrepancy', async () => {
    const h = harness();
    const t = randomUUID();
    const l = lab(h, t);
    await l.seed('po-1');
    // The receiver types ₹0.01 a unit against an order that agreed ₹50.00.
    const res = await l.receive('grn-1', 'po-1', 10, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const grn = grnOf(res);
    expect(grn.governanceFlags).toContain('cost_differs_from_order');
    expect(grn.captured.lines[0]?.unitCost.minor).toBe(5_000);
    expect(grn.costDiscrepancies).toEqual([expect.objectContaining({
      lineId: 'L1', productId: 'p1', quantityMinor: 10, orderUnitCost: expect.objectContaining({ minor: 5_000 }), typedUnitCost: expect.objectContaining({ minor: 1 }),
      valueMinor: 49_990, differenceMinor: -49_990, currency: 'INR',
    })]);
    // The stock is on the books at the order's cost — 10 × ₹50.00 — never the typed ₹0.10.
    expect(await l.stockValue()).toBe(50_000);
    // The receipts list counts it, so nobody has to know to look (P-08).
    expect(((await l.req('GET', '/v1/inventory/goods-receipt', 'u-owner')).body as { costDiscrepancyCount: number }).costDiscrepancyCount).toBe(1);
    // Stored: a cold restart reads the same discrepancy back.
    const restarted = harness(h.store);
    const again = await restarted.request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-1', userId: 'u-owner', tenantId: t });
    expect(grnOf(again).costDiscrepancies?.[0]).toMatchObject({ valueMinor: 49_990, typedUnitCost: { minor: 1 } });
  });

  it('a short delivery typed at an inflated cost: the shortage is valued at the order\'s cost, and the typed cost is a discrepancy', async () => {
    const h = harness();
    const t = randomUUID();
    const l = lab(h, t);
    await l.seed('po-2');
    const res = await l.receive('grn-2', 'po-2', 8, 9_999);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const grn = grnOf(res);
    expect(grn.captured.discrepancies).toEqual([expect.objectContaining({ kind: 'short', quantityMinor: 2, value: { minor: 10_000, currency: 'INR' } })]);
    expect(grn.costDiscrepancies).toEqual([expect.objectContaining({ quantityMinor: 8, valueMinor: 8 * 4_999, differenceMinor: 8 * 4_999 })]);
    expect(await l.stockValue()).toBe(40_000);
  });

  it('a typed cost that matches the order raises nothing; a receipt with no order is unchanged; a cashier is refused (403)', async () => {
    const h = harness();
    const t = randomUUID();
    const l = lab(h, t);
    await l.seed('po-3');
    const matched = grnOf(await l.receive('grn-3', 'po-3', 10, 5_000));
    expect(matched.governanceFlags).not.toContain('cost_differs_from_order');
    expect(matched.costDiscrepancies).toBeUndefined();
    // No order: there is no agreed cost to compare with — the line stands as sent (an owner question, not guessed here).
    const noOrder = grnOf(await l.receive('grn-4', undefined, 2, 4_000));
    expect(noOrder.governanceFlags).toContain('no_purchase_order');
    expect(noOrder.costDiscrepancies).toBeUndefined();
    expect(noOrder.captured.lines[0]?.unitCost.minor).toBe(4_000);
    // Booking stock in needs inventory.movement.append — a cashier has none; nothing is recorded.
    expect((await l.receive('grn-5', 'po-3', 1, 1, 'u-cash')).status).toBe(403);
    expect((await l.req('GET', '/v1/inventory/goods-receipt/grn-5', 'u-owner')).status).toBe(404);
  });
});
