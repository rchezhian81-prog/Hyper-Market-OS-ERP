import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03 catalogue — DURABILITY AND TENANT ISOLATION AS A WHOLE (M03-FR-01/02/03, API-02).
//
// product-merge and pack-hierarchy already prove their own cold-restart rebuild. This adds the
// consolidated property none of the per-leg suites asserts: the PRODUCT MASTER (latest-per-id), the
// BARCODE REGISTRY (one-code-one-item) and the per-HSN TAX SCHEDULE all rebuild from the event store
// after a restart, and one tenant's catalogue is invisible to — and cannot be blocked by — another's.
// A "restart" is a fresh surface (`apiHarness({ store })`) over the same event store; test-only, the
// catalogue is already event-sourced.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const SALT = { sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };
const CODE = '8901058000108';
const HSN = '25010020';

const publish = (h: ApiHarness, u: string, t: string, productId: string, product: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: u, tenantId: t, idempotencyKey: key, body: { product, categories: [GROCERY] } });
const getProduct = (h: ApiHarness, u: string, t: string, productId: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/products/${productId}`, userId: u, tenantId: t });
const listProducts = (h: ApiHarness, u: string, t: string) =>
  h.request({ method: 'GET', path: '/v1/catalogue/products', userId: u, tenantId: t });
const assignBarcode = (h: ApiHarness, u: string, t: string, productId: string, code: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/barcodes/${code}`, userId: u, tenantId: t, idempotencyKey: key, body: { kind: 'ean' } });
const lookupBarcode = (h: ApiHarness, u: string, t: string, code: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/barcodes/${code}`, userId: u, tenantId: t });
const setRate = (h: ApiHarness, u: string, t: string, hsn: string, from: string, rateBps: number, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/tax-classes/${hsn}/rates/${from}`, userId: u, tenantId: t, idempotencyKey: key, body: { rateBps } });
const resolveRate = (h: ApiHarness, u: string, t: string, hsn: string, on: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/tax-classes/${hsn}/rate`, userId: u, tenantId: t, query: { on } });

describe('M03 catalogue rebuilds and stays tenant-isolated after a restart (durability + isolation)', () => {
  it('product master + barcode registry + tax schedule all rebuild from the store after a restart', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await publish(h, 'u-owner', A, 'p-salt', SALT, 'k-pub')).status).toBe(201);
    expect((await assignBarcode(h, 'u-owner', A, 'p-salt', CODE, 'k-bc')).status).toBe(201);
    expect((await setRate(h, 'u-owner', A, HSN, '2017-07-01', 500, 'k-rate')).status).toBe(201);

    // Cold restart — a fresh surface over the same event store.
    const restarted = apiHarness({ store: h.store });

    const product = await getProduct(restarted, 'u-owner', A, 'p-salt');
    expect(product.status).toBe(200);
    expect((product.body as { product: { name: string; taxClass: string } }).product).toMatchObject({ name: 'Tata Salt 1kg', taxClass: HSN });

    const bc = await lookupBarcode(restarted, 'u-owner', A, CODE);
    expect(bc.status).toBe(200);
    expect((bc.body as { barcode: { productId: string } }).barcode.productId).toBe('p-salt');

    const rate = await resolveRate(restarted, 'u-owner', A, HSN, '2020-01-01');
    expect(rate.status).toBe(200);
    expect((rate.body as { rate: { rateBps: number } }).rate.rateBps).toBe(500);
  });

  it('a re-publish stays latest-wins across a restart — newest version, one entry', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await publish(h, 'u-owner', A, 'p-milk', { ...SALT, sku: 'SKU-MILK', name: 'Milk 500ml' }, 'k1');
    await publish(h, 'u-owner', A, 'p-milk', { ...SALT, sku: 'SKU-MILK', name: 'Milk 500ml (new pack)' }, 'k2');

    const restarted = apiHarness({ store: h.store });
    expect((await getProduct(restarted, 'u-owner', A, 'p-milk')).body as { product: { name: string } })
      .toMatchObject({ product: { name: 'Milk 500ml (new pack)' } });
    const products = (await listProducts(restarted, 'u-owner', A)).body as { products: { productId: string }[] };
    expect(products.products.filter((p) => p.productId === 'p-milk')).toHaveLength(1);
  });

  it('catalogue is tenant-isolated — one tenant cannot see, or be blocked by, another\'s products/barcodes', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner-a');
    await h.seedOwner(B, 'u-owner-b');
    await publish(h, 'u-owner-a', A, 'p-salt', SALT, 'kA');
    await assignBarcode(h, 'u-owner-a', A, 'p-salt', CODE, 'kA-bc');

    // Tenant B sees NONE of A's catalogue.
    expect((await getProduct(h, 'u-owner-b', B, 'p-salt')).status).toBe(404);
    expect((await lookupBarcode(h, 'u-owner-b', B, CODE)).status).toBe(404);

    // And B is NOT blocked by A's namespace: the same product id, SKU and barcode publish cleanly in B
    // (a clash across tenants would be a cross-tenant leak of the uniqueness check).
    expect((await publish(h, 'u-owner-b', B, 'p-salt', SALT, 'kB')).status).toBe(201);
    expect((await assignBarcode(h, 'u-owner-b', B, 'p-salt', CODE, 'kB-bc')).status).toBe(201);

    // Each tenant's barcode resolves within its OWN catalogue only.
    expect(((await lookupBarcode(h, 'u-owner-a', A, CODE)).body as { barcode: { productId: string } }).barcode.productId).toBe('p-salt');
    expect(((await lookupBarcode(h, 'u-owner-b', B, CODE)).body as { barcode: { productId: string } }).barcode.productId).toBe('p-salt');
  });
});
