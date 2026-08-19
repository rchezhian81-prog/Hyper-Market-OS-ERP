import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03-FR-01 / M03-FR-03: the product-master store + compliance-gated authoring on the live API. A product
// does not reach the catalogue until it VALIDATES — a name, SKU, unit of measure, category and HSN/tax
// class, and a regulated item its safety content (a food item its allergen declaration + country of
// origin). Published products are event-sourced, latest-per-id, so they survive a restart and a change is
// a new version, never an overwrite. Authoring is gated catalogue.pack.publish; reads catalogue.pack.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const FOOD = { categoryId: 'food', name: 'Food', parentId: null, regulated: ['food'] };
const SALT = { sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };

const publish = (h: ApiHarness, u: string, productId: string, product: unknown, categories: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: u, tenantId: A, idempotencyKey: key, body: { product, categories } });
const get = (h: ApiHarness, u: string, productId: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/products/${productId}`, userId: u, tenantId: A });
const list = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/catalogue/products', userId: u, tenantId: A });

describe('product master authoring (M03-FR-01/03)', () => {
  it('publishes a compliant product (draft → new) and reads it back', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await publish(h, 'u-owner', 'p-salt', SALT, [GROCERY], 'k-salt');
    expect(res.status).toBe(201);
    expect((res.body as { product: { lifecycle: string } }).product.lifecycle).toBe('new'); // draft is promoted on publish
    const got = await get(h, 'u-owner', 'p-salt');
    expect(got.status).toBe(200);
    expect((got.body as { product: { name: string; taxClass: string } }).product).toMatchObject({ name: 'Tata Salt 1kg', taxClass: '25010020' });
  });

  it('refuses a product with no HSN, and a food item with no allergen declaration', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const noHsn = await publish(h, 'u-owner', 'p-nohsn', { ...SALT, taxClass: null }, [GROCERY], 'k-nohsn');
    expect(noHsn.status).toBe(422);
    expect(codeOf(noHsn)).toBe('product_not_publishable');
    // A food item declares its allergens (an empty list is "none"; silence is not) and country of origin.
    const food = { sku: 'SKU-BREAD', name: 'Bread 400g', baseUom: 'each', primaryCategoryId: 'food', taxClass: '1905', lifecycle: 'draft', safety: { countryOfOrigin: 'India' } };
    const noAllergen = await publish(h, 'u-owner', 'p-bread', food, [FOOD], 'k-bread');
    expect(noAllergen.status).toBe(422);
    expect(codeOf(noAllergen)).toBe('product_not_publishable');
    // Neither was stored.
    expect((await get(h, 'u-owner', 'p-nohsn')).status).toBe(404);
    expect((await get(h, 'u-owner', 'p-bread')).status).toBe(404);
  });

  it('refuses a product whose category is not in the hierarchy supplied', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await publish(h, 'u-owner', 'p-orphan', { ...SALT, primaryCategoryId: 'nope' }, [GROCERY], 'k-orphan');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('unknown_category');
  });

  it('a re-publish is a new version — latest wins, one entry, never a second copy', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await publish(h, 'u-owner', 'p-milk', { ...SALT, sku: 'SKU-MILK', name: 'Milk 500ml' }, [GROCERY], 'k-milk-1');
    await publish(h, 'u-owner', 'p-milk', { ...SALT, sku: 'SKU-MILK', name: 'Milk 500ml (new pack)' }, [GROCERY], 'k-milk-2');
    const got = await get(h, 'u-owner', 'p-milk');
    expect((got.body as { product: { name: string } }).product.name).toBe('Milk 500ml (new pack)'); // latest version
    const products = (await list(h, 'u-owner')).body as { products: { productId: string }[]; count: number };
    expect(products.products.filter((p) => p.productId === 'p-milk')).toHaveLength(1); // not two
  });

  it('central boundary refuses a SKU already held by a DIFFERENT product (ADR-0013 control 9)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Two devices author offline: each validated its own product, neither could see the other's SKU.
    expect((await publish(h, 'u-owner', 'p-salt', SALT, [GROCERY], 'k-salt')).status).toBe(201);
    const clash = await publish(h, 'u-owner', 'p-salt-dup', { ...SALT, name: 'Salt (a different product, same code)' }, [GROCERY], 'k-dup');
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('sku_already_in_use');
    // The clashing product was NOT stored — the first keeps the SKU (nothing overwritten, hard rule #2).
    expect((await get(h, 'u-owner', 'p-salt-dup')).status).toBe(404);
    expect((await get(h, 'u-owner', 'p-salt')).status).toBe(200);
  });

  it('re-publishing the SAME product keeps its own SKU — a new version is never a self-clash', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await publish(h, 'u-owner', 'p-salt', SALT, [GROCERY], 'k-salt-1');
    // Same id, same SKU, changed name → a legitimate new version, not a collision with itself.
    const again = await publish(h, 'u-owner', 'p-salt', { ...SALT, name: 'Tata Salt 1kg (new pack)' }, [GROCERY], 'k-salt-2');
    expect(again.status).toBe(201);
    expect((await get(h, 'u-owner', 'p-salt')).status).toBe(200);
    // And a genuinely distinct product with its OWN SKU still publishes alongside it.
    const other = await publish(h, 'u-owner', 'p-sugar', { ...SALT, sku: 'SKU-SUGAR', name: 'Sugar 1kg' }, [GROCERY], 'k-sugar');
    expect(other.status).toBe(201);
  });

  it('gates authoring on catalogue.pack.publish; a manager may read but not publish; malformed → 400', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // has catalogue.pack.read, NOT catalogue.pack.publish
    await publish(h, 'u-owner', 'p-salt', SALT, [GROCERY], 'k-seed');
    expect((await publish(h, 'u-mgr', 'p-x', SALT, [GROCERY], 'k-mgr')).status).toBe(403); // cannot author
    expect((await get(h, 'u-mgr', 'p-salt')).status).toBe(200); // can read
    expect((await list(h, 'u-mgr')).status).toBe(200);
    // Malformed: no product object / no categories[].
    expect((await publish(h, 'u-owner', 'p-bad', undefined, [GROCERY], 'k-bad1')).status).toBe(400);
    const bad2 = await publish(h, 'u-owner', 'p-bad', SALT, undefined, 'k-bad2');
    expect(bad2.status).toBe(400);
    expect(codeOf(bad2)).toBe('not_readable_as_a_product');
  });
});
