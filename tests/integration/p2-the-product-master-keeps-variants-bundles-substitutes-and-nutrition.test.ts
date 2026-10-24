import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { productMasterAdapter } from '../../services/api/src/adapters';
import { bundlesInForce } from '../../services/api/src/p2-catalogue-adapters';

// OB-288 P2 — the product master's new parts through the real routes, on the in-memory store and (with DATABASE_URL) on
// real PostgreSQL, each with a cold restart reading the same record:
//   • M03-FR-01: a variant names a one-level parent held by head office and differs from its siblings; the category report
//     rolls variants up under the parent and keeps the manufacturer ("not recorded" when nobody said);
//   • M03-FR-03 · OB-307: nutrition is required only for food SRE packs or labels itself; recorded when known otherwise;
//   • M03-FR-02 · OB-306: an own-barcode bundle product names its components, versioned; nothing unsellable, no tobacco;
//   • M03-FR-04: the approved substitute list, versioned, served to staff and to the customer app; no controlled item;
//   • B17: a liquor product left over from before the rule is LEFT OUT of every pack and said.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const FOOD = { categoryId: 'food', name: 'Food', parentId: null, regulated: ['food'] };
const HOME = { categoryId: 'home', name: 'Home care', parentId: null };
const HAIR = { categoryId: 'hair', name: 'Hair care', parentId: 'home' };
const CATS = [FOOD, HOME, HAIR];
const foodSafety = { allergens: [], countryOfOrigin: 'India', storageConditions: 'cool and dry' };
const panel = { basis: 'per_100g', energyKcal: 350, proteinG: 22, carbohydrateG: 60, totalSugarsG: 3, addedSugarsG: 0, totalFatG: 1.5, saturatedFatG: 0.3, transFatG: 0, cholesterolMg: 0, sodiumMg: 15 };

async function cast(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-cash', 'cashier');
  await h.provisionRole(T, 'u-shopper', 'customer');
}
const post = (h: ApiHarness, T: string, path: string, body: unknown, userId = 'u-owner') =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, path: string, query: Record<string, string> = {}, userId = 'u-owner') =>
  h.request({ method: 'GET', path, userId, tenantId: T, query });
const publish = (h: ApiHarness, T: string, productId: string, product: Record<string, unknown>) =>
  post(h, T, `/v1/catalogue/products/${productId}/publish`, { product: { baseUom: 'each', lifecycle: 'active', taxClass: '3305', primaryCategoryId: 'hair', ...product, sku: product['sku'] ?? `SKU-${productId}`, name: product['name'] ?? productId }, categories: CATS });

describe.each(backings)('OB-288 P2 — the product master keeps variants, nutrition, bundles and substitutes — on $name', ({ harness }) => {
  it('variants share a one-level parent and differ from their siblings; the category report rolls them up with the manufacturer', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    expect((await publish(h, T, 'shampoo', { manufacturer: 'Maker A', brand: 'Shine' })).status).toBe(201);
    expect((await publish(h, T, 'shampoo-100', { parentProductId: 'shampoo', attributes: { size: '100ml' } })).status).toBe(201);
    expect((await publish(h, T, 'shampoo-200', { parentProductId: 'shampoo', attributes: { size: '200ml' } })).status).toBe(201);
    expect((await publish(h, T, 'comb', { primaryCategoryId: 'home' })).status).toBe(201);
    // Refused by name, nothing kept.
    expect(codeOf(await publish(h, T, 'x1', { parentProductId: 'nobody' }))).toBe('variant_parent_unknown');
    expect(codeOf(await publish(h, T, 'x2', { parentProductId: 'shampoo-100', attributes: { size: '5ml' } }))).toBe('variant_parent_is_a_variant');
    expect(codeOf(await publish(h, T, 'x3', { parentProductId: 'shampoo', attributes: { size: '100ml' } }))).toBe('variant_same_as_sibling');
    expect(codeOf(await publish(h, T, 'shampoo', { parentProductId: 'comb' }))).toBe('product_has_variants');
    expect((await get(h, T, '/v1/catalogue/products/x3')).status).toBe(404);

    const again = harness(h);
    const report = await get(again, T, '/v1/catalogue/reports/variants', { categoryId: 'home' }, 'u-mgr');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      familyCount: 2, productCount: 4, categoriesIncluded: ['hair', 'home'],
      byManufacturer: [{ manufacturer: 'Maker A', recorded: true, families: 1, products: 3 }, { manufacturer: 'not recorded', recorded: false, families: 1, products: 1 }],
    });
    const fam = (report.body as { families: { productId: string; variantCount: number; variants: { productId: string }[] }[] }).families.find((f) => f.productId === 'shampoo')!;
    expect(fam.variants.map((v) => v.productId)).toEqual(['shampoo-100', 'shampoo-200']);
    expect((await get(again, T, '/v1/catalogue/reports/variants', { categoryId: 'nowhere' })).status).toBe(404);
    expect((await get(again, T, '/v1/catalogue/reports/variants', {}, 'u-shopper')).status).toBe(403);
  }, 120_000);

  it('OB-307 — an SRE-packed food needs its nutrition panel; a bought-in pack does not; a panel given must add up', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    const dal = (safety: Record<string, unknown>) => ({ sku: 'SKU-DAL', name: 'Toor dal 1kg (SRE pack)', primaryCategoryId: 'food', taxClass: '0713', safety: { ...foodSafety, ...safety } });
    const missing = await publish(h, T, 'dal-sre', dal({ packedBySre: true }));
    expect(missing.status).toBe(422);
    expect((missing.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/nutrition/);
    expect(codeOf(await publish(h, T, 'dal-sre', dal({ packedBySre: true, nutrition: { ...panel, totalSugarsG: 90 } })))).toBe('product_not_publishable');
    expect((await publish(h, T, 'dal-sre', dal({ packedBySre: true, nutrition: panel }))).status).toBe(201);
    // A bought-in pack prints its own panel: published without one; recorded when known.
    expect((await publish(h, T, 'dal-brand', { ...dal({}), sku: 'SKU-DAL-B' })).status).toBe(201);
    const again = harness(h);
    expect((await get(again, T, '/v1/catalogue/products/dal-sre')).body).toMatchObject({ product: { safety: { packedBySre: true, nutrition: panel } } });
  }, 120_000);

  it('OB-306 — an own-barcode bundle names its components, versioned; it never holds tobacco or anything unsellable', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    for (const id of ['gift-box', 'tea', 'mug']) expect((await publish(h, T, id, { primaryCategoryId: 'home' })).status).toBe(201);
    expect((await publish(h, T, 'cig', { primaryCategoryId: 'home', lifecycle: 'draft', safety: { tobacco: true, packMinimumMinor: 10, minimumAge: 18 } })).status).toBe(201);
    const define = (components: unknown, userId = 'u-owner') => post(h, T, '/v1/catalogue/bundles/gift-box', { components, reason: 'Diwali gift box' }, userId);
    expect((await define([{ productId: 'tea', quantityMinor: 2 }], 'u-mgr')).status).toBe(403);
    expect(codeOf(await define([{ productId: 'tea', quantityMinor: 1 }, { productId: 'cig', quantityMinor: 10 }]))).toBe('bundle_component_not_sellable');
    expect(codeOf(await define([{ productId: 'tea', quantityMinor: 1 }]))).toBe('bundle_needs_components');
    expect(codeOf(await post(h, T, '/v1/catalogue/bundles/gift-box', { components: 'tea and a mug' }))).toBe('not_readable_as_a_bundle');
    const v1 = await define([{ productId: 'tea', quantityMinor: 2 }, { productId: 'mug', quantityMinor: 1 }]);
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ bundle: { version: 1, definedBy: 'u-owner' } });
    expect((await define([{ productId: 'mug', quantityMinor: 1 }, { productId: 'tea', quantityMinor: 2 }])).body).toMatchObject({ unchanged: true });
    expect((await define([{ productId: 'tea', quantityMinor: 3 }, { productId: 'mug', quantityMinor: 1 }])).body).toMatchObject({ bundle: { version: 2 } });
    // A component cannot itself be a bundle.
    expect(codeOf(await post(h, T, '/v1/catalogue/bundles/mug', { components: [{ productId: 'gift-box', quantityMinor: 2 }], reason: 'x' }))).toBe('bundle_is_a_component');

    const again = harness(h);
    const one = (await get(again, T, '/v1/catalogue/bundles/gift-box')).body as { bundle: { version: number }; history: unknown[] };
    expect(one.bundle.version).toBe(2);
    expect(one.history).toHaveLength(2);
    expect((await get(again, T, '/v1/catalogue/bundles', {}, 'u-cash')).body).toMatchObject({ count: 1 });
    // What a pack would carry for the tills to explode a bundle sale.
    expect((await bundlesInForce({ store: again.store, now: () => new Date().toISOString() }, T)).map((b) => [b.bundleProductId, b.version])).toEqual([['gift-box', 2]]);
    expect((await get(again, T, '/v1/catalogue/bundles/nothing')).status).toBe(404);
  }, 120_000);

  it('M03-FR-04 — the approved substitutes: set, versioned, served to staff and to the app; no controlled item', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    const milk = (id: string, allergens: readonly string[], over: Record<string, unknown> = {}) =>
      publish(h, T, id, { primaryCategoryId: 'food', taxClass: '0401', safety: { ...foodSafety, allergens }, ...over });
    expect((await milk('milk-a', ['milk'])).status).toBe(201);
    expect((await milk('milk-b', ['milk'])).status).toBe(201);
    expect((await milk('milk-nut', ['milk', 'peanuts_tree_nuts'])).status).toBe(201);
    expect((await milk('milk-old', ['milk'], { lifecycle: 'discontinued' })).status).toBe(201);
    expect((await publish(h, T, 'energy', { primaryCategoryId: 'home', taxClass: '22029920', safety: { minimumAge: 18 } })).status).toBe(201);
    const set = (productId: string, substitutes: readonly string[], userId = 'u-owner') => post(h, T, `/v1/catalogue/products/${productId}/substitutes`, { substitutes, reason: 'same size, same price band' }, userId);
    expect((await set('milk-a', ['milk-b'], 'u-mgr')).status).toBe(403);
    expect(codeOf(await set('milk-a', ['energy']))).toBe('substitute_controlled');
    expect(codeOf(await set('milk-a', ['milk-old']))).toBe('substitute_not_sellable');
    expect((await set('ghost', ['milk-b'])).status).toBe(404);
    const first = await set('milk-a', ['milk-b', 'milk-nut']);
    expect(first.status).toBe(201);
    expect((first.body as { warnings: string[] }).warnings[0]).toMatch(/peanuts_tree_nuts/);
    expect((await set('milk-a', ['milk-b'])).body).toMatchObject({ list: { version: 2, substitutes: ['milk-b'] } });

    const again = harness(h);
    // The picker (staff) reads the list in force and its history; the app shows the list by name.
    const staff = (await get(again, T, '/v1/catalogue/products/milk-a/substitutes', {}, 'u-cash')).body as { set: boolean; list: { version: number }; history: unknown[] };
    expect(staff).toMatchObject({ set: true, list: { version: 2 } });
    expect(staff.history).toHaveLength(2);
    expect((await get(again, T, '/v1/storefront/products/milk-a/substitutes', {}, 'u-shopper')).body).toEqual({ productId: 'milk-a', substitutes: [{ productId: 'milk-b', name: 'milk-b' }], set: true });
    expect((await get(again, T, '/v1/catalogue/products/milk-b/substitutes')).body).toMatchObject({ set: false, list: null });
    expect((await get(again, T, '/v1/storefront/products/milk-a/substitutes', {}, 'u-cash')).status).toBe(403);
  }, 120_000);

  it('B17 — a liquor product kept from before the rule is left out of every pack, and said', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    // Written straight to the master, as a product published before the liquor rule existed would be.
    await productMasterAdapter({ store: h.store, now: () => new Date().toISOString() }).publish(T, {
      productId: 'p-beer', tenantId: T, sku: 'SKU-BEER', name: 'Beer 650ml', baseUom: 'each', primaryCategoryId: 'home', taxClass: '22030000', lifecycle: 'active', safety: { minimumAge: 21 },
    }, 'legacy');
    expect((await publish(h, T, 'soap', { primaryCategoryId: 'home', taxClass: '3401' })).status).toBe(201);
    const preview = await get(harness(h), T, '/v1/catalogue/pack/preview', { storeId: 'store-1' });
    expect(preview.status).toBe(200);
    const body = preview.body as { notSold: { productId: string; reason: string; detail: string }[]; snapshot: { products: { productId: string }[] } };
    expect(body.notSold).toEqual([{ productId: 'p-beer', sku: 'SKU-BEER', reason: 'liquor_not_sold', detail: expect.stringMatching(/22030000/) }]);
    expect(body.snapshot.products.some((p) => p.productId === 'p-beer')).toBe(false);
  }, 120_000);
});
