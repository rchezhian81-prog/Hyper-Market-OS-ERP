import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';

/**
 * **SF-01 (prices) — a price saved on the screen is the price the till charges (Wave 4 · M05-FR-01 · M05-FR-02 ·
 * M05-FR-04 · P-02 one commerce truth).**
 *
 * The audit saved a price on the catalogue screen: 201, verdict ok — and the price list the catalogue pack is built
 * from had no entry for it, so the next pack (and every till) kept the old price. A governed price change now writes
 * its operative store-scope price-list entry, effective from today, in the same append as its record — for the store it
 * names, else every store head office knows. This follows it all the way: change → published pack → banked sale.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TODAY = new Date().toISOString().slice(0, 10);
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

async function shop(): Promise<{ h: ApiHarness; req: (method: 'POST' | 'GET', path: string, body?: unknown, key?: string) => Promise<{ status: number; body: unknown }> }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  const req = (method: 'POST' | 'GET', path: string, body?: unknown, key = `k-${Math.random()}`) =>
    h.request({ method, path, userId: 'u-owner', tenantId: A, ...(method === 'POST' ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { body }) });
  await aBranch(h, A, 'u-owner', 'store-1');
  await storeRules(h, A, 'u-owner', 'store-1', 0); // M05: the owner set no margin floor for this store (0 = none)
  expect((await req('POST', '/v1/catalogue/products/p-salt/publish', { product: { sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' }, categories: [GROCERY] })).status).toBeLessThan(300);
  expect((await req('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 })).status).toBeLessThan(300);
  // the price that stands before the change: ₹20 at store-1, from today
  expect((await req('POST', '/v1/prices/list/p-salt/entries/e1', { scope: 'store', scopeRef: 'store-1', priceMinor: 2_000, mrpMinor: 2_500, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY })).status).toBe(201);
  return { h, req };
}
const packPrice = async (req: Awaited<ReturnType<typeof shop>>['req']): Promise<{ version: number; price: number | undefined }> => {
  expect((await req('POST', '/v1/catalogue/pack', { storeId: 'store-1' })).status).toBe(201);
  const pack = (await req('GET', '/v1/catalogue/pack')).body as { snapshot: { version: number; products: { productId: string; unitPriceMinor: number }[] } };
  return { version: pack.snapshot.version, price: pack.snapshot.products.find((p) => p.productId === 'p-salt')?.unitPriceMinor };
};
const change = (priceMinor: number, over: Record<string, unknown> = {}) =>
  ({ productId: 'p-salt', priceMinor, mrpMinor: 2_500, costMinor: 1_000, currency: 'INR', marginFloorBps: 0, ...over });

describe('SF-01 — a price saved on the screen reaches the till', () => {
  it('THE AUDIT\'S CASE: ₹20 → ₹18 saved; the next pack for the store carries ₹18, and a sale at ₹18 on it is clean', async () => {
    const { req } = await shop();
    expect(await packPrice(req)).toEqual({ version: 1, price: 2_000 });

    const saved = await req('POST', '/v1/prices/changes', change(1_800));
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ verdict: 'ok', operativeAt: ['store-1'], effectiveFrom: TODAY });
    const next = await packPrice(req);
    expect(next).toEqual({ version: 2, price: 1_800 });

    // a till on the new pack charges ₹18: no price finding; one still charging ₹20 on it is flagged
    const sale = (saleId: string, unitPriceMinor: number) => ({
      saleId, receiptNumber: saleId, laneId: 'lane-1', cashierId: 'u-owner', locationId: 'store-1', tradingDay: TODAY,
      committedAt: `${TODAY}T10:00:00.000Z`, totalMinor: unitPriceMinor, currency: 'INR', packVersion: next.version,
      lines: [{ productId: 'p-salt', quantityMinor: 1, uom: 'each', unitPriceMinor, lineTotalMinor: unitPriceMinor }],
      tenders: [{ kind: 'cash', amountMinor: unitPriceMinor }],
    });
    const findings = async (body: unknown) => {
      const res = await req('POST', '/v1/sales', body);
      expect(res.status).toBe(202);
      return JSON.stringify(res.body);
    };
    expect(await findings(sale('S-new', 1_800))).not.toMatch(/price_differs_from_catalogue/);
    expect(await findings(sale('S-old', 2_000))).toMatch(/price_differs_from_catalogue/);
  });

  it('a change for ONE store moves only that store; the other keeps its price', async () => {
    const { h, req } = await shop();
    // a second store with its own price
    expect((await h.request({ method: 'POST', path: '/v1/org/nodes/store-2', userId: 'u-owner', tenantId: A, idempotencyKey: 'org-store-2', body: { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' } })).status).toBeLessThan(300);
    await storeRules(h, A, 'u-owner', 'store-2', 0);
    expect((await req('POST', '/v1/prices/list/p-salt/entries/e2', { scope: 'store', scopeRef: 'store-2', priceMinor: 2_100, mrpMinor: 2_500, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY })).status).toBe(201);
    const saved = await req('POST', '/v1/prices/changes', change(1_900, { storeId: 'store-2' }));
    expect(saved.body).toMatchObject({ operativeAt: ['store-2'] });
    expect((await packPrice(req)).price).toBe(2_000); // store-1 untouched
    expect((await req('POST', '/v1/catalogue/pack', { storeId: 'store-2' })).status).toBe(201);
    const pack2 = (await req('GET', '/v1/catalogue/pack')).body as { snapshot: { products: { productId: string; unitPriceMinor: number }[] } };
    expect(pack2.snapshot.products.find((p) => p.productId === 'p-salt')?.unitPriceMinor).toBe(1_900);
  });

  it('with no store set up, a change that no till would ever charge is refused, not "saved"', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await h.request({ method: 'POST', path: '/v1/prices/changes', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-nostore', body: change(1_800) });
    expect(res.status).toBe(422);
    expect((res.body as { error: { code: string } }).error.code).toBe('no_store_to_price');
  });

  it('a price above MRP is still refused before anything is written', async () => {
    const { req } = await shop();
    expect((await req('POST', '/v1/prices/changes', change(2_600))).status).toBe(422);
    expect((await packPrice(req)).price).toBe(2_000);
  });
});
