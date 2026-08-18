import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Slice 2 finish (M03 → M05 → the lane): the SIGNED catalogue pack is now built by folding the four cloud
// master-data stores for a store — the product master, the price lists, the barcode register and the
// tax-class rate schedules — through the tested buildCatalogueSnapshot. This proves the whole chain closes:
// a product AUTHORED, PRICED, BARCODED and its tax rate SET, then PUBLISHED, appears in the signed pack a
// lane reads over GET /v1/catalogue/pack — priced and taxed. A product with no price is NOT in the pack
// (never shipped unpriceable). Publishing needs the store the pack is for (prices resolve per store).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE = 'store-01';
const FUTURE_FROM = '2030-01-01';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

const publishProduct = (h: ApiHarness, productId: string, product: unknown) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-${productId}`, body: { product, categories: [GROCERY] } });
const setTaxRate = (h: ApiHarness, hsn: string, rateBps: number) =>
  h.request({ method: 'POST', path: `/v1/catalogue/tax-classes/${hsn}/rates/2017-07-01`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-tax-${hsn}`, body: { rateBps } });
const setPrice = (h: ApiHarness, productId: string, priceMinor: number, mrpMinor: number) =>
  h.request({ method: 'POST', path: `/v1/prices/list/${productId}/entries/e1`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-price-${productId}`, body: { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor, currency: 'INR', effectiveFrom: FUTURE_FROM } });
const assignBarcode = (h: ApiHarness, productId: string, code: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/barcodes/${code}`, userId: 'u-owner', tenantId: A, idempotencyKey: `k-bc-${productId}`, body: { kind: 'ean' } });
const publishPack = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/catalogue/pack', userId: u, tenantId: A, idempotencyKey: key, body });
const getPack = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/catalogue/pack', userId: u, tenantId: A });

const salt = (over: Record<string, unknown> = {}) =>
  ({ sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft', ...over });

describe('catalogue pack publish from master data (slice 2 finish)', () => {
  it('publishes a signed pack built from the authored product, and a lane reads it back priced + taxed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await publishProduct(h, 'p-salt', salt());
    await setTaxRate(h, '25010020', 500);
    await setPrice(h, 'p-salt', 2000, 2500);
    await assignBarcode(h, 'p-salt', '8901058000108');

    const pub = await publishPack(h, 'u-owner', { storeId: STORE, asOf: AS_OF }, 'k-pub-1');
    expect(pub.status).toBe(201);

    // The lane reads the SIGNED pack — the authored product is on it, priced and taxed.
    const pack = await getPack(h, 'u-owner');
    expect(pack.status).toBe(200);
    const products = (pack.body as { snapshot: { products: { productId: string; unitPriceMinor: number; taxBps: number }[]; barcodes: { code: string }[] } }).snapshot.products;
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ productId: 'p-salt', unitPriceMinor: 2000, taxBps: 500 });
    expect((pack.body as { snapshot: { barcodes: { code: string }[] } }).snapshot.barcodes.map((b) => b.code)).toContain('8901058000108');
  });

  it('never ships an unpriceable product: a product with no price is left off the published pack', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setTaxRate(h, '25010020', 500);
    await publishProduct(h, 'p-priced', salt({ sku: 'SKU-PRICED' }));
    await setPrice(h, 'p-priced', 2000, 2500);
    await publishProduct(h, 'p-unpriced', salt({ sku: 'SKU-UNPRICED', name: 'Salt (no price)' })); // no price set

    await publishPack(h, 'u-owner', { storeId: STORE, asOf: AS_OF }, 'k-pub-1');
    const ids = ((await getPack(h, 'u-owner')).body as { snapshot: { products: { productId: string }[] } }).snapshot.products.map((p) => p.productId);
    expect(ids).toContain('p-priced');
    expect(ids).not.toContain('p-unpriced'); // never on a lane without a price
  });

  it('refuses to publish without a store — a pack is priced per store', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await publishPack(h, 'u-owner', {}, 'k-nostore');
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_pack_publish');
  });
});
