import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { planLoad, executeLoad, type ExtractBundle } from '../../packages/migration/src/index';

/**
 * **SF-11 — the pack chain, operationally: ordered by the case, received by case and inner, stocked and sold in base units,
 * costed per base unit (M03-FR-02 · M06 · M07-FR-02 · M08-FR-01/04 · OB-31 "A").**
 *
 * Two products, through the real routes as named people, on the in-memory store and, with DATABASE_URL, on REAL PostgreSQL:
 *
 *   • sunflower oil, counted in ITEMS: 1 item → inner of 6 → case of 4 inners (24 items). The buyer orders 5 CASES at
 *     ₹2,880 a case; the order holds 120 items at ₹120 each. The receiver counts 4 cases + 3 inners + 2 singles = 116 items.
 *   • loose Ponni rice, a KILO product counted in GRAMS (OB-31): 1 g → kg of 1000 g → sack of 25 kg. The buyer orders 4
 *     SACKS at ₹1,550 a sack; the order holds 100 000 g at ₹62 per KILO. The receiver counts 3 sacks + 12 kg + 500 g =
 *     87 500 g, valued ONCE at 87 500 × ₹62 ÷ 1000 = ₹5,425 (never per gram — ₹62/kg is 6.2 paise a gram).
 *
 * Then the till sells 3 items and 1.250 kg; on-hand, value and cost of goods move in base units, to the paisa. A pack cost
 * that does not divide into whole paise per base unit, an unknown pack level, a product with no packs, and a kilo line counted
 * in the wrong unit are each refused by name with nothing saved. A re-sent receipt and a re-sent sale change nothing.
 */

const OWNER = 'u-owner';   // issues the order (purchase.order.approve)
const BUYER = 'u-buyer';   // store_manager: proposes the order and receives the delivery
const STORE = 'S1';
const today = new Date().toISOString().slice(0, 10);

const catalogue: ExtractBundle = {
  categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  taxRates: [{ hsnCode: '1512', effectiveFrom: '2017-07-01', rateBps: 500 }, { hsnCode: '1006', effectiveFrom: '2017-07-01', rateBps: 500 }],
  products: [
    {
      productId: 'P-OIL', sku: 'OIL-1L', name: 'Sunflower oil 1 L pouch', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1512',
      lifecycle: 'active', barcodes: [{ code: 'INT-OIL-1', kind: 'internal' }], priceMinor: 14_000, mrpMinor: 15_000, costMinor: 12_000, marginFloorBps: 0,
    },
    {
      productId: 'P-RICE', sku: 'RICE-LOOSE', name: 'Ponni rice (loose)', baseUom: 'kg', primaryCategoryId: 'grocery', taxClass: '1006',
      lifecycle: 'active', barcodes: [{ code: 'INT-RICE-1', kind: 'internal' }], priceMinor: 8_000, mrpMinor: 9_000, costMinor: 6_200, marginFloorBps: 0,
    },
    {
      productId: 'P-SOAP', sku: 'SOAP-1', name: 'Bath soap', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1512',
      lifecycle: 'active', barcodes: [{ code: 'INT-SOAP-1', kind: 'internal' }], priceMinor: 3_000, mrpMinor: 3_500, costMinor: 2_000, marginFloorBps: 0,
    },
  ],
  suppliers: [], customers: [], openingStock: [],
};

let pool: Pool | undefined;
const DATABASE_URL = process.env['DATABASE_URL'];
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly store: EventStore; readonly idempotency: MemoryIdempotencyStore | SqlIdempotencyStore }
const backings: { name: string; backing: () => Backing }[] = [
  { name: 'the in-memory event store', backing: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });
}

type Reply = { status: number; body: unknown };
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function setUp(h: ApiHarness, t: string): Promise<(method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>) => Promise<Reply>> {
  await h.seedOwner(t, OWNER);
  await h.provisionRole(t, BUYER, 'store_manager');
  const plan = planLoad(catalogue, {
    target: { targetId: 'sf11', tenantId: t, kind: 'rehearsal', label: 'SF-11' }, tenantId: t, demoTenantIds: [], operator: OWNER,
    targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0, loadId: 'sf11', stockLocationId: STORE, receivedOnDate: today, currency: 'INR',
  });
  if (!plan.ok) throw new Error(plan.detail);
  const loaded = await executeLoad(h, plan);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.steps.filter((s) => !s.ok)));
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  // The packs — the product master's own ladders (M03-FR-02), defined once, exact.
  expect((await call('POST', '/v1/catalogue/products/P-OIL/pack', OWNER, { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'inner', containsMinor: 6 }, { level: 'case', containsMinor: 4 }] }, 'pack-oil')).status).toBe(201);
  expect((await call('POST', '/v1/catalogue/products/P-RICE/pack', OWNER, { baseUom: 'kg', levels: [{ level: 'g', containsMinor: 1 }, { level: 'kg', containsMinor: 1000 }, { level: 'sack', containsMinor: 25 }] }, 'pack-rice')).status).toBe(201);
  return call;
}

describe.each(backings)('SF-11 the pack chain, case → inner → base, through the real routes — on $name', ({ backing }) => {
  it('ordered by the case and the sack, received by case / inner / kilo, stocked and sold in base units, costed to the paisa', async () => {
    const t = randomUUID();
    const b = backing();
    const h = apiHarness(b);
    const call = await setUp(h, t);

    // 1. The buyer orders BY THE PACK; head office converts exactly.
    const po = await call('POST', '/v1/purchase/orders/po-pack-1', BUYER, {
      supplierId: 'sup-1',
      lines: [
        { productId: 'P-OIL', pack: { level: 'case', quantity: 5 }, packCost: { minor: 288_000, currency: 'INR' } },
        { productId: 'P-RICE', pack: { level: 'sack', quantity: 4 }, packCost: { minor: 155_000, currency: 'INR' } },
      ],
    }, 'po-pack-1');
    expect(po.status).toBe(201);
    const order = (po.body as { order: { lines: { productId: string; orderedQty: number; unitCost: { minor: number }; uom: string; ordered: { level: string; quantity: number; unitsPerPack: number } }[]; totalMinor: number } }).order;
    expect(order.lines.map((l) => [l.productId, l.orderedQty, l.unitCost.minor, l.uom, l.ordered.level, l.ordered.quantity, l.ordered.unitsPerPack])).toEqual([
      ['P-OIL', 120, 12_000, 'each', 'case', 5, 24],        // 5 cases × 24 = 120 items at ₹120.00 each
      ['P-RICE', 100_000, 6_200, 'kg', 'sack', 4, 25_000],  // 4 sacks × 25 kg = 100 000 g at ₹62.00 per kilo
    ]);
    expect(order.totalMinor).toBe(5 * 288_000 + 4 * 155_000); // the order is worth exactly what the packs cost
    expect((await call('POST', '/v1/purchase/orders/po-pack-1/approval', OWNER, { reason: 'monthly stock' }, 'po-pack-1-ok')).status).toBe(200);

    // 2. The receiver counts in cases, inners and singles; in sacks, kilos and grams.
    const grnBody = {
      poId: 'po-pack-1', warehouseId: STORE, receivedOnDate: today, currency: 'INR',
      lines: [
        { lineId: 'L1', productId: 'P-OIL', orderedPacks: [{ level: 'case', quantity: 5 }], countedPacks: [{ level: 'case', quantity: 4 }, { level: 'inner', quantity: 3 }, { level: 'each', quantity: 2 }], unitCost: { minor: 12_000, currency: 'INR' }, condition: 'good' },
        { lineId: 'L2', productId: 'P-RICE', orderedPacks: [{ level: 'sack', quantity: 4 }], countedPacks: [{ level: 'sack', quantity: 3 }, { level: 'kg', quantity: 12 }, { level: 'g', quantity: 500 }], unitCost: { minor: 6_200, currency: 'INR' }, condition: 'good' },
      ],
    };
    const grn = await call('POST', '/v1/inventory/goods-receipt/grn-pack-1', BUYER, grnBody, 'grn-pack-1');
    expect(grn.status).toBe(201);
    const lines = (grn.body as { grn: { captured: { lines: { productId: string; sellableMinor: number; uom: string }[] } } }).grn.captured.lines;
    expect(lines.map((l) => [l.productId, l.sellableMinor, l.uom])).toEqual([['P-OIL', 116, 'each'], ['P-RICE', 87_500, 'kg']]);
    const posted = (await call('GET', '/v1/purchase/orders/po-pack-1', OWNER)).body as { order: { receivedByProduct: Record<string, number> } };
    expect(posted.order.receivedByProduct).toEqual({ 'P-OIL': 116, 'P-RICE': 87_500 }); // folded into the order in base units

    const onHand = async (): Promise<Record<string, number>> => {
      const rows = ((await call('GET', '/v1/inventory/availability', OWNER)).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows;
      return Object.fromEntries(rows.filter((r) => r.locationId === STORE).map((r) => [r.productId, r.onHandMinor]));
    };
    const valued = async (): Promise<Record<string, { value: number; cogs: number }>> => {
      const rows = ((await call('GET', '/v1/inventory/valuation', OWNER)).body as { rows: { productId: string; value: { minor: number }; cogs: { minor: number } }[] }).rows;
      return Object.fromEntries(rows.map((r) => [r.productId, { value: r.value.minor, cogs: r.cogs.minor }]));
    };
    expect(await onHand()).toEqual({ 'P-OIL': 116, 'P-RICE': 87_500 });
    // Cost per base unit: ₹120 an item; ₹62 a KILO — 87 500 g × 6 200 ÷ 1000 = 542 500 paise, rounded once.
    expect(await valued()).toEqual({ 'P-OIL': { value: 116 * 12_000, cogs: 0 }, 'P-RICE': { value: 542_500, cogs: 0 } });

    // 3. The till sells 3 pouches and 1.250 kg of rice — in base units.
    const sale = {
      saleId: 'sale-pack-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: OWNER, tradingDay: today, committedAt: new Date().toISOString(), // after the receipt: the average is folded in time order
      totalMinor: 3 * 14_000 + 10_000, currency: 'INR', packVersion: 1, locationId: STORE,
      lines: [
        { productId: 'P-OIL', quantityMinor: 3, uom: 'each', unitPriceMinor: 14_000, lineTotalMinor: 42_000 },
        { productId: 'P-RICE', quantityMinor: 1_250, uom: 'kg', unitPriceMinor: 8_000, lineTotalMinor: 10_000 },
      ],
      tenders: [{ kind: 'cash', amountMinor: 52_000 }],
    };
    expect((await call('POST', '/v1/sales', OWNER, sale, 'sale-pack-1')).status).toBe(202);
    expect(await onHand()).toEqual({ 'P-OIL': 113, 'P-RICE': 86_250 });
    // Cost of goods at the average: 3 × ₹120 = ₹360; 1 250 g of a 542 500-paise / 87 500 g lot = 7 750 paise (₹62/kg × 1.25 kg).
    expect(await valued()).toEqual({ 'P-OIL': { value: 113 * 12_000, cogs: 36_000 }, 'P-RICE': { value: 542_500 - 7_750, cogs: 7_750 } });

    // 4. Re-sent receipt and re-sent sale: nothing doubles. And a fresh process on the same database reads the same.
    const again = await call('POST', '/v1/inventory/goods-receipt/grn-pack-1', BUYER, grnBody, 'grn-pack-1-again');
    expect((again.body as { alreadyReceived: boolean }).alreadyReceived).toBe(true);
    await call('POST', '/v1/sales', OWNER, sale, 'sale-pack-1-again');
    const restarted = apiHarness(b);
    const rows = ((await restarted.request({ method: 'GET', path: '/v1/inventory/valuation', userId: OWNER, tenantId: t })).body as { rows: { productId: string; onHandMinor: number; value: { minor: number } }[] }).rows;
    expect(rows.map((r) => [r.productId, r.onHandMinor, r.value.minor])).toEqual([['P-OIL', 113, 113 * 12_000], ['P-RICE', 86_250, 542_500 - 7_750]]);
  }, 120_000);

  it('refuses by name, nothing saved: a pack cost that is not whole paise per unit, an unknown level, a product with no packs, a kilo counted in the wrong unit; a cashier cannot order', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    const call = await setUp(h, t);
    const order = (lines: unknown[], key: string, who = BUYER) => call('POST', `/v1/purchase/orders/${key}`, who, { supplierId: 'sup-1', lines }, key);

    // ₹250 for a case of 24 is 1041.67 paise an item — never rounded silently.
    const odd = await order([{ productId: 'P-OIL', pack: { level: 'case', quantity: 1 }, packCost: { minor: 25_000, currency: 'INR' } }], 'po-odd');
    expect(odd.status).toBe(422);
    expect(codeOf(odd)).toBe('pack_cost_not_whole_paise');
    const pallet = await order([{ productId: 'P-OIL', pack: { level: 'pallet', quantity: 1 }, packCost: { minor: 1_000_000, currency: 'INR' } }], 'po-pallet');
    expect(pallet.status).toBe(422);
    expect(codeOf(pallet)).toBe('unknown_pack_level');
    const noPack = await order([{ productId: 'P-SOAP', pack: { level: 'case', quantity: 1 }, packCost: { minor: 48_000, currency: 'INR' } }], 'po-nopack');
    expect(noPack.status).toBe(422);
    expect(codeOf(noPack)).toBe('no_pack_hierarchy');
    for (const id of ['po-odd', 'po-pallet', 'po-nopack']) expect((await call('GET', `/v1/purchase/orders/${id}`, OWNER)).status).toBe(404);
    await h.provisionRole(t, 'u-cash', 'cashier');
    expect((await order([{ productId: 'P-OIL', pack: { level: 'case', quantity: 1 }, packCost: { minor: 288_000, currency: 'INR' } }], 'po-cash', 'u-cash')).status).toBe(403);

    // A kilo product counted in "g" (or anything but its base unit) is refused — the shelf would be a thousand times out.
    const wrongUnit = await call('POST', '/v1/inventory/goods-receipt/grn-wrong', BUYER, {
      warehouseId: STORE, receivedOnDate: today, currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'P-RICE', orderedMinor: 5, countedMinor: 5, uom: 'g', unitCost: { minor: 6_200, currency: 'INR' }, condition: 'good' }],
    }, 'grn-wrong');
    expect(wrongUnit.status).toBe(422);
    expect(codeOf(wrongUnit)).toBe('receipt_unit_not_base');
    const badLevel = await call('POST', '/v1/inventory/goods-receipt/grn-bad-level', BUYER, {
      warehouseId: STORE, receivedOnDate: today, currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'P-OIL', orderedMinor: 24, countedPacks: [{ level: 'crate', quantity: 1 }], unitCost: { minor: 12_000, currency: 'INR' }, condition: 'good' }],
    }, 'grn-bad-level');
    expect(badLevel.status).toBe(422);
    expect(codeOf(badLevel)).toBe('unknown_pack_level');
    const rows = ((await call('GET', '/v1/inventory/availability', OWNER)).body as { rows: unknown[] }).rows;
    expect(rows).toEqual([]);
  }, 120_000);

  it('M03-FR-01: a report by category returns exactly that category\'s products, its sub-categories included; an unknown category is a 404, not an empty list', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await h.seedOwner(t, OWNER);
    const tree: ExtractBundle = {
      ...catalogue,
      categories: [
        { categoryId: 'grocery', name: 'Grocery', parentId: null },
        { categoryId: 'oils', name: 'Edible oils', parentId: 'grocery' },
        { categoryId: 'home', name: 'Home care', parentId: null },
      ],
      products: [
        { ...catalogue.products[0]!, primaryCategoryId: 'oils' },
        { ...catalogue.products[1]!, primaryCategoryId: 'grocery' },
        { ...catalogue.products[2]!, primaryCategoryId: 'home' },
      ],
    };
    const plan = planLoad(tree, {
      target: { targetId: 'sf11c', tenantId: t, kind: 'rehearsal', label: 'SF-11' }, tenantId: t, demoTenantIds: [], operator: OWNER,
      targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0, loadId: 'sf11c', stockLocationId: STORE, receivedOnDate: today, currency: 'INR',
    });
    if (!plan.ok) throw new Error(plan.detail);
    expect((await executeLoad(h, plan)).ok).toBe(true);
    const byCategory = async (categoryId: string): Promise<Reply> => h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OWNER, tenantId: t, query: { categoryId } });
    const ids = (r: Reply): string[] => (r.body as { products: { productId: string }[] }).products.map((p) => p.productId).sort();
    expect(ids(await byCategory('grocery'))).toEqual(['P-OIL', 'P-RICE']); // grocery + its sub-category oils
    expect(ids(await byCategory('oils'))).toEqual(['P-OIL']);
    expect(ids(await byCategory('home'))).toEqual(['P-SOAP']);
    expect((await byCategory('toys')).status).toBe(404);
    const all = (await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OWNER, tenantId: t })).body as { count: number };
    expect(all.count).toBe(3);
  }, 120_000);
});
