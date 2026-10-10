import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-31 "A" (owner, 10 Oct 2026) — weighed goods are counted in GRAMS everywhere; cost is per KG; value = grams × price per
 * kg ÷ 1000, rounded once (`packages/contracts/src/quantity.ts`) · SF-11 case → base on the head-office receipt.**
 *
 * Loose rice (master unit kg, ₹45.00 a kg; a 10 kg bag is a pack level) through the real routes:
 *   order 25.25 kg = 25250 g → ₹1,136.25 committed; delivered as 2 bags (→ 20000 g, said `counted_in_packs`) plus 5.25 kg loose
 *   typed "KG" (→ 5250 g, one spelling) → 25250 g on hand, valued ₹1,136.25; a line in "case" (no such level) refused by name;
 *   2.5 kg put in a bin; a 30 g count variance valued ₹1.35; a 100 g loss valued ₹4.50; an item product (each/EA) unchanged.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data only.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PER_KG = 4_500;

async function shop(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-recv', 'store_manager');
  await approvedSuppliers(h, t, 'sup-grain');
  await deliveryPlaces(h, t, 'S1', 'S1-BACK');
  expect((await call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  const publish = async (productId: string, baseUom: string) => expect((await call('POST', `/v1/catalogue/products/${productId}/publish`, 'u-owner', {
    product: { sku: productId, name: productId, baseUom, primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' },
    categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  }, `pub-${productId}`)).status).toBe(201);
  await publish('p-rice-loose', 'kg');
  await publish('p-soap', 'ea');
  expect((await call('POST', '/v1/catalogue/products/p-rice-loose/pack', 'u-owner', { baseUom: 'kg', levels: [{ level: 'kg', containsMinor: 1 }, { level: 'bag', containsMinor: 10 }] }, 'pack-rice')).status).toBe(201);
  return { call };
}

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

describe.each(backings)('OB-31 — weighed goods in grams, cost per kg — on $name', ({ harness }) => {
  it('order → receipt in bags and loose kg → on hand in grams, valued per kg; a bin, a count variance and a loss valued the same way', async () => {
    const h = harness();
    const t = randomUUID();
    const { call } = await shop(h, t);

    // The order: 25.25 kg = 25250 g at ₹45.00 a kg = ₹1,136.25 committed (never 25250 × 4500).
    const po = await call('POST', '/v1/purchase/orders/po-rice', 'u-buyer', { supplierId: 'sup-grain', deliverToLocationId: 'S1', lines: [{ productId: 'p-rice-loose', orderedQty: 25_250, unitCost: { minor: PER_KG, currency: 'INR' } }] }, 'po-rice');
    expect(po.status).toBe(201);
    expect(po.body).toMatchObject({ order: { totalMinor: 113_625, lines: [{ uom: 'kg', orderedQty: 25_250 }] } });
    expect((await call('POST', '/v1/purchase/orders/po-rice/approval', 'u-owner', { reason: 'ok' }, 'po-rice-ok')).status).toBe(200);
    expect(await call('GET', '/v1/purchase/commitments', 'u-owner')).toMatchObject({ body: { valueMinor: 113_625 } });

    // A line in a unit the product does not have (no "case" level) is refused by name; nothing received.
    const caseLine = await call('POST', '/v1/inventory/goods-receipt/g-bad', 'u-recv', {
      warehouseId: 'S1-BACK', receivedOnDate: '2026-10-10', currency: 'INR', poId: 'po-rice',
      lines: [{ lineId: 'L1', productId: 'p-rice-loose', orderedMinor: 2, countedMinor: 2, uom: 'case', unitCost: { minor: PER_KG, currency: 'INR' }, condition: 'good' }],
    }, 'g-bad');
    expect(caseLine.status).toBe(422);
    expect(codeOf(caseLine)).toBe('unit_not_the_products');

    // Two 10 kg bags (a pack level → 20000 g) and 5.25 kg loose typed "KG" (→ 5250 g): 25250 g received.
    const got = await call('POST', '/v1/inventory/goods-receipt/g-rice', 'u-recv', {
      warehouseId: 'S1-BACK', receivedOnDate: '2026-10-10', currency: 'INR', poId: 'po-rice',
      lines: [
        { lineId: 'L1', productId: 'p-rice-loose', orderedMinor: 2, countedMinor: 2, uom: 'bag', unitCost: { minor: PER_KG, currency: 'INR' }, condition: 'good' },
        { lineId: 'L2', productId: 'p-rice-loose', orderedMinor: 5_250, countedMinor: 5_250, uom: 'KG', unitCost: { minor: PER_KG, currency: 'INR' }, condition: 'good' },
      ],
    }, 'g-rice');
    expect(got.status, JSON.stringify(got.body)).toBe(201);
    const grn = (got.body as { grn: { governanceFlags: string[]; captured: { lines: { uom: string; sellableMinor: number }[] } } }).grn;
    expect(grn.governanceFlags).toContain('counted_in_packs');
    expect(grn.captured.lines.map((l) => [l.uom, l.sellableMinor])).toEqual([['kg', 20_000], ['kg', 5_250]]);
    const onHand = ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId: 'p-rice-loose' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows;
    expect(onHand).toEqual([expect.objectContaining({ locationId: 'S1-BACK', onHandMinor: 25_250 })]);
    // Value: 25250 g × ₹45.00/kg ÷ 1000 = ₹1,136.25; the average reads back per KG.
    const val = (await call('GET', '/v1/inventory/valuation', 'u-owner', undefined, undefined, { productId: 'p-rice-loose' })).body as { rows: { value: { minor: number }; unitCostMinor: number }[] };
    expect(val.rows).toEqual([expect.objectContaining({ value: { minor: 113_625, currency: 'INR' }, unitCostMinor: PER_KG })]);

    // A bin holds grams: 2.5 kg put away is 2500.
    expect((await call('POST', '/v1/warehouse/bins/BIN-R', 'u-owner', { storeId: 'S1', capacityMinor: 100_000, pickable: true, zone: 'ambient', locationId: 'S1-BACK' }, 'bin-r')).status).toBe(201);
    expect((await call('POST', '/v1/warehouse/movements/pa-r', 'u-recv', { kind: 'put_away', storeId: 'S1', productId: 'p-rice-loose', batchId: null, quantityMinor: 2_500, uom: 'Kg', fromBinId: null, toBinId: 'BIN-R' }, 'pa-r')).status).toBe(201);
    expect(((await call('GET', '/v1/warehouse/bins/BIN-R', 'u-owner')).body as { occupancyMinor: number }).occupancyMinor).toBe(2_500);

    // A count 30 g short: valued 30 × 4500 ÷ 1000 = ₹1.35 (never ₹1,350.00).
    const count = await call('POST', '/v1/inventory/counts/k-rice', 'u-recv', { productId: 'p-rice-loose', locationId: 'S1-BACK', uom: 'kg', countedMinor: 25_220, reasonCode: 'cycle_count' }, 'k-rice');
    expect(count.status, JSON.stringify(count.body)).toBeLessThan(300);
    expect(count.body).toMatchObject({ varianceMinor: -30, valueMinor: 135 });

    // A loss of 100 g: ₹4.50 at the average.
    const loss = await call('GET', '/v1/inventory/write-off-value', 'u-owner', undefined, undefined, { productId: 'p-rice-loose', locationId: 'S1-BACK', qty: '100', uom: 'kg' });
    expect(loss.body).toMatchObject({ valueMinor: 450 });
  }, 60_000);

  it('an item product is unchanged: "each" / "EA" / "ea" are one unit; value is quantity × cost', async () => {
    const h = harness();
    const t = randomUUID();
    const { call } = await shop(h, t);
    const got = await call('POST', '/v1/inventory/goods-receipt/g-soap', 'u-recv', {
      warehouseId: 'S1-BACK', receivedOnDate: '2026-10-10', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'p-soap', orderedMinor: 12, countedMinor: 12, uom: 'EACH', unitCost: { minor: 1_800, currency: 'INR' }, condition: 'good' }],
    }, 'g-soap');
    expect(got.status).toBe(201);
    expect((got.body as { grn: { captured: { lines: { uom: string }[] } } }).grn.captured.lines[0]!.uom).toBe('ea');
    const val = (await call('GET', '/v1/inventory/valuation', 'u-owner', undefined, undefined, { productId: 'p-soap' })).body as { rows: { value: { minor: number }; unitCostMinor: number }[] };
    expect(val.rows).toEqual([expect.objectContaining({ value: { minor: 21_600, currency: 'INR' }, unitCostMinor: 1_800 })]);
    expect(codeOf(await call('POST', '/v1/inventory/goods-receipt/g-soap-kg', 'u-recv', {
      warehouseId: 'S1-BACK', receivedOnDate: '2026-10-10', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'p-soap', orderedMinor: 1, countedMinor: 1, uom: 'kg', unitCost: { minor: 1_800, currency: 'INR' }, condition: 'good' }],
    }, 'g-soap-kg'))).toBe('unit_not_the_products');
  }, 60_000);
});
