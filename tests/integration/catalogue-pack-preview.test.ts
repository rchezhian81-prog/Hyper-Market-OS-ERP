import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Slice 2 (M03 → M05 → the lane): the catalogue-pack ASSEMBLY folds the four cloud master-data stores this
// session built — the product master, the price lists, the barcode register, and the tax-class GST-rate
// schedules — into ONE snapshot for a store, through the tested buildCatalogueSnapshot. This proves the
// end-to-end join: a product AUTHORED on the cloud, PRICED, BARCODED and its tax rate SET, appears in the
// pack a lane would hold — priced and taxed; and a product missing a price or a tax rate is LEFT OUT and
// NAMED with the reason (P-08: never a guessed or zero price on a lane).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE = 'store-01';
const FUTURE_FROM = '2030-01-01'; // future so the price is not back-dated (refused); resolved as of asOf
const AS_OF = '2030-06-01';

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

const publishProduct = (h: ApiHarness, productId: string, product: unknown) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-${productId}`, body: { product, categories: [GROCERY] } });
const setTaxRate = (h: ApiHarness, hsn: string, rateBps: number) =>
  h.request({ method: 'POST', path: `/v1/catalogue/tax-classes/${hsn}/rates/2017-07-01`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-tax-${hsn}`, body: { rateBps } });
const setPrice = (h: ApiHarness, productId: string, priceMinor: number, mrpMinor: number) =>
  // costMinor/marginFloorBps satisfy the price gate trivially — these tests exercise pack preview, not the gate.
  h.request({ method: 'POST', path: `/v1/prices/list/${productId}/entries/e1`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-price-${productId}`, body: { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: FUTURE_FROM } });
const assignBarcode = (h: ApiHarness, productId: string, code: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/barcodes/${code}`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-bc-${productId}`, body: { kind: 'ean' } });
const preview = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/catalogue/pack/preview', userId: u, tenantId: A, query });

const salt = (over: Record<string, unknown> = {}) =>
  ({ sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft', ...over });

describe('catalogue pack assembly / preview (slice 2)', () => {
  it('folds an authored + priced + barcoded + taxed product into the pack for a store', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await publishProduct(h, 'p-salt', salt())).status).toBe(201);
    expect((await setTaxRate(h, '25010020', 0)).status).toBe(201); // salt is GST-exempt — 0% is a rate, not "missing"
    expect((await setPrice(h, 'p-salt', 2000, 2500)).status).toBe(201);
    expect((await assignBarcode(h, 'p-salt', '8901058000108')).status).toBe(201);

    const res = await preview(h, 'u-owner', { storeId: STORE, asOf: AS_OF });
    expect(res.status).toBe(200);
    const body = res.body as {
      includedCount: number;
      excluded: unknown[];
      snapshot: { products: { productId: string; unitPriceMinor: number; taxBps: number }[]; barcodes: { code: string }[] };
    };
    expect(body.includedCount).toBe(1);
    expect(body.excluded).toEqual([]);
    expect(body.snapshot.products[0]).toMatchObject({ productId: 'p-salt', unitPriceMinor: 2000, taxBps: 0 });
    expect(body.snapshot.barcodes.map((b) => b.code)).toContain('8901058000108');
  });

  it('leaves out a product with no price, and one with no tax rate — each named with its reason (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setTaxRate(h, '25010020', 500); // a real rate for the classes that have one

    // Priced but its tax class has NO rate schedule → excluded 'no_tax_class'.
    await publishProduct(h, 'p-untaxed', salt({ sku: 'SKU-UNTAXED', name: 'Mystery 1kg', taxClass: '99999' }));
    await setPrice(h, 'p-untaxed', 3000, 3500);
    // Taxed but NO price at this store → excluded 'no_price'.
    await publishProduct(h, 'p-unpriced', salt({ sku: 'SKU-UNPRICED', name: 'Salt (no price) 1kg' }));

    const body = (await preview(h, 'u-owner', { storeId: STORE, asOf: AS_OF })).body as {
      includedCount: number;
      excluded: { productId: string; reason: string }[];
    };
    expect(body.includedCount).toBe(0);
    const byId = Object.fromEntries(body.excluded.map((e) => [e.productId, e.reason]));
    expect(byId['p-untaxed']).toBe('no_tax_class');
    expect(byId['p-unpriced']).toBe('no_price');
  });

  it('gates the preview on catalogue.pack.read; malformed (no storeId / bad asOf) → 400', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // lacks catalogue.pack.read
    expect((await preview(h, 'u-acct', { storeId: STORE })).status).toBe(403);
    const noStore = await preview(h, 'u-owner', { asOf: AS_OF });
    expect(noStore.status).toBe(400);
    expect((noStore.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_pack_preview');
    expect((await preview(h, 'u-owner', { storeId: STORE, asOf: 'not-a-date' })).status).toBe(400);
  });
});
